/**
 * Serializable configuration and defaults for the AIGC canvas host half.
 * The `providers` array holds one or more AIGC provider configs (name /
 * endpoint / apiKey / instructions). Since dsh 0.1.7-rc.1 the editable
 * fields are `.volatile()` members of the entry's profile-owned Cordis
 * Config (DSH-0.1.7-J1-04): the composition `config:` in cordis.patch.yml is
 * the first-boot seed only, and runtime edits persist per profile under the
 * entry id `dsh-aigc-canvas` through the settings service.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/config
 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

export { PROVIDER_ID_PATTERN, validateProviderId } from './provider-shape.js'

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
  /** Provider API key (persisted with the entry config in cordis.patch.yml; set via GUI or seed). */
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

/**
 * The live Cordis config the Loader passes to `apply`.
 *
 * `providers` is `.volatile()`: the field arrives as a stable reference whose
 * `.get()` always returns the latest accepted value (a committed settings
 * edit updates it in place without remounting the plugin). The other fields
 * are composition-seed knobs resolved once at load.
 */
export interface AigcEntryConfig {
  /** Live provider list reference; `.get()` returns the latest accepted value. */
  providers?: Volatile<readonly AigcProvider[]>
  requestTimeoutMs?: number
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

/**
 * Schemastery schema for the plugin's profile-owned Config.
 *
 * `providers` is `.volatile()` (dsh 0.1.7-rc.1 DSH-0.1.7-J1-04): the settings
 * service enumerates the entry's volatile fields for the configuration form,
 * and a committed edit updates the running reference in place. The numeric
 * knobs stay non-volatile (cordis.patch.yml seed only).
 */
export const Config = z.object({
  providers: z.array(ProviderSchema).description('One or more AIGC providers; the first is the default.').default([
    { id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '', auth: { scheme: 'bearer', name: '' }, builtin: true },
  ])
    .volatile(),
  requestTimeoutMs: z.number().step(1).min(1000).default(300_000),
  mediaSizeLimit: z.number().step(1).min(1024).default(100 * 1024 * 1024),
}) as unknown as z<AigcEntryConfig>

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

/** The fallback stub provider seeded when no provider is configured at load. */
const DEFAULT_STUB_PROVIDER: ResolvedAigcProvider = {
  id: 'stub',
  name: '',
  endpoint: 'stub://aigc-backend',
  apiKey: '',
  instructions: '',
  auth: { scheme: 'bearer', name: '' },
  builtin: true,
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

/**
 * Normalize a raw provider list (the volatile reference's latest snapshot, a
 * legacy imported document, or a hand-edited override) into resolved
 * providers. Non-object entries are skipped; duplicate ids keep the first
 * occurrence (insertion order preserved).
 * @param raw - the raw list value.
 * @returns the resolved providers, in order, deduplicated by id.
 */
export function resolveAigcProviders(raw: unknown): readonly ResolvedAigcProvider[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, ResolvedAigcProvider>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const resolved = resolveProvider(item as AigcProvider)
    if (!byId.has(resolved.id)) byId.set(resolved.id, resolved)
  }
  return [...byId.values()]
}

/**
 * Resolve the apply-time seed config (direct-call defaults after Loader
 * schema validation has normally run). The provider list reads the live
 * volatile reference; when it resolves empty at load, the default stub is
 * seeded so the tools always have one provider.
 * @param config - the entry config the Loader passed to `apply`.
 * @returns the fully defaulted seed settings.
 */
export function resolveAigcConfig(config: AigcEntryConfig | undefined): ResolvedAigcConfig {
  const providers = [...resolveAigcProviders(config?.providers?.get())]
  if (providers.length === 0) {
    providers.push(DEFAULT_STUB_PROVIDER)
  }
  return {
    providers,
    requestTimeoutMs: config?.requestTimeoutMs ?? 300_000,
    mediaSizeLimit: config?.mediaSizeLimit ?? 100 * 1024 * 1024,
  }
}
