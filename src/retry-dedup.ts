/**
 * Auto-retry + dedup for aigc_http_request: per docs/product/04-ux-reliability.md §4.
 *
 * Retry: 429/500/502/503/504 get exponential backoff (1s → 2s → 4s, max 3 attempts).
 * Dedup: same provider + path + body hash within dedupWindowMs returns the cached
 * filePath instead of re-calling the provider.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/retry-dedup
 */
import { createHash } from 'node:crypto'
import type { ResolvedAigcProvider } from './config.js'

/** Status codes that trigger automatic retry. */
export const RETRYABLE_STATUS_CODES: readonly number[] = [429, 500, 502, 503, 504]

/** Default retry config. */
export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  backoffBaseMs: 1000,
  retryOn: RETRYABLE_STATUS_CODES,
} as const

/** Per-session dedup cache: key = providerId:bodyHash, value = cached result. */
export interface DedupEntry {
  filePath?: string
  size?: number
  contentType: string
  kind: string
  status: number
  text?: string
  timestamp?: number
}

const dedupCacheBySession = new Map<string, Map<string, DedupEntry>>()

/** Compute the dedup cache key for one request. */
function dedupKey(providerId: string, method: string, path: string, body: string | undefined): string {
  const hash = createHash('sha256')
  hash.update(`${providerId}:${method}:${path}`)
  if (body !== undefined) hash.update(body)
  return hash.digest('hex')
}

/**
 * Check the dedup cache for a matching entry. Returns undefined when no cache
 * hit (or when dedup is disabled / the entry has expired).
 */
export function checkDedup(
  sessionId: string,
  providerId: string,
  method: string,
  path: string,
  body: string | undefined,
  dedupWindowMs: number,
): DedupEntry | undefined {
  if (dedupWindowMs <= 0) return undefined
  const cache = dedupCacheBySession.get(sessionId)
  if (cache === undefined) return undefined
  const key = dedupKey(providerId, method, path, body)
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  if (entry.timestamp === undefined || Date.now() - entry.timestamp > dedupWindowMs) {
    cache.delete(key)
    return undefined
  }
  return entry
}

/** Store one result in the dedup cache. */
export function storeDedup(
  sessionId: string,
  providerId: string,
  method: string,
  path: string,
  body: string | undefined,
  result: DedupEntry,
  dedupWindowMs: number,
): void {
  if (dedupWindowMs <= 0) return
  let cache = dedupCacheBySession.get(sessionId)
  if (cache === undefined) {
    cache = new Map()
    dedupCacheBySession.set(sessionId, cache)
  }
  const key = dedupKey(providerId, method, path, body)
  cache.set(key, { ...result, timestamp: Date.now() })
}

/** Clear the dedup cache for one session. */
export function clearSessionDedup(sessionId: string): void {
  dedupCacheBySession.delete(sessionId)
}

/**
 * Sleep for ms, respecting an abort signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal !== undefined) {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Whether a status code is retryable.
 */
export function isRetryable(status: number, retryOn: readonly number[] = RETRYABLE_STATUS_CODES): boolean {
  return retryOn.includes(status)
}

/**
 * Execute a function with automatic retry on retryable failures.
 * Returns the result of the function, or throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number
    backoffBaseMs?: number
    retryOn?: readonly number[]
    signal?: AbortSignal
    isRetryableResult?: (result: T) => boolean
    getResponseStatus?: (result: T) => number
  } = {},
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_RETRY_POLICY.backoffBaseMs
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_POLICY.retryOn
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.signal?.throwIfAborted()
    try {
      const result = await fn()
      // Check if the result is retryable (e.g. HTTP 429).
      if (opts.isRetryableResult !== undefined && opts.getResponseStatus !== undefined) {
        const status = opts.getResponseStatus(result)
        if (retryOn.includes(status) && attempt < maxAttempts) {
          const backoffMs = backoffBaseMs * Math.pow(2, attempt - 1)
          await sleep(backoffMs, opts.signal)
          continue
        }
      }
      return { result, attempts: attempt }
    } catch (error) {
      lastError = error
      if (opts.signal?.aborted === true) throw error
      if (attempt < maxAttempts) {
        const backoffMs = backoffBaseMs * Math.pow(2, attempt - 1)
        try {
          await sleep(backoffMs, opts.signal)
        } catch {
          throw error // sleep was aborted
        }
        continue
      }
    }
  }
  throw lastError
}
