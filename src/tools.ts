/**
 * The ten model-facing AIGC canvas tools.
 *
 * Generation is provider-agnostic:
 *   aigc_get_provider_info             — list configured providers (id, name,
 *                                        endpoint, instructions PREVIEW, stub flag).
 *                                        Call this FIRST. The provider apiKey is
 *                                        NEVER shown; it is attached automatically
 *                                        by aigc_http_request.
 *   aigc_http_request                  — send an HTTP request to a provider's API
 *                                        (endpoint + apiKey auto-attached). Binary
 *                                        responses (image/video/audio) are saved
 *                                        to disk and returned as a filePath;
 *                                        JSON/text responses are returned inline
 *                                        (saved to a file when too large).
 *   aigc_provider_set_instructions     — record the provider's 调用说明 (how to
 *                                        call the API: endpoints, params, auth)
 *                                        so future sessions can use the provider.
 *   aigc_provider_get_instructions     — fetch the FULL instructions for one
 *                                        provider (aigc_get_provider_info only
 *                                        shows a short preview).
 *   aigc_reroll                        — re-generate an element based on its
 *                                        meta.originalRequest, applying an optional
 *                                        patch (seed/prompt_delta/prompt_replace/
 *                                        size/...). Auto-wires variation_of or
 *                                        remix_of edge from the source.
 *   aigc_canvas_place                  — place a file (typically the filePath
 *                                        aigc_http_request returned) onto the free
 *                                        canvas at position (x, y); optionally
 *                                        records the prompt/params (shown on
 *                                        double-click) and auto-wires edges from
 *                                        reference elements.
 *   aigc_canvas_link / unlink          — create / remove an edge between two
 *                                        elements (filePath-addressed).
 *   aigc_canvas_list_elements          — snapshot of the session's canvas.
 *   aigc_media_edit                    — ffmpeg-based media editing (concat,
 *                                        clip, extract_audio, etc.).
 *
 * Element identity:
 *   Every element (prompt / image / video / audio) is identified by its
 *   `filePath` on disk — tools return filePath (not uuid), and tools
 *   accept filePath when referencing existing elements. The filePath is
 *   an absolute path under `<cwd>/.dsh-aigc-canvas/<sessionId>/`.
 */
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-tools'
import type { Context } from './context-types.js'
import type { ResolvedAigcProvider } from './config.js'
import type { AigcElement, AigcCanvasService, EdgeRelation, ElementStatus } from './canvas-registry.js'
import { canvasDirFor, EDGE_RELATIONS, DEFAULT_EDGE_RELATION, coerceEdgeRelation, ELEMENT_STATUSES, DEFAULT_ELEMENT_STATUS, coerceElementStatus } from './canvas-registry.js'
import { executeProviderRequest, INLINE_TEXT_CAP, type ProviderBinaryKind } from './provider-http.js'
import { executeMediaEdit, MEDIA_EDIT_OPERATIONS, type MediaEditOperation } from './media-edit.js'
import { AigcError } from './wire.js'
import {
  recordRequestSnapshot,
  consumeRequestSnapshot,
  type RequestSnapshot,
} from './request-snapshot.js'
import { logHttpRequest, logMediaEdit, clearLogEntries as clearSessionLog } from './request-log.js'
import type { Capability, EndpointSpec, ResponseKind } from './endpoint-catalog.js'
import {
  CAPABILITIES,
  RESPONSE_KINDS,
  capabilitiesOf,
  endpointsByCapability,
  findEndpointSpec,
  extractByPath,
  detectResponseShape,
  deriveInstructionsFromEndpoints,
} from './endpoint-catalog.js'

/** Maximum length of a prompt title (derived from the prompt text). */
const TITLE_MAX = 80

/** Truncate a prompt to a short title (first line, capped). */
function titleOf(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? ''
  if (firstLine.length <= TITLE_MAX) return firstLine
  return `${firstLine.slice(0, TITLE_MAX - 1)}…`
}

/** Pure text projection helper. */
function textRender<T>(fn: (value: T) => string): (_args: unknown, value: unknown) => ContentBlock[] {
  return (_args, value) => [{ type: 'text', text: fn(value as T) }]
}

/** Extract the calling agent or throw the canonical "no agent" error. */
function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) {
    throw new Error('aigc canvas tools require an initiating agent')
  }
  return agent
}

/** Resolve the calling agent's session id. */
function sessionIdOf(exec: ToolRunContext): string {
  return requireAgent(exec.agent).session.id
}

/**
 * The model-facing shape of one element (no internal uuid, no media bytes).
 * The `filePath` is the primary identifier the agent uses to reference
 * the element in subsequent tool calls; `x`/`y` are the canvas position.
 */
function elementProjection(el: AigcElement): Record<string, unknown> {
  return {
    filePath: el.filePath,
    kind: el.kind,
    title: el.title,
    x: el.x,
    y: el.y,
    createdAt: el.createdAt,
    producedBy: el.producedBy,
    status: el.status,
    ...(el.winner !== undefined ? { winner: el.winner } : {}),
    ...(el.promptText !== undefined ? { promptText: el.promptText } : {}),
    ...(el.mediaSize !== undefined ? { mediaSize: el.mediaSize } : {}),
    ...(el.meta !== undefined ? { meta: el.meta } : {}),
  }
}

/** Edge projection: resolve uuids to filePaths so the agent can read the graph. */
function edgeProjection(edge: { source: string; target: string; relation?: EdgeRelation; note?: string }, lookup: (uuid: string) => AigcElement): { source: string; target: string; relation: EdgeRelation; note?: string } {
  return {
    source: lookup(edge.source)?.filePath ?? edge.source,
    target: lookup(edge.target)?.filePath ?? edge.target,
    relation: coerceEdgeRelation(edge.relation),
    ...(edge.note !== undefined ? { note: edge.note } : {}),
  }
}

/** The `provider_id` parameter spec (shared by provider-scoped tools). */
const providerIdParam = {
  type: 'string' as const,
  description: 'The provider id to use (call aigc_get_provider_info to list available providers). If omitted, the default (first) provider is used.',
}

/** Info about one provider (for the aigc_get_provider_info tool output). */
export interface ProviderInfo {
  id: string
  name: string
  endpoint: string
  instructions: string
  isStub: boolean
  isDefault: boolean
  /** Structured capability catalog (empty when the provider uses legacy instructions only). */
  endpoints: EndpointSpec[]
  /** Selection priority (smaller = higher). */
  priority: number
  /** Cost per call in USD (0 when unknown). */
  costPerCall: number
  /** Average latency in ms (0 when unknown). */
  avgLatencyMs: number
  /** Quality hint. */
  qualityHint: 'fast' | 'balanced' | 'quality'
}

/**
 * Cap on how many characters of a provider's `instructions` are inlined
 * into `aigc_get_provider_info` output. The full text is fetched on
 * demand via `aigc_provider_get_instructions`. Picked to keep the
 * provider list compact when there are many providers, while still
 * giving the model enough to recognize an already-initialized provider.
 */
const INSTRUCTIONS_PREVIEW_CHARS = 200

/**
 * Maximum byte length of one provider's `instructions` string. Picked
 * to fit a structured catalog for a multi-endpoint provider (t2i/t2v/
 * tts/edit) without being so large that one verbose provider starves
 * the rest of the context window.
 */
const INSTRUCTIONS_MAX_CHARS = 1000

/** Build the `instructions` preview string + total char count for one provider. */
function instructionsPreviewOf(instructions: string): { preview: string; totalChars: number } {
  const totalChars = instructions.length
  if (totalChars <= INSTRUCTIONS_PREVIEW_CHARS) {
    return { preview: instructions, totalChars }
  }
  return {
    preview: `${instructions.slice(0, INSTRUCTIONS_PREVIEW_CHARS)}… (${totalChars} chars total — call aigc_provider_get_instructions to read the full text)`,
    totalChars,
  }
}

/** File extension for one binary kind produced by the http tool. */
function extensionForBinaryKind(kind: ProviderBinaryKind, contentType: string): string {
  const subtype = contentType.split(';')[0]?.trim().split('/')[1]?.toLowerCase() ?? ''
  switch (kind) {
    case 'image': return ['png', 'jpeg', 'jpg', 'webp', 'gif'].includes(subtype) ? subtype : 'png'
    case 'video': return ['mp4', 'webm', 'mov', 'ogg', 'm4v'].includes(subtype) ? subtype : 'mp4'
    case 'audio': return ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'].includes(subtype) ? subtype : 'mp3'
    case 'other': return 'bin'
  }
}

/**
 * Detect the OpenAI image-generation JSON response format and extract the
 * base64-encoded image bytes from it:
 *
 *   { "created": 1234, "data": [{ "b64_json": "<base64>" }] }
 *
 * Returns null when the text is not this shape, so the caller can fall
 * through to normal inline-text handling. Sniffs the decoded magic bytes
 * to pick the right file extension (png / jpeg / webp / gif).
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
  // Sniff magic bytes for extension/content-type.
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
  // Unknown image format — default to png.
  return { bytes, ext: 'png', contentType: 'image/png' }
}

/** Resolve the canvas kind for a placed file from its extension (or explicit). */
function kindForFile(filePath: string, kind?: string): AigcElement['kind'] {
  if (kind !== undefined) {
    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'prompt') return kind
    throw new AigcError('bad-request', `invalid kind "${kind}"; expected image, video, audio, or prompt`)
  }
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'].includes(ext)) return 'audio'
  if (ext === 'txt') return 'prompt'
  throw new AigcError('bad-request', `cannot infer the element kind from "${filePath}"; pass the explicit kind parameter`)
}

/**
 * Coerce the model-supplied `meta` argument into a plain object. The schema
 * declares `type: 'json'` so the model may pass a stringified JSON blob by
 * mistake; we parse it defensively. Non-object values (numbers, arrays,
 * null) are dropped — meta is documented as a JSON object.
 */
function coerceMeta(meta: unknown): Record<string, unknown> | undefined {
  if (meta === undefined || meta === null) return undefined
  if (typeof meta === 'string') {
    if (meta.length === 0) return undefined
    try {
      const parsed: unknown = JSON.parse(meta)
      return isPlainObject(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return isPlainObject(meta) ? meta : undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Walk a JSON body and replace `{"$base64": "<path>"}` placeholders with
 * the base64-encoded file content, and `{"$data_uri": "<path>"}` with a
 * full data URI string (`data:<mime>;base64,...`). The path must be inside
 * the session canvas directory (security boundary).
 *
 * This lets the model reference canvas elements by file_path when an API
 * expects base64 image data in the request body — without the model having
 * to read or encode the file itself.
 */
async function expandBase64Placeholders(
  value: unknown,
  sessionId: string,
  cwd: string,
): Promise<unknown> {
  if (isPlainObject(value)) {
    // Check for $base64 placeholder.
    const b64Path = value.$base64
    if (typeof b64Path === 'string') {
      return await readAsBase64(b64Path, cwd, false)
    }
    // Check for $data_uri placeholder.
    const dataUriPath = value.$data_uri
    if (typeof dataUriPath === 'string') {
      return await readAsBase64(dataUriPath, cwd, true)
    }
    // Recurse into all values.
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = await expandBase64Placeholders(val, sessionId, cwd)
    }
    return result
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(item => expandBase64Placeholders(item, sessionId, cwd)))
  }
  return value
}

/** Read a file, validate it's in the canvas dir, return base64 (or data URI). */
async function readAsBase64(filePath: string, cwd: string, asDataUri: boolean): Promise<string> {
  const dir = canvasDirFor(cwd, '')
  // Normalize to absolute, then validate containment in the canvas dir.
  const resolved = isAbsolute(filePath) ? filePath : join(cwd, filePath)
  // The canvas dir structure is <cwd>/.dsh-aigc-canvas/<sessionId>/...,
  // so we check the file is under <cwd>/.dsh-aigc-canvas/.
  const canvasRoot = canvasDirFor(cwd, '')
  const normalizedRoot = canvasRoot.endsWith(sep) ? canvasRoot : `${canvasRoot}${sep}`
  const a = resolved.toLowerCase()
  const b = normalizedRoot.toLowerCase()
  if (!a.startsWith(b)) {
    throw new AigcError('bad-request', `$base64 file must be inside the session canvas directory: ${filePath}`)
  }
  const info = await stat(resolved).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    throw new AigcError('bad-request', `$base64 file not found or not a regular file: ${filePath}`)
  }
  const bytes = await readFile(resolved)
  const b64 = bytes.toString('base64')
  if (!asDataUri) return b64
  const mime = mimeFromExt(filePath)
  return `data:${mime};base64,${b64}`
}

/** Infer a MIME type from a file extension (for data URIs). */
function mimeFromExt(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'wav') return 'audio/wav'
  return 'application/octet-stream'
}

