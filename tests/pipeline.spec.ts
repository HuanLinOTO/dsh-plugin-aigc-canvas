/**
 * Unit tests for the Pipeline DAG engine (src/pipeline.ts) and the 5
 * aigc_pipeline_* model-facing tools (per docs/product/02-pipeline.md §3, §9).
 *
 * Coverage:
 *  - topologicalSort (Kahn's algorithm; cycle / unknown-ref detection)
 *  - end-to-end stub pipeline run (5 steps with parallel branches, place + wire)
 *  - breakpoint resume (step 2 fails → resume with step_overrides)
 *  - cancel via pre-aborted AbortController
 *  - progress callback events
 *  - aigc_pipeline_run / status / list tools (through registerTools)
 *
 * The stub provider returns synthetic media (no network), so the full
 * t2i → i2v → tts → add_audio → clip flow can be exercised without real APIs.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAigcCanvasService, type AigcCanvasService } from '../src/canvas-registry.js'
import {
  PipelineEngine,
  topologicalSort,
  pipelineStateProjection,
  type PipelineSpec,
  type ProgressEvent,
} from '../src/pipeline.js'
import { registerTools, type ProviderInfo } from '../src/tools.js'
import { AigcError } from '../src/wire.js'
import type { ResolvedAigcProvider } from '../src/config.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

// ── Test fixtures ────────────────────────────────────────────────────────────

const STUB_PROVIDER: ResolvedAigcProvider = {
  id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '',
  auth: { scheme: 'bearer', name: '' }, builtin: true,
  endpoints: [], priority: 100, costPerCall: 0, costPerKiloToken: 0, costPerSecond: 0, avgLatencyMs: 0, qualityHint: 'balanced',
}

/** A second stub provider used to test step_overrides that swap provider_id. */
const ALT_STUB_PROVIDER: ResolvedAigcProvider = {
  ...STUB_PROVIDER,
  id: 'alt-stub', name: 'Alt Stub',
}

function providerInfoList(providers: readonly ResolvedAigcProvider[]): readonly ProviderInfo[] {
  return providers.map((p, i) => ({
    id: p.id,
    name: p.name,
    endpoint: p.endpoint,
    instructions: p.instructions,
    isStub: p.endpoint === '' || p.endpoint === 'stub://aigc-backend',
    isDefault: i === 0,
    endpoints: p.endpoints,
    priority: p.priority,
    costPerCall: p.costPerCall,
    avgLatencyMs: p.avgLatencyMs,
    qualityHint: p.qualityHint,
  }))
}

/** The 30s-product-ad spec from doc §1 (compressed to use the stub backend). */
function sampleAdSpec(): PipelineSpec {
  return {
    name: '30s product ad',
    onError: 'abort',
    steps: [
      { id: 'product_img', capability: 't2i', params: { prompt: 'product photo of {{product_name}}, studio lighting' } },
      { id: 'animated', capability: 'i2v', inputs: [{ from: 'product_img', relation: 'first_frame' }], params: { prompt: 'smooth camera pan' } },
      { id: 'narration', capability: 'tts', params: { text: '{{tagline}}', voice: 'male_en' } },
      { id: 'with_audio', operation: 'add_audio', inputs: [{ from: 'animated' }, { from: 'narration', relation: 'audio_track' }], params: {} },
      { id: 'final_30s', operation: 'clip', inputs: [{ from: 'with_audio' }], params: { start: 0, end: 30 } },
    ],
  }
}

// ── Mock tool registry (mirrors tools.spec.ts mockCtx) ──────────────────────

interface MockTools {
  tools: { register(tool: unknown): () => void }
  registered: Map<string, { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> | unknown }>
}

function mockCtx(): MockTools {
  const registered = new Map<string, { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> | unknown }>()
  return {
    tools: {
      register(tool: unknown) {
        const t = tool as { name: string; execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> | unknown }
        registered.set(t.name, t)
        return () => { registered.delete(t.name) }
      },
    },
    registered,
  }
}

function execFor(sessionId: string): ToolRunContext {
  const ac = new AbortController()
  return {
    signal: ac.signal,
    callId: 'test-call',
    name: 'test',
    arguments: {},
    agent: { id: 'agent-1', session: { id: sessionId, header: {} } },
  } as ToolRunContext
}

