/**
 * Structured provider capability catalog: replaces the free-form
 * `instructions: string` field with a typed `endpoints: EndpointSpec[]`
 * describing each provider endpoint's path, parameters, and response
 * shape. Lets the agent reason about provider capabilities without
 * parsing natural language.
 *
 * Per docs/product/03-provider-catalog.md §1-3.
 *
 * @module @dsh-external/dsh-aigc-canvas/endpoint-catalog
 */

/**
 * One AIGC capability. Drives the `capabilityMap` in aigc_get_provider_info
 * output so the agent can pick a provider by what it can do.
 */
export type Capability =
  | 't2i'          // text-to-image
  | 'i2i'          // image-to-image (style transfer, edit)
  | 't2v'          // text-to-video
  | 'i2v'          // image-to-video
  | 'fl2v'         // first+last frame to video
  | 'ref2v'        // multi-reference to video
  | 'tts'          // text-to-speech
  | 'music'        // text-to-music
  | 'transcribe'   // audio-to-text
  | 'edit'         // media edit (provider-side)
  | 'chat'         // multimodal chat (for self-assess)

/** All Capability values as a readonly array (for schema enum + validation). */
export const CAPABILITIES: readonly Capability[] = [
  't2i', 'i2i', 't2v', 'i2v', 'fl2v', 'ref2v',
  'tts', 'music', 'transcribe', 'edit', 'chat',
] as const

/**
 * How the host processes a successful provider response. Replaces the
 * hardcoded `extractOpenAIB64Image` sniffing with a spec-driven dispatch.
 */
export type ResponseKind =
  /**
   * OpenAI image format: `{ data: [{ b64_json: "<base64>" }] }`.
   * host decodes the base64 payload and saves it to disk.
   */
  | 'b64_json_array'
  /**
   * Single base64 field at a non-OpenAI path, e.g. `{ result: { image: "<base64>" } }`.
   * host uses `response.path` to locate the field, decodes, saves to disk.
   */
  | 'b64_json_field'
  /**
   * Raw binary bytes (image/png, video/mp4, audio/mpeg, ...).
   * host saves the bytes directly to disk.
   */
  | 'binary'
  /**
   * URL field: `{ data: [{ url: "https://..." }] }`. host does a secondary
   * GET to download the bytes (with the provider's auth attached).
   */
  | 'url_field'
  /**
   * Plain JSON / text response (chat completions, transcriptions, acks).
   * host returns the body inline to the model.
   */
  | 'json_text'

/** All ResponseKind values as a readonly array. */
export const RESPONSE_KINDS: readonly ResponseKind[] = [
  'b64_json_array', 'b64_json_field', 'binary', 'url_field', 'json_text',
] as const

/** One parameter on an endpoint (for documentation + validation). */
export interface ParamSpec {
  /** Parameter name (e.g. "prompt", "size", "seed"). */
  name: string
  /** JSON-like type. `image_ref` / `video_ref` / `audio_ref` mean the param accepts a canvas element filePath (host expands to $base64). */
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'image_ref' | 'video_ref' | 'audio_ref'
  /** Whether the parameter is required. */
  required: boolean
  /** Default value when omitted. */
  default?: unknown
  /** Allowed values (enum). */
  enum?: readonly unknown[]
  /** Numeric minimum. */
  min?: number
  /** Numeric maximum. */
  max?: number
  /** Short human-readable description. */
  description?: string
}

/** How a successful response is shaped + where to find the payload. */
export interface ResponseSpec {
  /** Response kind — drives how host processes the body. */
  kind: ResponseKind
  /**
   * Path to the payload field, when kind is `b64_json_array` / `b64_json_field` /
   * `url_field`. Uses dotted + `[index]` notation:
   *  - `data[0].b64_json` (OpenAI images)
   *  - `result.image` (single b64 field)
   *  - `data[0].url` (url_field)
   *  - `choices[0].message.content` (chat — used for inline text extraction)
   * Undefined for `binary` (no extraction needed) and `json_text` (whole body inline).
   */
  path?: string
}

/** One provider endpoint's complete description. */
export interface EndpointSpec {
  /** Request path relative to the provider endpoint, e.g. "/v1/images/generations". */
  path: string
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  /** What this endpoint does (drives the capabilityMap grouping). */
  capability: Capability
  /** Parameter schema (documentation + future validation). */
  params?: ParamSpec[]
  /** Response shape declaration. */
  response: ResponseSpec
  /** Whether the endpoint supports $base64 / $data_uri placeholders in the body. */
  acceptsCanvasRef?: boolean
  /** Short free-text notes (size constraints, gotchas). */
  notes?: string
}

/** Provider quality hint (used by the agent to pick fast vs. quality providers). */
export type QualityHint = 'fast' | 'balanced' | 'quality'

/** All QualityHint values. */
export const QUALITY_HINTS: readonly QualityHint[] = ['fast', 'balanced', 'quality'] as const

/**
 * Extract a value from a parsed JSON body by a dotted + `[index]` path.
 * Path syntax:
 *  - `data` → body.data
 *  - `data.b64_json` → body.data.b64_json
 *  - `data[0].b64_json` → body.data[0].b64_json
 *  - `choices[0].message.content` → body.choices[0].message.content
 *
 * Returns undefined when any segment doesn't resolve (missing field,
 * non-array indexed, etc.). Never throws — safe for sniffing unknown
 * response shapes.
 */