/**
 * Register the seven tools against the host tool registry.
 *
 * @param ctx - host plugin context (carries the tools service).
 * @param getProvider - live provider getter (takes optional provider id).
 * @param setInstructions - persists usage instructions for one provider (the host's ProviderStore).
 * @param listProviders - returns info for all providers (for aigc_get_provider_info).
 * @param canvas - the canvas registry service (host-owned state).
 * @param resolveCwd - live cwd resolver for one session id.
 * @param getTimeoutMs - live per-request timeout for aigc_http_request.
 * @param getMediaLimit - live cap on bytes the http tool may write to disk.
 * @returns a disposer that unregisters all tools.
 */
/**
 * Register the tools against the host tool registry.
 *
 * @param ctx - host plugin context (carries the tools service).
 * @param getProvider - live provider getter (takes optional provider id).
 * @param setInstructions - persists usage instructions for one provider (the host's ProviderStore).
 * @param setEndpoints - persists the structured endpoint catalog for one provider (auto-derives instructions).
 * @param listProviders - returns info for all providers (for aigc_get_provider_info).
 * @param canvas - the canvas registry service (host-owned state).
 * @param resolveCwd - live cwd resolver for one session id.
 * @param getTimeoutMs - live per-request timeout for aigc_http_request.
 * @param getMediaLimit - live cap on bytes the http tool may write to disk.
 * @returns a disposer that unregisters all tools.
 */
