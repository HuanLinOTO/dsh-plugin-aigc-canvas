/**
 * Typed fetch wrapper over the /aigc-canvas JSON API.
 */

/** One wire failure. */
export class AigcApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Element kind (matches the host enum). */
export type AigcElementKind = 'prompt' | 'image' | 'video' | 'audio'

/** Element lifecycle status (matches the host ElementStatus). */
export type ElementStatus = 'draft' | 'ready' | 'rejected' | 'archived'

/**
 * Semantic relation on an edge (matches the host EdgeRelation enum).
 * Drives the canvas line style + label. Optional on the client side for
 * backward compat with old canvas.json / WS pushes that predate the field
 * (defaults to 'input' in renderEdge).
 *
 * @see EdgeRelation in canvas-registry.ts for the full description.
 */
export type EdgeRelation =
  | 'input'
  | 'first_frame'
  | 'last_frame'
  | 'audio_track'
  | 'reference'
  | 'style'
  | 'mask'
  | 'variation_of'
  | 'remix_of'
  | 'alternative_of'
  | 'edited_from'

/** One canvas element (client view). */
export interface AigcElement {
  filePath: string
  uuid?: string
  sessionId?: string
  kind: AigcElementKind
  title: string
  /** Canvas position, world coordinates (infinite free canvas). */
  x: number
  /** Canvas position, world coordinates (infinite free canvas). */
  y: number
  createdAt: number
  producedBy: string
  promptText?: string
  mediaSize?: number
  meta?: Record<string, unknown>
  description?: string
  /** Lifecycle status: draft / ready (default) / rejected / archived. */
  status?: ElementStatus
  /** Whether this element was marked as the winner of a variation cluster. */
  winner?: boolean
}

/** One canvas edge (source filePath → target filePath, with semantic relation). */
export interface AigcEdge {
  source: string
  target: string
  /**
   * Why the source was wired to the target. Drives line style + label:
   *  - solid: input / first_frame / last_frame / audio_track (direct inputs)
   *  - dashed: reference / style / mask (references)
   *  - dotted: variation_of / remix_of / alternative_of (variations)
   *  - bold solid: edited_from (ffmpeg edit chain)
   * Optional for backward compat; defaults to 'input' when undefined.
   */
  relation?: EdgeRelation
  /** Optional short note supplementing the relation (free text). */
  note?: string
}

/** Full canvas state for one session. */
export interface AigcCanvasState {
  sessionId: string
  elements: AigcElement[]
  edges: AigcEdge[]
}

/** One provider (wire shape, matches the host ResolvedAigcProvider). */
export interface RuntimeProvider {
  id: string
  name: string
  endpoint: string
  apiKey: string
  instructions: string
  auth: { scheme: 'bearer' | 'header' | 'query'; name: string }
  builtin: boolean
  /**
   * Structured capability catalog (per docs/product/03-provider-catalog.md).
   * Empty array = legacy auto-sniff + instructions (backward compat).
   */
  endpoints?: RuntimeEndpointSpec[]
  /** Selection priority (smaller = higher; default 100). */
  priority?: number
  /** Cost per call in USD (for cost tracking). */
  costPerCall?: number
  /** Cost per 1k tokens in USD (chat / transcribe). */
  costPerKiloToken?: number
  /** Cost per second of video/audio in USD (t2v / tts). */
  costPerSecond?: number
  /** Average latency in ms (host auto-statistic; future use). */
  avgLatencyMs?: number
  /** Quality hint: fast / balanced / quality. */
  qualityHint?: RuntimeQualityHint
}

/** Quality hint (client-side mirror of the host QualityHint enum). */
export type RuntimeQualityHint = 'fast' | 'balanced' | 'quality'

/** All QualityHint values as a readonly array (for select dropdowns). */
export const RUNTIME_QUALITY_HINTS: readonly RuntimeQualityHint[] = ['fast', 'balanced', 'quality'] as const

/** One AIGC capability (client-side mirror of the host Capability enum). */
export type RuntimeCapability =
  | 't2i' | 'i2i' | 't2v' | 'i2v' | 'fl2v' | 'ref2v'
  | 'tts' | 'music' | 'transcribe' | 'edit' | 'chat'

/** All Capability values (for select dropdowns). */
export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  't2i', 'i2i', 't2v', 'i2v', 'fl2v', 'ref2v',
  'tts', 'music', 'transcribe', 'edit', 'chat',
] as const

/** Response kind (client-side mirror of the host ResponseKind enum). */
export type RuntimeResponseKind =
  | 'b64_json_array' | 'b64_json_field' | 'binary' | 'url_field' | 'json_text'

