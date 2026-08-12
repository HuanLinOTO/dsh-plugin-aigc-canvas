/**
 * In-memory, session-isolated request log: records every aigc_http_request
 * + aigc_media_edit call so the user can debug failed generations from the
 * canvas UI (per docs/product/04-ux-reliability.md §3).
 *
 * Per doc 06 decision 8: memory-only, session-isolated, no disk persistence
 * (request bodies may contain sensitive content; the user can manually
 * export via the UI if needed — export is a future feature).
 *
 * Security: the log stores request headers + body + response preview for
 * debugging, but the provider apiKey is REDACTED from headers/queries before
 * storage (see redactSecrets). The agent never sees the log directly — it's
 * surfaced only through the client UI via the /aigc-canvas/api/logs.* JSON API.
 *
 * @module @dsh-external/dsh-aigc-canvas/request-log
 */
import type { ResolvedAigcProvider } from './config.js'

/** Maximum entries kept per session (older entries are dropped FIFO). */
const MAX_ENTRIES_PER_SESSION = 200

/** One log entry — either a provider HTTP request or a ffmpeg media edit. */
export interface RequestLogEntry {
  /** Unique monotonic id (for React keys + expansion state). */
  id: number
  /** Wall-clock timestamp (ms since epoch). */
  timestamp: number
  /** Entry type: 'http' for aigc_http_request, 'media_edit' for aigc_media_edit. */
  type: 'http' | 'media_edit'
  // ── http fields ────────────────────────────────────────────────────────
  /** Provider id (for http entries). Undefined for media_edit. */
  providerId?: string
  /** HTTP method (for http entries). */
  method?: string
  /** Request path (for http entries). */
  path?: string
  // ── media_edit fields ──────────────────────────────────────────────────
  /** ffmpeg operation (for media_edit entries). */
  operation?: string
  /** Input file paths (for media_edit entries). */
  inputs?: string[]
  // ── common result fields ───────────────────────────────────────────────
  /** HTTP status code (http) or ffmpeg exit code (media_edit). 0 on success. */
  status: number
  /** Round-trip duration in ms. */
  durationMs: number
  /** Response / output file size in bytes (when applicable). */
  size?: number
  /** Failure message (when status indicates an error). */
  error?: string
  // ── request details (http only, apiKey REDACTED) ───────────────────────
  /** Request headers with apiKey redacted (http only). */
  requestHeaders?: Record<string, string>
  /** Request query params with apiKey redacted (http only). */
  requestQuery?: Record<string, string>
  /** Request body preview (first ~500 chars; http only). */
  requestBodyPreview?: string
  // ── response details (http only) ───────────────────────────────────────
  /** Response Content-Type header (http only). */
  responseContentType?: string
  /** Response body preview (first ~500 chars; http only). */
  responseBodyPreview?: string
  // ── canvas link ────────────────────────────────────────────────────────
  /**
   * filePath of the canvas element produced by this request (when the
   * response was saved to disk + placed). Used by the "locate on canvas"
   * button in the log panel UI.
   */
  elementPath?: string
}

/** Per-session log storage (sessionId → entries, newest last). */
const logBySession = new Map<string, RequestLogEntry[]>()

/** Per-session monotonic id counter (so ids are unique within a session). */
const idCounterBySession = new Map<string, number>()

/** Get (or lazily create) the per-session log array. */
function sessionLog(sessionId: string): RequestLogEntry[] {
  let arr = logBySession.get(sessionId)
  if (arr === undefined) {
    arr = []
    logBySession.set(sessionId, arr)
  }
  return arr
}

/** Next monotonic id for one session. */
function nextId(sessionId: string): number {
  const next = (idCounterBySession.get(sessionId) ?? 0) + 1
  idCounterBySession.set(sessionId, next)
  return next
}

/**
 * Append one entry to the session's log. Drops the oldest entry when the
 * per-session cap is exceeded (FIFO).
 */
export function appendLogEntry(sessionId: string, entry: Omit<RequestLogEntry, 'id' | 'timestamp'>): RequestLogEntry {
  const arr = sessionLog(sessionId)
  const full: RequestLogEntry = {
    id: nextId(sessionId),
    timestamp: Date.now(),
    ...entry,
  }
  arr.push(full)
  // Cap: drop oldest entries when over the limit.
  while (arr.length > MAX_ENTRIES_PER_SESSION) {
    arr.shift()
  }
  return full
}

/** Read all log entries for one session (newest last). */
export function getLogEntries(sessionId: string): readonly RequestLogEntry[] {
  return sessionLog(sessionId)
}

