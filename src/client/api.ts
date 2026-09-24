/**
 * Typed fetch wrapper over the /aigc-canvas JSON API, plus the settings
 * form value types the settings page consumes through `ctx.configForms`
 * (dsh 0.1.7-rc.1 DSH-0.1.7-J1-27).
 */
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

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

/** One canvas edge (source filePath → target filePath). */
export interface AigcEdge {
  source: string
  target: string
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

/**
 * The settings form value served under the `dsh-aigc-canvas` entry id:
 * the entry's volatile fields (only `providers` is volatile).
 */
export interface AigcFormValue {
  providers: RuntimeProvider[]
}

/** Sync snapshot of the plugin's settings form (status / value / revision / writable). */
export type AigcFormSnapshot = ConfigFormSnapshot<AigcFormValue>

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
