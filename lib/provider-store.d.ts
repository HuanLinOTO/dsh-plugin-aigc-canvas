/**
 * Provider store with CRUD, read-through the entry's profile-owned Cordis
 * Config when a persistence face is attached (the list persists in the
 * active profile's `cordis.patch.yml` under the `dsh-aigc-canvas` entry id,
 * dsh 0.1.7-rc.1 DSH-0.1.7-J1-04). Reads derive from the persistence
 * source on every call, so edits committed by ANY writer (the settings
 * page through the client `configForms` transport, the model's
 * aigc_provider_set_instructions tool, a hand-edited profile patch) are
 * visible immediately. Without an attached face (headless assemblies with
 * no settings provider) the store is in-memory only: composition seed,
 * lost on unload.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/provider-store
 */
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
 * Persistence face attached to a {@link ProviderStore}.
 *
 * `source` reads the currently committed raw list (the entry's live volatile
 * config); `persist` commits a replacement. Both are provided by
 * `installAigcSettings` (see `settings.ts`).
 */
export interface ProviderPersistence {
    /** The currently committed raw provider list. */
    source(): readonly AigcProvider[];
    /** Commit a replacement list. */
    persist(providers: readonly AigcProvider[]): Promise<void>;
}
/**
 * Mutable provider store. Owns the canonical provider list; tool
 * registration shares one instance per plugin fiber.
 *
 * While no persistence face is attached the in-memory map is canonical
 * (headless mode). Once a face is attached, every read resolves through the
 * face's source and every mutation commits through `persist` before its
 * result is reported — the committed profile config is the single source of
 * truth.
 */
export declare class ProviderStore {
    private readonly providers;
    /** Optional persistence face; absent in headless mode. */
    private persistence;
    /** @param seed - resolved seed providers (the composition layer). */
    constructor(seed: readonly ResolvedAigcProvider[]);
    /**
     * Attach a persistence face. Subsequent reads derive from the face's
     * source and mutations commit through it.
     * @param persistence - the read/write face over the entry's config.
     */
    attachPersistence(persistence: ProviderPersistence): void;
    /** The committed provider list (insertion order; duplicates keep the first). */
    private committed;
    /** Snapshot of all providers, in order. */
    list(): readonly ResolvedAigcProvider[];
    /** Look up one provider by id. */
    get(id: string): ResolvedAigcProvider | undefined;
    /** The default provider (first in order); undefined if empty. */
    defaultProvider(): ResolvedAigcProvider | undefined;
    /** Add a new provider. Returns failure for duplicate id or invalid shape. */
    add(provider: AigcProvider): Promise<ProviderMutationResult>;
    /** Update an existing provider. Returns failure if the id is unknown. */
    update(provider: AigcProvider): Promise<ProviderMutationResult>;
    /**
     * Replace a provider's usage instructions (called by the model's
     * aigc_provider_set_instructions tool after it probes the API).
     */
    setInstructions(id: string, instructions: string): Promise<ProviderMutationResult>;
    /** Remove a provider. Returns failure for unknown id. */
    remove(id: string): Promise<ProviderMutationResult>;
    /**
     * Commit a replacement list: through the persistence face when attached
     * (the post-commit committed value is reported), otherwise into the
     * in-memory map. A refused persistence write leaves the committed state
     * untouched and reports `{ ok: false }`.
     */
    private commit;
}