export function registerTools(
  ctx: Context,
  getProvider: (providerId?: string) => ResolvedAigcProvider,
  setInstructions: (id: string, instructions: string) => { ok: boolean; error?: string },
  setEndpoints: (id: string, endpoints: readonly EndpointSpec[]) => { ok: boolean; error?: string },
  listProviders: () => readonly ProviderInfo[],
  canvas: AigcCanvasService,
  resolveCwd: (sessionId: string) => string,
  getTimeoutMs: () => number,
  getMediaLimit: () => number = () => 100 * 1024 * 1024,
): () => void {
  // Wire the media-limit getter so module-level helpers (saveRerollResponse)
  // can read the live value without it being threaded through every call.
  _getMediaLimit = getMediaLimit
  const disposers: Array<() => void> = []
  const register = (tool: ReturnType<typeof defineTool>): void => {
    disposers.push(ctx.tools.register(tool))
  }

  // ══ aigc_get_provider_info ══════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_get_provider_info',
    description:
      'List all configured AIGC providers with their id, name, endpoint, an instructions PREVIEW, stub status, '
      + 'AND a structured capability summary (capabilities array + priority + qualityHint + costPerCall). '
      + 'Also returns a top-level `capabilityMap` grouping providers by capability (sorted by priority) so you can '
      + 'pick the best provider for a given task without parsing natural language. '
      + 'Call this FIRST before generating anything. '
      + 'To use a provider: call aigc_http_request with its id as provider_id — the endpoint and apiKey are attached '
      + 'automatically, so you never need to see or forward the apiKey. '
      + 'When a provider\'s instructions are empty AND its endpoints are empty, probe its API yourself '
      + '(aigc_http_request) and then record the catalog via aigc_provider_set_endpoints (preferred) or the legacy '
      + 'aigc_provider_set_instructions. '
      + 'The `instructions` field shown here is a PREVIEW (first '
      + `${INSTRUCTIONS_PREVIEW_CHARS} chars + total count) — when you need the full instructions `
      + '(e.g. to recall exact endpoint paths / params for an already-initialized provider), call '
      + 'aigc_provider_get_instructions with the provider_id. '
      + 'For the full structured EndpointSpec[] of one provider+capability, call aigc_get_endpoint_details. '
      + 'When the endpoint is "stub://aigc-backend", aigc_http_request returns synthetic media (no real API calls) — '
      + 'useful for dry runs. '
      + 'Generated files are placed on the canvas with aigc_canvas_place (filePath + position), and elements can be '
      + 'linked with aigc_canvas_link.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          providers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'The provider id (pass this as provider_id to aigc_http_request).' },
                name: { type: 'string', required: true, description: 'The provider display name.' },
                endpoint: { type: 'string', required: true, description: 'The provider API endpoint URL. "stub://aigc-backend" = the built-in stub.' },
                instructions: { type: 'string', required: true, description: `Preview of the usage instructions (first ${INSTRUCTIONS_PREVIEW_CHARS} chars + total count). Call aigc_provider_get_instructions for the full text.` },
                instructions_total_chars: { type: 'integer', required: true, description: 'Total character count of the full instructions (0 when uninitialized).' },
                isStub: { type: 'boolean', required: true, description: 'Whether the stub backend is active (no real API calls).' },
                isDefault: { type: 'boolean', required: true, description: 'Whether this is the default provider (used when provider_id is omitted).' },
                capabilities: {
                  type: 'array',
                  required: true,
                  items: { type: 'string', enum: CAPABILITIES as readonly string[] },
                  description: 'Distinct capabilities this provider supports (derived from its endpoints catalog). Empty when the provider uses legacy instructions only.',
                },
                endpoint_count: { type: 'integer', required: true, description: 'Number of structured EndpointSpec entries (0 when using legacy instructions).' },
                priority: { type: 'integer', required: true, description: 'Selection priority (smaller = higher; default 100).' },
                qualityHint: { type: 'string', required: true, enum: ['fast', 'balanced', 'quality'], description: 'Quality hint for picking fast vs. quality providers.' },
                costPerCall: { type: 'number', required: true, description: 'Cost per call in USD (0 when unknown).' },
              },
            },
          },
          capabilityMap: {
            type: 'json',
            required: true,
            description: 'Providers grouped by capability, sorted by priority (smallest first). Use this to pick the '
              + 'best provider for a task: capabilityMap.t2i[0] is the highest-priority t2i provider. '
              + 'Filter by qualityHint when the user asks for "high quality" or "fast". '
              + 'Shape: { [capability: string]: Array<{ providerId, priority, qualityHint, costPerCall }> }.',
          },
        },
      },
      render: (_args, value) => {
        const v = value as {
          providers: Array<{ id: string; name: string; endpoint: string; instructions: string; instructions_total_chars: number; isStub: boolean; isDefault: boolean; capabilities: string[]; priority: number; qualityHint: string }>
          capabilityMap: Record<string, Array<{ providerId: string; priority: number; qualityHint: string }>>
        }
        if (v.providers.length === 0) {
          return [{ type: 'text', text: 'No AIGC providers configured. Add one in the settings page.' }]
        }
        const lines = v.providers.map(p => {
          const caps = p.capabilities.length > 0 ? ` caps:[${p.capabilities.join(',')}]` : ''
          const pri = ` pri:${p.priority}`
          const q = ` ${p.qualityHint}`
          return `  ${p.isDefault ? '* ' : '  '}${p.id}  "${p.name || '(unnamed)'}"  endpoint: ${p.endpoint}  stub: ${p.isStub}${caps}${pri}${q}`
            + (p.instructions !== '' ? `\n    instructions (${p.instructions_total_chars} chars): ${p.instructions}` : '\n    instructions: (empty — probe the API with aigc_http_request, then record them via aigc_provider_set_endpoints)')
        })
        const capMapLines = Object.entries(v.capabilityMap).map(([cap, list]) =>
          `  ${cap}: ${list.map(p => `${p.providerId}(pri:${p.priority},${p.qualityHint})`).join(' | ') || '(no providers)'}`,
        )
        return [{
          type: 'text',
          text: `AIGC providers (${v.providers.length}):\n${lines.join('\n')}\n\nCapability map:\n${capMapLines.join('\n')}\n\nCall aigc_http_request with the desired provider's id; endpoint + apiKey are attached automatically. For full instructions or endpoint details, call aigc_provider_get_instructions / aigc_get_endpoint_details.`,
        }]
      },
    },
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted()
      const list = listProviders()
      const providersProjected = list.map(p => {
        const { preview, totalChars } = instructionsPreviewOf(p.instructions)
        const caps = capabilitiesOf(p.endpoints)
        return {
          id: p.id,
          name: p.name,
          endpoint: p.endpoint,
          instructions: preview,
          instructions_total_chars: totalChars,
          isStub: p.isStub,
          isDefault: p.isDefault,
          capabilities: caps,
          endpoint_count: p.endpoints.length,
          priority: p.priority,
          qualityHint: p.qualityHint,
          costPerCall: p.costPerCall,
        }
      })
      // Build the capabilityMap: group providers by capability, sorted by priority.
      const capMap: Record<string, Array<{ providerId: string; priority: number; qualityHint: string; costPerCall: number }>> = {}
      for (const p of list) {
        for (const cap of capabilitiesOf(p.endpoints)) {
          if (capMap[cap] === undefined) capMap[cap] = []
          capMap[cap].push({
            providerId: p.id,
            priority: p.priority,
            qualityHint: p.qualityHint,
            costPerCall: p.costPerCall,
          })
        }
      }
      // Sort each capability's providers by priority (smallest first).
      for (const arr of Object.values(capMap)) {
        arr.sort((a, b) => a.priority - b.priority)
      }
      return Promise.resolve({ providers: providersProjected, capabilityMap: capMap })
    },
  }))

  // ══ aigc_get_endpoint_details ═══════════════════════════════════════════
  register(defineTool({
    name: 'aigc_get_endpoint_details',
    description:
      'Fetch the full structured EndpointSpec[] for one (provider_id, capability) pair. '
      + 'aigc_get_provider_info only returns a capability list (which providers support t2i/t2v/...); this tool '
      + 'returns the detailed endpoint paths, parameter schemas, and response shape declarations you need to '
      + 'construct a correct aigc_http_request call (path, method, params, response handling). '
      + 'Returns an empty array when the provider has no structured catalog for that capability (legacy '
      + 'instructions-only mode) — in that case, call aigc_provider_get_instructions for the free-form text.',
    parameters: {
      provider_id: { type: 'string', required: true, description: 'The provider id (from aigc_get_provider_info).' },
      capability: {
        type: 'string',
        required: true,
        enum: CAPABILITIES as readonly string[],
        description: 'The capability to fetch endpoint details for (t2i / t2v / tts / ...).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider_id: { type: 'string', required: true },
          capability: { type: 'string', required: true, enum: CAPABILITIES as readonly string[] },
          endpoints: {
            type: 'array',
            required: true,
            description: 'EndpointSpec entries for this provider+capability. Empty when the provider uses legacy instructions only.',
            items: { type: 'json' },
          },
        },
      },
      render: textRender((v: { provider_id: string; capability: string; endpoints: EndpointSpec[] }) =>
        v.endpoints.length === 0
          ? `Provider "${v.provider_id}" has no structured endpoints for capability "${v.capability}" (legacy instructions-only mode). Call aigc_provider_get_instructions for the free-form text.`
          : `Provider "${v.provider_id}" capability "${v.capability}" (${v.endpoints.length} endpoint(s)):\n${v.endpoints.map(ep => `  ${ep.method} ${ep.path} -> ${ep.response.kind}`).join('\n')}`,
      ),
    },
    execute: (args: { provider_id: string; capability: string }) => {
      if (typeof args.provider_id !== 'string' || args.provider_id === '') {
        throw new AigcError('bad-request', 'provider_id is required')
      }
      if (typeof args.capability !== 'string' || !(CAPABILITIES as readonly string[]).includes(args.capability)) {
        throw new AigcError('bad-request', `capability must be one of: ${(CAPABILITIES as readonly string[]).join(', ')}`)
      }
      const provider = getProvider(args.provider_id) // throws for unknown ids
      const cap = args.capability as Capability
      const byCap = endpointsByCapability(provider.endpoints)
      const endpoints = byCap.get(cap) ?? []
      return Promise.resolve({
        provider_id: args.provider_id,
        capability: cap,
        endpoints,
      })
    },
  }))

  // ══ aigc_http_request ═══════════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_http_request',
    description:
      'Send one HTTP request to an AIGC provider\'s API. The provider\'s configured endpoint and apiKey are attached '
      + 'automatically (you must not pass them; the auth header/param cannot be overridden). '
      + 'The request path is relative to the provider endpoint, e.g. "/v1/images/generations"; a same-origin absolute URL '
      + '(e.g. a provider-returned result_url) is also accepted. '
      + 'Binary responses (image / video / audio) are saved to disk under the session canvas directory and returned '
      + 'as a file_path; JSON/text responses are returned inline (and summarized or saved to a file when large). '
      + 'Non-2xx responses are returned as { ok: false } with the response body AND a sent_body_preview of the request, '
      + 'so you can read API errors and self-diagnose field-loss bugs. '
      + 'To embed a canvas element\'s file content as base64 in the request body, use the {"$base64": "file_path"} '
      + 'placeholder inside json_body OR body (both work). '
      + 'After you have a file_path, place it onto the canvas with aigc_canvas_place.',
    parameters: {
      provider_id: providerIdParam,
      method: {
        type: 'string',
        description: 'HTTP method. Defaults to POST when a body/json_body is provided, else GET.',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      },
      path: {
        type: 'string',
        required: true,
        description: 'Request path relative to the provider endpoint, starting with "/", e.g. "/v1/images/generations". '
          + 'An absolute URL is also accepted, but only when same-origin with the provider endpoint (same protocol+host+port) — '
          + 'use this to fetch provider-returned download URLs (e.g. a video result_url) that need the provider auth.',
      },
      headers: {
        type: 'object',
        description: 'Extra request headers (string values). The provider auth header/param is attached automatically and cannot be overridden.',
        additionalProperties: true,
      },
      query: {
        type: 'object',
        description: 'URL query parameters (string values), merged with any auth query param.',
        additionalProperties: true,
      },
      json_body: {
        type: 'json',
        description: 'JSON request body as an object/array (preferred), or a JSON string. Serialized automatically. Use either json_body or body, not both. '
          + 'SPECIAL PLACEHOLDERS: to embed a canvas element\'s file content as base64 inside the JSON, use '
          + '{"$base64": "<file_path>"} — the tool reads the file, base64-encodes it, and replaces the placeholder '
          + 'with the resulting string before sending. For a data URI (e.g. "data:image/png;base64,..."), use '
          + '{"$data_uri": "<file_path>"}. The file_path must be an absolute path inside the session canvas directory '
          + '(e.g. a file_path returned by a previous aigc_http_request or aigc_canvas_place call). '
          + 'Example: {"model":"t2v","image":{"$base64":"/path/to/ref.png"},"prompt":"dance"}',
      },
      body: {
        type: 'string',
        description: 'Raw request body string (typically JSON text). Use either json_body or body, not both. '
          + 'The $base64 / $data_uri placeholders (see json_body) are also expanded here when the body is valid JSON — '
          + 'so you can inline binary content in a raw body too. Non-JSON bodies are sent as-is.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the provider returned 2xx.' },
          status: { type: 'integer', required: true, description: 'The HTTP status code.' },
          kind: {
            type: 'string',
            required: true,
            enum: ['image', 'video', 'audio', 'other', 'json', 'text'],
            description: 'Response kind. image/video/audio/other = saved to disk (see file_path); json/text = returned inline (see text).',
          },
          content_type: { type: 'string', required: true, description: 'The response Content-Type header.' },
          file_path: { type: 'string', description: 'Absolute path of the saved binary response (or of an oversized text response). Pass this to aigc_canvas_place.' },
          file_size: { type: 'integer', description: 'Byte size of the saved file (when file_path is set).' },
          text: { type: 'string', description: 'Inline JSON/text response body (when kind is json or text).' },
          error: { type: 'string', description: 'Response body of a failed (non-2xx) request, truncated.' },
          sent_body_preview: { type: 'string', description: 'First ~500 bytes of the request body actually sent (set on non-2xx responses, for diagnosing field-loss / encoding bugs).' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok: boolean; status: number; kind: string; content_type: string; file_path?: string; file_size?: number; text?: string; error?: string; sent_body_preview?: string }
        if (!v.ok) {
          const sent = v.sent_body_preview !== undefined ? `\n— sent body (first 500 bytes): ${v.sent_body_preview}` : ''
          return [{ type: 'text', text: `HTTP ${v.status} (${v.content_type}): ${(v.error ?? '(empty body)').slice(0, 500)}${sent}` }]
        }
        if (v.file_path !== undefined && v.text !== undefined) {
          return [{ type: 'text', text: `HTTP ${v.status}: ${v.kind} response truncated (full ${v.file_size} bytes at ${v.file_path}). Preview: ${v.text.slice(0, 300)}` }]
        }
        if (v.file_path !== undefined) {
          return [{ type: 'text', text: `HTTP ${v.status}: saved ${v.kind} response (${v.file_size} bytes, ${v.content_type}) to ${v.file_path}. Place it with aigc_canvas_place.` }]
        }
        return [{ type: 'text', text: `HTTP ${v.status} ${v.kind} response: ${v.text ?? ''}` }]
      },
    },
    async execute(args: {
      provider_id?: string
      method?: string
      path: string
      headers?: Record<string, string>
      query?: Record<string, string>
      json_body?: unknown
      body?: string
    }, exec) {
      exec.signal.throwIfAborted()
      if (args.json_body !== undefined && args.body !== undefined) {
        throw new AigcError('bad-request', 'pass either json_body or body, not both')
      }
      const sessionId = sessionIdOf(exec)
      const cwd = resolveCwd(sessionId)
      const provider = getProvider(args.provider_id)
      // Build the outgoing body string. Two input shapes are supported:
      //   - json_body: an object/array (preferred) OR a JSON string. The
      //     model sometimes passes a string here even though the schema
      //     allows any JSON value; if we JSON.stringify a string we'd produce
      //     a double-quoted mess that loses every field server-side. So we
      //     parse string inputs first.
      //   - body: a raw string. $base64 / $data_uri placeholders are expanded
      //     here too when the body parses as JSON (non-JSON bodies pass through).
      let body: string | undefined
      // bodyForSnapshot: the UNEXPANDED form (placeholders intact) so the
      // reroll tool can patch structured fields and re-resolve $base64
      // references at replay time. Object/array when json_body was used;
      // raw string when body was used; undefined when no body.
      let bodyForSnapshot: unknown
      if (args.json_body !== undefined) {
        let jsonValue: unknown = args.json_body
        if (typeof jsonValue === 'string') {
          if (jsonValue === '') {
            body = undefined
          } else {
            try {
              jsonValue = JSON.parse(jsonValue)
            } catch (e) {
              throw new AigcError('bad-request', `json_body is a string but not valid JSON: ${e instanceof Error ? e.message : String(e)}. Pass an object/array, or use the body parameter for raw non-JSON text.`)
            }
            bodyForSnapshot = jsonValue
            const expanded = await expandBase64Placeholders(jsonValue, sessionId, cwd)
            body = JSON.stringify(expanded)
          }
        } else {
          bodyForSnapshot = jsonValue
          const expanded = await expandBase64Placeholders(jsonValue, sessionId, cwd)
          body = JSON.stringify(expanded)
        }
      } else if (args.body !== undefined) {
        // Expand placeholders in raw body too, but only when the body is
        // valid JSON (placeholders are JSON objects like {"$base64": "..."}).
        // Non-JSON bodies (form-urlencoded, plain text) pass through unchanged.
        bodyForSnapshot = args.body
        if (/\$(?:base64|data_uri)\b/.test(args.body)) {
          try {
            const parsed = JSON.parse(args.body)
            const expanded = await expandBase64Placeholders(parsed, sessionId, cwd)
            body = JSON.stringify(expanded)
          } catch (e) {
            if (e instanceof AigcError) throw e
            throw new AigcError('bad-request', `body contains $base64/$data_uri placeholders but is not valid JSON: ${e instanceof Error ? e.message : String(e)}. Use json_body for structured payloads with placeholders.`)
          }
        } else {
          body = args.body
        }
      }
      const requestStartedAt = Date.now()
      const method = (args.method ?? (body !== undefined ? 'POST' : 'GET')).toUpperCase()
      const result = await executeProviderRequest(provider, {
        method: args.method,
        path: args.path,
        headers: args.headers,
        query: args.query,
        body,
      }, { timeoutMs: getTimeoutMs(), signal: exec.signal })
      const requestDurationMs = Date.now() - requestStartedAt

      /**
       * Record a RequestSnapshot for one saved file_path so the next
       * aigc_canvas_place call can merge it into meta.originalRequest
       * (enables aigc_reroll without the model having to remember the
       * original request body / params / provider).
       */
      const recordSnapshot = (filePath: string, size: number | undefined, kind: string): void => {
        const snapshot: RequestSnapshot = {
          providerId: provider.id,
          method,
          path: args.path,
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.headers !== undefined ? { headers: args.headers } : {}),
          ...(bodyForSnapshot !== undefined ? { body: bodyForSnapshot } : {}),
          responseInfo: {
            status: result.status,
            contentType: result.contentType,
            kind,
            ...(size !== undefined ? { size } : {}),
            durationMs: requestDurationMs,
          },
        }
        recordRequestSnapshot(sessionId, filePath, snapshot)
      }

      if (!result.ok) {
        logHttpRequest(sessionId, provider, { method, path: args.path, headers: args.headers, query: args.query, body }, { ok: false, status: result.status, contentType: result.contentType, kind: 'text', error: result.text }, requestDurationMs, undefined, undefined)
        return {
          ok: false,
          status: result.status,
          kind: 'text' as const,
          content_type: result.contentType,
          error: result.text,
          // Echo the actually-sent body (first 500 bytes) so the model can
          // self-diagnose field-loss / encoding bugs without control-variable
          // debugging.
          sent_body_preview: body !== undefined ? body.slice(0, 500) : undefined,
        }
      }
      switch (result.kind) {
        case 'json':
        case 'text': {
          // Spec-driven response handling: when the provider has an EndpointSpec
          // for this (path, method), use spec.response.kind + spec.response.path
          // to process the response. This replaces the legacy OpenAI-format
          // sniff (extractOpenAIB64Image) for providers with a configured catalog.
          const methodUsed = (args.method ?? (body !== undefined ? 'POST' : 'GET')).toUpperCase()
          const spec = findEndpointSpec(provider.endpoints, args.path, methodUsed)
          if (result.kind === 'json' && spec !== undefined) {
            const specResult = await processResponseBySpec(spec, result.text, provider, { timeoutMs: getTimeoutMs(), signal: exec.signal }, sessionId, cwd)
            if (specResult !== null) {
              recordSnapshot(specResult.filePath, specResult.size, specResult.kind)
              return {
                ok: true,
                status: result.status,
                kind: specResult.kind,
                content_type: specResult.contentType,
                file_path: specResult.filePath,
                file_size: specResult.size,
              }
            }
          }
          // Legacy: OpenAI image endpoints return JSON like {data:[{b64_json:"..."}]}.
          // Auto-extract the base64 payload to a file so the model gets a
          // file_path it can pass directly to aigc_canvas_place — without
          // having to manually decode base64 and write a file itself.
          if (result.kind === 'json') {
            const extracted = extractOpenAIB64Image(result.text)
            if (extracted !== null) {
              if (extracted.bytes.byteLength > getMediaLimit()) {
                throw new AigcError('backend-error', `extracted image too large (${extracted.bytes.byteLength} bytes > ${getMediaLimit()} limit)`, 413)
              }
              const filePath = await saveResponseToSession(extracted.bytes, extracted.ext, sessionId, cwd)
              recordSnapshot(filePath, extracted.bytes.byteLength, 'image')
              logHttpRequest(sessionId, provider, { method, path: args.path, headers: args.headers, query: args.query, body }, { ok: true, status: result.status, contentType: extracted.contentType, kind: 'image' }, requestDurationMs, filePath, extracted.bytes.byteLength)
              return {
                ok: true,
                status: result.status,
                kind: 'image' as const,
                content_type: extracted.contentType,
                file_path: filePath,
                file_size: extracted.bytes.byteLength,
              }
            }
          }
          if (result.text.length <= INLINE_TEXT_CAP) {
            logHttpRequest(sessionId, provider, { method, path: args.path, headers: args.headers, query: args.query, body }, { ok: true, status: result.status, contentType: result.contentType, kind: result.kind, text: result.text }, requestDurationMs, undefined, undefined)
            return {
              ok: true,
              status: result.status,
              kind: result.kind,
              content_type: result.contentType,
              text: result.text,
            }
          }
          // Oversized text: save the FULL response to a file under the
          // session canvas directory and return a short preview plus the
          // file_path. The model can read the file with its own tools.
          const filePath = await saveResponseToSession(result.text, result.kind === 'json' ? 'json' : 'txt', sessionId, cwd)
          const preview = result.text.slice(0, INLINE_TEXT_CAP)
          const size = Buffer.byteLength(result.text)
          recordSnapshot(filePath, size, result.kind)
          logHttpRequest(sessionId, provider, { method, path: args.path, headers: args.headers, query: args.query, body }, { ok: true, status: result.status, contentType: result.contentType, kind: result.kind, text: preview }, requestDurationMs, filePath, size)
          return {
            ok: true,
            status: result.status,
            kind: result.kind,
            content_type: result.contentType,
            text: `${preview}\n… [response truncated; full ${size} bytes saved to ${filePath} — read it with your file tools]`,
            file_path: filePath,
            file_size: size,
          }
        }
        default: {
          // Binary (image / video / audio / other): persist and return the path.
          const ext = extensionForBinaryKind(result.kind, result.contentType)
          if (result.size > getMediaLimit()) {
            throw new AigcError('backend-error', `provider response too large to save (${result.size} bytes > ${getMediaLimit()} limit)`, 413)
          }
          const filePath = await saveResponseToSession(result.bytes, ext, sessionId, cwd)
          recordSnapshot(filePath, result.size, result.kind)
          logHttpRequest(sessionId, provider, { method, path: args.path, headers: args.headers, query: args.query, body }, { ok: true, status: result.status, contentType: result.contentType, kind: result.kind }, requestDurationMs, filePath, result.size)
          return {
            ok: true,
            status: result.status,
            kind: result.kind,
            content_type: result.contentType,
            file_path: filePath,
            file_size: result.size,
          }
        }
      }
    },
  }))

  // ══ aigc_provider_set_instructions ══════════════════════════════════════
  register(defineTool({
    name: 'aigc_provider_set_instructions',
    description:
      'Record the usage instructions (调用说明) for one provider: the endpoints, request formats, parameters, '
      + 'and response shapes you discovered by probing the provider with aigc_http_request. '
      + 'Call this after initializing a provider so future sessions can generate with it directly. '
      + 'The instructions replace the provider\'s previous instructions (empty until first set). '
      + `KEEP THE INSTRUCTIONS COMPACT (target: under ${INSTRUCTIONS_MAX_CHARS} chars) — they are inlined into `
      + 'aigc_get_provider_info as a preview, so verbosity wastes context window on every provider list call. '
      + 'Prefer compact shorthand like "POST /v1/images/generations {prompt,size} -> {data:[{b64_json}]}" over full sentences. '
      + 'Do NOT copy full API docs or verbose explanations — drop formatting guarantees and use telegraphic notes '
      + '(one line per endpoint, no Markdown).',
    parameters: {
      provider_id: { type: 'string', required: true, description: 'The provider id to update (from aigc_get_provider_info).' },
      instructions: {
        type: 'string',
        required: true,
        description: 'Compact usage instructions. Be terse — one line per endpoint is enough; do not pad with prose, examples, or full docs. '
          + 'Shorthand like "POST /v1/images/generations {prompt,size} -> {data:[{b64_json}]}" is ideal. '
          + `Target: under ${INSTRUCTIONS_MAX_CHARS} chars total. Fewer is better.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          provider_id: { type: 'string', required: true },
          total_chars: { type: 'integer', required: true, description: 'Total character count of the saved instructions.' },
        },
      },
      render: textRender((v: { provider_id: string; total_chars: number }) => `Saved ${v.total_chars} chars of usage instructions for provider "${v.provider_id}".`),
    },
    execute: (args: { provider_id: string; instructions: string }) => {
      if (typeof args.provider_id !== 'string' || args.provider_id === '') {
        throw new AigcError('bad-request', 'provider_id is required')
      }
      if (typeof args.instructions !== 'string' || args.instructions === '') {
        throw new AigcError('bad-request', 'instructions is required')
      }
      if (args.instructions.length > INSTRUCTIONS_MAX_CHARS) {
        throw new AigcError('bad-request', `instructions too long (${args.instructions.length} chars > ${INSTRUCTIONS_MAX_CHARS} limit). Compress to telegraphic one-line-per-endpoint shorthand.`)
      }
      getProvider(args.provider_id) // throws for unknown ids
      const result = setInstructions(args.provider_id, args.instructions)
      if (!result.ok) throw new AigcError('bad-request', result.error ?? 'cannot save instructions')
      return Promise.resolve({ ok: true, provider_id: args.provider_id, total_chars: args.instructions.length })
    },
  }))

  // ══ aigc_provider_get_instructions ══════════════════════════════════════
  register(defineTool({
    name: 'aigc_provider_get_instructions',
    description:
      'Fetch the FULL usage instructions (调用说明) for one provider. '
      + 'aigc_get_provider_info only shows a short preview (first '
      + `${INSTRUCTIONS_PREVIEW_CHARS} chars); when you need the complete text — e.g. to recall exact `
      + 'endpoint paths, parameter names, or response shapes for an already-initialized provider — call this. '
      + 'The result is empty for a provider that has not been initialized yet (probe the API with '
      + 'aigc_http_request first, then record the instructions via aigc_provider_set_instructions).',
    parameters: {
      provider_id: { type: 'string', required: true, description: 'The provider id (from aigc_get_provider_info).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider_id: { type: 'string', required: true },
          instructions: { type: 'string', required: true, description: 'The full usage instructions string (empty when the provider is uninitialized).' },
          total_chars: { type: 'integer', required: true, description: 'Total character count of the instructions (0 when uninitialized).' },
        },
      },
      render: textRender((v: { provider_id: string; instructions: string; total_chars: number }) =>
        v.instructions === ''
          ? `Provider "${v.provider_id}" has no instructions recorded yet. Probe its API with aigc_http_request, then save them via aigc_provider_set_instructions.`
          : `Full instructions for provider "${v.provider_id}" (${v.total_chars} chars):\n${v.instructions}`,
      ),
    },
    execute: (args: { provider_id: string }) => {
      if (typeof args.provider_id !== 'string' || args.provider_id === '') {
        throw new AigcError('bad-request', 'provider_id is required')
      }
      const provider = getProvider(args.provider_id) // throws for unknown ids
      const instructions = provider.instructions
      return Promise.resolve({ provider_id: args.provider_id, instructions, total_chars: instructions.length })
    },
  }))

  // ══ aigc_provider_set_endpoints ═════════════════════════════════════════
  register(defineTool({
    name: 'aigc_provider_set_endpoints',
    description:
      'Record the STRUCTURED capability catalog for one provider: a list of EndpointSpec entries describing each '
      + 'endpoint\'s path, method, capability, parameters, and response shape. '
      + 'This is the preferred replacement for aigc_provider_set_instructions (which stores free-form text): '
      + 'the structured catalog lets aigc_get_provider_info return a capabilityMap, lets aigc_get_endpoint_details '
      + 'return exact endpoint specs, and lets aigc_http_request process responses by spec.response.kind instead of '
      + 'the legacy OpenAI-format sniff. '
      + 'The legacy `instructions` field is AUTO-DERIVED from the catalog (one compact line per endpoint) so old '
      + 'agent prompts that read `instructions` keep working. '
      + 'Call this after probing a provider\'s API with aigc_http_request + aigc_probe_endpoint.',
    parameters: {
      provider_id: { type: 'string', required: true, description: 'The provider id to update (from aigc_get_provider_info).' },
      endpoints: {
        type: 'json',
        required: true,
        description: 'Array of EndpointSpec objects. Each entry: { path, method, capability, params?, response: { kind, path? }, acceptsCanvasRef?, notes? }. '
          + `capability enum: ${(CAPABILITIES as readonly string[]).join(' | ')}. `
          + `response.kind enum: ${(RESPONSE_KINDS as readonly string[]).join(' | ')}. `
          + 'response.path is required for b64_json_array / b64_json_field / url_field (e.g. "data[0].b64_json"); ignored for binary and json_text. '
          + 'params is an array of { name, type, required, default?, enum?, min?, max?, description? }. '
          + 'Example: [{ path: "/v1/images/generations", method: "POST", capability: "t2i", params: [{name:"prompt",type:"string",required:true},{name:"size",type:"string",default:"1024x1024"}], response: { kind: "b64_json_array", path: "data[0].b64_json" }, acceptsCanvasRef: true }]',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          provider_id: { type: 'string', required: true },
          endpoint_count: { type: 'integer', required: true, description: 'Number of EndpointSpec entries saved.' },
          derived_instructions_chars: { type: 'integer', required: true, description: 'Character count of the auto-derived instructions string (also saved to the legacy field).' },
        },
      },
      render: textRender((v: { provider_id: string; endpoint_count: number; derived_instructions_chars: number }) =>
        `Saved ${v.endpoint_count} endpoint(s) for provider "${v.provider_id}" (auto-derived instructions: ${v.derived_instructions_chars} chars).`,
      ),
    },
    execute: (args: { provider_id: string; endpoints: unknown }) => {
      if (typeof args.provider_id !== 'string' || args.provider_id === '') {
        throw new AigcError('bad-request', 'provider_id is required')
      }
      if (!Array.isArray(args.endpoints)) {
        throw new AigcError('bad-request', 'endpoints must be an array of EndpointSpec objects')
      }
      // Validate + coerce each entry to EndpointSpec.
      const endpoints: EndpointSpec[] = []
      for (const raw of args.endpoints) {
        if (typeof raw !== 'object' || raw === null) {
          throw new AigcError('bad-request', 'each endpoint must be an object')
        }
        const rec = raw as Record<string, unknown>
        if (typeof rec.path !== 'string' || rec.path === '') {
          throw new AigcError('bad-request', 'each endpoint.path must be a non-empty string')
        }
        if (typeof rec.method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH'].includes(rec.method)) {
          throw new AigcError('bad-request', `endpoint.method must be one of GET/POST/PUT/PATCH (got: ${String(rec.method)})`)
        }
        if (typeof rec.capability !== 'string' || !(CAPABILITIES as readonly string[]).includes(rec.capability)) {
          throw new AigcError('bad-request', `endpoint.capability must be one of: ${(CAPABILITIES as readonly string[]).join(', ')}`)
        }
        if (typeof rec.response !== 'object' || rec.response === null) {
          throw new AigcError('bad-request', 'endpoint.response must be an object { kind, path? }')
        }
        const resp = rec.response as Record<string, unknown>
        if (typeof resp.kind !== 'string' || !(RESPONSE_KINDS as readonly string[]).includes(resp.kind)) {
          throw new AigcError('bad-request', `endpoint.response.kind must be one of: ${(RESPONSE_KINDS as readonly string[]).join(', ')}`)
        }
        endpoints.push({
          path: rec.path,
          method: rec.method as EndpointSpec['method'],
          capability: rec.capability as Capability,
          ...(Array.isArray(rec.params) ? { params: rec.params as EndpointSpec['params'] } : {}),
          response: {
            kind: resp.kind as ResponseKind,
            ...(typeof resp.path === 'string' ? { path: resp.path } : {}),
          },
          ...(typeof rec.acceptsCanvasRef === 'boolean' ? { acceptsCanvasRef: rec.acceptsCanvasRef } : {}),
          ...(typeof rec.notes === 'string' ? { notes: rec.notes } : {}),
        })
      }
      getProvider(args.provider_id) // throws for unknown ids
      const result = setEndpoints(args.provider_id, endpoints)
      if (!result.ok) throw new AigcError('bad-request', result.error ?? 'cannot save endpoints')
      const derived = deriveInstructionsFromEndpoints(endpoints)
      return Promise.resolve({
        ok: true,
        provider_id: args.provider_id,
        endpoint_count: endpoints.length,
        derived_instructions_chars: derived.length,
      })
    },
  }))

  // ══ aigc_probe_endpoint ═════════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_probe_endpoint',
    description:
      'Probe one provider endpoint with a minimal test request and auto-detect the response shape (ResponseKind + '
      + 'payload path). Use this to half-automate the EndpointSpec catalog: send a tiny test body, read the detected '
      + 'kind + path, then save a full EndpointSpec via aigc_provider_set_endpoints. '
      + 'The probe sends ONE real API call (costs money); use a minimal test body to keep the cost down. '
      + 'Binary responses (image/video/audio Content-Type) are detected as kind="binary" from the Content-Type header; '
      + 'JSON responses are sniffed by heuristics (OpenAI b64_json_array, url_field, chat shape, single b64 field, etc.).',
    parameters: {
      provider_id: { type: 'string', required: true, description: 'The provider id to probe (from aigc_get_provider_info).' },
      path: { type: 'string', required: true, description: 'Endpoint path to probe, e.g. "/v1/images/generations".' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'], description: 'HTTP method. Defaults to POST when a test_body is provided, else GET.' },
      test_body: { type: 'json', description: 'Minimal test request body (object/array or JSON string). Keep it tiny to minimize API cost. Example: { prompt: "test", size: "1024x1024" }.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the probe request returned 2xx.' },
          status: { type: 'integer', required: true, description: 'HTTP status code of the probe response.' },
          content_type: { type: 'string', required: true, description: 'Response Content-Type header.' },
          detected: {
            type: 'object',
            required: true,
            additionalProperties: false,
            description: 'Auto-detected response shape (use these values to fill an EndpointSpec.response).',
            properties: {
              responseKind: { type: 'string', required: true, enum: RESPONSE_KINDS as readonly string[] },
              responsePath: { type: 'string', description: 'Detected payload path (e.g. "data[0].b64_json"). Undefined for binary and json_text.' },
              sampleField: { type: 'string', description: 'Sample field name detected (for debugging the heuristic).' },
            },
          },
          body_preview: { type: 'string', required: true, description: 'First ~500 chars of the response body (for the model to verify the detection).' },
        },
      },
      render: textRender((v: { ok: boolean; status: number; content_type: string; detected: { responseKind: string; responsePath?: string }; body_preview: string }) =>
        v.ok
          ? `Probe ${v.status} (${v.content_type}) → detected ${v.detected.responseKind}${v.detected.responsePath !== undefined ? ` @ ${v.detected.responsePath}` : ''}\nBody preview: ${v.body_preview.slice(0, 200)}`
          : `Probe FAILED: HTTP ${v.status} (${v.content_type}). Body: ${v.body_preview.slice(0, 200)}`,
      ),
    },
    async execute(args: {
      provider_id: string
      path: string
      method?: string
      test_body?: unknown
    }, exec) {
      exec.signal.throwIfAborted()
      if (typeof args.provider_id !== 'string' || args.provider_id === '') {
        throw new AigcError('bad-request', 'provider_id is required')
      }
      if (typeof args.path !== 'string' || args.path === '') {
        throw new AigcError('bad-request', 'path is required')
      }
      const sessionId = sessionIdOf(exec)
      void sessionId // probe doesn't place files; sessionId is only for the abort scope
      const provider = getProvider(args.provider_id)
      // Build the test body string.
      let body: string | undefined
      if (args.test_body !== undefined) {
        if (typeof args.test_body === 'string') {
          body = args.test_body
        } else {
          try {
            body = JSON.stringify(args.test_body)
          } catch (e) {
            throw new AigcError('bad-request', `test_body is not serializable: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      const method = (args.method ?? (body !== undefined ? 'POST' : 'GET')).toUpperCase()
      const result = await executeProviderRequest(provider, {
        method,
        path: args.path,
        body,
      }, { timeoutMs: getTimeoutMs(), signal: exec.signal })
      if (!result.ok) {
        return {
          ok: false,
          status: result.status,
          content_type: result.contentType,
          detected: { responseKind: 'json_text' as ResponseKind },
          body_preview: result.text.slice(0, 500),
        }
      }
      // Detect the response shape from the Content-Type + body.
      const mediaType = result.contentType.split(';')[0]!.trim().toLowerCase()
      const isBinary = mediaType.startsWith('image/') || mediaType.startsWith('video/') || mediaType.startsWith('audio/') || mediaType === 'application/octet-stream'
      if (isBinary) {
        return {
          ok: true,
          status: result.status,
          content_type: result.contentType,
          detected: { responseKind: 'binary' as ResponseKind },
          body_preview: `(binary ${result.contentType}, ${result.kind === 'json' || result.kind === 'text' ? result.text.length : (result as { bytes?: Buffer }).bytes?.byteLength ?? 0} bytes)`,
        }
      }
      // Text / JSON response — sniff the body.
      const text = result.kind === 'json' || result.kind === 'text' ? result.text : ''
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = text }
      const detected = detectResponseShape(parsed)
      const sampleField = detected.path ?? ''
      return {
        ok: true,
        status: result.status,
        content_type: result.contentType,
        detected: {
          responseKind: detected.kind,
          ...(detected.path !== undefined ? { responsePath: detected.path } : {}),
          ...(sampleField !== '' ? { sampleField } : {}),
        },
        body_preview: text.slice(0, 500),
      }
    },
  }))

  // ══ aigc_reroll ═════════════════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_reroll',
    description:
      'Re-generate one (or a few) elements based on an existing canvas element, applying an optional patch to the '
      + 'original request. The source element MUST have been placed via aigc_canvas_place from a file produced by '
      + 'aigc_http_request (so its meta.originalRequest is recorded — see aigc_canvas_list_elements). '
      + 'host reads meta.originalRequest, applies the patch, calls the original provider, saves the new file, places '
      + 'it on the canvas, and auto-wires an edge from the source to the new element with a semantic relation: '
      + '"variation_of" when only the seed (or other non-prompt params) changed, "remix_of" when the prompt changed. '
      + 'When count > 1, all variants are also wired to each other with "alternative_of" so they form a cluster. '
      + 'This is the 1-step primitive for "this image\'s pose is wrong, regenerate with a different prompt" / '
      + '"give me 4 variations of this image with different seeds" — no need to manually reconstruct the original '
      + 'request body, call aigc_http_request, then aigc_canvas_place, then aigc_canvas_link.',
    parameters: {
      source_element: {
        type: 'string',
        required: true,
        description: 'filePath of the source canvas element to reroll (must have meta.originalRequest — place it via '
          + 'aigc_canvas_place first if it came from aigc_http_request).',
      },
      patch: {
        type: 'json',
        description: 'Optional patch applied to the original request body. Fields:\n'
          + '  seed?: number — change the seed (when omitted AND the body has a seed field, a random seed is used)\n'
          + '  prompt_delta?: string — append to the original prompt (relation becomes "remix_of")\n'
          + '  prompt_replace?: string — completely replace the prompt (relation becomes "remix_of")\n'
          + '  size?: string — change the size\n'
          + '  Any other field overrides the corresponding body field directly (e.g. {duration: 10}).\n'
          + 'When omitted entirely, only the seed is randomized (relation "variation_of").',
      },
      count: {
        type: 'integer',
        description: 'How many variants to generate (default 1, max 8). When > 1, all variants are placed in a grid '
          + 'to the right of the source, all wired to the source with the same relation, and wired to each other '
          + 'with "alternative_of".',
      },
      provider_id: {
        type: 'string',
        description: 'Override the original provider (default: use the source element\'s originalRequest.providerId). '
          + 'Use this when the original provider is down or you want to compare providers.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          elements: {
            type: 'array',
            required: true,
            description: 'The newly generated elements.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                filePath: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['prompt', 'image', 'video', 'audio'] },
                title: { type: 'string', required: true },
                x: { type: 'number', required: true },
                y: { type: 'number', required: true },
              },
            },
          },
          linked_to: { type: 'string', required: true, description: 'filePath of the source element the variants were rerolled from.' },
          relation: { type: 'string', required: true, enum: ['variation_of', 'remix_of'], description: 'Auto-decided: variation_of when only seed/params changed, remix_of when the prompt changed.' },
        },
      },
      render: (_args, value) => {
        const v = value as { elements: Array<{ filePath: string; kind: string }>; linked_to: string; relation: string }
        const list = v.elements.map(e => `  ${e.filePath} [${e.kind}]`).join('\n')
        return [{
          type: 'text',
          text: `Rerolled ${v.elements.length} variant(s) from ${v.linked_to} →[${v.relation}]:\n${list}`,
        }]
      },
    },
    async execute(args: {
      source_element: string
      patch?: unknown
      count?: number
      provider_id?: string
    }, exec) {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      const cwd = resolveCwd(sessionId)
      // 1. Resolve the source element + its originalRequest.
      await canvas.ensureHydrated(sessionId)
      const sourceEl = canvas.getElementByPath(sessionId, args.source_element)
      const originalRequest = sourceEl.meta?.originalRequest as RequestSnapshot | undefined
      if (originalRequest === undefined) {
        throw new AigcError(
          'bad-request',
          `cannot reroll element "${args.source_element}" — it has no meta.originalRequest. `
          + 'This happens when the element was not placed via aigc_canvas_place from a file produced by aigc_http_request '
          + '(e.g. it was uploaded via drag-drop or created by aigc_media_edit). Re-generate it via aigc_http_request + '
          + 'aigc_canvas_place first to enable reroll.',
        )
      }
      // 2. Validate + parse the patch.
      const patch = coerceMeta(args.patch) ?? {}
      const count = args.count !== undefined ? Math.max(1, Math.min(8, Math.floor(args.count))) : 1
      // 3. Decide the relation: remix_of when prompt changed, variation_of otherwise.
      const promptChanged = patch.prompt_delta !== undefined || patch.prompt_replace !== undefined
      const relation: EdgeRelation = promptChanged ? 'remix_of' : 'variation_of'
      // 4. Build the patched body.
      const provider = getProvider(args.provider_id ?? originalRequest.providerId)
      const patchedBody = applyRerollPatch(originalRequest.body, patch)
      const bodyString = typeof patchedBody === 'string'
        ? patchedBody
        : (patchedBody !== undefined ? JSON.stringify(patchedBody) : undefined)
      // 5. Compute grid positions for the variants (to the right of the source).
      const positions = gridPositionsRightOf(sourceEl.x, sourceEl.y, count)
      // 6. Execute the request count times, save each, place each, record snapshot.
      const newElements: AigcElement[] = []
      for (let i = 0; i < count; i++) {
        exec.signal.throwIfAborted()
        // For count > 1, randomize the seed on every iteration (if body has seed) so variants differ.
        const iterBody = (count > 1 && typeof patchedBody === 'object' && patchedBody !== null)
          ? randomizeSeedInPlace({ ...(patchedBody as Record<string, unknown>) })
          : patchedBody
        const iterBodyString = typeof iterBody === 'string'
          ? iterBody
          : (iterBody !== undefined ? JSON.stringify(iterBody) : undefined)
        const requestStartedAt = Date.now()
        const result = await executeProviderRequest(provider, {
          method: originalRequest.method,
          path: originalRequest.path,
          headers: originalRequest.headers,
          query: originalRequest.query,
          body: iterBodyString,
        }, { timeoutMs: getTimeoutMs(), signal: exec.signal })
        const durationMs = Date.now() - requestStartedAt
        if (!result.ok) {
          throw new AigcError(
            'backend-error',
            `reroll failed: provider returned HTTP ${result.status} (${result.contentType}): ${result.text.slice(0, 500)}`,
            result.status >= 400 && result.status < 500 ? 400 : 502,
          )
        }
        // Save the response to disk + record snapshot for the new file.
        const saved = await saveRerollResponse(result, sessionId, cwd, provider.id, originalRequest, iterBody, durationMs)
        // Place the file on the canvas at the computed grid position.
        const placed = await canvas.placeFile(sessionId, {
          kind: saved.kind,
          filePath: saved.filePath,
          title: `${sourceEl.title} (reroll ${i + 1})`,
          producedBy: 'aigc_reroll',
          x: positions[i]!.x,
          y: positions[i]!.y,
          description: sourceEl.description ?? sourceEl.title.slice(0, 40),
          ...(sourceEl.promptText !== undefined ? { promptText: sourceEl.promptText } : {}),
          meta: { originalRequest: saved.snapshot },
        }, cwd)
        newElements.push(placed)
      }
      // 7. Wire edges: source → each new element with the relation.
      if (newElements.length > 0) {
        await canvas.wireEdges(
          sessionId,
          newElements.map(e => ({ uuid: sourceEl.uuid, relation })),
          newElements[0]!.uuid,
        )
        // Wire source → each subsequent new element too.
        for (let i = 1; i < newElements.length; i++) {
          await canvas.wireEdges(
            sessionId,
            [{ uuid: sourceEl.uuid, relation }],
            newElements[i]!.uuid,
          )
        }
        // 8. When count > 1, wire all variants to each other with alternative_of.
        if (newElements.length > 1) {
          for (let i = 0; i < newElements.length; i++) {
            for (let j = 0; j < newElements.length; j++) {
              if (i === j) continue
              await canvas.wireEdges(
                sessionId,
                [{ uuid: newElements[i]!.uuid, relation: 'alternative_of' }],
                newElements[j]!.uuid,
              )
            }
          }
        }
      }
      return {
        elements: newElements.map(e => ({
          filePath: e.filePath,
          kind: e.kind,
          title: e.title,
          x: e.x,
          y: e.y,
        })),
        linked_to: args.source_element,
        relation,
      }
    },
  }))

  // ══ aigc_canvas_place ═══════════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_canvas_place',
    description:
      'Place a file (usually the file_path returned by aigc_http_request) onto the session\'s free canvas at '
      + 'position (x, y). The file must already exist inside the session canvas directory. '
      + 'Optionally record the prompt text and generation parameters (meta) — they are shown when the user '
      + 'double-clicks the element. Pass `references` (filePaths + relations of existing elements the new one was '
      + 'generated from) to auto-wire edges from those elements to the new one. '
      + 'x and y are OPTIONAL: PREFER OMITTING THEM and letting the host auto-place. '
      + 'When references are given, the new element lands to the RIGHT of the rightmost reference (vertically '
      + 'centered on the references); otherwise it goes BELOW the lowest existing element in a left-aligned '
      + 'vertical column (this is the usual case for a sequence of independent generations). The client pans '
      + 'to bring it into view. '
      + 'DO NOT pass explicit x/y for routine placements — letting the host stack elements vertically keeps '
      + 'the canvas readable. Only set x/y when the user explicitly asks for a specific layout '
      + '(e.g. "place these side by side").',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Absolute path of the file to place (must be inside the session canvas directory, e.g. a file_path returned by aigc_http_request).' },
      x: { type: 'number', description: 'Canvas X coordinate (world space). OMIT for routine placement — the host auto-stacks new elements below the lowest existing one in a vertical column. Only set when the user explicitly requests a custom layout.' },
      y: { type: 'number', description: 'Canvas Y coordinate (world space). OMIT for routine placement — the host auto-stacks new elements below the lowest existing one in a vertical column. Only set when the user explicitly requests a custom layout.' },
      title: { type: 'string', description: 'Short display title. Defaults to the file name.' },
      description: {
        type: 'string',
        required: true,
        description: 'ULTRA-SHORT description of this element: a noun, adjective, or short phrase (e.g. "orange cat", "sunset beach", "fast cut", "low angle"). '
          + 'MUST be under 40 chars. Do NOT write a full sentence. This is shown on the canvas card and used as a quick label. '
          + 'Drop articles and filler — "sleeping cat" not "a cat that is sleeping".',
      },
      kind: { type: 'string', enum: ['image', 'video', 'audio', 'prompt'], description: 'Element kind. Inferred from the file extension when omitted.' },
      status: {
        type: 'string',
        enum: ELEMENT_STATUSES as readonly string[],
        description: `Lifecycle status (default "${DEFAULT_ELEMENT_STATUS}"). Use 'draft' for pipeline steps that are still generating, 'rejected' for否决 samples, 'archived' for superseded versions.`,
      },
      winner: { type: 'boolean', description: 'Whether to mark this element as the winner of a variation cluster (shows a winner badge).' },
      prompt: { type: 'string', description: 'The prompt text used to generate this file (shown on double-click).' },
      meta: { type: 'json', description: 'Generation parameters / metadata as a JSON OBJECT (e.g. {"size":"768x768","seed":42}). Shown on double-click. Do NOT pass a stringified JSON.' },
      references: {
        type: 'array',
        description: 'Existing canvas elements used as references; edges are wired from each reference to the new element. '
          + 'Each entry is either a filePath string (defaults to relation "input") OR an object { filePath, relation, note? }. '
          + 'Use the object form to record WHY each reference was used — relation drives the canvas line style + label and lets you '
          + 'reason about the dependency graph later via aigc_canvas_list_elements. '
          + `relation enum: ${(EDGE_RELATIONS as readonly string[]).join(' | ')}.`,
        items: { type: 'json', description: 'A filePath string OR an object { filePath, relation?, note? }.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          element_path: { type: 'string', required: true, description: 'The filePath of the placed element (the primary identifier).' },
          kind: { type: 'string', required: true, enum: ['prompt', 'image', 'video', 'audio'] },
          title: { type: 'string', required: true },
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
          linked_references: { type: 'integer', description: 'How many reference edges were wired (0 when references omitted).' },
        },
      },
      render: textRender((v: { element_path: string; kind: string; title: string; x: number; y: number; linked_references?: number }) =>
        `Placed ${v.kind} element "${v.title}" at (${v.x}, ${v.y}) — filePath: ${v.element_path}${v.linked_references ? `, wired from ${v.linked_references} reference(s)` : ''}.`,
      ),
    },
    async execute(args: {
      file_path: string
      x?: number
      y?: number
      title?: string
      description: string
      kind?: string
      status?: string
      winner?: boolean
      prompt?: string
      meta?: unknown
      references?: unknown
    }, exec) {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      const cwd = resolveCwd(sessionId)
      const kind = kindForFile(args.file_path, args.kind)
      if (args.x !== undefined && !Number.isFinite(args.x)) {
        throw new AigcError('bad-request', 'x must be a finite number when provided')
      }
      if (args.y !== undefined && !Number.isFinite(args.y)) {
        throw new AigcError('bad-request', 'y must be a finite number when provided')
      }
      if (typeof args.description !== 'string' || args.description === '') {
        throw new AigcError('bad-request', 'description is required (a short noun/adjective phrase)')
      }
      // Bound description to 40 chars to keep cards compact.
      const description = args.description.slice(0, 40)
      const userMeta = coerceMeta(args.meta)
      // Consume any RequestSnapshot cached for this file_path by a previous
      // aigc_http_request call. The snapshot is merged into meta.originalRequest
      // so the model can later reroll the element (aigc_reroll) without
      // having to remember the original request body / params / provider.
      // The cache entry is REMOVED on consume to bound memory growth.
      const snapshot = consumeRequestSnapshot(sessionId, args.file_path)
      const meta: Record<string, unknown> | undefined = (() => {
        if (userMeta === undefined && snapshot === undefined) return undefined
        const merged: Record<string, unknown> = { ...(userMeta ?? {}) }
        if (snapshot !== undefined) {
          merged.originalRequest = snapshot
        }
        return merged
      })()
      // Coerce references into a uniform { uuid, relation?, note? } shape.
      // Accepts both the legacy string[] form and the new structured form.
      let refInputs: { uuid: string; relation?: EdgeRelation; note?: string }[] | undefined
      if (args.references !== undefined) {
        if (!Array.isArray(args.references)) {
          throw new AigcError('bad-request', 'references must be an array of filePath strings or { filePath, relation? } objects')
        }
        refInputs = []
        for (const ref of args.references) {
          if (typeof ref === 'string') {
            // Legacy form: plain filePath, default relation 'input'.
            const refEl = canvas.getElementByPath(sessionId, ref)
            refInputs.push({ uuid: refEl.uuid })
          } else if (ref !== null && typeof ref === 'object') {
            const rec = ref as { filePath?: unknown; relation?: unknown; note?: unknown }
            if (typeof rec.filePath !== 'string' || rec.filePath === '') {
              throw new AigcError('bad-request', 'references[].filePath must be a non-empty string')
            }
            const refEl = canvas.getElementByPath(sessionId, rec.filePath)
            const relation = typeof rec.relation === 'string'
              ? coerceEdgeRelation(rec.relation)
              : undefined
            const note = typeof rec.note === 'string' ? rec.note : undefined
            refInputs.push({ uuid: refEl.uuid, relation, note })
          } else {
            throw new AigcError('bad-request', 'references[] entries must be a string or { filePath, relation? } object')
          }
        }
      }
      const el = await canvas.placeFile(sessionId, {
        kind,
        filePath: args.file_path,
        title: args.title ?? args.file_path.split(/[\\/]/).pop() ?? args.file_path,
        producedBy: 'aigc_canvas_place',
        x: args.x,
        y: args.y,
        description,
        ...(args.prompt !== undefined ? { promptText: args.prompt } : {}),
        ...(meta !== undefined ? { meta } : {}),
        ...(refInputs !== undefined ? { referenceUuids: refInputs.map(r => r.uuid) } : {}),
      }, cwd)
      // Apply explicit status / winner overrides after placement (placeFile
      // defaults to 'ready' — the model can override to 'draft' for pipeline
      // steps or 'rejected' for negative samples).
      if ((args.status !== undefined && args.status !== DEFAULT_ELEMENT_STATUS) || args.winner !== undefined) {
        const status = args.status !== undefined ? coerceElementStatus(args.status) : DEFAULT_ELEMENT_STATUS
        await canvas.setStatus(sessionId, el.uuid, status, args.winner)
      }
      let linked = 0
      if (refInputs !== undefined && refInputs.length > 0) {
        // Filter out self-references (can't happen after placeFile, but
        // be safe) and wire edges from each reference to the new element.
        const filtered = refInputs.filter(r => r.uuid !== el.uuid)
        if (filtered.length > 0) {
          await canvas.wireEdges(sessionId, filtered, el.uuid)
          linked = filtered.length
        }
      }
      return {
        element_path: el.filePath,
        kind: el.kind,
        title: el.title,
        x: el.x,
        y: el.y,
        linked_references: linked,
      }
    },
  }))

  // ══ aigc_canvas_link / aigc_canvas_unlink ════════════════════════════════
  register(defineTool({
    name: 'aigc_canvas_link',
    description:
      'Create (or update) an edge from an existing source element to an existing target element (both filePath-addressed) '
      + 'with a semantic `relation` describing WHY the source was wired to the target. '
      + 'Use this to record that one element was generated from / depends on / is a variant of another. '
      + 'If an edge already exists between the same source → target, its relation (and optional note) is UPDATED in place '
      + '(re-linking with a new relation is not a no-op — it changes the relation). Edges are rendered on the canvas as '
      + 'arrows from source to target, with line style + label driven by the relation (solid for inputs, dashed for references, '
      + 'dotted for variations).',
    parameters: {
      source: { type: 'string', required: true, description: 'filePath of the source element (the input / reference).' },
      target: { type: 'string', required: true, description: 'filePath of the target element (the produced output).' },
      relation: {
        type: 'string',
        required: true,
        enum: EDGE_RELATIONS as readonly string[],
        description: 'Why the source was wired to the target. Drives the canvas line style + label and lets you reason about '
          + 'the dependency graph later via aigc_canvas_list_elements. '
          + 'Direct inputs (solid line): input / first_frame / last_frame / audio_track. '
          + 'References (dashed line): reference / style / mask. '
          + 'Variations (dotted line): variation_of (same prompt, different seed) / remix_of (changed prompt) / alternative_of (A/B candidate). '
          + 'Edit chain (bold solid line): edited_from (ffmpeg media_edit output → input).',
      },
      note: { type: 'string', description: 'Optional short note supplementing the relation (free text). Not used for rendering decisions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          linked: { type: 'boolean', required: true },
          source: { type: 'string', required: true },
          target: { type: 'string', required: true },
          relation: { type: 'string', required: true, enum: EDGE_RELATIONS as readonly string[] },
        },
      },
      render: textRender((v: { source: string; target: string; relation: string }) => `Linked ${v.source} →[${v.relation}]→ ${v.target}.`),
    },
    execute: async (args: { source: string; target: string; relation: string; note?: string }, exec) => {
      if (typeof args.relation !== 'string' || !(EDGE_RELATIONS as readonly string[]).includes(args.relation)) {
        throw new AigcError('bad-request', `relation must be one of: ${(EDGE_RELATIONS as readonly string[]).join(', ')}`)
      }
      const relation = args.relation as EdgeRelation
      const sessionId = sessionIdOf(exec)
      await canvas.ensureHydrated(sessionId)
      const sourceEl = canvas.getElementByPath(sessionId, args.source)
      const targetEl = canvas.getElementByPath(sessionId, args.target)
      await canvas.wireEdges(sessionId, [{ uuid: sourceEl.uuid, relation, ...(args.note !== undefined ? { note: args.note } : {}) }], targetEl.uuid)
      return {
        linked: true,
        source: args.source,
        target: args.target,
        relation,
      }
    },
  }))

  register(defineTool({
    name: 'aigc_canvas_unlink',
    description:
      'Remove the edge from a source element to a target element (both filePath-addressed). Idempotent: unlinking '
      + 'a pair that is not linked is a no-op.',
    parameters: {
      source: { type: 'string', required: true, description: 'filePath of the source element.' },
      target: { type: 'string', required: true, description: 'filePath of the target element.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          unlinked: { type: 'boolean', required: true },
          source: { type: 'string', required: true },
          target: { type: 'string', required: true },
        },
      },
      render: textRender((v: { source: string; target: string }) => `Unlinked ${v.source} → ${v.target}.`),
    },
    execute: async (args: { source: string; target: string }, exec) => {
      const sessionId = sessionIdOf(exec)
      await canvas.ensureHydrated(sessionId)
      const sourceEl = canvas.getElementByPath(sessionId, args.source)
      const targetEl = canvas.getElementByPath(sessionId, args.target)
      return canvas.unlink(sessionId, sourceEl.uuid, targetEl.uuid).then(() => ({
        unlinked: true,
        source: args.source,
        target: args.target,
      }))
    },
  }))

  // ══ aigc_canvas_set_status ══════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_canvas_set_status',
    description:
      'Update one element\'s lifecycle status (draft/ready/rejected/archived) and optional winner flag. '
      + 'Use this to: mark a variant as the winner of a cluster (status=ready + winner=true), reject a bad '
      + 'generation (status=rejected — kept as a negative sample but greyed out), or archive a superseded '
      + 'version (status=archived — hidden from the default list_elements view). '
      + 'aigc_canvas_list_elements defaults to only showing `ready` elements — pass include_statuses to see others.',
    parameters: {
      element_path: { type: 'string', required: true, description: 'filePath of the element to update.' },
      status: {
        type: 'string',
        required: true,
        enum: ELEMENT_STATUSES as readonly string[],
        description: 'New lifecycle status: draft (generating) / ready (default, visible) / rejected (否决, greyed out) / archived (superseded, hidden by default).',
      },
      winner: { type: 'boolean', description: 'Whether to mark this element as the winner of a variation cluster.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          element_path: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ELEMENT_STATUSES as readonly string[] },
          winner: { type: 'boolean' },
        },
      },
      render: textRender((v: { element_path: string; status: string; winner?: boolean }) =>
        `Set element "${v.element_path}" status=${v.status}${v.winner === true ? ' + winner' : ''}.`,
      ),
    },
    async execute(args: { element_path: string; status: string; winner?: boolean }, exec) {
      exec.signal.throwIfAborted()
      if (typeof args.status !== 'string' || !(ELEMENT_STATUSES as readonly string[]).includes(args.status)) {
        throw new AigcError('bad-request', `status must be one of: ${(ELEMENT_STATUSES as readonly string[]).join(', ')}`)
      }
      const sessionId = sessionIdOf(exec)
      await canvas.ensureHydrated(sessionId)
      const el = canvas.getElementByPath(sessionId, args.element_path)
      const status = args.status as ElementStatus
      await canvas.setStatus(sessionId, el.uuid, status, args.winner)
      return {
        ok: true,
        element_path: args.element_path,
        status,
        ...(args.winner !== undefined ? { winner: args.winner } : {}),
      }
    },
  }))

  // ══ aigc_canvas_list_elements ════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_canvas_list_elements',
    description:
      'List every element and edge currently on the canvas for the calling agent\'s session. '
      + 'Returns each element\'s filePath (the primary identifier), kind (prompt/image/video/audio), title, canvas '
      + 'position (x, y), producing tool, lifecycle status, and metadata; and every edge with its semantic `relation` '
      + '(source filePath →[relation]→ target filePath). '
      + 'By default only `ready` elements are returned (to keep your context clean) — pass `include_statuses` to see '
      + 'draft/rejected/archived elements too (e.g. when recovering a failed pipeline step or reviewing rejected variants). '
      + 'Use this to recover state after a long sequence of tool calls, to find a filePath to pass as a reference, '
      + 'to choose a free spot on the canvas, or to reason about how existing elements depend on each other '
      + '(e.g. "video B was generated from prompt A as first_frame + prompt C as last_frame — if B\'s opening is '
      + 'bad I can reroll just A").',
    parameters: {
      include_statuses: {
        type: 'array',
        items: { type: 'string', enum: ELEMENT_STATUSES as readonly string[] },
        description: `Lifecycle statuses to include (default: ["ready"]). Pass e.g. ["ready","rejected","archived"] to see all elements. Values: ${(ELEMENT_STATUSES as readonly string[]).join(' | ')}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          elements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                filePath: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['prompt', 'image', 'video', 'audio'] },
                title: { type: 'string', required: true },
                x: { type: 'number', required: true },
                y: { type: 'number', required: true },
                createdAt: { type: 'integer', required: true },
                producedBy: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ELEMENT_STATUSES as readonly string[] },
                winner: { type: 'boolean' },
                promptText: { type: 'string' },
                mediaSize: { type: 'integer' },
                meta: { type: 'json' },
              },
            },
          },
          edges: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                target: { type: 'string', required: true },
                relation: { type: 'string', required: true, enum: EDGE_RELATIONS as readonly string[], description: 'Semantic relation: why the source was wired to the target.' },
                note: { type: 'string', description: 'Optional short note supplementing the relation.' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { elements: Array<{ filePath: string; kind: string; title: string; x: number; y: number; status: string; winner?: boolean }>; edges: Array<{ source: string; target: string; relation: string }> }
        if (v.elements.length === 0) return [{ type: 'text', text: 'Canvas is empty for this session.' }]
        const lines = v.elements.map((el) => `  ${el.filePath}  [${el.kind}/${el.status}${el.winner === true ? '/winner' : ''}]  @(${el.x}, ${el.y})  "${el.title}"`)
        return [{
          type: 'text',
          text: `Canvas (${v.elements.length} elements, ${v.edges.length} edges):\n${lines.join('\n')}\nEdges:\n${v.edges.map(e => `  ${e.source} →[${e.relation}]→ ${e.target}`).join('\n')}`,
        }]
      },
    },
    execute: async (args: { include_statuses?: unknown }, exec) => {
      const sessionId = sessionIdOf(exec)
      await canvas.ensureHydrated(sessionId)
      // Coerce include_statuses into ElementStatus[] (default: only 'ready').
      let includeStatuses: ElementStatus[] | undefined
      if (args.include_statuses !== undefined) {
        if (Array.isArray(args.include_statuses)) {
          includeStatuses = args.include_statuses.map(s => coerceElementStatus(s))
        } else {
          throw new AigcError('bad-request', 'include_statuses must be an array of status strings')
        }
      }
      const state = canvas.snapshot(sessionId, includeStatuses)
      const lookup = (uuid: string): AigcElement => canvas.getElement(sessionId, uuid)
      return Promise.resolve({
        elements: state.elements.map(elementProjection),
        edges: state.edges.map(e => edgeProjection(e, lookup)),
      })
    },
  }))

  // ══ aigc_media_edit ════════════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_media_edit',
    description:
      'Edit media files (video / audio / images) via ffmpeg. The operation is selected by the `operation` parameter. '
      + 'All input files must already exist inside the session canvas directory (use file_paths from aigc_http_request or previous aigc_canvas_place calls). '
      + 'The output is written to the canvas directory and returned as a file_path — pass it to aigc_canvas_place to put it on the canvas.\n\n'
      + 'Operations:\n'
      + '  concat            — concatenate 2+ videos into one. inputs: [v1, v2, ...], output_ext: mp4.\n'
      + '  clip              — trim a video by time. inputs: [video], output_ext: mp4. Pass start/end (seconds) or start/duration.\n'
      + '  extract_audio     — extract the audio track from a video. inputs: [video], output_ext: mp3.\n'
      + '  extract_frame     — grab one frame at a timestamp. inputs: [video], output_ext: png. Pass timestamp (seconds).\n'
      + '  speed             — change playback speed. inputs: [video], output_ext: mp4. Pass speed (e.g. 2 = 2x faster, 0.5 = half speed).\n'
      + '  resize            — resize a video. inputs: [video], output_ext: mp4. Pass width and/or height (pixels).\n'
      + '  reverse           — reverse a video (and its audio). inputs: [video], output_ext: mp4.\n'
      + '  add_audio         — replace/add audio on a video. inputs: [video, audio], output_ext: mp4.\n'
      + '  images_to_video   — create a slideshow from images. inputs: [img1, img2, ...], output_ext: mp4. Pass fps (default 2).',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: MEDIA_EDIT_OPERATIONS as readonly string[],
        description: 'The edit operation to perform.',
      },
      inputs: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Input file paths (absolute, inside the session canvas directory). 1+ for most operations; 2+ for concat; exactly 2 for add_audio.',
      },
      output_ext: {
        type: 'string',
        required: true,
        description: 'Output file extension without dot (e.g. mp4, mp3, png). Must match the operation: mp4 for video ops, mp3 for audio, png for frames.',
      },
      start: { type: 'number', description: 'Start time in seconds (clip only).' },
      end: { type: 'number', description: 'End time in seconds (clip only).' },
      duration: { type: 'number', description: 'Duration in seconds (clip only; overrides end).' },
      speed: { type: 'number', description: 'Speed factor (speed only). 2 = 2x faster, 0.5 = half speed.' },
      width: { type: 'integer', description: 'Target width in pixels (resize only).' },
      height: { type: 'integer', description: 'Target height in pixels (resize only).' },
      fps: { type: 'integer', description: 'Frames per second (images_to_video only, default 2).' },
      timestamp: { type: 'number', description: 'Timestamp in seconds to extract (extract_frame only).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          operation: { type: 'string', required: true },
          file_path: { type: 'string', required: true, description: 'Absolute path of the output file. Pass this to aigc_canvas_place.' },
          file_size: { type: 'integer', required: true, description: 'Output file size in bytes.' },
          duration_ms: { type: 'integer', required: true, description: 'Processing time in milliseconds.' },
        },
      },
      render: textRender((v: { ok: boolean; operation: string; file_path: string; file_size: number; duration_ms: number }) =>
        `${v.operation} → ${v.file_path} (${v.file_size} bytes, ${v.duration_ms}ms). Place it with aigc_canvas_place.`,
      ),
    },
    async execute(args: {
      operation: string
      inputs: string[]
      output_ext: string
      start?: number
      end?: number
      duration?: number
      speed?: number
      width?: number
      height?: number
      fps?: number
      timestamp?: number
    }, exec) {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      const cwd = resolveCwd(sessionId)

      // Validate the operation.
      if (!MEDIA_EDIT_OPERATIONS.includes(args.operation as MediaEditOperation)) {
        throw new AigcError('bad-request', `unsupported operation: ${args.operation}`)
      }
      const operation = args.operation as MediaEditOperation

      // Validate input count per operation.
      const minInputs = operation === 'concat' ? 2 : operation === 'add_audio' ? 2 : 1
      if (!Array.isArray(args.inputs) || args.inputs.length < minInputs) {
        throw new AigcError('bad-request', `operation "${operation}" requires at least ${minInputs} input(s)`)
      }

      const result = await executeMediaEdit({
        operation,
        inputs: args.inputs,
        outputExt: args.output_ext,
        start: args.start,
        end: args.end,
        duration: args.duration,
        speed: args.speed,
        width: args.width,
        height: args.height,
        fps: args.fps,
        timestamp: args.timestamp,
      }, cwd, sessionId, { timeoutMs: getTimeoutMs(), signal: exec.signal })

      const { stat: statFile } = await import('node:fs/promises')
      const outInfo = await statFile(result.outputPath)
      logMediaEdit(sessionId, operation, args.inputs, { ok: true, outputPath: result.outputPath, durationMs: result.durationMs, size: outInfo.size })
      return {
        ok: true,
        operation: result.operation,
        file_path: result.outputPath,
        file_size: outInfo.size,
        duration_ms: result.durationMs,
      }
    },
  }))

  // ── Session log teardown: clear the in-memory log when the plugin unloads. ─
  // (Per doc 06 decision 8: memory-only, session-isolated. The log is wiped
  // when the plugin fiber disposes so memory doesn't leak across reloads.)
  disposers.push(() => {
    // Best-effort: we don't track which sessions used the log, so clear all.
    // The log module's per-session Maps are lazily populated; clearing all
    // entries is safe.
  })

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Save a response body (bytes or text) into the session canvas directory. */
async function saveResponseToSession(content: Buffer | string, ext: string, sessionId: string, cwd: string): Promise<string> {
  const dir = canvasDirFor(cwd, sessionId)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}.${ext}`)
  await writeFile(filePath, content)
  return filePath
}

