/**
 * Generic HTTP executor for one provider: the `aigc_http_request` tool's
 * engine. Builds the request URL from the provider endpoint + a relative
 * path, attaches the apiKey per the provider's `auth` config (default
 * `Authorization: Bearer <key>`), and runs it with a bounded timeout.
 *
 * Security boundary:
 * - Only relative request paths are allowed (`/foo/bar`), never absolute
 *   URLs — every request stays on the provider's configured endpoint.
 * - The apiKey never enters the tool output; only the response does.
 *
 * Stub mode: when the endpoint is `stub://aigc-backend` (or empty), the
 * executor returns synthetic media so the whole flow (http → file → place)
 * can be exercised without a real API. The stub media kind is inferred from
 * the request path / body (image/video/audio), defaulting to JSON text.
 */
import type { ResolvedAigcProvider } from './config.js'
import { isStubEndpoint } from './config.js'
import { AigcError } from './wire.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'

/** Binary kinds the executor can hand back (for canvas placement). */
export type ProviderBinaryKind = 'image' | 'video' | 'audio' | 'other'

/** Text response kinds (inline for the model). */
export type ProviderTextKind = 'json' | 'text'

/** One raw request the model wants to send to the provider API. */
export interface ProviderHttpRequest {
  /** HTTP method (default GET). */
  method?: string
  /**
   * Path relative to the provider endpoint, e.g. `/v1/images/generations`.
   * Must start with `/`.
   *
   * Absolute URLs are also accepted, but only when same-origin with the
   * provider's configured endpoint (same protocol + host + port). This lets
   * the model fetch provider-returned download URLs (e.g. video result URLs)
   * that require the provider's auth, without opening an SSRF surface.
   */
  path: string
  /** Extra request headers (may not override the auth header). */
  headers?: Record<string, string>
  /** Raw request body (string, typically JSON). */
  body?: string
  /** URL query params to append (merged with any auth query param). */
  query?: Record<string, string>
}

/** A successful binary response (persisted by the caller). */
export interface ProviderHttpBinary {
  ok: true
  status: number
  kind: ProviderBinaryKind
  contentType: string
  bytes: Buffer
  /** Bytes length (the caller's file size). */
  size: number
}

/** A successful text response (embedded inline for the model). */
export interface ProviderHttpText {
  ok: true
  status: number
  kind: ProviderTextKind
  contentType: string
  text: string
}

/** A failed response (non-2xx): the body is surfaced so the model can adapt. */
export interface ProviderHttpFailure {
  ok: false
  status: number
  contentType: string
  /** Truncated response body (UTF-8) for the model to read. */
  text: string
}

export type ProviderHttpResult = ProviderHttpBinary | ProviderHttpText | ProviderHttpFailure

/** Cap on how much of a failure body is surfaced to the model. */
const FAILURE_TEXT_CAP = 4096

/**
 * Cap on inline text responses. The model-facing tool result is size-
 * limited by the host framework (very small — a few hundred chars), so
 * anything larger is saved to disk and the model gets a file_path with a
 * short preview instead.
 */
export const INLINE_TEXT_CAP = 2000

// ── Stub asset loader ──────────────────────────────────────────────────────
// The stub backend returns real, playable sample media (a PNG, an MP4, an
// MP3) bundled with the plugin under `assets/`. The bytes are loaded once
// and cached for the process lifetime.

/** Directory containing the bundled stub assets (../assets from lib/). */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

/** Cached stub asset bytes, keyed by filename. */
const assetCache = new Map<string, Buffer>()

/**
 * Load a bundled stub asset, caching the result. Falls back to a synthetic
 * minimal buffer if the asset file is missing (broken install) so the stub
 * still functions — just with less pretty media.
 */
