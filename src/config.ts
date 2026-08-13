/**
 * Serializable configuration and defaults for the AIGC canvas host half.
 * The `providers` array holds one or more AIGC provider configs (name /
 * endpoint / apiKey / instructions), editable at runtime through the DSH
 * GUI settings page; cordis.yml `config:` is the first-boot seed only.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/config
 */
import z from 'schemastery'
import type { EndpointSpec, QualityHint } from './endpoint-catalog.js'

/** Provider id pattern: lowercase letters, digits, hyphens; must start with a letter. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** How the aigc_http_request tool attaches the provider apiKey to requests. */
export interface AigcProviderAuth {
  /**
   * Auth scheme:
   *  - `bearer`: `Authorization: Bearer <apiKey>` (the default)
   *  - `header`: `<name>: <apiKey>` (name defaults to `x-api-key`)
   *  - `query`:  `<name>=<apiKey>` URL query parameter (name defaults to `api_key`)
   */
  scheme?: 'bearer' | 'header' | 'query'
  /** Header name (scheme=header) or query param name (scheme=query). Ignored for bearer. */
  name?: string
}

/** Resolved auth config (every field guaranteed). */
export interface ResolvedAigcProviderAuth {
  scheme: 'bearer' | 'header' | 'query'
  name: string
}

/** One AIGC provider configuration (editable at runtime via the settings page). */
export interface AigcProvider {
  /** Stable identifier (lowercase, hyphenated); used as the `provider_id` tool param. */
  id: string
  /** Provider display name (e.g. "Volcano Engine", "Jimeng", "MiniMax"). */
  name: string
  /** Provider API endpoint URL. `stub://aigc-backend` = the built-in stub. */
  endpoint: string
  /** Provider API key (stored in memory only; set via GUI or cordis.yml). */
  apiKey: string
  /** Free-form usage instructions the agent reads via aigc_get_provider_info. */
  instructions: string
  /** How the http tool attaches the apiKey (default: Authorization: Bearer). */
  auth?: AigcProviderAuth
  /** Whether this provider is a builtin seed (cordis.yml); user-added providers are never builtin. */
  builtin?: boolean
  /**
   * Structured capability catalog (replaces the free-form `instructions`
   * string for new agent flows). When non-empty, aigc_http_request uses
   * the matching EndpointSpec.response.kind to process responses instead
   * of the legacy OpenAI-format sniff. When empty, the legacy sniff + the
   * `instructions` string are used (backward compat).
   */
  endpoints?: EndpointSpec[]
  /**
   * Provider selection priority (smaller = higher priority; default 100).
   * Drives the capabilityMap ordering in aigc_get_provider_info.
   */
  priority?: number
  /** Cost per call in USD (for cost tracking; future use). */
  costPerCall?: number
  /** Cost per 1k tokens in USD (for chat/transcription cost tracking). */
  costPerKiloToken?: number
  /** Cost per second of video/audio in USD (for t2v/tts cost tracking). */
  costPerSecond?: number
  /** Average latency in ms (host auto-statistic; future use). */
  avgLatencyMs?: number
  /** Quality hint used by the agent to pick fast vs. quality providers. */
  qualityHint?: QualityHint
}

/** Tunable AIGC canvas host settings (every field optional; defaults fill in). */
export interface AigcCanvasConfig {
  /** One or more AIGC providers; the first is the default. */
  providers?: AigcProvider[]
  /** Per-request timeout for backend calls (ms). */
  requestTimeoutMs?: number
  /** Maximum media bytes to write to disk per generated asset. */
  mediaSizeLimit?: number
}

/** Schemastery schema for one endpoint's response shape declaration. */
const ResponseSchema = z.object({
  kind: z.union(['b64_json_array', 'b64_json_field', 'binary', 'url_field', 'json_text']).description(
    'How host processes a successful response. b64_json_array = OpenAI image format {data:[{b64_json}]}; '
    + 'b64_json_field = single base64 string at response.path; binary = raw bytes (image/video/audio); '
    + 'url_field = {data:[{url}]} requiring a secondary GET; json_text = inline JSON/text body.',
  ).default('json_text'),
  path: z.string().description(
    'Dotted + [index] path to the payload field (e.g. "data[0].b64_json", "result.image", "choices[0].message.content"). '
    + 'Required for b64_json_array / b64_json_field / url_field; ignored for binary and json_text.',
  ).default(''),
})

