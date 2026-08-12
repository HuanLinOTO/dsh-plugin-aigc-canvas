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
