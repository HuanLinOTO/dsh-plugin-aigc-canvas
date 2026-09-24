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
import type { AigcProvider, ResolvedAigcProvider } from './config.js'
import { resolveAigcProviders } from './config.js'
import { validateProviderId } from './provider-shape.js'

/** CRUD result: the success branch carries the latest list. */
export type ProviderMutationResult =
  | { readonly ok: true; readonly providers: readonly ResolvedAigcProvider[] }
  | { readonly ok: false; readonly error: string }

/**
 * Persistence face attached to a {@link ProviderStore}.
 *
 * `source` reads the currently committed raw list (the entry's live volatile
 * config); `persist` commits a replacement. Both are provided by
 * `installAigcSettings` (see `settings.ts`).
 */
export interface ProviderPersistence {
  /** The currently committed raw provider list. */
  source(): readonly AigcProvider[]
  /** Commit a replacement list. */
  persist(providers: readonly AigcProvider[]): Promise<void>
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
export class ProviderStore {
  private readonly providers = new Map<string, ResolvedAigcProvider>()
  /** Optional persistence face; absent in headless mode. */
  private persistence: ProviderPersistence | undefined

  /** @param seed - resolved seed providers (the composition layer). */
  constructor(seed: readonly ResolvedAigcProvider[]) {
    for (const provider of seed) {
      this.providers.set(provider.id, provider)
    }
  }

  /**
   * Attach a persistence face. Subsequent reads derive from the face's
   * source and mutations commit through it.
   * @param persistence - the read/write face over the entry's config.
   */
  attachPersistence(persistence: ProviderPersistence): void {
    this.persistence = persistence
  }

  /** The committed provider list (insertion order; duplicates keep the first). */
  private committed(): readonly ResolvedAigcProvider[] {
    if (this.persistence === undefined) return [...this.providers.values()]
    return resolveAigcProviders(this.persistence.source())
  }

  /** Snapshot of all providers, in order. */
  list(): readonly ResolvedAigcProvider[] {
    return this.committed()
  }

  /** Look up one provider by id. */
  get(id: string): ResolvedAigcProvider | undefined {
    return this.committed().find(provider => provider.id === id)
  }

  /** The default provider (first in order); undefined if empty. */
  defaultProvider(): ResolvedAigcProvider | undefined {
    return this.committed()[0]
  }

  /** Add a new provider. Returns failure for duplicate id or invalid shape. */
  async add(provider: AigcProvider): Promise<ProviderMutationResult> {
    const idError = validateProviderId(provider.id)
    if (idError !== undefined) return { ok: false, error: idError }
    const committed = this.committed()
    if (committed.some(p => p.id === provider.id)) {
      return { ok: false, error: `provider id already exists: ${provider.id}` }
    }
    // Mutations added at runtime are never builtin: only the composition
    // seed can mark a provider as builtin. Strip any caller-supplied
    // builtin=true.
    const stored: ResolvedAigcProvider = { ...resolveStored(provider), builtin: false }
    return this.commit([...committed, stored])
  }

  /** Update an existing provider. Returns failure if the id is unknown. */
  async update(provider: AigcProvider): Promise<ProviderMutationResult> {
    const idError = validateProviderId(provider.id)
    if (idError !== undefined) return { ok: false, error: idError }
    const committed = this.committed()
    const existing = committed.find(p => p.id === provider.id)
    if (existing === undefined) {
      return { ok: false, error: `provider id not found: ${provider.id}` }
    }
    // The `builtin` flag is a presentation hint owned by the seed layer: an
    // update cannot flip it. Auth members omitted from the update keep the
    // committed values.
    const stored: ResolvedAigcProvider = {
      ...resolveStored(provider),
      auth: {
        scheme: provider.auth?.scheme ?? existing.auth.scheme,
        name: provider.auth?.name ?? existing.auth.name,
      },
      builtin: existing.builtin,
    }
    return this.commit(committed.map(p => (p.id === stored.id ? stored : p)))
  }

  /**
   * Replace a provider's usage instructions (called by the model's
   * aigc_provider_set_instructions tool after it probes the API).
   */
  async setInstructions(id: string, instructions: string): Promise<ProviderMutationResult> {
    const committed = this.committed()
    const existing = committed.find(p => p.id === id)
    if (existing === undefined) {
      return { ok: false, error: `provider id not found: ${id}` }
    }
    return this.commit(committed.map(p => (p.id === id ? { ...p, instructions } : p)))
  }

  /** Remove a provider. Returns failure for unknown id. */
  async remove(id: string): Promise<ProviderMutationResult> {
    const committed = this.committed()
    if (!committed.some(p => p.id === id)) {
      return { ok: false, error: `provider id not found: ${id}` }
    }
    return this.commit(committed.filter(p => p.id !== id))
  }

  /**
   * Commit a replacement list: through the persistence face when attached
   * (the post-commit committed value is reported), otherwise into the
   * in-memory map. A refused persistence write leaves the committed state
   * untouched and reports `{ ok: false }`.
   */
  private async commit(next: readonly AigcProvider[]): Promise<ProviderMutationResult> {
    if (this.persistence === undefined) {
      this.providers.clear()
      for (const provider of resolveAigcProviders(next)) {
        this.providers.set(provider.id, provider)
      }
      return { ok: true, providers: this.list() }
    }
    try {
      await this.persistence.persist(next)
      return { ok: true, providers: this.list() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Normalize one mutation input into its resolved stored shape. */
function resolveStored(provider: AigcProvider): ResolvedAigcProvider {
  const auth = provider.auth ?? {}
  return {
    id: provider.id,
    name: provider.name ?? '',
    endpoint: provider.endpoint ?? 'stub://aigc-backend',
    apiKey: provider.apiKey ?? '',
    instructions: provider.instructions ?? '',
    auth: {
      scheme: auth.scheme ?? 'bearer',
      name: auth.name ?? '',
    },
    builtin: provider.builtin ?? false,
  }
}
