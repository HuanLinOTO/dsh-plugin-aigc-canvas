/**
 * Pipeline templates — declarative PipelineSpec skeletons with named
 * `{{param}}` placeholders, persisted to `~/.dsh/aigc-canvas/templates/<name>.json`
 * so they survive session teardown and can be re-instantiated by future
 * sessions (per docs/product/02-pipeline.md §7).
 *
 * A TemplateSpec is a PipelineSpec + a param declaration list. Instantiation
 * substitutes `{{param}}` placeholders in every string of the spec with the
 * caller-supplied values, then hands the resolved spec to PipelineEngine.start
 * (which re-applies the same substitution defensively — idempotent).
 *
 * Storage layout:
 *   templates/
 *   ├── <name>.json          # one TemplateSpec per file
 *   └── ...
 *
 * Built-in templates (always available, never written to disk):
 *   simple-t2i                — single t2i step (1 step)
 *   simple-t2v                — single t2v step (1 step)
 *   first-last-frame-video    — t2i × 2 → fl2v (3 steps)
 *   30s-product-ad            — t2i → i2v → tts → add_audio → clip (5 steps)
 *   multi-angle-product       — t2i × 3 → images_to_video (4 steps)
 *
 * The module is self-contained: every function loads/saves its template
 * file directly. Callers (tools) do not need to thread a store instance.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/pipeline-templates
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { AigcError } from './wire.js'
import type { PipelineSpec } from './pipeline.js'

// ── Public types ─────────────────────────────────────────────────────────────

/** Allowed value types for a template param (string / number / boolean). */
export type ParamType = 'string' | 'number' | 'boolean'

/**
 * One declared template parameter (doc §4 ParamSpec).
 * The agent fills these in at instantiation time; the value is substituted
 * into every `{{name}}` placeholder in the spec.
 */
export interface ParamSpec {
  name: string
  type: ParamType
  required: boolean
  /** Default value used when the caller omits the param. */
  default?: string | number | boolean
  description?: string
}

/** A full template definition (doc §7 storage format). */
export interface TemplateSpec {
  name: string
  description: string
  params: ParamSpec[]
  spec: PipelineSpec
}

/** Compact projection used by aigc_template_list (no spec body). */
export interface TemplateSummary {
  name: string
  description: string
  /** "built-in" for the 5 hard-coded templates, "user" for disk-saved ones. */
  source: 'built-in' | 'user'
  param_count: number
  step_count: number
  /** Declared param names (with a `*` suffix on required ones) for quick scanning. */
  params: Array<{ name: string; type: ParamType; required: boolean }>
}

// ── Storage root (overridable by tests, mirroring asset-library.ts) ──────────

/** Default root directory for templates (under the DSH user dir, doc §7). */
const DEFAULT_TEMPLATES_DIR = join(homedir(), '.dsh', 'aigc-canvas', 'templates')

/** Mutable templates root (overridable by tests via {@link setTemplatesDir}). */
let templatesDir = DEFAULT_TEMPLATES_DIR

/**
 * Override the templates root directory. Tests use this to point at a temp
 * dir so they don't pollute the real `~/.dsh/aigc-canvas/templates/`.
 * Production code never calls this.
 */
export function setTemplatesDir(dir: string): void {
  templatesDir = dir
}

/** Reset the templates root to the default (used by tests in afterEach). */
export function resetTemplatesDir(): void {
  templatesDir = DEFAULT_TEMPLATES_DIR
}

/** Resolve a path inside the templates root. */
function tplPath(...segments: string[]): string {
  return join(templatesDir, ...segments)
}

/** Validate a template name (filename-safe, no path traversal). */
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function validateTemplateName(name: string): void {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new AigcError(
      'bad-request',
      `invalid template name "${name}"; must be lowercase-hyphenated, start with a letter (e.g. "my-template-1")`,
    )
  }
}