export function extractByPath(body: unknown, path: string): unknown {
  if (body === null || body === undefined) return undefined
  let current: unknown = body
  // Tokenize: split on '.' but keep [index] attached to the preceding key.
  // E.g. "data[0].b64_json" → ["data[0]", "b64_json"]
  const tokens = path.split('.')
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined
    // Parse "key[index]" or just "key".
    const match = /^([^\[\]]+)((?:\[\d+\])*)$/.exec(token)
    if (match === null) return undefined
    const key = match[1]
    const indices = match[2]
    // Walk the key.
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
    // Walk each [index].
    if (indices !== '') {
      const idxMatches = indices.matchAll(/\[(\d+)\]/g)
      for (const idxMatch of idxMatches) {
        if (current === null || current === undefined) return undefined
        if (!Array.isArray(current)) return undefined
        const idx = Number(idxMatch[1])
        current = current[idx]
      }
    }
  }
  return current
}

/**
 * Detect the response kind + path from a successful provider response.
 * Used by `aigc_probe_endpoint` to auto-fill an EndpointSpec.response.
 *
 * Heuristics (checked in order):
 *  1. body.data[0].b64_json is a non-empty string → b64_json_array, path "data[0].b64_json"
 *  2. body.data[0].url is a non-empty string (http) → url_field, path "data[0].url"
 *  3. body.choices[0].message.content is a string → json_text (chat shape)
 *  4. body.text is a string → json_text (transcription shape)
 *  5. body.result.image is a non-empty string (likely base64) → b64_json_field, path "result.image"
 *  6. body.image / body.b64 / body.data (string, not array) → b64_json_field
 *  7. Fallback: json_text (return the whole body inline).
 *
 * Binary responses (image/png, video/mp4, audio/mpeg Content-Type) are
 * detected by the caller from the Content-Type header, not from the body —
 * this function is only called when the body parses as JSON.
 */
export function detectResponseShape(body: unknown): { kind: ResponseKind; path?: string } {
  if (typeof body !== 'object' || body === null) return { kind: 'json_text' }
  const obj = body as Record<string, unknown>
  // 1. OpenAI image: data[0].b64_json
  const b64 = extractByPath(obj, 'data[0].b64_json')
  if (typeof b64 === 'string' && b64.length > 0) {
    return { kind: 'b64_json_array', path: 'data[0].b64_json' }
  }
  // 2. URL field: data[0].url
  const url = extractByPath(obj, 'data[0].url')
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return { kind: 'url_field', path: 'data[0].url' }
  }
  // 3. Chat: choices[0].message.content
  const content = extractByPath(obj, 'choices[0].message.content')
  if (typeof content === 'string') {
    return { kind: 'json_text' }
  }
  // 4. Transcription: text
  if (typeof obj.text === 'string') {
    return { kind: 'json_text' }
  }
  // 5. result.image (single b64 field)
  const resultImage = extractByPath(obj, 'result.image')
  if (typeof resultImage === 'string' && resultImage.length > 0) {
    return { kind: 'b64_json_field', path: 'result.image' }
  }
  // 6. body.image / body.b64 / body.data (string)
  for (const key of ['image', 'b64', 'data']) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) {
      return { kind: 'b64_json_field', path: key }
    }
  }
  // 7. Fallback.
  return { kind: 'json_text' }
}

/**
 * Auto-derive a short `instructions` string from a structured endpoint
 * catalog. Used by `aigc_provider_set_endpoints` so the legacy
 * `instructions` field stays in sync with the structured `endpoints`
 * (the legacy field is still read by old agent prompts).
 *
 * Format (one line per endpoint):
 *   POST /v1/images/generations {prompt,size} -> b64_json_array
 *   POST /v1/videos/generations {prompt,duration} -> url_field
 */
export function deriveInstructionsFromEndpoints(endpoints: readonly EndpointSpec[]): string {
  if (endpoints.length === 0) return ''
  const lines = endpoints.map(ep => {
    const params = (ep.params ?? [])
      .filter(p => p.required)
      .map(p => p.name)
      .join(',')
    const paramPart = params !== '' ? ` {${params}}` : ''
    const refHint = ep.acceptsCanvasRef ? ' (accepts $base64)' : ''
    return `${ep.method} ${ep.path}${paramPart} -> ${ep.response.kind}${refHint}`
  })
  return lines.join('\n')
}

/**
 * Find the EndpointSpec for one (path, method) pair on a provider.
 * Returns undefined when the provider has no catalog entry for that
 * endpoint — the caller then falls back to the legacy auto-sniff logic.
 *
 * Method matching is case-insensitive. When the provider has multiple
 * endpoints at the same path with different methods, the first match wins.
 */
export function findEndpointSpec(
  endpoints: readonly EndpointSpec[] | undefined,
  path: string,
  method: string,
): EndpointSpec | undefined {
  if (endpoints === undefined || endpoints.length === 0) return undefined
  const upperMethod = method.toUpperCase()
  return endpoints.find(ep => ep.path === path && ep.method.toUpperCase() === upperMethod)
}

/** Group endpoints by capability (for the capabilityMap output). */
export function endpointsByCapability(endpoints: readonly EndpointSpec[]): Map<Capability, EndpointSpec[]> {
  const map = new Map<Capability, EndpointSpec[]>()
  for (const ep of endpoints) {
    const list = map.get(ep.capability)
    if (list === undefined) {
      map.set(ep.capability, [ep])
    } else {
      list.push(ep)
    }
  }
  return map
}

/** Distinct capabilities a provider supports (derived from its endpoints). */
export function capabilitiesOf(endpoints: readonly EndpointSpec[] | undefined): Capability[] {
  if (endpoints === undefined || endpoints.length === 0) return []
  const seen = new Set<Capability>()
  for (const ep of endpoints) seen.add(ep.capability)
  return [...seen]
}
