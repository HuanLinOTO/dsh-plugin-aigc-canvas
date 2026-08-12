/**
 * Wire helpers for the /aigc-canvas JSON API: bounded body reading, response
 * writing, and the shared error envelope. Every API method returns
 * `{ ok: true, value }` on success and `{ ok: false, error: { code, message } }`
 * (HTTP 4xx/5xx matching the code) on failure — mirrors better-sidebar's
 * `/sidebar/api/*` envelope so the client-side fetch helper is identical.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Machine-readable error codes of the canvas API. */
export type AigcErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'fs-error'
  | 'backend-error'
  | 'internal'

/** One API failure with its wire code and HTTP status. */
export class AigcError extends Error {
  constructor(
    readonly code: AigcErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

/** Success envelope of one API method. */
export interface AigcOk<T> { ok: true; value: T }

/** Failure envelope of one API method. */
export interface AigcErr { ok: false; error: { code: AigcErrorCode; message: string } }

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new AigcError('bad-request', 'request body too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AigcError('bad-request', 'request body is not valid JSON')
  }
}

/** Write a JSON response with the given status. */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Write the success envelope. */
export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
export function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof AigcError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** Narrow an unknown payload value to a string, else throw bad-request. */
export function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new AigcError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

/** Narrow an unknown payload value to an array of strings (default [] when absent). */
export function optionalStringArray(payload: unknown, key: string): string[] {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new AigcError('bad-request', `"${key}" must be an array of strings`)
  }
  for (const item of value) {
    if (typeof item !== 'string' || item === '') {
      throw new AigcError('bad-request', `"${key}" must contain only non-empty strings`)
    }
  }
  return value as string[]
}
