import type { Context } from './context-types.js';
import type { ResolvedAigcProvider } from './config.js';
import type { AigcElement, AigcCanvasService } from './canvas-registry.js';
/** Truncate a prompt to a short title (first line, capped). */
declare function titleOf(prompt: string): string;
/**
 * The model-facing shape of one element (no internal uuid, no media bytes).
 * The `filePath` is the primary identifier the agent uses to reference
 * the element in subsequent tool calls; `x`/`y` are the canvas position.
 */
declare function elementProjection(el: AigcElement): Record<string, unknown>;
/** Edge projection: resolve uuids to filePaths so the agent can read the graph. */
declare function edgeProjection(edge: {
    source: string;
    target: string;
}, lookup: (uuid: string) => AigcElement): {
    source: string;
    target: string;
};
/** Info about one provider (for the aigc_get_provider_info tool output). */
export interface ProviderInfo {
    id: string;
    name: string;
    endpoint: string;
    instructions: string;
    isStub: boolean;
    isDefault: boolean;
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
export declare function registerTools(ctx: Context, getProvider: (providerId?: string) => ResolvedAigcProvider, setInstructions: (id: string, instructions: string) => {
    ok: boolean;
    error?: string;
}, listProviders: () => readonly ProviderInfo[], canvas: AigcCanvasService, resolveCwd: (sessionId: string) => string, getTimeoutMs: () => number, getMediaLimit?: () => number): () => void;
/** Re-export the projection helpers for the unit tests. */
export { elementProjection, edgeProjection, titleOf };