async function loadStubAsset(filename: string, fallback: () => Buffer): Promise<Buffer> {
  const cached = assetCache.get(filename)
  if (cached !== undefined) return cached
  try {
    const bytes = await readFile(join(ASSETS_DIR, filename))
    const buf = Buffer.from(bytes)
    assetCache.set(filename, buf)
    return buf
  } catch {
    const fb = fallback()
    assetCache.set(filename, fb)
    return fb
  }
}

/** Synthetic 1×1 PNG (fallback when the bundled asset is missing). */
function fallbackPng(): Buffer {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.from([
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ])
  const idat = Buffer.from([
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  ])
  const iend = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
  return Buffer.concat([magic, ihdr, idat, iend])
}

/** Synthetic minimal MP4 ftyp box (fallback when the bundled asset is missing). */
function fallbackMp4(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ])
}

/** Synthetic minimal WAV (fallback when the bundled asset is missing). */
function fallbackWav(): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(0, 40)
  return header
}

/**
 * Classify a stub request by matching its path against the OpenAI API
 * surface (and common AIGC vendor paths). Only the **path** is examined —
 * never the body — so a field name like `"image"` inside a video request
 * body can't trick the stub into returning the wrong media kind.
 *
 * Returns one of:
 *  - 'image'             → /v1/images/generations, /v1/images/edits, /v1/images/variations, t2i, img2img, ref2i
 *  - 'video'             → /v1/videos/generations, /v1/video/create, t2v, img2video, fl2v, ref2v
 *  - 'audio'             → /v1/audio/speech, t2music, tts, speech, voice, music
 *  - 'transcription'     → /v1/audio/transcriptions, /v1/audio/translations
 *  - 'chat'              → /v1/chat/completions, /v1/completions
 *  - 'other'             → anything else (returns a JSON ack)
 */
type StubRoute = 'image' | 'video' | 'audio' | 'transcription' | 'chat' | 'other'

function classifyStubRoute(request: ProviderHttpRequest): StubRoute {
  const p = request.path.toLowerCase()
  // ── OpenAI standard endpoints (path-precise) ──────────────────────────
  if (/\/v1\/images\/(generations|edits|variations)/.test(p)) return 'image'
  if (/\/v1\/audio\/speech/.test(p)) return 'audio'
  if (/\/v1\/audio\/(transcriptions|translations)/.test(p)) return 'transcription'
  if (/\/v1\/(chat\/completions|completions)/.test(p)) return 'chat'
  if (/\/v1\/videos?\/(generations?|create)/.test(p)) return 'video'
  // ── Common vendor / shorthand path patterns ───────────────────────────
  if (/\bimages?\b|t2i|img2img|ref2i|2img/.test(p)) return 'image'
  if (/\baudios?\b|t2music|tts|speech|voice|music|singing?/.test(p)) return 'audio'
  if (/\bvideos?\b|t2v|img2video|fl2v|ref2v|2video|motion|clips?/.test(p)) return 'video'
  return 'other'
}

/** Parse the request body JSON; returns undefined on parse failure. */
function parseBody(request: ProviderHttpRequest): Record<string, unknown> | undefined {
  if (request.body === undefined || request.body === '') return undefined
  try { return JSON.parse(request.body) as Record<string, unknown> } catch { return undefined }
}

/** Extract the first user message content from a chat completions body. */
function extractUserMessage(body: Record<string, unknown> | undefined): string {
  if (body === undefined) return ''
  const messages = body.messages
  if (!Array.isArray(messages)) return ''
  for (const msg of messages) {
    if (typeof msg === 'object' && msg !== null && (msg as { role?: string }).role === 'user') {
      const c = (msg as { content?: unknown }).content
      if (typeof c === 'string') return c
    }
  }
  return ''
}

/** Extract a short prompt snippet from the request body for the stub marker. */
function promptSnippet(request: ProviderHttpRequest): string {
  const body = parseBody(request)
  if (body === undefined) return ''
  const p = body.prompt ?? body.text ?? body.input ?? body.messages
  if (typeof p === 'string') return p.slice(0, 64)
  return ''
}

