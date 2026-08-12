/**
 * Serializable configuration and defaults for the AIGC canvas host half.
 * The `providers` array holds one or more AIGC provider configs (name /
 * endpoint / apiKey / instructions), editable at runtime through the DSH
 * GUI settings page; cordis.yml `config:` is the first-boot seed only.
 *
 * @module @dsh-external/dsh-aigc-canvas/config
 */
import z from 'schemastery'

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
  instructions: z.string().description('Free-form usage instructions for the agent (call aigc_get_provider_info to read).').default(''),
  auth: ProviderAuthSchema.description('How the aigc_http_request tool attaches the apiKey.').default({ scheme: 'bearer', name: '' }),
  builtin: z.boolean().description('Whether this provider is a builtin seed (cordis.yml).').default(false),
})

/** Schemastery schema for the plugin configuration. */
export const Config: z<AigcCanvasConfig> = z.object({
  providers: z.array(ProviderSchema).description('One or more AIGC providers; the first is the default.').default([
    { id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '', auth: { scheme: 'bearer', name: '' }, builtin: true },
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
  }
}

/** Apply direct-call defaults after Loader schema validation has normally run. */
export function resolveAigcConfig(config: AigcCanvasConfig | undefined): ResolvedAigcConfig {
  const providers = (config?.providers ?? []).map(resolveProvider)
  // If no providers are configured, add a default stub so the tools always have one.
  if (providers.length === 0) {
    providers.push({ id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '', auth: { scheme: 'bearer', name: '' }, builtin: true })
  }
  return {
    providers,
    requestTimeoutMs: config?.requestTimeoutMs ?? 300_000,
    mediaSizeLimit: config?.mediaSizeLimit ?? 100 * 1024 * 1024,
  }
}