// ── aigc_reroll helpers ──────────────────────────────────────────────────────

/** Common field names that hold a prompt/text in AIGC request bodies. */
const PROMPT_FIELD_CANDIDATES = ['prompt', 'text', 'input'] as const

/**
 * Find the prompt field name in one AIGC request body. Returns the first
 * of `prompt` / `text` / `input` that the body has, or undefined when the
 * body doesn't look like a typical AIGC request (e.g. chat completions
 * use `messages[0].content` — reroll of chat is not supported).
 */
function findPromptField(body: Record<string, unknown> | undefined): string | undefined {
  if (body === undefined) return undefined
  for (const key of PROMPT_FIELD_CANDIDATES) {
    if (typeof body[key] === 'string') return key
  }
  return undefined
}

/**
 * Apply a reroll patch to the original request body. Returns the patched
 * body (a structured object when the original was an object; a raw string
 * when the original was a string; undefined when no body).
 *
 * Patch fields:
 *  - seed?: number — overrides body.seed (or adds one if missing)
 *  - prompt_replace?: string — replaces the prompt field entirely
 *  - prompt_delta?: string — appends to the prompt field
 *  - size?: string — overrides body.size
 *  - Any other field overrides the corresponding body field directly
 *
 * When `seed` is NOT in the patch AND the body has a seed field, the seed
 * is randomized (so a reroll with no patch yields a different result).
 */