/** Atomic write: mkdir + temp file + rename (mirrors asset-library.ts). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  } catch {
    // Best-effort: leave the temp file behind if rename fails.
  }
}

// ── Built-in templates (doc §7 table) ────────────────────────────────────────

/**
 * The 5 built-in templates shipped with the plugin (doc §7).
 * These live in source, not on disk — `listTemplates` and `getTemplate`
 * merge them with any user-saved templates. A user can shadow a built-in
 * by saving a template with the same name (the disk copy wins).
 */
export const BUILTIN_TEMPLATES: readonly TemplateSpec[] = [
  {
    name: 'simple-t2i',
    description: '单步文生图（教学用）：输入 prompt 生成一张图。',
    params: [
      { name: 'prompt', type: 'string', required: true, description: '图像描述' },
      { name: 'size', type: 'string', required: false, default: '1024x1024', description: '图像尺寸' },
    ],
    spec: {
      name: 'simple-t2i ({{prompt}})',
      onError: 'abort',
      steps: [
        {
          id: 'image',
          capability: 't2i',
          params: { prompt: '{{prompt}}', size: '{{size}}' },
        },
      ],
    },
  },
  {
    name: 'simple-t2v',
    description: '单步文生视频：输入 prompt 生成一段视频。',
    params: [
      { name: 'prompt', type: 'string', required: true, description: '视频描述' },
      { name: 'duration', type: 'number', required: false, default: 5, description: '视频时长（秒）' },
    ],
    spec: {
      name: 'simple-t2v ({{prompt}})',
      onError: 'abort',
      steps: [
        {
          id: 'video',
          capability: 't2v',
          params: { prompt: '{{prompt}}', duration: '{{duration}}' },
        },
      ],
    },
  },
  {
    name: 'first-last-frame-video',
    description: '首尾帧生视频：先生成首帧和尾帧两张图，再用 fl2v 合成过渡视频。',
    params: [
      { name: 'first_frame_prompt', type: 'string', required: true, description: '首帧描述' },
      { name: 'last_frame_prompt', type: 'string', required: true, description: '尾帧描述' },
      { name: 'transition_prompt', type: 'string', required: false, default: 'smooth transition', description: '过渡描述' },
    ],
    spec: {
      name: 'first-last-frame-video',
      onError: 'abort',
      steps: [
        {
          id: 'first_frame',
          capability: 't2i',
          params: { prompt: '{{first_frame_prompt}}, studio lighting', size: '1024x1024' },
        },
        {
          id: 'last_frame',
          capability: 't2i',
          params: { prompt: '{{last_frame_prompt}}, studio lighting', size: '1024x1024' },
        },
        {
          id: 'video',
          capability: 'fl2v',
          inputs: [
            { from: 'first_frame', relation: 'first_frame' },
            { from: 'last_frame', relation: 'last_frame' },
          ],
          params: { prompt: '{{transition_prompt}}' },
        },
      ],
    },
  },
  {
    name: '30s-product-ad',
    description: '30 秒产品广告片完整流程：产品图 → 动起来 → 配音 → 合成 → 剪辑。',
    params: [
      { name: 'product_name', type: 'string', required: true, description: '产品名' },
      { name: 'tagline', type: 'string', required: true, description: '旁白文案' },
      { name: 'voice', type: 'string', required: false, default: 'male_en', description: '配音音色' },
    ],
    spec: {
      name: '30s product ad for {{product_name}}',
      onError: 'abort',
      steps: [
        {
          id: 'product_img',
          capability: 't2i',
          params: { prompt: 'product photo of {{product_name}}, studio lighting', size: '1024x1024' },
        },
        {
          id: 'animated',
          capability: 'i2v',
          inputs: [{ from: 'product_img', relation: 'first_frame' }],
          params: { prompt: 'smooth camera pan around the product', duration: 5 },
        },
        {
          id: 'narration',
          capability: 'tts',
          params: { text: '{{tagline}}', voice: '{{voice}}' },
        },
        {
          id: 'with_audio',
          operation: 'add_audio',
          inputs: [
            { from: 'animated' },
            { from: 'narration', relation: 'audio_track' },
          ],
          params: {},
        },
        {
          id: 'final_30s',
          operation: 'clip',
          inputs: [{ from: 'with_audio' }],
          params: { start: 0, end: 30 },
        },
      ],
    },
  },
  {
    name: 'multi-angle-product',
    description: '多角度产品图：生成 3 张不同角度的产品图，再用 images_to_video 拼成展示视频。',
    params: [
      { name: 'product', type: 'string', required: true, description: '产品名' },
      { name: 'fps', type: 'number', required: false, default: 2, description: '展示视频帧率' },
    ],
    spec: {
      name: 'multi-angle-product ({{product}})',
      onError: 'abort',
      steps: [
        {
          id: 'front',
          capability: 't2i',
          params: { prompt: 'front view of {{product}}, studio lighting', size: '1024x1024' },
        },
        {
          id: 'side',
          capability: 't2i',
          params: { prompt: 'side view of {{product}}, studio lighting', size: '1024x1024' },
        },
        {
          id: 'back',
          capability: 't2i',
          params: { prompt: 'back view of {{product}}, studio lighting', size: '1024x1024' },
        },
        {
          id: 'showcase',
          operation: 'images_to_video',
          inputs: [
            { from: 'front' },
            { from: 'side' },
            { from: 'back' },
          ],
          params: { fps: '{{fps}}' },
        },
      ],
    },
  },
]

