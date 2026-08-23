/**
 * Serializable configuration and defaults for the AIGC canvas host half.
 * The `providers` array holds one or more AIGC provider configs (name /
 * endpoint / apiKey / instructions), editable at runtime through the DSH
 * GUI settings page; cordis.yml `config:` is the first-boot seed only.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/config
 */
import z from 'schemastery';
/** Provider id pattern: lowercase letters, digits, hyphens; must start with a letter. */
export declare const PROVIDER_ID_PATTERN: RegExp;
/** How the aigc_http_request tool attaches the provider apiKey to requests. */
export interface AigcProviderAuth {
    /**
     * Auth scheme:
     *  - `bearer`: `Authorization: Bearer <apiKey>` (the default)
     *  - `header`: `<name>: <apiKey>` (name defaults to `x-api-key`)
     *  - `query`:  `<name>=<apiKey>` URL query parameter (name defaults to `api_key`)
     */
    scheme?: 'bearer' | 'header' | 'query';
    /** Header name (scheme=header) or query param name (scheme=query). Ignored for bearer. */
    name?: string;
}
/** Resolved auth config (every field guaranteed). */
export interface ResolvedAigcProviderAuth {
    scheme: 'bearer' | 'header' | 'query';
    name: string;
}
/** One AIGC provider configuration (editable at runtime via the settings page). */
export interface AigcProvider {
    /** Stable identifier (lowercase, hyphenated); used as the `provider_id` tool param. */
    id: string;
    /** Provider display name (e.g. "Volcano Engine", "Jimeng", "MiniMax"). */
    name: string;
    /** Provider API endpoint URL. `stub://aigc-backend` = the built-in stub. */
    endpoint: string;
    /** Provider API key (stored in memory only; set via GUI or cordis.yml). */
    apiKey: string;
    /** Free-form usage instructions the agent reads via aigc_get_provider_info. */
    instructions: string;
    /** How the http tool attaches the apiKey (default: Authorization: Bearer). */
    auth?: AigcProviderAuth;
    /** Whether this provider is a builtin seed (cordis.yml); user-added providers are never builtin. */
    builtin?: boolean;
}
/** Tunable AIGC canvas host settings (every field optional; defaults fill in). */
export interface AigcCanvasConfig {
    /** One or more AIGC providers; the first is the default. */
    providers?: AigcProvider[];
    /** Per-request timeout for backend calls (ms). */
    requestTimeoutMs?: number;
    /** Maximum media bytes to write to disk per generated asset. */
    mediaSizeLimit?: number;
}
/** Schemastery schema for the plugin configuration. */
export declare const Config: z<AigcCanvasConfig>;
/** A fully-resolved provider (all fields guaranteed). */
export interface ResolvedAigcProvider extends AigcProvider {
    name: string;
    endpoint: string;
    apiKey: string;
    instructions: string;
    auth: ResolvedAigcProviderAuth;
    builtin: boolean;
}
/** Fully defaulted settings consumed by the host half. */
export interface ResolvedAigcConfig {
    readonly providers: readonly ResolvedAigcProvider[];
    requestTimeoutMs: number;
    mediaSizeLimit: number;
}
/** Returns true when the provider endpoint points at the built-in stub backend. */
export declare function isStubEndpoint(endpoint: string): boolean;
/** Validate a provider id; returns an error message or undefined if valid. */
export declare function validateProviderId(id: string): string | undefined;
/** Apply direct-call defaults after Loader schema validation has normally run. */
export declare function resolveAigcConfig(config: AigcCanvasConfig | undefined): ResolvedAigcConfig;