/** Build a PipelineEngine + registerTools harness backed by the stub provider(s). */
function setupEngine(
  cwd: string,
  canvas: AigcCanvasService,
  providers: readonly ResolvedAigcProvider[] = [STUB_PROVIDER],
  onProgress?: (event: ProgressEvent) => void,
): { engine: PipelineEngine; ctx: MockTools; dispose: () => void } {
  const mutable = providers.map(p => ({ ...p }))
  const byId = new Map(mutable.map(p => [p.id, p]))
  const getProvider = (providerId?: string) => {
    if (providerId === undefined || providerId === '') return mutable[0]!
    const p = byId.get(providerId)
    if (p === undefined) {
      throw new AigcError('bad-request', `unknown provider_id "${providerId}"`)
    }
    return p
  }
  const engine = new PipelineEngine({
    canvas,
    getProvider,
    resolveCwd: () => cwd,
    getTimeoutMs: () => 5_000,
    getMediaLimit: () => 100 * 1024 * 1024,
    ...(onProgress !== undefined ? { onProgress } : {}),
  })
  const ctx = mockCtx()
  const dispose = registerTools(
    ctx as unknown as Parameters<typeof registerTools>[0],
    getProvider,
    () => ({ ok: true }),
    () => ({ ok: true }),
    () => providerInfoList(mutable),
    canvas,
    () => cwd,
    () => 5_000,
    () => 100 * 1024 * 1024,
    engine,
  )
  return { engine, ctx, dispose }
}

// ── topologicalSort unit tests ──────────────────────────────────────────────