/** All ResponseKind values (for select dropdowns). */
export const RUNTIME_RESPONSE_KINDS: readonly RuntimeResponseKind[] = [
  'b64_json_array', 'b64_json_field', 'binary', 'url_field', 'json_text',
] as const

/** HTTP method (client-side mirror of the host EndpointSpec.method). */
export type RuntimeHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH'

/** All HTTP methods (for select dropdowns). */
export const RUNTIME_HTTP_METHODS: readonly RuntimeHttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH'] as const

/** One parameter on an endpoint (client-side mirror of ParamSpec). */
export interface RuntimeParamSpec {
  name: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'image_ref' | 'video_ref' | 'audio_ref'
  required: boolean
  default?: unknown
  description?: string
}

/** All parameter types (for select dropdowns). */
export const RUNTIME_PARAM_TYPES: readonly RuntimeParamSpec['type'][] = [
  'string', 'number', 'integer', 'boolean', 'array', 'object',
  'image_ref', 'video_ref', 'audio_ref',
] as const

/** Response shape declaration (client-side mirror of ResponseSpec). */
export interface RuntimeResponseSpec {
  kind: RuntimeResponseKind
  path?: string
}

/** One provider endpoint's complete description (client-side mirror of EndpointSpec). */
export interface RuntimeEndpointSpec {
  path: string
  method: RuntimeHttpMethod
  capability: RuntimeCapability
  params?: RuntimeParamSpec[]
  response: RuntimeResponseSpec
  acceptsCanvasRef?: boolean
  notes?: string
}

/** Global settings wire shape. */
export interface RuntimeGlobalSettings {
  requestTimeoutMs: number
  mediaSizeLimit: number
}

