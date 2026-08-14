import type { AigcProvider, ResolvedAigcProvider } from './config.js';
/** CRUD result: the success branch carries the latest list. */
export type ProviderMutationResult = {
    readonly ok: true;
    readonly providers: readonly ResolvedAigcProvider[];
} | {
    readonly ok: false;
    readonly error: string;
};
/**
 * Mutable provider store. Owns the canonical provider list; the backend
 * client map and RPC handlers share one instance per plugin fiber.
 *
 * Persistence: on construction the store loads `~/.dsh/aigc-canvas/
 * providers.json` (if present) and merges it over the cordis.yml seed —
 * persisted providers win, so user edits and deletions survive restarts.
 * Every mutation writes the list back to disk (fire-and-forget).
 */
export declare class ProviderStore {
    private readonly providers;
    private readonly dataPath;
    /** Serializes disk writes so rapid mutations can't interleave. */
    private persistChain;
    constructor(seed: readonly AigcProvider[], dataPath?: string);
    /** Snapshot of all providers, in insertion order. */
    list(): readonly ResolvedAigcProvider[];
    /** Look up one provider by id. */
    get(id: string): ResolvedAigcProvider | undefined;
    /** The default provider (first in insertion order); undefined if empty. */
    defaultProvider(): ResolvedAigcProvider | undefined;
    /** Add a new provider. Returns failure for duplicate id or invalid shape. */
    add(provider: AigcProvider): ProviderMutationResult;
    /** Update an existing provider. Returns failure if the id is unknown. */
    update(provider: AigcProvider): ProviderMutationResult;
    /**
     * Replace a provider's usage instructions (called by the model's
     * aigc_provider_set_instructions tool after it probes the API).
     */
    setInstructions(id: string, instructions: string): ProviderMutationResult;
    /** Remove a provider. Returns failure for unknown id. */
    remove(id: string): ProviderMutationResult;
    /**
     * Persist the current provider list to disk (fire-and-forget, serialized).
     * Only the user-editable fields are written; `builtin` is re-derived from
     * the seed on load. Failures are swallowed — the in-memory state stays
     * canonical. Each call snapshots the CURRENT list, so a burst of mutations
     * ends with the latest state on disk.
     */
    private persist;
}
