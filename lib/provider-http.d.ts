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
import type { ResolvedAigcProvider } from './config.js';
/** Binary kinds the executor can hand back (for canvas placement). */
export type ProviderBinaryKind = 'image' | 'video' | 'audio' | 'other';
/** Text response kinds (inline for the model). */
export type ProviderTextKind = 'json' | 'text';
/** One raw request the model wants to send to the provider API. */
export interface ProviderHttpRequest {
    /** HTTP method (default GET). */
    method?: string;
    /**
     * Path relative to the provider endpoint, e.g. `/v1/images/generations`.
     * Must start with `/`.
     *
     * Absolute URLs are also accepted, but only when same-origin with the
     * provider's configured endpoint (same protocol + host + port). This lets
     * the model fetch provider-returned download URLs (e.g. video result URLs)
     * that require the provider's auth, without opening an SSRF surface.
     */
    path: string;
    /** Extra request headers (may not override the auth header). */
    headers?: Record<string, string>;
    /** Raw request body (string, typically JSON). */
    body?: string;
    /** URL query params to append (merged with any auth query param). */
    query?: Record<string, string>;
}
/** A successful binary response (persisted by the caller). */
export interface ProviderHttpBinary {
    ok: true;
    status: number;
    kind: ProviderBinaryKind;
    contentType: string;
    bytes: Buffer;
    /** Bytes length (the caller's file size). */
    size: number;
}
/** A successful text response (embedded inline for the model). */
export interface ProviderHttpText {
    ok: true;
    status: number;
    kind: ProviderTextKind;
    contentType: string;
    text: string;
}
/** A failed response (non-2xx): the body is surfaced so the model can adapt. */
export interface ProviderHttpFailure {
    ok: false;
    status: number;
    contentType: string;
    /** Truncated response body (UTF-8) for the model to read. */
    text: string;
}
export type ProviderHttpResult = ProviderHttpBinary | ProviderHttpText | ProviderHttpFailure;
/**
 * Cap on inline text responses. The model-facing tool result is size-
 * limited by the host framework (very small — a few hundred chars), so
 * anything larger is saved to disk and the model gets a file_path with a
 * short preview instead.
 */
export declare const INLINE_TEXT_CAP = 2000;
/** Execute one request against the provider (or the built-in stub). */
export declare function executeProviderRequest(provider: ResolvedAigcProvider, request: ProviderHttpRequest, opts: {
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<ProviderHttpResult>;