/** Look up a built-in template by name. */
function builtinByName(name: string): TemplateSpec | undefined {
  return BUILTIN_TEMPLATES.find(t => t.name === name)
}

// ── Param substitution ───────────────────────────────────────────────────────

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

/**
 * Validate the caller-supplied params against a template's ParamSpec list
 * and produce a `Record<string, string>` ready for substitution. Required
 * params without a value AND without a default throw. Missing optional
 * params with a default are filled in. Coerces numbers/booleans to strings
 * (the substitution function only handles string values — the resolved
 * PipelineSpec's params object can then be re-typed by the engine).
 */
export function resolveTemplateParams(
  template: TemplateSpec,
  callerParams: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  for (const decl of template.params) {
    seen.add(decl.name)
    const raw = callerParams?.[decl.name]
    if (raw === undefined) {
      if (decl.default !== undefined) {
        out[decl.name] = String(decl.default)
        continue
      }
      if (decl.required) {
        throw new AigcError(
          'bad-request',
          `missing required template param "${decl.name}" (template "${template.name}")`,
        )
      }
      // Optional, no default: leave unset (placeholders stay in spec).
      continue
    }
    // Light type coercion: numbers/booleans/strings all stringify.
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[decl.name] = String(raw)
      continue
    }
    throw new AigcError(
      'bad-request',
      `template param "${decl.name}" must be a ${decl.type} (got ${typeof raw})`,
    )
  }
  // Reject unknown params (catches typos that would silently leave placeholders un-substituted).
  for (const key of Object.keys(callerParams ?? {})) {
    if (!seen.has(key)) {
      throw new AigcError(
        'bad-request',
        `unknown template param "${key}" (template "${template.name}" declares: ${[...seen].join(', ') || '(none)'})`,
      )
    }
  }
  return out
}

/**
 * Substitute the resolved param values into a template's spec, returning a
 * fresh PipelineSpec with all `{{param}}` placeholders replaced (or left
 * in place when the param was optional + no value + no default).
 */
export function instantiateTemplateSpec(
  template: TemplateSpec,
  params: Record<string, unknown> | undefined,
): PipelineSpec {
  const resolved = resolveTemplateParams(template, params)
  return applyTemplateToValue(template.spec, resolved)
}

// ── Storage functions ────────────────────────────────────────────────────────

/** Read one user-saved template from disk. Returns undefined when absent. */
async function loadUserTemplate(name: string): Promise<TemplateSpec | undefined> {
  validateTemplateName(name)
  let raw: string
  try {
    raw = await readFile(tplPath(`${name}.json`), 'utf8')
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return undefined
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AigcError('backend-error', `template file "${name}.json" is malformed JSON`)
  }
  assertTemplateShape(parsed, name)
  return parsed as TemplateSpec
}