/** Schemastery schema for one parameter. */
const ParamSchema = z.object({
  name: z.string().description('Parameter name (e.g. "prompt", "size", "seed").').default(''),
  type: z.union(['string', 'number', 'integer', 'boolean', 'array', 'object', 'image_ref', 'video_ref', 'audio_ref']).description(
    'JSON-like type. image_ref / video_ref / audio_ref = the param accepts a canvas element filePath (host expands to $base64).',
  ).default('string'),
  required: z.boolean().description('Whether the parameter is required.').default(false),
  default: z.any().description('Default value when omitted.').default(null),
  description: z.string().description('Short human-readable description.').default(''),
})

/** Schemastery schema for one endpoint. */
const EndpointSchema = z.object({
  path: z.string().description('Request path relative to the provider endpoint, e.g. "/v1/images/generations".').default(''),
  method: z.union(['GET', 'POST', 'PUT', 'PATCH']).description('HTTP method.').default('POST'),
  capability: z.union(['t2i', 'i2i', 't2v', 'i2v', 'fl2v', 'ref2v', 'tts', 'music', 'transcribe', 'edit', 'chat']).description(
    'What this endpoint does. Drives the capabilityMap grouping in aigc_get_provider_info.',
  ).default('t2i'),
  params: z.array(ParamSchema).description('Parameter schema (documentation + future validation).').default([]),
  response: ResponseSchema.description('Response shape declaration.').default({ kind: 'json_text', path: '' }),
  acceptsCanvasRef: z.boolean().description('Whether the endpoint supports $base64 / $data_uri placeholders in the body.').default(false),
  notes: z.string().description('Short free-text notes (size constraints, gotchas).').default(''),
})

/** Schemastery schema for the per-provider auth config. */
const ProviderAuthSchema = z.object({
  scheme: z.union(['bearer', 'header', 'query']).description('How to attach the apiKey: bearer (Authorization: Bearer <key>), header (<name>: <key>), or query (<name>=<key>).').default('bearer'),
  name: z.string().description('Header name (scheme=header) or query param name (scheme=query). Ignored for bearer.').default(''),
})

/** Schemastery schema for one provider. */
const ProviderSchema = z.object({
  id: z.string().description('Provider id (lowercase, hyphenated; used as the provider_id tool param).').default(''),
  name: z.string().description('Provider display name (e.g. "Volcano Engine", "Jimeng", "MiniMax").').default(''),
  endpoint: z.string().description('Provider API endpoint URL. Use "stub://aigc-backend" for the built-in stub.').default('stub://aigc-backend'),
  apiKey: z.string().description('Provider API key. Leave empty for the stub backend.').default(''),
  instructions: z.string().description('Free-form usage instructions for the agent (call aigc_get_provider_info to read). Auto-derived from endpoints when endpoints are set via aigc_provider_set_endpoints.').default(''),
  auth: ProviderAuthSchema.description('How the aigc_http_request tool attaches the apiKey.').default({ scheme: 'bearer', name: '' }),
  builtin: z.boolean().description('Whether this provider is a builtin seed (cordis.yml).').default(false),
  endpoints: z.array(EndpointSchema).description('Structured capability catalog. When non-empty, aigc_http_request uses the EndpointSpec.response.kind to process responses. Empty = legacy auto-sniff + instructions.').default([]),
  priority: z.number().step(1).description('Selection priority (smaller = higher priority; default 100). Drives capabilityMap ordering.').default(100),
  costPerCall: z.number().step(0.0001).description('Cost per call in USD (for cost tracking).').default(0),
  costPerKiloToken: z.number().step(0.0001).description('Cost per 1k tokens in USD (for chat/transcription cost tracking).').default(0),
  costPerSecond: z.number().step(0.0001).description('Cost per second of video/audio in USD (for t2v/tts cost tracking).').default(0),
  avgLatencyMs: z.number().step(1).description('Average latency in ms (host auto-statistic).').default(0),
  qualityHint: z.union(['fast', 'balanced', 'quality']).description('Quality hint: fast / balanced / quality.').default('balanced'),
})