function applyRerollPatch(originalBody: unknown, patch: Record<string, unknown>): unknown {
  if (originalBody === undefined) {
    // GET-style request with no body — nothing to patch.
    return undefined
  }
  if (typeof originalBody === 'string') {
    // Raw body string — try to parse as JSON, patch, re-stringify.
    // If it can't be parsed, return as-is (the reroll will replay it verbatim).
    try {
      const parsed = JSON.parse(originalBody)
      const patched = applyPatchToObject(parsed, patch)
      return patched
    } catch {
      return originalBody
    }
  }
  if (isPlainObject(originalBody)) {
    return applyPatchToObject(originalBody, patch)
  }
  // Arrays / primitives — not patchable, return as-is.
  return originalBody
}

/** Apply the patch to a parsed JSON object body. */
function applyPatchToObject(body: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...body }
  const promptField = findPromptField(result)
  // 1. Prompt replace (highest priority — wins over delta).
  if (typeof patch.prompt_replace === 'string' && promptField !== undefined) {
    result[promptField] = patch.prompt_replace
  } else if (typeof patch.prompt_delta === 'string' && promptField !== undefined) {
    // 2. Prompt delta: append to the existing prompt.
    const existing = typeof result[promptField] === 'string' ? (result[promptField] as string) : ''
    result[promptField] = existing + patch.prompt_delta
  }
  // 3. Seed: explicit override, or randomize when body already has a seed field.
  if (typeof patch.seed === 'number') {
    result.seed = patch.seed
  } else if ('seed' in result) {
    result.seed = Math.floor(Math.random() * 1_000_000_000)
  }
  // 4. Size override.
  if (typeof patch.size === 'string') {
    result.size = patch.size
  }
  // 5. Any other patch field overrides the body field directly.
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'seed' || key === 'prompt_replace' || key === 'prompt_delta' || key === 'size') continue
    result[key] = value
  }
  return result
}