/** Type-guard the persisted JSON shape. Throws AigcError on malformed files. */
function assertTemplateShape(v: unknown, name: string): void {
  if (typeof v !== 'object' || v === null) {
    throw new AigcError('backend-error', `template "${name}": expected an object`)
  }
  const o = v as Record<string, unknown>
  if (typeof o.name !== 'string' || o.name === '') {
    throw new AigcError('backend-error', `template "${name}": missing or invalid "name"`)
  }
  if (typeof o.description !== 'string') {
    throw new AigcError('backend-error', `template "${name}": missing or invalid "description"`)
  }
  if (!Array.isArray(o.params)) {
    throw new AigcError('backend-error', `template "${name}": "params" must be an array`)
  }
  if (typeof o.spec !== 'object' || o.spec === null || Array.isArray(o.spec)) {
    throw new AigcError('backend-error', `template "${name}": "spec" must be a PipelineSpec object`)
  }
}

/**
 * List all available templates: built-in + user-saved on disk.
 * A user-saved template shadows a built-in of the same name (the disk
 * copy wins). Returns alphabetically sorted by name.
 */
export async function listTemplates(): Promise<TemplateSummary[]> {
  const byName = new Map<string, { spec: TemplateSpec; source: 'built-in' | 'user' }>()
  for (const t of BUILTIN_TEMPLATES) {
    byName.set(t.name, { spec: t, source: 'built-in' })
  }
  // Scan the templates dir for user-saved templates.
  let files: string[] = []
  try {
    files = await readdir(tplPath())
  } catch (err) {
    if (!(err !== null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT')) {
      throw err
    }
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const name = file.slice(0, -'.json'.length)
    if (!NAME_PATTERN.test(name)) continue
    try {
      const raw = await readFile(tplPath(file), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      assertTemplateShape(parsed, name)
      byName.set(name, { spec: parsed as TemplateSpec, source: 'user' })
    } catch {
      // Skip malformed files (mirrors the pipeline engine's list() approach).
    }
  }
  const summaries: TemplateSummary[] = []
  for (const [name, { spec, source }] of byName) {
    summaries.push({
      name,
      description: spec.description,
      source,
      param_count: spec.params.length,
      step_count: spec.spec.steps.length,
      params: spec.params.map(p => ({ name: p.name, type: p.type, required: p.required })),
    })
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name))
  return summaries
}

/**
 * Get one template's full spec + param declarations (built-in or user-saved).
 * Throws not-found when the name doesn't match any template.
 */
export async function getTemplate(name: string): Promise<TemplateSpec & { source: 'built-in' | 'user' }> {
  validateTemplateName(name)
  // User-saved wins over built-in (allows shadowing).
  const user = await loadUserTemplate(name)
  if (user !== undefined) return { ...user, source: 'user' }
  const builtin = builtinByName(name)
  if (builtin !== undefined) return { ...builtin, source: 'built-in' }
  throw new AigcError('not-found', `template "${name}" not found (call aigc_template_list to see available templates)`, 404)
}

/**
 * Persist a template to disk as `<name>.json` under the templates root.
 * Overwrites an existing template with the same name. Built-in names are
 * allowed (the user file shadows the built-in at read time).
 */
export async function saveTemplate(template: TemplateSpec): Promise<{ name: string; source: 'user'; file_path: string }> {
  validateTemplateName(template.name)
  // Reuse the shape guard so saved files always match what loadUserTemplate expects.
  assertTemplateShape(template, template.name)
  const filePath = tplPath(`${template.name}.json`)
  await writeJsonAtomic(filePath, template)
  return { name: template.name, source: 'user', file_path: filePath }
}

/**
 * Remove a user-saved template from disk. Returns false when the template
 * doesn't exist on disk (idempotent on the index side). Refuses to delete
 * a built-in-only name (returns false, since there's nothing to delete).
 */
export async function removeTemplate(name: string): Promise<boolean> {
  validateTemplateName(name)
  const { rm } = await import('node:fs/promises')
  try {
    await rm(tplPath(`${name}.json`))
    return true
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return false
    }
    throw err
  }
}