describe('topologicalSort', () => {
  it('orders steps by dependency (linear chain)', () => {
    const spec: PipelineSpec = {
      name: 'linear', onError: 'abort',
      steps: [
        { id: 'c', capability: 't2i', inputs: [{ from: 'b' }], params: {} },
        { id: 'a', capability: 't2i', params: {} },
        { id: 'b', capability: 't2i', inputs: [{ from: 'a' }], params: {} },
      ],
    }
    const ordered = topologicalSort(spec.steps)
    expect(ordered.map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('preserves spec order for independent steps (stable seed)', () => {
    const spec: PipelineSpec = {
      name: 'parallel', onError: 'continue',
      steps: [
        { id: 'first', capability: 't2i', params: {} },
        { id: 'second', capability: 'tts', params: {} },
        { id: 'third', capability: 't2v', params: {} },
      ],
    }
    const ordered = topologicalSort(spec.steps)
    // No dependencies → topo order matches spec order (stable Kahn).
    expect(ordered.map(s => s.id)).toEqual(['first', 'second', 'third'])
  })

  it('handles fan-out + fan-in (the 30s ad DAG)', () => {
    // product_img → animated ──┐
    //                │         ├─→ with_audio → final_30s
    // narration ──────────────┘
    const spec = sampleAdSpec()
    const ordered = topologicalSort(spec.steps)
    const ids = ordered.map(s => s.id)
    // product_img + narration come before animated; animated before with_audio; with_audio before final_30s.
    expect(ids.indexOf('product_img')).toBeLessThan(ids.indexOf('animated'))
    expect(ids.indexOf('animated')).toBeLessThan(ids.indexOf('with_audio'))
    expect(ids.indexOf('narration')).toBeLessThan(ids.indexOf('with_audio'))
    expect(ids.indexOf('with_audio')).toBeLessThan(ids.indexOf('final_30s'))
    // product_img + narration are both roots (in-degree 0) — they should be the first two.
    expect(ids.slice(0, 2).sort()).toEqual(['narration', 'product_img'])
  })

  it('throws on unknown `from` reference', () => {
    const spec: PipelineSpec = {
      name: 'bad', onError: 'abort',
      steps: [{ id: 'a', capability: 't2i', inputs: [{ from: 'nonexistent' }], params: {} }],
    }
    expect(() => topologicalSort(spec.steps)).toThrow(AigcError)
  })

  it('throws on a cycle', () => {
    const spec: PipelineSpec = {
      name: 'cycle', onError: 'abort',
      steps: [
        { id: 'a', capability: 't2i', inputs: [{ from: 'b' }], params: {} },
        { id: 'b', capability: 't2i', inputs: [{ from: 'a' }], params: {} },
      ],
    }
    expect(() => topologicalSort(spec.steps)).toThrow(/cycle/)
  })

  it('throws on duplicate ids', () => {
    const spec: PipelineSpec = {
      name: 'dup', onError: 'abort',
      steps: [
        { id: 'a', capability: 't2i', params: {} },
        { id: 'a', capability: 'tts', params: {} },
      ],
    }
    expect(() => topologicalSort(spec.steps)).toThrow(/duplicate/)
  })
})

// ── PipelineEngine end-to-end (stub provider) ───────────────────────────────

describe('PipelineEngine (stub provider)', () => {
  let cwd: string
  let canvas: AigcCanvasService

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-pipeline-'))
    canvas = createAigcCanvasService(() => cwd)
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('runs a 5-step stub pipeline to completion (parallel branches + edges wired)', async () => {
    const events: ProgressEvent[] = []
    const { engine } = setupEngine(cwd, canvas, [STUB_PROVIDER], e => events.push(e))
    const spec = sampleAdSpec()
    const state = await engine.start('s1', spec, { product_name: 'iPhone 17', tagline: '未来已来' })
    expect(state.status).toBe('running')
    expect(state.steps).toHaveLength(5)
    const abort = new AbortController()
    const finalState = await engine.run(state, abort)
    // All steps completed; pipeline completed.
    expect(finalState.status).toBe('completed')
    expect(finalState.steps.every(s => s.status === 'completed')).toBe(true)
    // Each step has an element_path on disk + canvas.
    for (const step of finalState.steps) {
      expect(step.element_path).toBeDefined()
      expect(step.element_path!).toContain('.dsh-aigc-canvas')
    }
    // Template substitution worked.
    expect(state.spec.steps[0]!.params.prompt).toBe('product photo of iPhone 17, studio lighting')
    expect(state.spec.steps[2]!.params.text).toBe('未来已来')
    // Canvas has 5 elements + edges wired per the declared inputs.
    const snap = canvas.snapshot('s1')
    expect(snap.elements).toHaveLength(5)
    // Edges: animated←product_img (first_frame), with_audio←animated (input default),
    //        with_audio←narration (audio_track), final_30s←with_audio (input default)
    expect(snap.edges).toHaveLength(4)
    // Verify the first_frame edge exists.
    const productImgEl = snap.elements.find(e => e.title === 'product_img')!
    const animatedEl = snap.elements.find(e => e.title === 'animated')!
    const firstFrameEdge = snap.edges.find(e => e.source === productImgEl.uuid && e.target === animatedEl.uuid)
    expect(firstFrameEdge).toBeDefined()
    expect(firstFrameEdge!.relation).toBe('first_frame')
    // Progress events: 1 started + 5 step_started + 5 step_completed + 1 completed = 12.
    expect(events.length).toBe(12)
    expect(events[0]!.kind).toBe('pipeline_started')
    expect(events[events.length - 1]!.kind).toBe('pipeline_completed')
    // The pipeline_started event summary mentions the step count.
    expect(events[0]!.summary).toContain('5 steps')
    // Verify element kind inference: product_img is image, animated is video, narration is audio.
    expect(productImgEl.kind).toBe('image')
    expect(animatedEl.kind).toBe('video')
    expect(snap.elements.find(e => e.title === 'narration')!.kind).toBe('audio')
    // All elements are producedBy 'aigc_pipeline'.
    expect(snap.elements.every(e => e.producedBy === 'aigc_pipeline')).toBe(true)
  })

  it('emits step_started before step_completed for each step', async () => {
    const events: ProgressEvent[] = []
    const { engine } = setupEngine(cwd, canvas, [STUB_PROVIDER], e => events.push(e))
    const spec: PipelineSpec = {
      name: 'two-step', onError: 'abort',
      steps: [
        { id: 'a', capability: 't2i', params: { prompt: 'first' } },
        { id: 'b', capability: 't2i', inputs: [{ from: 'a' }], params: { prompt: 'second' } },
      ],
    }
    const state = await engine.start('s1', spec)
    await engine.run(state, new AbortController())
    // pipeline_started, a:step_started, a:step_completed, b:step_started, b:step_completed, pipeline_completed
    const kinds = events.map(e => e.kind)
    expect(kinds).toEqual([
      'pipeline_started',
      'step_started', 'step_completed',
      'step_started', 'step_completed',
      'pipeline_completed',
    ])
    // The step_completed summary includes the produced filePath.
    const bCompleted = events.find(e => e.kind === 'step_completed' && e.summary.includes('"b"'))!
    expect(bCompleted.summary).toContain('→')
  })

  it('runs independent branches in parallel waves (topo order verified via progress)', async () => {
    // product_img + narration are both roots → wave 1.
    // animated depends on product_img → wave 2.
    const events: ProgressEvent[] = []
    const { engine } = setupEngine(cwd, canvas, [STUB_PROVIDER], e => events.push(e))
    const spec: PipelineSpec = {
      name: 'parallel-roots', onError: 'abort',
      steps: [
        { id: 'product_img', capability: 't2i', params: { prompt: 'p' } },
        { id: 'narration', capability: 'tts', params: { text: 'n' } },
        { id: 'animated', capability: 'i2v', inputs: [{ from: 'product_img' }], params: { prompt: 'a' } },
      ],
    }
    const state = await engine.start('s1', spec)
    await engine.run(state, new AbortController())
    // The two step_started events for wave 1 (product_img + narration) fire
    // before any step_completed events — that's the parallel-wave semantics.
    const startedIds = events.filter(e => e.kind === 'step_started').map(e => {
      const m = e.summary.match(/"([^"]+)"/)
      return m?.[1] ?? '?'
    })
    // Wave 1: product_img + narration both start before either completes.
    expect(new Set(startedIds.slice(0, 2))).toEqual(new Set(['product_img', 'narration']))
    // animated starts only after product_img completes — compare indices in
    // the SAME events array (mixing indices across arrays is meaningless).
    const animatedStartIdx = events.findIndex(e => e.kind === 'step_started' && e.summary.includes('"animated"'))
    const productImgCompletedIdx = events.findIndex(e => e.kind === 'step_completed' && e.summary.includes('"product_img"'))
    expect(animatedStartIdx).toBeGreaterThan(productImgCompletedIdx)
  })

  it('persists state to <cwd>/.dsh-aigc-canvas/<sessionId>/pipelines/<id>.json', async () => {
    const { engine } = setupEngine(cwd, canvas)
    const spec: PipelineSpec = {
      name: 'persist', onError: 'abort',
      steps: [{ id: 'a', capability: 't2i', params: { prompt: 'p' } }],
    }
    const state = await engine.start('s1', spec)
    const pipelineJsonPath = join(cwd, '.dsh-aigc-canvas', 's1', 'pipelines', `${state.pipeline_id}.json`)
    const raw = await readFile(pipelineJsonPath, 'utf8')
    const persisted = JSON.parse(raw)
    expect(persisted.pipeline_id).toBe(state.pipeline_id)
    expect(persisted.name).toBe('persist')
    expect(persisted.status).toBe('running')
  })
})

// ── Breakpoint resume ───────────────────────────────────────────────────────

describe('PipelineEngine.resume (breakpoint resume)', () => {
  let cwd: string
  let canvas: AigcCanvasService

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-pipeline-resume-'))
    canvas = createAigcCanvasService(() => cwd)
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('skips completed steps and retries failed ones with step_overrides', async () => {
    // Use both stub providers. step_2 references 'alt-stub' which exists, but
    // we'll make it fail by giving step_2 a nonexistent provider_id initially;
    // resume fixes it via step_overrides.
    const { engine } = setupEngine(cwd, canvas, [STUB_PROVIDER, ALT_STUB_PROVIDER])
    const spec: PipelineSpec = {
      name: 'resume-flow', onError: 'abort',
      steps: [
        { id: 'step_1', capability: 't2i', params: { prompt: 'first' } },
        // step_2 has a nonexistent provider → getProvider throws → step fails.
        { id: 'step_2', capability: 't2i', provider_id: 'nonexistent', inputs: [{ from: 'step_1' }], params: { prompt: 'second' } },
        { id: 'step_3', capability: 'tts', inputs: [{ from: 'step_2' }], params: { text: 'third' } },
      ],
    }
    const state = await engine.start('s1', spec)
    const failed = await engine.run(state, new AbortController())
    // Pipeline failed at step_2; step_1 completed; step_3 is still pending (never ran).
    expect(failed.status).toBe('failed')
    expect(failed.steps[0]!.status).toBe('completed')
    expect(failed.steps[1]!.status).toBe('failed')
    expect(failed.steps[1]!.error).toContain('nonexistent')
    expect(failed.steps[2]!.status).toBe('pending')
    // The failed step's element_path is undefined; step_1's is set.
    expect(failed.steps[1]!.element_path).toBeUndefined()
    expect(failed.steps[0]!.element_path).toBeDefined()

    // Resume with a step_override that fixes step_2 (swap to the stub provider).
    const resumed = await engine.resume('s1', failed.pipeline_id, {
      step_2: { provider_id: 'stub' },
    })
    // step_1 was skipped (still completed with its original element_path);
    // step_2 retried with the stub → succeeded; step_3 ran → succeeded.
    expect(resumed.status).toBe('completed')
    expect(resumed.steps[0]!.status).toBe('completed')
    expect(resumed.steps[0]!.element_path).toBe(failed.steps[0]!.element_path) // unchanged
    expect(resumed.steps[1]!.status).toBe('completed')
    expect(resumed.steps[1]!.element_path).toBeDefined()
    expect(resumed.steps[2]!.status).toBe('completed')
    expect(resumed.steps[2]!.element_path).toBeDefined()
    // Canvas has 3 elements (step_1's original + step_2's new + step_3's new).
    const snap = canvas.snapshot('s1')
    expect(snap.elements).toHaveLength(3)
    // The spec was updated with the override.
    expect(resumed.spec.steps[1]!.provider_id).toBe('stub')
  })

  it('resume throws when the pipeline is not found', async () => {
    const { engine } = setupEngine(cwd, canvas)
    await expect(engine.resume('s1', 'pipe_nonexistent')).rejects.toThrow(AigcError)
  })

  it('onError=continue skips the failed step\'s downstream branch but runs independent branches', async () => {
    const { engine } = setupEngine(cwd, canvas, [STUB_PROVIDER, ALT_STUB_PROVIDER])
    // step_1 fails; step_2 depends on step_1 (skipped); step_3 is independent (runs).
    const spec: PipelineSpec = {
      name: 'continue-on-error', onError: 'continue',
      steps: [
        { id: 'step_1', capability: 't2i', provider_id: 'nonexistent', params: { prompt: 'fails' } },
        { id: 'step_2', capability: 'tts', inputs: [{ from: 'step_1' }], params: { text: 'downstream' } },
        { id: 'step_3', capability: 'tts', params: { text: 'independent' } },
      ],
    }
    const state = await engine.start('s1', spec)
    const result = await engine.run(state, new AbortController())
    // step_1 failed; step_2 was never ready (its dep failed) → stays 'pending';
    // step_3 is independent → runs to completion.
    expect(result.status).toBe('failed') // anyFailed → pipeline is failed
    expect(result.steps[0]!.status).toBe('failed')
    expect(result.steps[1]!.status).toBe('pending')
    expect(result.steps[2]!.status).toBe('completed')
  })
})

// ── Cancel ──────────────────────────────────────────────────────────────────

describe('PipelineEngine.cancel', () => {
  let cwd: string
  let canvas: AigcCanvasService

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-pipeline-cancel-'))
    canvas = createAigcCanvasService(() => cwd)
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('pre-aborted controller marks all steps as skipped + status cancelled', async () => {
    const { engine } = setupEngine(cwd, canvas)
    const spec: PipelineSpec = {
      name: 'cancel-pre', onError: 'abort',
      steps: [
        { id: 'a', capability: 't2i', params: { prompt: 'p' } },
        { id: 'b', capability: 'tts', inputs: [{ from: 'a' }], params: { text: 't' } },
      ],
    }
    const state = await engine.start('s1', spec)
    const abort = new AbortController()
    abort.abort(new Error('pre-cancelled'))
    const finalState = await engine.run(state, abort)
    expect(finalState.status).toBe('cancelled')
    expect(finalState.steps.every(s => s.status === 'skipped')).toBe(true)
    expect(finalState.finished_at).toBeDefined()
  })

  it('cancel() aborts a running pipeline and returns the completed step count', async () => {
    const { engine } = setupEngine(cwd, canvas)
    const spec: PipelineSpec = {
      name: 'cancel-running', onError: 'abort',
      steps: [
        { id: 'a', capability: 't2i', params: { prompt: 'p' } },
        { id: 'b', capability: 'tts', inputs: [{ from: 'a' }], params: { text: 't' } },
      ],
    }
    const state = await engine.start('s1', spec)
    // Fire run in the background, then cancel immediately.
    const abort = new AbortController()
    const runPromise = engine.run(state, abort)
    const result = await engine.cancel('s1', state.pipeline_id, true)
    expect(result.cancelled).toBe(true)
    await runPromise
    // After cancel settles, the state is cancelled. Either step_1 completed
    // before the abort took effect (status='completed') or it was skipped —
    // both are acceptable (race-tolerant). Step_2 is either pending or skipped.
    const finalState = await engine.status('s1', state.pipeline_id)
    expect(finalState.status).toBe('cancelled')
    // completed_steps returned by cancel matches the count in state.
    const completedCount = finalState.steps.filter(s => s.status === 'completed').length
    expect(result.completed_steps).toBe(completedCount)
  })

  it('cancel on a non-running pipeline returns cancelled=false with the persisted count', async () => {
    const { engine } = setupEngine(cwd, canvas)
    const spec: PipelineSpec = {
      name: 'cancel-completed', onError: 'abort',
      steps: [{ id: 'a', capability: 't2i', params: { prompt: 'p' } }],
    }
    const state = await engine.start('s1', spec)
    await engine.run(state, new AbortController())
    // Pipeline is already completed — cancel is idempotent.
    const result = await engine.cancel('s1', state.pipeline_id, true)
    expect(result.cancelled).toBe(false)
    expect(result.completed_steps).toBe(1)
  })
})

// ── Pipeline list + status ──────────────────────────────────────────────────

describe('PipelineEngine.list / status', () => {
  let cwd: string
  let canvas: AigcCanvasService

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-pipeline-list-'))
    canvas = createAigcCanvasService(() => cwd)
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('list returns all pipelines for the session (running + completed)', async () => {
    const { engine } = setupEngine(cwd, canvas)
    const spec1: PipelineSpec = {
      name: 'one', onError: 'abort',
      steps: [{ id: 'a', capability: 't2i', params: { prompt: 'p' } }],
    }
    const spec2: PipelineSpec = {
      name: 'two', onError: 'abort',
      steps: [{ id: 'b', capability: 'tts', params: { text: 't' } }],
    }
    const s1 = await engine.start('s1', spec1)
    await engine.run(s1, new AbortController())
    const s2 = await engine.start('s1', spec2)
    await engine.run(s2, new AbortController())
    const list = await engine.list('s1')
    expect(list).toHaveLength(2)
    expect(list.map(s => s.name).sort()).toEqual(['one', 'two'])
    expect(list.every(s => s.status === 'completed')).toBe(true)
    expect(list.every(s => s.step_count === 1 && s.completed_count === 1)).toBe(true)
  })

  it('list returns empty for a session with no pipelines', async () => {
    const { engine } = setupEngine(cwd, canvas)
    const list = await engine.list('s1')
    expect(list).toEqual([])
  })

  it('status throws not-found for an unknown pipeline id', async () => {
    const { engine } = setupEngine(cwd, canvas)
    await expect(engine.status('s1', 'pipe_nonexistent')).rejects.toThrow(AigcError)
  })
})

// ── aigc_pipeline_* tools (end-to-end through registerTools) ────────────────

describe('aigc_pipeline_* tools (through registerTools)', () => {
  let cwd: string
  let canvas: AigcCanvasService
  let ctx: MockTools
  let dispose: () => void

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-pipeline-tools-'))
    canvas = createAigcCanvasService(() => cwd)
    const setup = setupEngine(cwd, canvas)
    ctx = setup.ctx
    dispose = setup.dispose
  })

  afterEach(async () => {
    dispose()
    await rm(cwd, { recursive: true, force: true })
  })

  it('aigc_pipeline_run with async=false blocks until completion', async () => {
    const tool = ctx.registered.get('aigc_pipeline_run')!
    const result = await tool.execute({
      spec: {
        name: 'sync-run', onError: 'abort',
        steps: [{ id: 'a', capability: 't2i', params: { prompt: 'p' } }],
      },
      async: false,
    }, execFor('s1')) as { pipeline_id: string; status: string; steps: Array<{ id: string; status: string; element_path?: string }> }
    expect(result.status).toBe('completed')
    expect(result.steps[0]!.status).toBe('completed')
    expect(result.steps[0]!.element_path).toBeDefined()
    expect(result.pipeline_id).toMatch(/^pipe_/)
  })

  it('aigc_pipeline_run with async=true returns immediately with status running', async () => {
    const tool = ctx.registered.get('aigc_pipeline_run')!
    const statusTool = ctx.registered.get('aigc_pipeline_status')!
    const result = await tool.execute({
      spec: {
        name: 'async-run', onError: 'abort',
        steps: [{ id: 'a', capability: 't2i', params: { prompt: 'p' } }],
      },
      async: true,
    }, execFor('s1')) as { pipeline_id: string; status: string }
    expect(result.status).toBe('running')
    expect(result.pipeline_id).toMatch(/^pipe_/)
    // Wait for the background run to settle before letting the test end
    // (otherwise the afterEach rm() races with in-flight file writes on Windows).
    for (let i = 0; i < 200; i++) {
      const status = await statusTool.execute({ pipeline_id: result.pipeline_id }, execFor('s1')) as { status: string }
      if (status.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })

  it('aigc_pipeline_run applies template params ({{name}} substitution)', async () => {
    const tool = ctx.registered.get('aigc_pipeline_run')!
    const result = await tool.execute({
      spec: {
        name: 'template-{{product}}', onError: 'abort',
        steps: [{ id: 'a', capability: 't2i', params: { prompt: 'photo of {{product}}' } }],
      },
      params: { product: 'iPhone 17' },
      async: false,
    }, execFor('s1')) as { name: string }
    expect(result.name).toBe('template-iPhone 17')
  })

  it('aigc_pipeline_status returns the current state', async () => {
    const runTool = ctx.registered.get('aigc_pipeline_run')!
    const statusTool = ctx.registered.get('aigc_pipeline_status')!
    const runResult = await runTool.execute({
      spec: { name: 's', onError: 'abort', steps: [{ id: 'a', capability: 't2i', params: { prompt: 'p' } }] },
      async: false,
    }, execFor('s1')) as { pipeline_id: string }
    const statusResult = await statusTool.execute({ pipeline_id: runResult.pipeline_id }, execFor('s1')) as { status: string; steps: Array<{ status: string }> }
    expect(statusResult.status).toBe('completed')
    expect(statusResult.steps[0]!.status).toBe('completed')
  })

  it('aigc_pipeline_list returns pipelines for the session', async () => {
    const runTool = ctx.registered.get('aigc_pipeline_run')!
    const listTool = ctx.registered.get('aigc_pipeline_list')!
    await runTool.execute({
      spec: { name: 'p1', onError: 'abort', steps: [{ id: 'a', capability: 't2i', params: { prompt: 'p' } }] },
      async: false,
    }, execFor('s1'))
    await runTool.execute({
      spec: { name: 'p2', onError: 'abort', steps: [{ id: 'b', capability: 'tts', params: { text: 't' } }] },
      async: false,
    }, execFor('s1'))
    const listResult = await listTool.execute({}, execFor('s1')) as { pipelines: Array<{ name: string; status: string }> }
    expect(listResult.pipelines).toHaveLength(2)
    expect(listResult.pipelines.map(p => p.name).sort()).toEqual(['p1', 'p2'])
    expect(listResult.pipelines.every(p => p.status === 'completed')).toBe(true)
  })

  it('aigc_pipeline_resume retries a failed pipeline with step_overrides', async () => {
    const runTool = ctx.registered.get('aigc_pipeline_run')!
    const resumeTool = ctx.registered.get('aigc_pipeline_resume')!
    // First run: step_2 fails because of a nonexistent provider.
    const runResult = await runTool.execute({
      spec: {
        name: 'resumable', onError: 'abort',
        steps: [
          { id: 'step_1', capability: 't2i', params: { prompt: 'p' } },
          { id: 'step_2', capability: 't2i', provider_id: 'nonexistent', inputs: [{ from: 'step_1' }], params: { prompt: 'q' } },
        ],
      },
      async: false,
    }, execFor('s1')) as { pipeline_id: string; status: string; steps: Array<{ id: string; status: string }> }
    expect(runResult.status).toBe('failed')
    expect(runResult.steps[1]!.status).toBe('failed')
    // Resume: swap step_2's provider_id to the stub.
    const resumeResult = await resumeTool.execute({
      pipeline_id: runResult.pipeline_id,
      step_overrides: { step_2: { provider_id: 'stub' } },
    }, execFor('s1')) as { status: string; steps: Array<{ id: string; status: string }> }
    expect(resumeResult.status).toBe('completed')
    expect(resumeResult.steps[0]!.status).toBe('completed') // skipped (already done)
    expect(resumeResult.steps[1]!.status).toBe('completed') // retried with stub
  })

  it('aigc_pipeline_cancel on a completed pipeline returns cancelled=false', async () => {
    const runTool = ctx.registered.get('aigc_pipeline_run')!
    const cancelTool = ctx.registered.get('aigc_pipeline_cancel')!
    const runResult = await runTool.execute({
      spec: { name: 'c', onError: 'abort', steps: [{ id: 'a', capability: 't2i', params: { prompt: 'p' } }] },
      async: false,
    }, execFor('s1')) as { pipeline_id: string }
    const cancelResult = await cancelTool.execute({ pipeline_id: runResult.pipeline_id }, execFor('s1')) as { cancelled: boolean; completed_steps: number }
    expect(cancelResult.cancelled).toBe(false)
    expect(cancelResult.completed_steps).toBe(1)
  })

  it('aigc_pipeline_run rejects an invalid spec (no capability/operation)', async () => {
    const tool = ctx.registered.get('aigc_pipeline_run')!
    await expect(tool.execute({
      spec: { name: 'bad', onError: 'abort', steps: [{ id: 'a', params: {} }] },
      async: false,
    }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_pipeline_run rejects a spec with a cycle', async () => {
    const tool = ctx.registered.get('aigc_pipeline_run')!
    await expect(tool.execute({
      spec: {
        name: 'cyclic', onError: 'abort',
        steps: [
          { id: 'a', capability: 't2i', inputs: [{ from: 'b' }], params: {} },
          { id: 'b', capability: 't2i', inputs: [{ from: 'a' }], params: {} },
        ],
      },
      async: false,
    }, execFor('s1'))).rejects.toThrow(/cycle/)
  })
})

// ── pipelineStateProjection ─────────────────────────────────────────────────

describe('pipelineStateProjection', () => {
  it('projects the state to the doc §3 wire shape (no internal fields)', () => {
    const state = {
      pipeline_id: 'pipe_test',
      session_id: 's1',
      name: 'test',
      status: 'completed' as const,
      started_at: 1000,
      finished_at: 2000,
      spec: { name: 'test', onError: 'abort' as const, steps: [] },
      steps: [
        { id: 'a', status: 'completed' as const, element_path: '/path/a.png', started_at: 1001, finished_at: 1100 },
        { id: 'b', status: 'failed' as const, error: 'oops', started_at: 1101, finished_at: 1200 },
        { id: 'c', status: 'pending' as const },
      ],
    }
    const projected = pipelineStateProjection(state)
    expect(projected).toEqual({
      pipeline_id: 'pipe_test',
      name: 'test',
      status: 'completed',
      steps: [
        { id: 'a', status: 'completed', element_path: '/path/a.png', started_at: 1001, finished_at: 1100 },
        { id: 'b', status: 'failed', error: 'oops', started_at: 1101, finished_at: 1200 },
        { id: 'c', status: 'pending' },
      ],
    })
    // session_id and spec are NOT exposed to the model.
    expect(projected).not.toHaveProperty('session_id')
    expect(projected).not.toHaveProperty('spec')
  })
})