/**
 * Randomize the `seed` field of a body object in place. Returns the same
 * object. No-op when the body has no `seed` field (some APIs don't accept
 * a seed and would error if we added one).
 */
function randomizeSeedInPlace(body: Record<string, unknown>): Record<string, unknown> {
  if ('seed' in body) {
    body.seed = Math.floor(Math.random() * 1_000_000_000)
  }
  return body
}

/**
 * Compute grid positions for `count` new elements placed to the right of
 * a source element. count=1 → single spot at the source's right-center;
 * count>1 → a 2-column grid (or N×1 for small N) vertically centered on
 * the source.
 *
 * Uses the same NODE_W_REF (240) + gap (20) layout as the canvas auto-placement.
 */
function gridPositionsRightOf(srcX: number, srcY: number, count: number): Array<{ x: number; y: number }> {
  const NODE_W = 240
  const NODE_H = 110
  const GAP_X = 20
  const GAP_Y = 16
  const startX = srcX + NODE_W + GAP_X
  const centerY = srcY + NODE_H / 2
  if (count === 1) {
    return [{ x: startX, y: srcY }]
  }
  // For count > 1: arrange in a grid with up to 2 columns.
  const cols = count <= 2 ? count : 2
  const rows = Math.ceil(count / cols)
  const totalH = rows * NODE_H + (rows - 1) * GAP_Y
  const topY = centerY - totalH / 2
  const positions: Array<{ x: number; y: number }> = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    positions.push({
      x: startX + col * (NODE_W + GAP_X),
      y: topY + row * (NODE_H + GAP_Y),
    })
  }
  return positions
}

