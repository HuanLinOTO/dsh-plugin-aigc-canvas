/**
 * Pipeline DAG engine — the host-side state machine behind the
 * `aigc_pipeline_*` tools (per docs/product/02-pipeline.md §1-3, §5-6, §9-10).
 *
 * A Pipeline is a declarative spec of AIGC steps (capability or operation)
 * wired by declared input edges. The engine:
 *   1. Topologically sorts the steps (Kahn's algorithm).
 *   2. Executes them in waves: each wave is the set of currently-runnable
 *      steps (all deps completed) — independent branches thus parallelize.
 *   3. Places each step's output on the canvas + wires edges to its inputs.
 *   4. Persists state to `<cwd>/.dsh-aigc-canvas/<sessionId>/pipelines/<pipeline_id>.json`
 *      after every wave so a crashed run can be resumed.
 *   5. Emits progress events to a callback (the host wires this to
 *      `agent.inject` so the model sees "[2/5] Done: animated → /path/to/video.mp4").
 *   6. Honors an AbortSignal for `aigc_pipeline_cancel`.
 *
 * Scope per doc 06 decision 5: linear + simple fan-out / fan-in DAGs. The
 * sort itself handles arbitrary DAGs; the user-facing restriction is about
 * reasoning complexity, not the algorithm.
 *
 * Step execution:
 *   - `capability` step: looks up an EndpointSpec for that capability in the
 *     provider's catalog (or falls back to a default path per capability),
 *     calls executeProviderRequest, processes the response (binary save or
 *     OpenAI b64_json extraction), places the result on the canvas.
 *   - `operation` step: maps inputs → MediaEditRequest.inputs, calls
 *     executeMediaEdit (ffmpeg), places the result on the canvas.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AigcError } from './wire.js'
import {
  canvasDirFor,
  coerceEdgeRelation,
  type AigcCanvasService,
  type AigcElementKind,
  type EdgeRelation,
} from './canvas-registry.js'
import { executeProviderRequest, type ProviderBinaryKind, type ProviderHttpResult } from './provider-http.js'
import { executeMediaEdit, MEDIA_EDIT_OPERATIONS, type MediaEditOperation } from './media-edit.js'
import type { ResolvedAigcProvider } from './config.js'
import type { Capability, EndpointSpec } from './endpoint-catalog.js'
import { endpointsByCapability, extractByPath } from './endpoint-catalog.js'

// ── Public types ─────────────────────────────────────────────────────────────

/** Pipeline error-handling strategy (doc §4). */
export type PipelineOnError = 'abort' | 'continue'

/** Pipeline lifecycle status. */
export type PipelineStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** Step lifecycle status (doc §3 — adds 'skipped' for cancelled/continue paths). */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/** One declared input edge into a step. */
export interface StepInputSpec {
  /** The upstream step id whose output feeds this step. */
  from: string
  /** Semantic relation on the edge (defaults to 'input' when omitted). */
  relation?: EdgeRelation
}

/** One step in a PipelineSpec (doc §4). */
export interface StepSpec {
  id: string
  /** Provider capability (t2i / i2v / tts / ...) — mutually exclusive with `operation`. */
  capability?: Capability | string
  /** ffmpeg operation (concat / clip / extract_audio / ...) — mutually exclusive with `capability`. */
  operation?: MediaEditOperation | string
  /** Declared input edges from prior step outputs. */
  inputs?: StepInputSpec[]
  /** Step parameters (JSON body for capability steps; ffmpeg params for operation steps). */
  params: Record<string, unknown>
  /** Override the default provider selection. */
  provider_id?: string
  /** Conditional execution expression, e.g. "step_a.status == 'completed'". */
  when?: string
}

/** The full declarative pipeline spec (doc §4). */
export interface PipelineSpec {
  name: string
  onError: PipelineOnError
  steps: StepSpec[]
}

/** One step's persisted state (doc §3 return shape). */
export interface PipelineStepState {
  id: string
  status: StepStatus
  /** filePath of the produced canvas element (when status is 'completed'). */
  element_path?: string
  /** Failure message (when status is 'failed'). */
  error?: string
  started_at?: number
  finished_at?: number
}

/** Full pipeline state — persisted to disk + held in memory while running. */
export interface PipelineState {
  pipeline_id: string
  session_id: string
  name: string
  status: PipelineStatus
  started_at: number
  finished_at?: number
  spec: PipelineSpec
  steps: PipelineStepState[]
}

/** Per-step override applied at resume time (doc §3 aigc_pipeline_resume). */
export interface StepOverride {
  provider_id?: string
  params?: Record<string, unknown>
}

/** Map of step_id → override. */
export type StepOverrides = Record<string, StepOverride>

/** Compact summary used by aigc_pipeline_list. */
export interface PipelineSummary {
  pipeline_id: string
  name: string
  status: PipelineStatus
  started_at: number
  finished_at?: number
  step_count: number
  completed_count: number
}

/** Kind of progress event (doc §5 notification timing). */
export type ProgressEventKind =
  | 'pipeline_started'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'pipeline_completed'
  | 'pipeline_failed'
  | 'pipeline_cancelled'

/** One progress notification delivered to the host (which injects it into the agent). */
export interface ProgressEvent {
  pipeline_id: string
  session_id: string
  kind: ProgressEventKind
  summary: string
  state: PipelineState
}