/** Full config response (providers + global settings). */
export interface RuntimeConfig extends RuntimeGlobalSettings {
  providers: RuntimeProvider[]
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/aigc-canvas/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    throw new AigcApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new AigcApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/** Fetch the canvas state (elements + edges) for one session. */
export function fetchCanvas(sessionId: string, signal?: AbortSignal): Promise<AigcCanvasState> {
  return call<AigcCanvasState>('canvas.list', { sessionId }, signal)
}

/** Persist one element's new canvas position (after a client drag). */
export function moveCanvasElement(sessionId: string, uuid: string, x: number, y: number, signal?: AbortSignal): Promise<AigcElement> {
  return call<AigcElement>('canvas.move', { sessionId, uuid, x, y }, signal)
}

/** Delete one element from the canvas (also removes its edges). */
export function deleteCanvasElement(sessionId: string, uuid: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>('canvas.delete', { sessionId, uuid }, signal)
}

/** Upload a file (drag-dropped onto the canvas) and place it as a new element. */
export function uploadCanvasFile(sessionId: string, fileName: string, mediaBase64: string, opts?: { x?: number; y?: number; description?: string }, signal?: AbortSignal): Promise<{ ok: boolean; element: AigcElement }> {
  return call<{ ok: boolean; element: AigcElement }>('canvas.upload', { sessionId, fileName, mediaBase64, ...opts }, signal)
}

/**
 * Inject a user-role notice into the agent's next-step context
 * (non-waking). Used by the canvas UI's right-click menu and quick
 * action toolbar to ask the agent to regenerate / edit / run a
 * workflow. Per docs/product/04-ux-reliability.md §1 + §7.
 *
 * The optional `summary` is the short label shown in the agent's
 * inbox (truncated to 120 chars by the host).
 */
export function notifyAgent(sessionId: string, message: string, summary?: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  const payload: Record<string, unknown> = { sessionId, message }
  if (summary !== undefined) payload.summary = summary
  return call<{ ok: boolean }>('canvas.notify', payload, signal)
}

/**
 * Update one element's lifecycle status (draft/ready/rejected/archived)
 * and optional winner flag. Per docs/product/01-agent-autonomy.md §5
 * + docs/product/04-ux-reliability.md §1 (right-click → mark as
 * winner / rejected / archive).
 */
export function setElementStatus(sessionId: string, uuid: string, status: ElementStatus, winner?: boolean, signal?: AbortSignal): Promise<{ ok: boolean; element: AigcElement }> {
  const payload: Record<string, unknown> = { sessionId, uuid, status }
  if (winner !== undefined) payload.winner = winner
  return call<{ ok: boolean; element: AigcElement }>('canvas.set_status', payload, signal)
}

/** Fetch the full runtime config (providers + global settings). */
export function fetchConfig(signal?: AbortSignal): Promise<RuntimeConfig> {
  return call<RuntimeConfig>('config.get', {}, signal)
}

/** List all providers. */
export function listProviders(signal?: AbortSignal): Promise<{ providers: RuntimeProvider[] }> {
  return call<{ providers: RuntimeProvider[] }>('providers.list', {}, signal)
}

/** Add a new provider. */
export function addProvider(provider: RuntimeProvider, signal?: AbortSignal): Promise<{ providers: RuntimeProvider[] }> {
  return call<{ providers: RuntimeProvider[] }>('providers.add', { provider }, signal)
}

/** Update an existing provider. */
export function updateProvider(provider: RuntimeProvider, signal?: AbortSignal): Promise<{ providers: RuntimeProvider[] }> {
  return call<{ providers: RuntimeProvider[] }>('providers.update', { provider }, signal)
}

/** Remove a provider by id. */
export function removeProvider(id: string, signal?: AbortSignal): Promise<{ providers: RuntimeProvider[] }> {
  return call<{ providers: RuntimeProvider[] }>('providers.remove', { id }, signal)
}

/** Build the media URL for one element's media file (by uuid; the host resolves to the file). */
export function mediaUrlOf(sessionId: string, uuid: string, download = false): string {
  const params = new URLSearchParams({ sessionId, uuid })
  if (download) params.set('download', '1')
  return `/aigc-canvas/file?${params.toString()}`
}

/** Build the WebSocket URL for the canvas push endpoint. */
export function canvasWsUrl(sessionId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/aigc-canvas/ws/canvas?sessionId=${encodeURIComponent(sessionId)}`
}

// ── Request log (per docs/product/04-ux-reliability.md §3) ──────────────

/** One request log entry (client view; matches the host RequestLogEntry). */
export interface RequestLogEntry {
  id: number
  timestamp: number
  type: 'http' | 'media_edit'
  providerId?: string
  method?: string
  path?: string
  operation?: string
  inputs?: string[]
  status: number
  durationMs: number
  size?: number
  error?: string
  requestHeaders?: Record<string, string>
  requestQuery?: Record<string, string>
  requestBodyPreview?: string
  responseContentType?: string
  responseBodyPreview?: string
  elementPath?: string
}

/** Fetch the request log for one session (newest last). */
export function fetchRequestLog(sessionId: string, signal?: AbortSignal): Promise<{ entries: RequestLogEntry[] }> {
  return call<{ entries: RequestLogEntry[] }>('logs.list', { sessionId }, signal)
}

/** Clear the request log for one session. */
export function clearRequestLog(sessionId: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>('logs.clear', { sessionId }, signal)
}

// ── Cost tracking (per docs/product/04-ux-reliability.md §5) ─────────────

/** Per-session cost breakdown. */
export interface SessionCost {
  total: number
  byProvider: Record<string, number>
  byCapability: Record<string, number>
  callCount: number
}

/** Fetch the per-session cost summary (for the canvas header). */
export function fetchSessionCost(sessionId: string, signal?: AbortSignal): Promise<SessionCost> {
  return call<SessionCost>('cost.get', { sessionId }, signal)
}

// ── Asset library (per docs/product/04-ux-reliability.md §6) ─────────────

/** Asset category (matches the host AssetCategory enum). */
export type AssetCategory =
  | 'style-reference'
  | 'subject-reference'
  | 'prompt-template'
  | 'voice-sample'
  | 'final-product'

/** Asset file type. */
export type AssetType = 'image' | 'prompt' | 'audio' | 'video'

/** One asset in the cross-session library (client view). */
export interface LibraryAsset {
  id: string
  type: AssetType
  filePath: string
  title: string
  tags: string[]
  category: AssetCategory
  originalPrompt?: string
  sourceSessionId?: string
  sourceElementPath?: string
  createdAt: number
  metadata?: Record<string, unknown>
}

/** Optional filters for {@link fetchLibraryAssets}. */
export interface LibraryAssetFilter {
  type?: AssetType
  category?: AssetCategory
  tags?: string[]
  search?: string
}

/** List assets in the cross-session library (with optional filters). */
export function fetchLibraryAssets(filter?: LibraryAssetFilter, signal?: AbortSignal): Promise<{ assets: LibraryAsset[] }> {
  return call<{ assets: LibraryAsset[] }>('library.list', { ...(filter ?? {}) } as Record<string, unknown>, signal)
}

/** Promote one canvas element (by uuid) to the asset library. */
export function promoteAsset(sessionId: string, uuid: string, opts: { category: AssetCategory; title?: string; tags?: string[] }, signal?: AbortSignal): Promise<{ asset: LibraryAsset }> {
  return call<{ asset: LibraryAsset }>('library.promote', { sessionId, uuid, ...opts }, signal)
}

/** Remove one asset from the library (by id). Idempotent. */
export function removeAsset(assetId: string, signal?: AbortSignal): Promise<{ removed: boolean; asset_id: string }> {
  return call<{ removed: boolean; asset_id: string }>('library.remove', { asset_id: assetId }, signal)
}