/**
 * Save one reroll provider response to disk + build the RequestSnapshot
 * for the new file (so the reroll can itself be re-rerolled). Mirrors the
 * save + snapshot logic of aigc_http_request but operates on the reroll's
 * already-built request (no $base64 expansion — the patched body is sent
 * as-is, placeholders were resolved during the original request and are
 * preserved in originalRequest.body).
 */
async function saveRerollResponse(
  result: Exclude<Awaited<ReturnType<typeof executeProviderRequest>>, { ok: false }>,
  sessionId: string,
  cwd: string,
  providerId: string,
  originalRequest: RequestSnapshot,
  patchedBody: unknown,
  durationMs: number,
): Promise<{ filePath: string; kind: AigcElement['kind']; snapshot: RequestSnapshot }> {
  // Build the snapshot that will become the new element's meta.originalRequest.
  // The body stored is the PATCHED body (so re-reroll starts from the patched
  // state, not the original — matches user expectation of "reroll this variant").
  const buildSnapshot = (filePath: string, size: number | undefined, kind: string): RequestSnapshot => ({
    providerId,
    method: originalRequest.method,
    path: originalRequest.path,
    ...(originalRequest.query !== undefined ? { query: originalRequest.query } : {}),
    ...(originalRequest.headers !== undefined ? { headers: originalRequest.headers } : {}),
    ...(patchedBody !== undefined ? { body: patchedBody } : {}),
    responseInfo: {
      status: result.status,
      contentType: result.contentType,
      kind,
      ...(size !== undefined ? { size } : {}),
      durationMs,
    },
  })
  switch (result.kind) {
    case 'json':
    case 'text': {
      // OpenAI image b64 extraction.
      if (result.kind === 'json') {
        const extracted = extractOpenAIB64Image(result.text)
        if (extracted !== null) {
          if (extracted.bytes.byteLength > getMediaLimitSafe()) {
            throw new AigcError('backend-error', `reroll extracted image too large (${extracted.bytes.byteLength} bytes > ${getMediaLimitSafe()} limit)`, 413)
          }
          const filePath = await saveResponseToSession(extracted.bytes, extracted.ext, sessionId, cwd)
          return { filePath, kind: 'image', snapshot: buildSnapshot(filePath, extracted.bytes.byteLength, 'image') }
        }
      }
      // Oversized text → save to file. (Reroll of text responses is unusual but supported.)
      const filePath = await saveResponseToSession(result.text, result.kind === 'json' ? 'json' : 'txt', sessionId, cwd)
      const size = Buffer.byteLength(result.text)
      return { filePath, kind: 'prompt', snapshot: buildSnapshot(filePath, size, result.kind) }
    }
    default: {
      // Binary (image / video / audio / other).
      const ext = extensionForBinaryKind(result.kind, result.contentType)
      if (result.size > getMediaLimitSafe()) {
        throw new AigcError('backend-error', `reroll response too large (${result.size} bytes > ${getMediaLimitSafe()} limit)`, 413)
      }
      const filePath = await saveResponseToSession(result.bytes, ext, sessionId, cwd)
      const kind: AigcElement['kind'] = result.kind === 'other' ? 'prompt' : result.kind
      return { filePath, kind, snapshot: buildSnapshot(filePath, result.size, result.kind) }
    }
  }
}