/** Clear all log entries for one session. */
export function clearLogEntries(sessionId: string): void {
  logBySession.delete(sessionId)
  idCounterBySession.delete(sessionId)
}

/** Total entries across all sessions (for tests / debug). */
export function requestLogCount(): number {
  let total = 0
  for (const arr of logBySession.values()) total += arr.length
  return total
}

/** Cap on request body / response body preview size (chars). */
const PREVIEW_CAP = 500

/** Truncate a string to the preview cap. */
function previewOf(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  if (s.length <= PREVIEW_CAP) return s
  return `${s.slice(0, PREVIEW_CAP)}… (${s.length} chars total)`
}

/**
 * Redact the provider apiKey from request headers + query params before
 * storing them in the log. The auth header/query name is derived from the
 * provider's auth config:
 *  - bearer: redact the `Authorization` header value → `Bearer ***`
 *  - header: redact the header named `auth.name` (default `x-api-key`) → `***`
 *  - query:  redact the query param named `auth.name` (default `api_key`) → `***`
 *
 * Also redacts any header whose name contains "key"/"token"/"auth"/"secret"
 * (case-insensitive) as a defense-in-depth against accidentally logging
 * credentials passed as extra headers.
 */
export function redactSecrets(
  headers: Record<string, string> | undefined,
  query: Record<string, string> | undefined,
  provider: ResolvedAigcProvider,
): { headers?: Record<string, string>; query?: Record<string, string> } {
  const auth = provider.auth
  const authHeaderName = auth.scheme === 'header' ? (auth.name === '' ? 'x-api-key' : auth.name) : 'authorization'
  const authQueryName = auth.scheme === 'query' ? (auth.name === '' ? 'api_key' : auth.name) : ''
  const sensitivePattern = /key|token|auth|secret|password/i
  const redact = (src: Record<string, string> | undefined, isHeader: boolean): Record<string, string> | undefined => {
    if (src === undefined) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(src)) {
      const lk = k.toLowerCase()
      if (isHeader && lk === authHeaderName.toLowerCase()) {
        out[k] = auth.scheme === 'bearer' ? 'Bearer ***' : '***'
      } else if (!isHeader && authQueryName !== '' && lk === authQueryName.toLowerCase()) {
        out[k] = '***'
      } else if (sensitivePattern.test(k)) {
        out[k] = '***'
      } else {
        out[k] = v
      }
    }
    return out
  }
  return {
    headers: redact(headers, true),
    query: redact(query, false),
  }
}

/** Helper: build + append an http log entry from a provider request + result. */
export function logHttpRequest(
  sessionId: string,
  provider: ResolvedAigcProvider,
  request: { method: string; path: string; headers?: Record<string, string>; query?: Record<string, string>; body?: string },
  result: { ok: boolean; status: number; contentType: string; kind: string; text?: string; error?: string },
  durationMs: number,
  producedFilePath: string | undefined,
  producedSize: number | undefined,
): void {
  const redacted = redactSecrets(request.headers, request.query, provider)
  appendLogEntry(sessionId, {
    type: 'http',
    providerId: provider.id,
    method: request.method,
    path: request.path,
    status: result.status,
    durationMs,
    ...(producedSize !== undefined ? { size: producedSize } : {}),
    ...(result.error !== undefined ? { error: previewOf(result.error) } : {}),
    ...(redacted.headers !== undefined ? { requestHeaders: redacted.headers } : {}),
    ...(redacted.query !== undefined ? { requestQuery: redacted.query } : {}),
    ...(request.body !== undefined ? { requestBodyPreview: previewOf(request.body) } : {}),
    responseContentType: result.contentType,
    ...(result.text !== undefined ? { responseBodyPreview: previewOf(result.text) } : {}),
    ...(producedFilePath !== undefined ? { elementPath: producedFilePath } : {}),
  })
}

/** Helper: build + append a media_edit log entry. */
export function logMediaEdit(
  sessionId: string,
  operation: string,
  inputs: string[],
  result: { ok: boolean; outputPath?: string; durationMs: number; size?: number; error?: string },
): void {
  appendLogEntry(sessionId, {
    type: 'media_edit',
    operation,
    inputs,
    status: result.ok ? 0 : 1,
    durationMs: result.durationMs,
    ...(result.size !== undefined ? { size: result.size } : {}),
    ...(result.error !== undefined ? { error: previewOf(result.error) } : {}),
    ...(result.outputPath !== undefined ? { elementPath: result.outputPath } : {}),
  })
}