/** Callback the host wires to `agent.inject` (doc §5). */
export type ProgressCallback = (event: ProgressEvent) => void

/** Dependencies the PipelineEngine needs (all live getters — same as registerTools). */
export interface PipelineEngineDeps {
  canvas: AigcCanvasService
  getProvider: (providerId?: string) => ResolvedAigcProvider
  resolveCwd: (sessionId: string) => string
  getTimeoutMs: () => number
  getMediaLimit: () => number
  onProgress?: ProgressCallback
}

// ── Constants & helpers ──────────────────────────────────────────────────────

/** Sub-directory under the session canvas dir where pipeline JSON state lives. */
const PIPELINE_DIR_NAME = 'pipelines'

/**
 * Default endpoint path per capability when a provider has no structured
 * EndpointSpec for it (e.g. the built-in stub provider). Matches the stub's
 * classifyStubRoute path patterns so capability steps produce the right
 * synthetic media kind.
 */
const DEFAULT_PATH_FOR_CAPABILITY: Record<string, string> = {
  t2i: '/v1/images/generations',
  i2i: '/v1/images/edits',
  t2v: '/v1/videos/generations',
  i2v: '/v1/videos/generations',
  fl2v: '/v1/videos/generations',
  ref2v: '/v1/videos/generations',
  tts: '/v1/audio/speech',
  music: '/v1/audio/speech',
  transcribe: '/v1/audio/transcriptions',
  edit: '/v1/images/edits',
  chat: '/v1/chat/completions',
}

/** File extension per AigcElement kind (no leading dot). */
function extensionForKind(kind: AigcElementKind): string {
  switch (kind) {
    case 'image': return 'png'
    case 'video': return 'mp4'
    case 'audio': return 'mp3'
    case 'prompt': return 'txt'
  }
}

/** Default output extension per MediaEditOperation (no leading dot). */
function defaultOutputExtForOperation(operation: string): string {
  switch (operation) {
    case 'extract_audio': return 'mp3'
    case 'extract_frame': return 'png'
    case 'concat':
    case 'clip':
    case 'speed':
    case 'resize':
    case 'reverse':
    case 'add_audio':
    case 'images_to_video':
      return 'mp4'
    default: return 'bin'
  }
}

/** File extension for one binary kind produced by the provider (image/video/audio). */
function extensionForBinaryKind(kind: ProviderBinaryKind, contentType: string): string {
  const subtype = contentType.split(';')[0]?.trim().split('/')[1]?.toLowerCase() ?? ''
  switch (kind) {
    case 'image': return ['png', 'jpeg', 'jpg', 'webp', 'gif'].includes(subtype) ? subtype : 'png'
    case 'video': return ['mp4', 'webm', 'mov', 'ogg', 'm4v'].includes(subtype) ? subtype : 'mp4'
    case 'audio': return ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'].includes(subtype) ? subtype : 'mp3'
    case 'other': return 'bin'
  }
}

/** Resolve the per-session pipelines directory under the session cwd. */
function pipelinesDirFor(cwd: string, sessionId: string): string {
  return join(canvasDirFor(cwd, sessionId), PIPELINE_DIR_NAME)
}

/** Resolve the JSON path for one pipeline's persisted state. */
function pipelineJsonPath(cwd: string, sessionId: string, pipelineId: string): string {
  return join(pipelinesDirFor(cwd, sessionId), `${pipelineId}.json`)
}

