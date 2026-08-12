/**
 * Per-session cache of the most recent provider request that produced each
 * canvas file_path. The `aigc_http_request` tool writes a snapshot every
 * time it saves a binary (or oversized text) response to disk; the
 * `aigc_canvas_place` tool consumes the snapshot and merges it into the
 * placed element's `meta.originalRequest` — so the model can later reroll
 * the element (see `aigc_reroll`) without having to remember the original
 * request body / params / provider.
 *
 * Lifecycle:
 *  - `record(filePath, snapshot)` — called by aigc_http_request after save.
 *  - `consume(filePath)` — called by aigc_canvas_place; REMOVES the entry
 *    so memory doesn't grow unboundedly across a long session.
 *  - `peek(filePath)` — non-destructive read (used by tests + future hooks).
 *  - `clearSession(sessionId)` — wipes the session's entries (used on
 *    session teardown; safe to call when no entries exist).
 *
 * Security:
 *  - The snapshot stores the user-supplied headers + query (NOT the
 *    provider auth header / query param — those are re-attached at reroll
 *    time from the live provider config, so the apiKey never enters
 *    `meta.originalRequest`).
 *  - The body is stored as the EXPANDED string actually sent over the wire
 *    (placeholder `$base64` / `$data_uri` already resolved), plus the
 *    parsed JSON form when the model passed `json_body` — so the reroll
 *    tool can patch structured fields (prompt / seed / size) without
 *    re-parsing.
 *
 * @module @dsh-external/dsh-aigc-canvas/request-snapshot
 */

/**
 * The host-side record of "how was this file produced?" — sufficient to
 * replay (reroll) the request with optional patches.
 *
 * Stored as `meta.originalRequest` on the placed element (a structured
 * sub-field of the freeform meta bag).
 */
export interface RequestSnapshot {
  /** Provider id used for the original request (reroll looks it up fresh). */
  providerId: string
  /** HTTP method (uppercase). */
  method: string
  /** Request path relative to the provider endpoint (or same-origin absolute URL). */
  path: string
  /** User-supplied query params (auth query param NOT included — re-attached at reroll). */
  query?: Record<string, string>
  /** User-supplied headers (auth header NOT included — re-attached at reroll). */
  headers?: Record<string, string>
  /**
   * The request body in its UNEXPANDED form (placeholders intact), so the
   * reroll tool can patch structured fields (prompt / seed / size) and so
   * `$base64` references re-resolve at reroll time (e.g. if the referenced
   * file was replaced). May be:
   *  - An object/array when the model passed `json_body` as an object/array
   *  - A parsed JSON value (object/array/string/number/...) when the model
   *    passed `json_body` as a JSON string
   *  - A raw string when the model passed `body` (may be non-JSON)
   *  - Undefined for GET requests with no body
   *
   * NOT the expanded form sent over the wire — that would balloon
   * `meta.originalRequest` size when the body has inlined base64.
   */
  body?: unknown
  /** Info about the original response (for debugging + cost tracking). */
  responseInfo: {
    /** HTTP status code of the original response. */
    status: number
    /** Response Content-Type header. */
    contentType: string
    /** Response kind (image / video / audio / other / json / text). */
    kind: string
    /** Saved file size in bytes (when the response was persisted to disk). */
    size?: number
    /** Round-trip duration in ms (provider request → response received). */
    durationMs: number
  }
}

/**
 * Per-session snapshot cache. Keyed by sessionId → filePath → snapshot.
 *
 * Uses a Map of Maps so `clearSession` can wipe one session's entries
 * without touching others.
 */
const cacheBySession = new Map<string, Map<string, RequestSnapshot>>()

/** Get (or lazily create) the per-session cache. */
function sessionCache(sessionId: string): Map<string, RequestSnapshot> {
  let m = cacheBySession.get(sessionId)
  if (m === undefined) {
    m = new Map()
    cacheBySession.set(sessionId, m)
  }
  return m
}

/**
 * Record a snapshot for one (sessionId, filePath) pair. Called by
 * `aigc_http_request` after it saves a binary / oversized-text response.
 * Overwrites any previous snapshot for the same filePath.
 */
export function recordRequestSnapshot(sessionId: string, filePath: string, snapshot: RequestSnapshot): void {
  sessionCache(sessionId).set(filePath, snapshot)
}

/**
 * Consume (read + delete) the snapshot for one (sessionId, filePath) pair.
 * Called by `aigc_canvas_place` — the snapshot is merged into the placed
 * element's `meta.originalRequest` and then dropped from the cache so
 * memory doesn't grow unboundedly across a long session.
 *
 * Returns undefined when no snapshot exists (e.g. the file was uploaded
 * by the user via drag-drop, or produced by `aigc_media_edit` rather than
 * `aigc_http_request`).
 */
export function consumeRequestSnapshot(sessionId: string, filePath: string): RequestSnapshot | undefined {
  const m = cacheBySession.get(sessionId)
  if (m === undefined) return undefined
  const snap = m.get(filePath)
  if (snap !== undefined) m.delete(filePath)
  return snap
}

/**
 * Non-destructive read of one snapshot. Used by tests + future host-side
 * hooks (e.g. the request log panel may want to show the pending snapshot
 * for a file that hasn't been placed yet).
 */
export function peekRequestSnapshot(sessionId: string, filePath: string): RequestSnapshot | undefined {
  return cacheBySession.get(sessionId)?.get(filePath)
}

/**
 * Wipe all snapshots for one session. Called on session teardown. Safe to
 * call when no entries exist.
 */
export function clearSessionSnapshots(sessionId: string): void {
  cacheBySession.delete(sessionId)
}

/** Total number of cached snapshots across all sessions (for tests / debug). */
export function requestSnapshotCount(): number {
  let total = 0
  for (const m of cacheBySession.values()) total += m.size
  return total
}