/** Execute one request against the provider (or the built-in stub). */
export async function executeProviderRequest(
  provider: ResolvedAigcProvider,
  request: ProviderHttpRequest,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<ProviderHttpResult> {
  const path = request.path.trim()
  if (path === '') {
    throw new AigcError('bad-request', 'path is required (relative to the provider endpoint, starting with "/")')
  }
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(path)

  // ── Stub mode: no network, synthetic response. ─────────────────────────
  if (isStubEndpoint(provider.endpoint)) {
    if (isAbsolute) {
      throw new AigcError('bad-request', `absolute URLs are not allowed in stub mode: ${path}`)
    }
    if (!path.startsWith('/')) {
      throw new AigcError('bad-request', `path must start with "/": ${path}`)
    }
    // Default to POST when a body is present (HTTP convention); GET otherwise.
    const method = (request.method ?? (request.body !== undefined ? 'POST' : 'GET')).toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      // GET on the stub returns a JSON document describing the simulated API.
      return {
        ok: true,
        status: 200,
        kind: 'json',
        contentType: 'application/json; charset=utf-8',
        text: JSON.stringify({
          stub: true,
          hint: 'Built-in stub backend. POST to OpenAI-compatible endpoints to receive sample media:',
          endpoints: {
            '/v1/images/generations': 'Returns {created, data:[{b64_json}]} — OpenAI image generation format.',
            '/v1/images/edits': 'Same response format as /v1/images/generations.',
            '/v1/audio/speech': 'Returns audio/mpeg binary bytes directly.',
            '/v1/audio/transcriptions': 'Returns {text} JSON.',
            '/v1/chat/completions': 'Returns {choices:[{message:{content}}]} JSON.',
            '/v1/videos/generations': 'Returns video/mp4 binary bytes directly.',
          },
          provider: provider.id,
          path,
        }, null, 2),
      }
    }
    const route = classifyStubRoute(request)
    const snippet = promptSnippet(request)
    switch (route) {
      case 'image': {
        // OpenAI format: { created, data: [{ b64_json }] }
        const bytes = await loadStubAsset('stub-image.png', fallbackPng)
        return {
          ok: true,
          status: 200,
          kind: 'json',
          contentType: 'application/json; charset=utf-8',
          text: JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: bytes.toString('base64') }],
          }),
        }
      }
      case 'video': {
        const bytes = await loadStubAsset('stub-video.mp4', fallbackMp4)
        return {
          ok: true,
          status: 200,
          kind: 'video',
          contentType: 'video/mp4',
          bytes,
          size: bytes.byteLength,
        }
      }
      case 'audio': {
        const bytes = await loadStubAsset('stub-audio.mp3', fallbackWav)
        return {
          ok: true,
          status: 200,
          kind: 'audio',
          contentType: 'audio/mpeg',
          bytes,
          size: bytes.byteLength,
        }
      }
      case 'transcription': {
        return {
          ok: true,
          status: 200,
          kind: 'json',
          contentType: 'application/json; charset=utf-8',
          text: JSON.stringify({
            text: `[stub transcription] ${snippet || '(simulated audio transcript)'}`,
          }),
        }
      }
      case 'chat': {
        const body = parseBody(request)
        const model = typeof body?.model === 'string' ? body.model : 'gpt-4o'
        const userContent = extractUserMessage(body)
        return {
          ok: true,
          status: 200,
          kind: 'json',
          contentType: 'application/json; charset=utf-8',
          text: JSON.stringify({
            id: `chatcmpl-stub-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: `[stub] Simulated response to: ${userContent.slice(0, 200)}`,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        }
      }
      default: {
        return {
          ok: true,
          status: 200,
          kind: 'json',
          contentType: 'application/json; charset=utf-8',
          text: JSON.stringify({ stub: true, ok: true, path, method, provider: provider.id }, null, 2),
        }
      }
    }
  }

  // ── Real endpoint. ─────────────────────────────────────────────────────
  // Default to POST when a body is present (HTTP convention); GET otherwise.
  const method = (request.method ?? (request.body !== undefined ? 'POST' : 'GET')).toUpperCase()
  let url: URL
  if (isAbsolute) {
    // Absolute URL: only allow same-origin with the provider endpoint
    // (same protocol + host + port). This lets the model fetch provider-
    // returned download URLs that need the provider's auth, without
    // opening an SSRF surface to arbitrary hosts.
    let pathUrl: URL
    try {
      pathUrl = new URL(path)
    } catch {
      throw new AigcError('bad-request', `invalid absolute URL: ${path}`)
    }
    let endpointUrl: URL
    try {
      endpointUrl = new URL(provider.endpoint)
    } catch {
      throw new AigcError('backend-error', `invalid provider endpoint URL: ${provider.endpoint}`, 502)
    }
    if (pathUrl.origin !== endpointUrl.origin) {
      throw new AigcError('bad-request', `absolute URL must be same-origin as the provider endpoint (${endpointUrl.origin}): ${path}`)
    }
    url = pathUrl
  } else {
    if (!path.startsWith('/')) {
      throw new AigcError('bad-request', `path must start with "/": ${path}`)
    }
    try {
      url = new URL(`${provider.endpoint.replace(/\/+$/, '')}${path}`)
    } catch {
      throw new AigcError('backend-error', `invalid provider endpoint URL: ${provider.endpoint}`, 502)
    }
  }
  if (request.query !== undefined) {
    for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value)
  }
  const headers = new Headers({ ...(request.headers ?? {}) })
  const auth = provider.auth
  if (auth.scheme === 'bearer') {
    headers.set('Authorization', `Bearer ${provider.apiKey}`)
  } else if (auth.scheme === 'header') {
    headers.set(auth.name === '' ? 'x-api-key' : auth.name, provider.apiKey)
  } else {
    url.searchParams.set(auth.name === '' ? 'api_key' : auth.name, provider.apiKey)
  }
  if (request.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  let response: Response
  try {
    const abortSignals: AbortSignal[] = [AbortSignal.timeout(opts.timeoutMs)]
    if (opts.signal !== undefined) abortSignals.push(opts.signal)
    const signal = abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0]!
    response = await fetch(url, { method, headers, body: request.body, signal, redirect: 'follow' })
  } catch (error) {
    if (error instanceof AigcError) throw error
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new AigcError('backend-error', `provider request aborted (timeout ${opts.timeoutMs}ms or caller abort)`, 504)
    }
    throw new AigcError('backend-error', `provider request failed: ${error instanceof Error ? error.message : String(error)}`, 502)
  }

  const contentType = response.headers.get('content-type') ?? ''
  const mediaType = contentType.split(';')[0]!.trim().toLowerCase()
  const status = response.status

  if (status < 200 || status >= 300) {
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      ok: false,
      status,
      contentType,
      text: buffer.toString('utf8').slice(0, FAILURE_TEXT_CAP),
    }
  }

  if (mediaType.startsWith('image/')) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return { ok: true, status, kind: 'image', contentType, bytes, size: bytes.byteLength }
  }
  if (mediaType.startsWith('video/')) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return { ok: true, status, kind: 'video', contentType, bytes, size: bytes.byteLength }
  }
  if (mediaType.startsWith('audio/')) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return { ok: true, status, kind: 'audio', contentType, bytes, size: bytes.byteLength }
  }
  const isBinaryFallback = mediaType === 'application/octet-stream'
    || (mediaType === '' && !contentType.includes('json') && !contentType.includes('text'))
  if (isBinaryFallback) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return { ok: true, status, kind: 'other', contentType, bytes, size: bytes.byteLength }
  }
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8')
  const kind: ProviderTextKind = mediaType.includes('json') || (text.trim().startsWith('{') || text.trim().startsWith('[')) ? 'json' : 'text'
  return { ok: true, status, kind, contentType, text }
}