/** Save a buffer into the session canvas directory; returns the absolute path. */
async function saveBytesToCanvas(bytes: Buffer, ext: string, sessionId: string, cwd: string): Promise<string> {
  const dir = canvasDirFor(cwd, sessionId)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}.${ext}`)
  await writeFile(filePath, bytes)
  return filePath
}

/**
 * Detect the OpenAI image-generation JSON response format and extract the
 * base64-encoded image bytes from it: `{ "data": [{ "b64_json": "<base64>" }] }`.
 * Returns null when the text is not this shape. Sniffs the decoded magic
 * bytes to pick the right file extension.
 */
function extractOpenAIB64Image(text: string): { bytes: Buffer; ext: string; contentType: string } | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const data = (parsed as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return null
  const first = data[0]
  if (typeof first !== 'object' || first === null) return null
  const b64 = (first as { b64_json?: unknown }).b64_json
  if (typeof b64 !== 'string' || b64.length === 0) return null
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.byteLength < 8) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { bytes, ext: 'png', contentType: 'image/png' }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, ext: 'jpg', contentType: 'image/jpeg' }
  }
  if (bytes.byteLength >= 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') {
    return { bytes, ext: 'webp', contentType: 'image/webp' }
  }
  if (bytes.slice(0, 6).toString('ascii') === 'GIF89a' || bytes.slice(0, 6).toString('ascii') === 'GIF87a') {
    return { bytes, ext: 'gif', contentType: 'image/gif' }
  }
  return { bytes, ext: 'png', contentType: 'image/png' }
}

/**
 * Evaluate a `when` conditional expression. Supports the simple form
 * `<step_id>.status == 'value'` / `<step_id>.status != 'value'`. Returns
 * true (always run) for unrecognized expressions — fail-open so a typo in
 * the expression doesn't silently skip a step the user wanted.
 */
function evaluateWhen(expr: string, stepStateById: Map<string, PipelineStepState>): boolean {
  const trimmed = expr.trim()
  if (trimmed === '') return true
  const match = trimmed.match(/^([A-Za-z0-9_-]+)\.status\s*(==|!=)\s*['"]?([A-Za-z0-9_-]+)['"]?$/)
  if (match === null) return true
  const [, stepId, op, value] = match
  const state = stepStateById.get(stepId!)
  if (state === undefined) return false
  return op === '==' ? state.status === value : state.status !== value
}

/** Replace `{{param_name}}` placeholders in a string with values from `params`. */
function substituteTemplate(value: string, params: Record<string, string>): string {
  return value.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (whole, name: string) => {
    const v = params[name]
    return typeof v === 'string' ? v : whole
  })
}

/** Deep-walk a structure and apply `{{param}}` substitution to every string. */
function applyTemplateToValue<T>(value: T, params: Record<string, string>): T {
  if (typeof value === 'string') return substituteTemplate(value, params) as unknown as T
  if (Array.isArray(value)) return value.map(item => applyTemplateToValue(item, params)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyTemplateToValue(v, params)
    }
    return out as unknown as T
  }
  return value
}

/** Apply template param substitution to a full PipelineSpec (mutates a copy). */
function applyTemplateParams(spec: PipelineSpec, params?: Record<string, string>): PipelineSpec {
  if (params === undefined) return spec
  return applyTemplateToValue(spec, params)
}

/** Validate a resolved PipelineSpec (after template substitution). */
function validateSpec(spec: PipelineSpec): void {
  if (typeof spec.name !== 'string' || spec.name === '') {
    throw new AigcError('bad-request', 'pipeline spec.name is required')
  }
  if (spec.onError !== 'abort' && spec.onError !== 'continue') {
    throw new AigcError('bad-request', `pipeline spec.onError must be "abort" or "continue" (got "${spec.onError}")`)
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    throw new AigcError('bad-request', 'pipeline spec.steps must be a non-empty array')
  }
  for (const step of spec.steps) {
    if (typeof step.id !== 'string' || step.id === '') {
      throw new AigcError('bad-request', 'each step needs a non-empty id')
    }
    if (step.capability === undefined && step.operation === undefined) {
      throw new AigcError('bad-request', `step "${step.id}" has neither capability nor operation`)
    }
    if (step.capability !== undefined && step.operation !== undefined) {
      throw new AigcError('bad-request', `step "${step.id}" has both capability and operation (mutually exclusive)`)
    }
    if (step.params === undefined || step.params === null || typeof step.params !== 'object' || Array.isArray(step.params)) {
      throw new AigcError('bad-request', `step "${step.id}" params must be a JSON object`)
    }
  }
}

/** Apply step overrides to a spec (returns a new spec; doesn't mutate the input). */
function applyStepOverrides(spec: PipelineSpec, overrides: StepOverrides): PipelineSpec {
  const newSteps: StepSpec[] = spec.steps.map(step => {
    const ov = overrides[step.id]
    if (ov === undefined) return step
    return {
      ...step,
      ...(ov.provider_id !== undefined ? { provider_id: ov.provider_id } : {}),
      ...(ov.params !== undefined ? { params: { ...step.params, ...ov.params } } : {}),
    }
  })
  return { ...spec, steps: newSteps }
}

/** Build a compact PipelineSummary from a full state. */
function summarize(state: PipelineState): PipelineSummary {
  return {
    pipeline_id: state.pipeline_id,
    name: state.name,
    status: state.status,
    started_at: state.started_at,
    ...(state.finished_at !== undefined ? { finished_at: state.finished_at } : {}),
    step_count: state.steps.length,
    completed_count: state.steps.filter(s => s.status === 'completed').length,
  }
}

/** The shape returned to tools — projects state.steps to the doc §3 wire shape. */
export function pipelineStateProjection(state: PipelineState): {
  pipeline_id: string
  name: string
  status: PipelineStatus
  steps: Array<{
    id: string
    status: StepStatus
    element_path?: string
    error?: string
    started_at?: number
    finished_at?: number
  }>
} {
  return {
    pipeline_id: state.pipeline_id,
    name: state.name,
    status: state.status,
    steps: state.steps.map(s => ({
      id: s.id,
      status: s.status,
      ...(s.element_path !== undefined ? { element_path: s.element_path } : {}),
      ...(s.error !== undefined ? { error: s.error } : {}),
      ...(s.started_at !== undefined ? { started_at: s.started_at } : {}),
      ...(s.finished_at !== undefined ? { finished_at: s.finished_at } : {}),
    })),
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Persist pipeline state to disk (atomic-ish — best-effort, no tmp file). */
async function persistState(state: PipelineState, cwd: string): Promise<void> {
  const dir = pipelinesDirFor(cwd, state.session_id)
  await mkdir(dir, { recursive: true })
  await writeFile(pipelineJsonPath(cwd, state.session_id, state.pipeline_id), JSON.stringify(state, null, 2), 'utf8')
}

/** Load one pipeline's persisted state. Returns undefined when the file doesn't exist. */
async function loadState(cwd: string, sessionId: string, pipelineId: string): Promise<PipelineState | undefined> {
  try {
    const raw = await readFile(pipelineJsonPath(cwd, sessionId, pipelineId), 'utf8')
    return JSON.parse(raw) as PipelineState
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return undefined
    }
    throw err
  }
}

// ── Topological sort ────────────────────────────────────────────────────────

/**
 * Compute a topological order of the steps (Kahn's algorithm). The doc limits
 * the supported shape to "linear + simple fan-out" (decision 5), but the
 * sort itself handles arbitrary DAGs; the restriction is about user-facing
 * complexity, not the algorithm. Throws on cycles and unknown `from` refs.
 */
export function topologicalSort(steps: readonly StepSpec[]): StepSpec[] {
  const byId = new Map(steps.map(s => [s.id, s]))
  if (byId.size !== steps.length) {
    throw new AigcError('bad-request', 'pipeline spec has duplicate step ids')
  }
  for (const s of steps) {
    for (const input of s.inputs ?? []) {
      if (!byId.has(input.from)) {
        throw new AigcError('bad-request', `step "${s.id}" references unknown input step "${input.from}"`)
      }
    }
  }
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const s of steps) {
    inDegree.set(s.id, 0)
    dependents.set(s.id, [])
  }
  for (const s of steps) {
    const seen = new Set<string>()
    for (const input of s.inputs ?? []) {
      if (seen.has(input.from)) continue
      seen.add(input.from)
      inDegree.set(s.id, (inDegree.get(s.id) ?? 0) + 1)
      dependents.get(input.from)!.push(s.id)
    }
  }
  const queue: string[] = steps
    .filter(s => (inDegree.get(s.id) ?? 0) === 0)
    .map(s => s.id)
  const ordered: StepSpec[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    ordered.push(byId.get(id)!)
    for (const dep of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 0) - 1
      inDegree.set(dep, newDeg)
      if (newDeg === 0) queue.push(dep)
    }
  }
  if (ordered.length !== steps.length) {
    throw new AigcError('bad-request', 'pipeline spec has a cycle (steps depend on each other circularly)')
  }
  return ordered
}

// ── Engine ───────────────────────────────────────────────────────────────────

interface RunningEntry {
  state: PipelineState
  abort: AbortController
}

/**
 * The host-side pipeline engine. Constructed in index.ts with all live
 * dependencies (canvas, getProvider, resolveCwd, ...) and passed to
 * registerTools so the 5 aigc_pipeline_* tools can call its methods.
 */
export class PipelineEngine {
  private readonly running = new Map<string, RunningEntry>()

  constructor(private readonly deps: PipelineEngineDeps) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a new pipeline state from a spec + optional template params.
   * Validates the spec, applies template substitution, persists the initial
   * state to disk, and returns it. Does NOT start execution — call `run`
   * separately (the aigc_pipeline_run tool decides whether to await it
   * based on the `async` parameter).
   */
  async start(
    sessionId: string,
    spec: PipelineSpec,
    params?: Record<string, string>,
  ): Promise<PipelineState> {
    const pipelineId = `pipe_${randomUUID()}`
    const cwd = this.deps.resolveCwd(sessionId)
    const resolvedSpec = applyTemplateParams(spec, params)
    validateSpec(resolvedSpec)
    // Validate the topo order up front so cycle / unknown-ref errors surface
    // before any step actually runs.
    topologicalSort(resolvedSpec.steps)
    const state: PipelineState = {
      pipeline_id: pipelineId,
      session_id: sessionId,
      name: resolvedSpec.name,
      status: 'running',
      started_at: Date.now(),
      spec: resolvedSpec,
      steps: resolvedSpec.steps.map(s => ({ id: s.id, status: 'pending' as StepStatus })),
    }
    await persistState(state, cwd)
    return state
  }

  /**
   * Execute a pipeline to completion. Used by aigc_pipeline_run (async=false)
   * and aigc_pipeline_resume. The provided AbortController is the only
   * cancellation handle — aigc_pipeline_cancel looks it up via the in-memory
   * running map and calls .abort() on it.
   */
  async run(state: PipelineState, abort: AbortController): Promise<PipelineState> {
    const cwd = this.deps.resolveCwd(state.session_id)
    this.running.set(state.pipeline_id, { state, abort })
    try {
      await this.runToCompletion(state, cwd, abort)
    } finally {
      this.running.delete(state.pipeline_id)
    }
    await persistState(state, cwd)
    return state
  }

  /** Query the current state of one pipeline (in-memory first, then disk). */
  async status(sessionId: string, pipelineId: string): Promise<PipelineState> {
    const running = this.running.get(pipelineId)
    if (running !== undefined) return running.state
    const cwd = this.deps.resolveCwd(sessionId)
    const state = await loadState(cwd, sessionId, pipelineId)
    if (state === undefined) {
      throw new AigcError('not-found', `pipeline "${pipelineId}" not found in session "${sessionId}"`, 404)
    }
    return state
  }

  /**
   * Resume a paused/failed pipeline from its breakpoint (doc §6).
   *
   * - Loads the persisted state from disk.
   * - Applies `step_overrides` to the spec (e.g. swap a step's provider_id).
   * - Resets failed/skipped/pending steps back to 'pending' (completed steps
   *   stay completed — their element_path is reused by downstream steps).
   * - Re-runs the engine.
   */
  async resume(
    sessionId: string,
    pipelineId: string,
    overrides?: StepOverrides,
  ): Promise<PipelineState> {
    const cwd = this.deps.resolveCwd(sessionId)
    const existing = await loadState(cwd, sessionId, pipelineId)
    if (existing === undefined) {
      throw new AigcError('not-found', `pipeline "${pipelineId}" not found in session "${sessionId}"`, 404)
    }
    if (this.running.has(pipelineId)) {
      throw new AigcError('bad-request', `pipeline "${pipelineId}" is already running`)
    }
    if (overrides !== undefined) {
      existing.spec = applyStepOverrides(existing.spec, overrides)
    }
    // Reset anything that isn't 'completed' back to 'pending'. Completed
    // steps keep their element_path so downstream steps can wire to them.
    for (const step of existing.steps) {
      if (step.status !== 'completed') {
        step.status = 'pending'
        step.error = undefined
        step.started_at = undefined
        step.finished_at = undefined
        step.element_path = undefined
      }
    }
    existing.status = 'running'
    existing.finished_at = undefined
    await persistState(existing, cwd)
    const abort = new AbortController()
    return this.run(existing, abort)
  }

  /**
   * Cancel a running pipeline. Aborts the in-flight AbortController and
   * returns the count of steps that had already completed. If the pipeline
   * isn't currently running, returns the persisted completed count and
   * `cancelled: false` (idempotent — caller can treat both as "stopped").
   */
  async cancel(
    sessionId: string,
    pipelineId: string,
    keepArtifacts: boolean,
  ): Promise<{ cancelled: boolean; completed_steps: number }> {
    void keepArtifacts // Artifacts are always kept on disk (canvas owns lifecycle).
    const entry = this.running.get(pipelineId)
    if (entry === undefined) {
      const cwd = this.deps.resolveCwd(sessionId)
      const state = await loadState(cwd, sessionId, pipelineId)
      if (state === undefined) {
        throw new AigcError('not-found', `pipeline "${pipelineId}" not found in session "${sessionId}"`, 404)
      }
      return {
        cancelled: false,
        completed_steps: state.steps.filter(s => s.status === 'completed').length,
      }
    }
    entry.abort.abort(new Error('pipeline cancelled by user'))
    // Give the run loop a microtask to settle (it observes the abort at
    // the next iteration boundary and updates state.status to 'cancelled').
    await new Promise(resolve => setImmediate(resolve))
    return {
      cancelled: true,
      completed_steps: entry.state.steps.filter(s => s.status === 'completed').length,
    }
  }

  /**
   * List all pipelines for one session (running + persisted). The summary
   * excludes the full spec/steps — call aigc_pipeline_status for details.
   */
  async list(sessionId: string): Promise<PipelineSummary[]> {
    const cwd = this.deps.resolveCwd(sessionId)
    const dir = pipelinesDirFor(cwd, sessionId)
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch (err) {
      if (!(err !== null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT')) {
        throw err
      }
    }
    const summaries: PipelineSummary[] = []
    const seen = new Set<string>()
    for (const entry of this.running.values()) {
      if (entry.state.session_id !== sessionId) continue
      if (seen.has(entry.state.pipeline_id)) continue
      seen.add(entry.state.pipeline_id)
      summaries.push(summarize(entry.state))
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const pipelineId = file.slice(0, -'.json'.length)
      if (seen.has(pipelineId)) continue
      try {
        const raw = await readFile(join(dir, file), 'utf8')
        const state = JSON.parse(raw) as PipelineState
        if (state.session_id !== sessionId) continue
        seen.add(pipelineId)
        summaries.push(summarize(state))
      } catch {
        // Skip malformed files.
      }
    }
    return summaries
  }

  // ── Run loop ───────────────────────────────────────────────────────────────

  private emitProgress(kind: ProgressEventKind, state: PipelineState, summary: string): void {
    const cb = this.deps.onProgress
    if (cb === undefined) return
    try {
      cb({ pipeline_id: state.pipeline_id, session_id: state.session_id, kind, summary, state })
    } catch {
      // Progress callback failures must never break the pipeline.
    }
  }

  private async runToCompletion(
    state: PipelineState,
    cwd: string,
    abort: AbortController,
  ): Promise<void> {
    const { signal } = abort
    // Index the spec + step states by id for O(1) lookups during the run.
    const specById = new Map(state.spec.steps.map(s => [s.id, s]))
    const stepStateById = new Map(state.steps.map(s => [s.id, s]))

    this.emitProgress('pipeline_started', state, `Pipeline "${state.name}" started: ${state.steps.length} steps`)

    let failedInPipeline = false
    // Walk in waves: each iteration finds all pending steps whose deps are
    // completed (or whose `when` clause allows) and runs them in parallel.
    while (true) {
      if (signal.aborted) break
      // Resolve the next wave.
      const wave: PipelineStepState[] = []
      for (const step of state.steps) {
        if (step.status !== 'pending') continue
        const spec = specById.get(step.id)!
        if (spec.when !== undefined && spec.when !== '' && !evaluateWhen(spec.when, stepStateById)) {
          step.status = 'skipped'
          step.finished_at = Date.now()
          continue
        }
        const inputs = spec.inputs ?? []
        let ready = true
        for (const input of inputs) {
          const dep = stepStateById.get(input.from)!
          if (dep.status === 'completed') continue
          // Upstream failed/skipped/pending/running → not ready.
          ready = false
          break
        }
        if (ready) wave.push(step)
      }
      if (wave.length === 0) break

      // Mark wave steps as running + emit progress + persist.
      for (const step of wave) {
        step.status = 'running'
        step.started_at = Date.now()
        const idx = state.steps.findIndex(s => s.id === step.id) + 1
        this.emitProgress('step_started', state, `[${idx}/${state.steps.length}] Running step "${step.id}"...`)
      }
      await persistState(state, cwd)

      // Execute the wave in parallel. Each step either completes (element_path
      // set) or fails (error set). Step failures don't reject the Promise.all —
      // they're caught and recorded so the wave can settle and the loop decides
      // what to do based on `onError`.
      await Promise.all(wave.map(async (step) => {
        const spec = specById.get(step.id)!
        try {
          const result = await this.executeStep(state.session_id, spec, stepStateById, cwd, signal)
          step.status = 'completed'
          step.element_path = result.filePath
          step.finished_at = Date.now()
          const idx = state.steps.findIndex(s => s.id === step.id) + 1
          this.emitProgress('step_completed', state, `[${idx}/${state.steps.length}] Done: "${step.id}" → ${result.filePath}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          step.status = 'failed'
          step.error = message
          step.finished_at = Date.now()
          failedInPipeline = true
          const idx = state.steps.findIndex(s => s.id === step.id) + 1
          this.emitProgress('step_failed', state, `[${idx}/${state.steps.length}] FAILED: "${step.id}" (${message}). Resume with aigc_pipeline_resume.`)
        }
      }))
      await persistState(state, cwd)

      // onError=abort: stop as soon as a step fails. The remaining pending
      // steps stay 'pending' so resume picks them up after the failed one is
      // retried (and downstream steps can re-resolve their inputs).
      if (failedInPipeline && state.spec.onError === 'abort') break
    }

    // If aborted, cancel any still-pending/running steps.
    if (signal.aborted) {
      for (const step of state.steps) {
        if (step.status === 'running' || step.status === 'pending') {
          step.status = 'skipped'
          step.finished_at = Date.now()
        }
      }
      state.status = 'cancelled'
      state.finished_at = Date.now()
      this.emitProgress('pipeline_cancelled', state, `Pipeline "${state.name}" cancelled.`)
      return
    }

    // Finalize. onError=abort may have left pending steps (downstream of a
    // failure) — those are NOT 'skipped' (so resume retries them) but the
    // pipeline is marked failed.
    const anyFailed = state.steps.some(s => s.status === 'failed')
    const completedCount = state.steps.filter(s => s.status === 'completed').length
    if (!anyFailed) {
      state.status = 'completed'
      // The final output is the last completed step's element_path.
      const finalStep = [...state.steps].reverse().find(s => s.status === 'completed' && s.element_path !== undefined)
      const finalOut = finalStep?.element_path ?? '(no final output)'
      this.emitProgress('pipeline_completed', state, `Pipeline "${state.name}" completed: ${completedCount}/${state.steps.length} steps. Final output: ${finalOut}`)
    } else {
      state.status = 'failed'
      const failedStep = state.steps.find(s => s.status === 'failed')
      this.emitProgress('pipeline_failed', state, `Pipeline "${state.name}" failed at step "${failedStep?.id ?? '?'}". ${completedCount}/${state.steps.length} steps completed. Resume with aigc_pipeline_resume.`)
    }
    state.finished_at = Date.now()
  }

  // ── Step execution ────────────────────────────────────────────────────────

  private async executeStep(
    sessionId: string,
    spec: StepSpec,
    stepStateById: Map<string, PipelineStepState>,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; kind: AigcElementKind }> {
    signal.throwIfAborted()
    // Resolve the input element_paths + relations from the upstream step states.
    const inputSpecs = spec.inputs ?? []
    const inputPaths: string[] = []
    const inputRelations: Array<{ path: string; relation: EdgeRelation }> = []
    for (const input of inputSpecs) {
      const dep = stepStateById.get(input.from)
      if (dep === undefined) {
        throw new AigcError('backend-error', `step "${spec.id}" references unknown input step "${input.from}"`)
      }
      if (dep.element_path === undefined) {
        throw new AigcError('backend-error', `input step "${input.from}" has no element_path (status=${dep.status})`)
      }
      inputPaths.push(dep.element_path)
      inputRelations.push({ path: dep.element_path, relation: coerceEdgeRelation(input.relation) })
    }

    let result: { filePath: string; kind: AigcElementKind }
    if (spec.capability !== undefined) {
      result = await this.executeCapabilityStep(sessionId, spec.capability, spec.params, spec.provider_id, cwd, signal)
    } else if (spec.operation !== undefined) {
      result = await this.executeOperationStep(sessionId, spec.operation, spec.params, inputPaths, cwd, signal)
    } else {
      // validateSpec already caught this, but be defensive.
      throw new AigcError('bad-request', `step "${spec.id}" has neither capability nor operation`)
    }

    // Place the produced file on the canvas + wire edges from each input
    // element to the new one (using the declared relation per input).
    await this.placeAndWire(sessionId, result.filePath, result.kind, spec.params, inputRelations, cwd, spec.id)
    return result
  }

  /** Execute a capability step: resolve endpoint, call provider, save response. */
  private async executeCapabilityStep(
    sessionId: string,
    capability: string,
    params: Record<string, unknown>,
    providerId: string | undefined,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; kind: AigcElementKind }> {
    const provider = this.deps.getProvider(providerId)
    // Find an EndpointSpec for this capability in the provider's catalog.
    const cap = capability as Capability
    const endpointList = endpointsByCapability(provider.endpoints).get(cap) ?? []
    const endpointSpec = endpointList[0]
    const path = endpointSpec?.path ?? DEFAULT_PATH_FOR_CAPABILITY[capability] ?? '/v1/generate'
    const method = endpointSpec?.method ?? 'POST'
    // Build the request body. `params` is the JSON body as-is. (Template
    // substitution was already applied at start time.)
    const body = Object.keys(params).length > 0 ? JSON.stringify(params) : undefined
    const result = await executeProviderRequest(provider, {
      method,
      path,
      body,
    }, { timeoutMs: this.deps.getTimeoutMs(), signal })
    return this.processResponse(result, endpointSpec, provider, sessionId, cwd, signal)
  }

  /** Execute an operation step: build MediaEditRequest, call ffmpeg. */
  private async executeOperationStep(
    sessionId: string,
    operation: string,
    params: Record<string, unknown>,
    inputPaths: string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; kind: AigcElementKind }> {
    if (!(MEDIA_EDIT_OPERATIONS as readonly string[]).includes(operation)) {
      throw new AigcError('bad-request', `step operation "${operation}" is not a valid MediaEditOperation`)
    }
    const op = operation as MediaEditOperation
    const outputExt = typeof params.output_ext === 'string' && params.output_ext !== ''
      ? params.output_ext
      : defaultOutputExtForOperation(op)
    const request = {
      operation: op,
      inputs: inputPaths,
      outputExt,
      ...(typeof params.start === 'number' ? { start: params.start } : {}),
      ...(typeof params.end === 'number' ? { end: params.end } : {}),
      ...(typeof params.duration === 'number' ? { duration: params.duration } : {}),
      ...(typeof params.speed === 'number' ? { speed: params.speed } : {}),
      ...(typeof params.width === 'number' ? { width: params.width } : {}),
      ...(typeof params.height === 'number' ? { height: params.height } : {}),
      ...(typeof params.fps === 'number' ? { fps: params.fps } : {}),
      ...(typeof params.timestamp === 'number' ? { timestamp: params.timestamp } : {}),
    }
    const result = await executeMediaEdit(request, cwd, sessionId, { timeoutMs: this.deps.getTimeoutMs(), signal })
    // Infer the element kind from the output extension.
    const kind: AigcElementKind = outputExt === 'png' || outputExt === 'jpg' || outputExt === 'jpeg' || outputExt === 'webp' || outputExt === 'gif'
      ? 'image'
      : outputExt === 'mp3' || outputExt === 'wav' || outputExt === 'flac' || outputExt === 'ogg' || outputExt === 'm4a' || outputExt === 'aac' || outputExt === 'opus'
        ? 'audio'
        : outputExt === 'txt' || outputExt === 'json'
          ? 'prompt'
          : 'video'
    return { filePath: result.outputPath, kind }
  }

  /**
   * Process a provider response into a saved file on disk. Handles:
   *   - binary responses (image/video/audio) → save bytes
   *   - JSON responses with OpenAI b64_json format → extract + save
   *   - spec-driven b64_json_field / url_field extraction
   *   - text/JSON fallback → save as prompt element
   */
  private async processResponse(
    result: ProviderHttpResult,
    spec: EndpointSpec | undefined,
    provider: ResolvedAigcProvider,
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; kind: AigcElementKind }> {
    if (!result.ok) {
      throw new AigcError('backend-error', `provider returned HTTP ${result.status}: ${result.text.slice(0, 200)}`, result.status >= 400 && result.status < 500 ? 400 : 502)
    }
    switch (result.kind) {
      case 'json':
      case 'text': {
        // Spec-driven extraction first (when the provider has an EndpointSpec).
        if (result.kind === 'json' && spec !== undefined) {
          const specResult = await this.processBySpec(spec, result.text, provider, sessionId, cwd, signal)
          if (specResult !== null) return specResult
        }
        // OpenAI b64_json image format.
        if (result.kind === 'json') {
          const openAi = extractOpenAIB64Image(result.text)
          if (openAi !== null) {
            const filePath = await saveBytesToCanvas(openAi.bytes, openAi.ext, sessionId, cwd)
            return { filePath, kind: 'image' }
          }
        }
        // Fallback: save the text body as a prompt element.
        const ext = result.kind === 'json' ? 'json' : 'txt'
        const buf = Buffer.from(result.text, 'utf8')
        const filePath = await saveBytesToCanvas(buf, ext, sessionId, cwd)
        return { filePath, kind: 'prompt' }
      }
      default: {
        // Binary (image / video / audio / other).
        const ext = extensionForBinaryKind(result.kind, result.contentType)
        const filePath = await saveBytesToCanvas(result.bytes, ext, sessionId, cwd)
        const kind: AigcElementKind = result.kind === 'other' ? 'prompt' : result.kind
        return { filePath, kind }
      }
    }
  }

  /**
   * Spec-driven response extraction. Handles b64_json_array, b64_json_field,
   * and url_field response kinds (per EndpointSpec.response). Returns null
   * for binary / json_text (caller falls back to the legacy handling).
   */
  private async processBySpec(
    spec: EndpointSpec,
    textBody: string,
    provider: ResolvedAigcProvider,
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; kind: AigcElementKind } | null> {
    const responseKind = spec.response.kind
    if (responseKind === 'json_text' || responseKind === 'binary') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(textBody)
    } catch {
      return null
    }
    if (responseKind === 'b64_json_array' || responseKind === 'b64_json_field') {
      const path = spec.response.path
      if (path === undefined || path === '') return null
      const b64 = extractByPath(parsed, path)
      if (typeof b64 !== 'string' || b64.length === 0) return null
      const bytes = Buffer.from(b64, 'base64')
      if (bytes.byteLength < 8) return null
      if (bytes.byteLength > this.deps.getMediaLimit()) {
        throw new AigcError('backend-error', `extracted payload too large (${bytes.byteLength} bytes)`, 413)
      }
      // Sniff magic bytes for the extension + kind.
      const ext = sniffExtFromBytes(bytes)
      const filePath = await saveBytesToCanvas(bytes, ext, sessionId, cwd)
      return { filePath, kind: ext === 'png' || ext === 'jpg' || ext === 'webp' || ext === 'gif' ? 'image' : 'prompt' }
    }
    if (responseKind === 'url_field') {
      const path = spec.response.path
      if (path === undefined || path === '') return null
      const url = extractByPath(parsed, path)
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
      const downloadResult = await executeProviderRequest(provider, {
        method: 'GET',
        path: url,
      }, { timeoutMs: this.deps.getTimeoutMs(), signal })
      if (!downloadResult.ok || downloadResult.kind === 'json' || downloadResult.kind === 'text') return null
      // After the text-kind check, downloadResult is ProviderHttpBinary (has .bytes + .size).
      // TypeScript can't narrow the union here (kind is a string-literal union on the text variant),
      // so use explicit field casts — mirrors tools.ts processResponseBySpec.
      const dlBytes = (downloadResult as { bytes: Buffer }).bytes
      const dlSize = (downloadResult as { size: number }).size
      const dlKind = (downloadResult as { kind: ProviderBinaryKind }).kind
      const dlContentType = downloadResult.contentType
      const ext = extensionForBinaryKind(dlKind, dlContentType)
      if (dlSize > this.deps.getMediaLimit()) {
        throw new AigcError('backend-error', `downloaded payload too large (${dlSize} bytes)`, 413)
      }
      const filePath = await saveBytesToCanvas(dlBytes, ext, sessionId, cwd)
      const kind: AigcElementKind = dlKind === 'other' ? 'prompt' : dlKind
      return { filePath, kind }
    }
    return null
  }

  /**
   * Place a produced file on the canvas + wire edges from each input element.
   * Mirrors what aigc_canvas_place does, but without the description/title
   * requirements (the pipeline engine doesn't go through the tool layer).
   */
  private async placeAndWire(
    sessionId: string,
    filePath: string,
    kind: AigcElementKind,
    params: Record<string, unknown>,
    inputRelations: Array<{ path: string; relation: EdgeRelation }>,
    cwd: string,
    stepId: string,
  ): Promise<void> {
    const promptText = typeof params.prompt === 'string' ? params.prompt
      : typeof params.text === 'string' ? params.text
      : undefined
    // Resolve input element uuids for auto-positioning + edge wiring.
    const referenceUuids: string[] = []
    for (const input of inputRelations) {
      try {
        const el = this.deps.canvas.getElementByPath(sessionId, input.path)
        referenceUuids.push(el.uuid)
      } catch {
        // Element not on canvas (shouldn't happen since prior steps placed
        // their outputs, but be defensive — skip the edge, keep the placement).
      }
    }
    const placed = await this.deps.canvas.placeFile(sessionId, {
      kind,
      filePath,
      title: stepId,
      producedBy: 'aigc_pipeline',
      ...(promptText !== undefined ? { promptText } : {}),
      referenceUuids: referenceUuids.length > 0 ? referenceUuids : undefined,
    }, cwd)
    // Wire edges with their declared relations.
    if (referenceUuids.length > 0) {
      const edges: Array<{ uuid: string; relation: EdgeRelation }> = []
      for (let i = 0; i < inputRelations.length; i++) {
        const refUuid = referenceUuids[i]
        if (refUuid === undefined) continue
        edges.push({ uuid: refUuid, relation: inputRelations[i]!.relation })
      }
      if (edges.length > 0) {
        await this.deps.canvas.wireEdges(sessionId, edges, placed.uuid)
      }
    }
  }
}

/** Sniff a buffer's magic bytes to determine the file extension. */
function sniffExtFromBytes(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.byteLength >= 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (bytes.slice(0, 6).toString('ascii') === 'GIF89a' || bytes.slice(0, 6).toString('ascii') === 'GIF87a') return 'gif'
  return 'png'
}

// Re-export the kind inference helper for tests / external use.
export { extensionForKind }