/** Schemastery schema for the plugin configuration. */
export const Config: z<AigcCanvasConfig> = z.object({
  providers: z.array(ProviderSchema).description('One or more AIGC providers; the first is the default.').default([
    { id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '', auth: { scheme: 'bearer', name: '' }, builtin: true, endpoints: [], priority: 100, costPerCall: 0, costPerKiloToken: 0, costPerSecond: 0, avgLatencyMs: 0, qualityHint: 'balanced' },
  ]),
  requestTimeoutMs: z.number().step(1).min(1000).default(300_000),
  mediaSizeLimit: z.number().step(1).min(1024).default(100 * 1024 * 1024),
})

/** A fully-resolved provider (all fields guaranteed). */
export interface ResolvedAigcProvider extends AigcProvider {
  name: string
  endpoint: string
  apiKey: string
  instructions: string
  auth: ResolvedAigcProviderAuth
  builtin: boolean
  endpoints: EndpointSpec[]
  priority: number
  costPerCall: number
  costPerKiloToken: number
  costPerSecond: number
  avgLatencyMs: number
  qualityHint: QualityHint
}

/** Fully defaulted settings consumed by the host half. */
export interface ResolvedAigcConfig {
  readonly providers: readonly ResolvedAigcProvider[]
  requestTimeoutMs: number
  mediaSizeLimit: number
}

/** Returns true when the provider endpoint points at the built-in stub backend. */
export function isStubEndpoint(endpoint: string): boolean {
  return endpoint === '' || endpoint === 'stub://aigc-backend'
}

/** Validate a provider id; returns an error message or undefined if valid. */
export function validateProviderId(id: string): string | undefined {
  if (id === '') return 'provider id is required'
  if (!PROVIDER_ID_PATTERN.test(id)) return `invalid provider id: ${JSON.stringify(id)} (must be lowercase, hyphenated, start with a letter)`
  return undefined
}

/** Migrate + resolve a single provider from config input. */
function resolveProvider(p: AigcProvider): ResolvedAigcProvider {
  const auth = p.auth ?? {}
  return {
    id: p.id,
    name: p.name ?? '',
    endpoint: p.endpoint ?? 'stub://aigc-backend',
    apiKey: p.apiKey ?? '',
    instructions: p.instructions ?? '',
    auth: {
      scheme: auth.scheme ?? 'bearer',
      name: auth.name ?? '',
    },
    builtin: p.builtin ?? false,
    endpoints: p.endpoints ?? [],
    priority: p.priority ?? 100,
    costPerCall: p.costPerCall ?? 0,
    costPerKiloToken: p.costPerKiloToken ?? 0,
    costPerSecond: p.costPerSecond ?? 0,
    avgLatencyMs: p.avgLatencyMs ?? 0,
    qualityHint: p.qualityHint ?? 'balanced',
  }
}

/** Apply direct-call defaults after Loader schema validation has normally run. */
export function resolveAigcConfig(config: AigcCanvasConfig | undefined): ResolvedAigcConfig {
  const providers = (config?.providers ?? []).map(resolveProvider)
  // If no providers are configured, add a default stub so the tools always have one.
  if (providers.length === 0) {
    providers.push({
      id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '',
      auth: { scheme: 'bearer', name: '' }, builtin: true,
      endpoints: [], priority: 100, costPerCall: 0, costPerKiloToken: 0, costPerSecond: 0, avgLatencyMs: 0, qualityHint: 'balanced',
    })
  }
  return {
    providers,
    requestTimeoutMs: config?.requestTimeoutMs ?? 300_000,
    mediaSizeLimit: config?.mediaSizeLimit ?? 100 * 1024 * 1024,
  }
}
