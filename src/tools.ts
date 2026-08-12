/**
 * The seven model-facing AIGC canvas tools.
 *
 * Generation is provider-agnostic:
 *   aigc_get_provider_info         — list configured providers (id, name,
 *                                    endpoint, usage instructions, stub flag).
 *                                    Call this FIRST. The provider apiKey is
 *                                    NEVER shown; it is attached automatically
 *                                    by aigc_http_request.
 *   aigc_http_request              — send an HTTP request to a provider's API
 *                                    (endpoint + apiKey auto-attached). Binary
 *                                    responses (image/video/audio) are saved
 *                                    to disk and returned as a filePath;
 *                                    JSON/text responses are returned inline
 *                                    (saved to a file when too large).
 *   aigc_provider_set_instructions — record the provider's 调用说明 (how to
 *                                    call the API: endpoints, params, auth)
 *                                    so future sessions can use the provider.
 *   aigc_canvas_place              — place a file (typically the filePath
 *                                    aigc_http_request returned) onto the free
 *                                    canvas at position (x, y); optionally
 *                                    records the prompt/params (shown on
 *                                    double-click) and auto-wires edges from
 *                                    reference elements.
 *   aigc_canvas_link / unlink      — create / remove an edge between two
 *                                    elements (filePath-addressed).
 *   aigc_canvas_list_elements      — snapshot of the session's canvas.
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
import type { AigcElement, AigcCanvasService } from './canvas-registry.js'
import { canvasDirFor } from './canvas-registry.js'
import { executeProviderRequest, INLINE_TEXT_CAP, type ProviderBinaryKind } from './provider-http.js'
import { executeMediaEdit, MEDIA_EDIT_OPERATIONS, type MediaEditOperation } from './media-edit.js'
import { AigcError } from './wire.js'

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
    ...(el.promptText !== undefined ? { promptText: el.promptText } : {}),
    ...(el.mediaSize !== undefined ? { mediaSize: el.mediaSize } : {}),
    ...(el.meta !== undefined ? { meta: el.meta } : {}),
  }
}

/** Edge projection: resolve uuids to filePaths so the agent can read the graph. */
function edgeProjection(edge: { source: string; target: string }, lookup: (uuid: string) => AigcElement): { source: string; target: string } {
  return {
    source: lookup(edge.source)?.filePath ?? edge.source,
    target: lookup(edge.target)?.filePath ?? edge.target,
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
export function registerTools(
  ctx: Context,
  getProvider: (providerId?: string) => ResolvedAigcProvider,
  setInstructions: (id: string, instructions: string) => { ok: boolean; error?: string },
  listProviders: () => readonly ProviderInfo[],
  canvas: AigcCanvasService,
  resolveCwd: (sessionId: string) => string,
  getTimeoutMs: () => number,
  getMediaLimit: () => number = () => 100 * 1024 * 1024,
): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: ReturnType<typeof defineTool>): void => {
    disposers.push(ctx.tools.register(tool))
  }

  // ══ aigc_get_provider_info ══════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_get_provider_info',
    description:
      'List all configured AIGC providers with their id, name, endpoint, usage instructions, and stub status. '
      + 'Call this FIRST before generating anything. '
      + 'To use a provider: call aigc_http_request with its id as provider_id — the endpoint and apiKey are attached '
      + 'automatically, so you never need to see or forward the apiKey. '
      + 'When a provider\'s instructions field is empty, probe its API yourself (aigc_http_request) and then record '
      + 'how to call it via aigc_provider_set_instructions (KEEP THE INSTRUCTIONS AS SHORT AS POSSIBLE — see that tool). '
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
                instructions: { type: 'string', required: true, description: 'Free-form usage instructions for calling the provider API (empty until initialized).' },
                isStub: { type: 'boolean', required: true, description: 'Whether the stub backend is active (no real API calls).' },
                isDefault: { type: 'boolean', required: true, description: 'Whether this is the default provider (used when provider_id is omitted).' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { providers: Array<{ id: string; name: string; endpoint: string; instructions: string; isStub: boolean; isDefault: boolean }> }
        if (v.providers.length === 0) {
          return [{ type: 'text', text: 'No AIGC providers configured. Add one in the settings page.' }]
        }
        const lines = v.providers.map(p =>
          `  ${p.isDefault ? '* ' : '  '}${p.id}  "${p.name || '(unnamed)'}"  endpoint: ${p.endpoint}  stub: ${p.isStub}`
          + (p.instructions !== '' ? `\n    instructions: ${p.instructions}` : '\n    instructions: (empty — probe the API with aigc_http_request, then record them via aigc_provider_set_instructions)'),
        )
        return [{
          type: 'text',
          text: `AIGC providers (${v.providers.length}):\n${lines.join('\n')}\n\nCall aigc_http_request with the desired provider's id; endpoint + apiKey are attached automatically.`,
        }]
      },
    },
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted()
      return Promise.resolve({ providers: listProviders() })
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
            const expanded = await expandBase64Placeholders(jsonValue, sessionId, cwd)
            body = JSON.stringify(expanded)
          }
        } else {
          const expanded = await expandBase64Placeholders(jsonValue, sessionId, cwd)
          body = JSON.stringify(expanded)
        }
      } else if (args.body !== undefined) {
        // Expand placeholders in raw body too, but only when the body is
        // valid JSON (placeholders are JSON objects like {"$base64": "..."}).
        // Non-JSON bodies (form-urlencoded, plain text) pass through unchanged.
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
      const result = await executeProviderRequest(provider, {
        method: args.method,
        path: args.path,
        headers: args.headers,
        query: args.query,
        body,
      }, { timeoutMs: getTimeoutMs(), signal: exec.signal })

      if (!result.ok) {
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
          // OpenAI image endpoints return JSON like {data:[{b64_json:"..."}]}.
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
          return {
            ok: true,
            status: result.status,
            kind: result.kind,
            content_type: result.contentType,
            text: `${preview}\n… [response truncated; full ${Buffer.byteLength(result.text)} bytes saved to ${filePath} — read it with your file tools]`,
            file_path: filePath,
            file_size: Buffer.byteLength(result.text),
          }
        }
        default: {
          // Binary (image / video / audio / other): persist and return the path.
          const ext = extensionForBinaryKind(result.kind, result.contentType)
          if (result.size > getMediaLimit()) {
            throw new AigcError('backend-error', `provider response too large to save (${result.size} bytes > ${getMediaLimit()} limit)`, 413)
          }
          const filePath = await saveResponseToSession(result.bytes, ext, sessionId, cwd)
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
      + 'CRITICAL: KEEP THE INSTRUCTIONS AS SHORT AS POSSIBLE — a few words per endpoint is enough. '
      + 'Do NOT copy full API docs, examples, or verbose explanations. Prefer compact shorthand like '
      + '"POST /v1/images/generations {prompt,size} -> {data:[{b64_json}]}" over full sentences. '
      + 'Every byte here is inlined into aigc_get_provider_info output on every call, so verbosity directly '
      + 'wastes context window. Aim for under 200 characters total.',
    parameters: {
      provider_id: { type: 'string', required: true, description: 'The provider id to update (from aigc_get_provider_info).' },
      instructions: {
        type: 'string',
        required: true,
        description: 'Compact usage instructions. BE TERSE — a few words per endpoint is enough; do not pad with prose, examples, or full docs. '
          + 'Drop any formatting guarantees (no need for valid JSON / Markdown / complete sentences). '
          + 'Shorthand like "POST /v1/images/generations {prompt,size} -> {data:[{b64_json}]}" is ideal. '
          + 'Target: under 200 chars. Fewer is better.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          provider_id: { type: 'string', required: true },
        },
      },
      render: textRender((v: { provider_id: string }) => `Saved usage instructions for provider "${v.provider_id}".`),
    },
    execute: (args: { provider_id: string; instructions: string }) => {
      if (typeof args.provider_id !== 'string' || args.provider_id === '') {
        throw new AigcError('bad-request', 'provider_id is required')
      }
      if (typeof args.instructions !== 'string' || args.instructions === '') {
        throw new AigcError('bad-request', 'instructions is required')
      }
      getProvider(args.provider_id) // throws for unknown ids
      const result = setInstructions(args.provider_id, args.instructions)
      if (!result.ok) throw new AigcError('bad-request', result.error ?? 'cannot save instructions')
      return Promise.resolve({ ok: true, provider_id: args.provider_id })
    },
  }))

  // ══ aigc_canvas_place ═══════════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_canvas_place',
    description:
      'Place a file (usually the file_path returned by aigc_http_request) onto the session\'s free canvas at '
      + 'position (x, y). The file must already exist inside the session canvas directory. '
      + 'Optionally record the prompt text and generation parameters (meta) — they are shown when the user '
      + 'double-clicks the element. Pass `references` (filePaths of existing elements the new one was generated '
      + 'from) to auto-wire edges from those elements to the new one. '
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
      prompt: { type: 'string', description: 'The prompt text used to generate this file (shown on double-click).' },
      meta: { type: 'json', description: 'Generation parameters / metadata as a JSON OBJECT (e.g. {"size":"768x768","seed":42}). Shown on double-click. Do NOT pass a stringified JSON.' },
      references: { type: 'array', items: { type: 'string' }, description: 'filePaths of existing canvas elements used as references; edges are wired from each reference to the new element.' },
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
      prompt?: string
      meta?: unknown
      references?: string[]
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
      const meta = coerceMeta(args.meta)
      // Resolve reference elements BEFORE placing so the host can position
      // the new element to the right of its references (instead of the
      // default bottom-of-column placement).
      let refUuids: string[] | undefined
      if (args.references !== undefined && args.references.length > 0) {
        refUuids = []
        for (const refPath of args.references) {
          const refEl = canvas.getElementByPath(sessionId, refPath)
          refUuids.push(refEl.uuid)
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
        ...(refUuids !== undefined ? { referenceUuids: refUuids } : {}),
      }, cwd)
      let linked = 0
      if (refUuids !== undefined && refUuids.length > 0) {
        // Filter out self-references (can't happen after placeFile, but
        // be safe) and wire edges from each reference to the new element.
        const filtered = refUuids.filter(u => u !== el.uuid)
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
      'Create an edge from an existing source element to an existing target element (both filePath-addressed). '
      + 'Use this to record that one element was generated from (or depends on) another. Idempotent: linking the '
      + 'same pair twice is a no-op. Edges are rendered on the canvas as arrows from source to target.',
    parameters: {
      source: { type: 'string', required: true, description: 'filePath of the source element (the input / reference).' },
      target: { type: 'string', required: true, description: 'filePath of the target element (the produced output).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          linked: { type: 'boolean', required: true },
          source: { type: 'string', required: true },
          target: { type: 'string', required: true },
        },
      },
      render: textRender((v: { source: string; target: string }) => `Linked ${v.source} → ${v.target}.`),
    },
    execute: async (args: { source: string; target: string }, exec) => {
      const sessionId = sessionIdOf(exec)
      await canvas.ensureHydrated(sessionId)
      const sourceEl = canvas.getElementByPath(sessionId, args.source)
      const targetEl = canvas.getElementByPath(sessionId, args.target)
      return canvas.wireEdges(sessionId, [sourceEl.uuid], targetEl.uuid).then(() => ({
        linked: true,
        source: args.source,
        target: args.target,
      }))
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

  // ══ aigc_canvas_list_elements ════════════════════════════════════════════
  register(defineTool({
    name: 'aigc_canvas_list_elements',
    description:
      'List every element and edge currently on the canvas for the calling agent\'s session. '
      + 'Returns each element\'s filePath (the primary identifier), kind (prompt/image/video/audio), title, canvas '
      + 'position (x, y), producing tool, and metadata; and every edge (source filePath → target filePath). '
      + 'Use this to recover state after a long sequence of tool calls, to find a filePath to pass as a reference, '
      + 'or to choose a free spot on the canvas.',
    parameters: {},
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
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { elements: Array<{ filePath: string; kind: string; title: string; x: number; y: number }>; edges: Array<{ source: string; target: string }> }
        if (v.elements.length === 0) return [{ type: 'text', text: 'Canvas is empty for this session.' }]
        const lines = v.elements.map((el) => `  ${el.filePath}  [${el.kind}]  @(${el.x}, ${el.y})  "${el.title}"`)
        return [{
          type: 'text',
          text: `Canvas (${v.elements.length} elements, ${v.edges.length} edges):\n${lines.join('\n')}\nEdges:\n${v.edges.map(e => `  ${e.source} → ${e.target}`).join('\n')}`,
        }]
      },
    },
    execute: async (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      await canvas.ensureHydrated(sessionId)
      const state = canvas.snapshot(sessionId)
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
      return {
        ok: true,
        operation: result.operation,
        file_path: result.outputPath,
        file_size: outInfo.size,
        duration_ms: result.durationMs,
      }
    },
  }))

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

/** Re-export the projection helpers for the unit tests. */
export { elementProjection, edgeProjection, titleOf }