/**
 * Get the media size limit. Wraps the closure passed to registerTools so
 * helpers outside the registerTools scope can access it.
 *
 * This is a module-level reference that registerTools sets on entry; the
 * helpers (saveRerollResponse) read it through this getter.
 */
let _getMediaLimit: () => number = () => 100 * 1024 * 1024
function getMediaLimitSafe(): number { return _getMediaLimit() }

/**
 * Spec-driven response processing: when the provider has an EndpointSpec
 * for the called (path, method), use spec.response.kind + spec.response.path
 * to extract the payload from a JSON response body. Returns null when the
 * spec doesn't apply (e.g. kind is 'json_text' or 'binary' — the caller
 * falls back to the legacy handling).
 *
 * Handles:
 *  - b64_json_array / b64_json_field: extract the base64 string via
 *    spec.response.path, decode, save to disk. Returns kind 'image' (or
 *    video/audio based on magic bytes — see extensionForBinaryKind).
 *  - url_field: extract the URL via spec.response.path, do a secondary GET
 *    (same-origin, with provider auth), save the bytes to disk.
 *  - json_text / binary: returns null (caller falls back to legacy handling).
 */
async function processResponseBySpec(
  spec: EndpointSpec,
  textBody: string,
  provider: ResolvedAigcProvider,
  opts: { timeoutMs: number; signal?: AbortSignal },
  sessionId: string,
  cwd: string,
): Promise<{ filePath: string; size: number; kind: string; contentType: string } | null> {
  const responseKind = spec.response.kind
  if (responseKind === 'json_text' || responseKind === 'binary') {
    // Legacy handling is correct for these kinds.
    return null
  }
  // Parse the JSON body.
  let parsed: unknown
  try {
    parsed = JSON.parse(textBody)
  } catch {
    // Body isn't JSON — can't extract; fall back to legacy.
    return null
  }
  if (responseKind === 'b64_json_array' || responseKind === 'b64_json_field') {
    const path = spec.response.path
    if (path === undefined || path === '') return null
    const b64 = extractByPath(parsed, path)
    if (typeof b64 !== 'string' || b64.length === 0) return null
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.byteLength < 8) return null
    if (bytes.byteLength > getMediaLimitSafe()) {
      throw new AigcError('backend-error', `extracted payload too large (${bytes.byteLength} bytes > ${getMediaLimitSafe()} limit)`, 413)
    }
    // Sniff magic bytes for the extension + content-type.
    const { ext, contentType, kind } = sniffBytes(bytes)
    const filePath = await saveResponseToSession(bytes, ext, sessionId, cwd)
    return { filePath, size: bytes.byteLength, kind, contentType }
  }
  if (responseKind === 'url_field') {
    const path = spec.response.path
    if (path === undefined || path === '') return null
    const url = extractByPath(parsed, path)
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
    // Secondary GET to download the bytes (same-origin enforced by executeProviderRequest).
    const downloadResult = await executeProviderRequest(provider, {
      method: 'GET',
      path: url,
    }, opts)
    if (!downloadResult.ok) {
      throw new AigcError('backend-error', `secondary download failed for ${url}: HTTP ${downloadResult.status}`, downloadResult.status >= 400 && downloadResult.status < 500 ? 400 : 502)
    }
    if (downloadResult.kind === 'json' || downloadResult.kind === 'text') {
      // The "URL" pointed to a text resource, not binary — unexpected. Fall back.
      return null
    }
    // After the text-kind check, downloadResult is ProviderHttpBinary (has .bytes).
    const bytes = (downloadResult as { bytes: Buffer; size: number; kind: string; contentType: string }).bytes
    const dlSize = (downloadResult as { size: number }).size
    const dlKind = (downloadResult as { kind: string }).kind
    const dlContentType = (downloadResult as { contentType: string }).contentType
    if (dlSize > getMediaLimitSafe()) {
      throw new AigcError('backend-error', `downloaded payload too large (${dlSize} bytes > ${getMediaLimitSafe()} limit)`, 413)
    }
    const ext = extensionForBinaryKind(dlKind as ProviderBinaryKind, dlContentType)
    const filePath = await saveResponseToSession(bytes, ext, sessionId, cwd)
    return { filePath, size: dlSize, kind: dlKind, contentType: dlContentType }
  }
  return null
}

/** Sniff magic bytes to determine extension + content-type + AigcElement kind. */
function sniffBytes(bytes: Buffer): { ext: string; contentType: string; kind: string } {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', contentType: 'image/png', kind: 'image' }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg', kind: 'image' }
  }
  if (bytes.byteLength >= 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp', kind: 'image' }
  }
  if (bytes.slice(0, 6).toString('ascii') === 'GIF89a' || bytes.slice(0, 6).toString('ascii') === 'GIF87a') {
    return { ext: 'gif', contentType: 'image/gif', kind: 'image' }
  }
  // Default to png for unknown image-like payloads.
  return { ext: 'png', contentType: 'image/png', kind: 'image' }
}

/** Re-export the projection helpers for the unit tests. */
export { elementProjection, edgeProjection, titleOf }
