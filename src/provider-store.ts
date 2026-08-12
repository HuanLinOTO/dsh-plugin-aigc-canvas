/**
 * In-memory provider store with CRUD + disk persistence. Holds the
 * canonical list of AIGC providers; tool registration and the settings-
 * page RPC share one instance per plugin fiber. Persisted to
 * `~/.dsh/aigc-canvas/providers.json` so restarts keep user-added
 * providers and instructions.
 *
 * @module @dsh-external/dsh-aigc-canvas/provider-store
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import type { AigcProvider, ResolvedAigcProvider } from './config.js'
import { validateProviderId } from './config.js'
import type { EndpointSpec } from './endpoint-catalog.js'
import { deriveInstructionsFromEndpoints } from './endpoint-catalog.js'

/** Directory for persisted AIGC canvas state (under the DSH user dir). */
const DATA_DIR = join(homedir(), '.dsh', 'aigc-canvas')

/** Path to the persisted providers JSON. */
const PROVIDERS_JSON = join(DATA_DIR, 'providers.json')

/** Atomic write: mkdir + temp file + rename. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  } catch {
    // Best-effort: leave the temp file behind if rename fails.
  }
}

/** CRUD result: the success branch carries the latest list. */
export type ProviderMutationResult =
  | { readonly ok: true; readonly providers: readonly ResolvedAigcProvider[] }
  | { readonly ok: false; readonly error: string }

/**
 * Mutable provider store. Owns the canonical provider list; the backend
 * client map and RPC handlers share one instance per plugin fiber.
 *
 * Persistence: on construction the store loads `~/.dsh/aigc-canvas/
 * providers.json` (if present) and merges it over the cordis.yml seed —
 * persisted providers win, so user edits and deletions survive restarts.
 * Every mutation writes the list back to disk (fire-and-forget).
 */
export class ProviderStore {
  private readonly providers = new Map<string, ResolvedAigcProvider>()
  private readonly dataPath: string
  /** Serializes disk writes so rapid mutations can't interleave. */
  private persistChain: Promise<void> = Promise.resolve()

  constructor(seed: readonly AigcProvider[], dataPath: string = PROVIDERS_JSON) {
    this.dataPath = dataPath
    const seedBuiltin = new Map(seed.map(p => [p.id, p.builtin ?? false]))
    const persisted = loadPersistedSync(dataPath)
    const sources: readonly AigcProvider[] = persisted ?? seed
    for (const p of sources) {
      const resolved: ResolvedAigcProvider = {
        id: p.id,
        name: p.name ?? '',
        endpoint: p.endpoint ?? 'stub://aigc-backend',
        apiKey: p.apiKey ?? '',
        instructions: p.instructions ?? '',
        auth: {
          scheme: p.auth?.scheme ?? 'bearer',
          name: p.auth?.name ?? '',
        },
        // builtin is a seed-layer hint: restore it from the seed even when
        // the provider came from disk (a persisted file never marks builtin).
        builtin: seedBuiltin.get(p.id) ?? false,
        endpoints: p.endpoints ?? [],
        priority: p.priority ?? 100,
        costPerCall: p.costPerCall ?? 0,
        costPerKiloToken: p.costPerKiloToken ?? 0,
        costPerSecond: p.costPerSecond ?? 0,
        avgLatencyMs: p.avgLatencyMs ?? 0,
        qualityHint: p.qualityHint ?? 'balanced',
      }
      this.providers.set(resolved.id, resolved)
    }
  }

  /** Snapshot of all providers, in insertion order. */
  list(): readonly ResolvedAigcProvider[] {
    return [...this.providers.values()]
  }

  /** Look up one provider by id. */
  get(id: string): ResolvedAigcProvider | undefined {
    return this.providers.get(id)
  }

  /** The default provider (first in insertion order); undefined if empty. */
  defaultProvider(): ResolvedAigcProvider | undefined {
    return this.providers.values().next().value as ResolvedAigcProvider | undefined
  }

  /** Add a new provider. Returns failure for duplicate id or invalid shape. */
  add(provider: AigcProvider): ProviderMutationResult {
    const idError = validateProviderId(provider.id)
    if (idError !== undefined) return { ok: false, error: idError }
    if (this.providers.has(provider.id)) {
      return { ok: false, error: `provider id already exists: ${provider.id}` }
    }
    // RPC-added providers are never builtin: only the cordis.yml seed can mark
    // a provider as builtin. Strip any caller-supplied builtin=true.
    const stored: ResolvedAigcProvider = {
      id: provider.id,
      name: provider.name ?? '',
      endpoint: provider.endpoint ?? 'stub://aigc-backend',
      apiKey: provider.apiKey ?? '',
      instructions: provider.instructions ?? '',
      auth: {
        scheme: provider.auth?.scheme ?? 'bearer',
        name: provider.auth?.name ?? '',
      },
      builtin: false,
      endpoints: provider.endpoints ?? [],
      priority: provider.priority ?? 100,
      costPerCall: provider.costPerCall ?? 0,
      costPerKiloToken: provider.costPerKiloToken ?? 0,
      costPerSecond: provider.costPerSecond ?? 0,
      avgLatencyMs: provider.avgLatencyMs ?? 0,
      qualityHint: provider.qualityHint ?? 'balanced',
    }
    this.providers.set(stored.id, stored)
    this.persist()
    return { ok: true, providers: this.list() }
  }

  /** Update an existing provider. Returns failure if the id is unknown. */
  update(provider: AigcProvider): ProviderMutationResult {
    const idError = validateProviderId(provider.id)
    if (idError !== undefined) return { ok: false, error: idError }
    const existing = this.providers.get(provider.id)
    if (existing === undefined) {
      return { ok: false, error: `provider id not found: ${provider.id}` }
    }
    // The `builtin` flag is a presentation hint owned by the seed layer: an
    // update cannot flip it.
    const stored: ResolvedAigcProvider = {
      id: provider.id,
      name: provider.name ?? '',
      endpoint: provider.endpoint ?? 'stub://aigc-backend',
      apiKey: provider.apiKey ?? '',
      instructions: provider.instructions ?? '',
      auth: {
        scheme: provider.auth?.scheme ?? existing.auth.scheme,
        name: provider.auth?.name ?? existing.auth.name,
      },
      builtin: existing.builtin,
      endpoints: provider.endpoints ?? existing.endpoints,
      priority: provider.priority ?? existing.priority,
      costPerCall: provider.costPerCall ?? existing.costPerCall,
      costPerKiloToken: provider.costPerKiloToken ?? existing.costPerKiloToken,
      costPerSecond: provider.costPerSecond ?? existing.costPerSecond,
      avgLatencyMs: provider.avgLatencyMs ?? existing.avgLatencyMs,
      qualityHint: provider.qualityHint ?? existing.qualityHint,
    }
    this.providers.set(stored.id, stored)
    this.persist()
    return { ok: true, providers: this.list() }
  }

  /**
   * Replace a provider's usage instructions (called by the model's
   * aigc_provider_set_instructions tool after it probes the API).
   */
  setInstructions(id: string, instructions: string): ProviderMutationResult {
    const existing = this.providers.get(id)
    if (existing === undefined) {
      return { ok: false, error: `provider id not found: ${id}` }
    }
    const stored: ResolvedAigcProvider = { ...existing, instructions }
    this.providers.set(stored.id, stored)
    this.persist()
    return { ok: true, providers: this.list() }
  }

  /**
   * Replace a provider's structured endpoint catalog (called by the model's
   * aigc_provider_set_endpoints tool after probing the API). Also auto-
   * derives a short `instructions` string from the catalog so legacy agent
   * prompts that read `instructions` stay in sync (per doc 03 §3 +
   * doc 06 decision 6: coexist + auto-derive).
   */
  setEndpoints(id: string, endpoints: readonly EndpointSpec[]): ProviderMutationResult {
    const existing = this.providers.get(id)
    if (existing === undefined) {
      return { ok: false, error: `provider id not found: ${id}` }
    }
    const derived = deriveInstructionsFromEndpoints(endpoints)
    const instructions = derived !== '' ? derived : existing.instructions
    const stored: ResolvedAigcProvider = {
      ...existing,
      endpoints: [...endpoints],
      instructions,
    }
    this.providers.set(stored.id, stored)
    this.persist()
    return { ok: true, providers: this.list() }
  }

  /** Remove a provider. Returns failure for unknown id. */
  remove(id: string): ProviderMutationResult {
    if (!this.providers.delete(id)) {
      return { ok: false, error: `provider id not found: ${id}` }
    }
    this.persist()
    return { ok: true, providers: this.list() }
  }

  /**
   * Persist the current provider list to disk (fire-and-forget, serialized).
   * Only the user-editable fields are written; `builtin` is re-derived from
   * the seed on load. Failures are swallowed — the in-memory state stays
   * canonical. Each call snapshots the CURRENT list, so a burst of mutations
   * ends with the latest state on disk.
   */
  private persist(): void {
    const snapshot = [...this.providers.values()].map(({ builtin: _b, ...rest }) => rest)
    this.persistChain = this.persistChain
      .then(() => writeJsonAtomic(this.dataPath, snapshot))
      .catch(() => {})
  }
}

/** Read the persisted providers JSON; returns null when absent/unreadable. */
function loadPersistedSync(dataPath: string): readonly AigcProvider[] | null {
  try {
    const raw = readFileSync(dataPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const providers: AigcProvider[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      if (typeof rec.id !== 'string' || rec.id === '') continue
      providers.push({
        id: rec.id,
        name: typeof rec.name === 'string' ? rec.name : '',
        endpoint: typeof rec.endpoint === 'string' ? rec.endpoint : 'stub://aigc-backend',
        apiKey: typeof rec.apiKey === 'string' ? rec.apiKey : '',
        instructions: typeof rec.instructions === 'string' ? rec.instructions : '',
        ...(typeof rec.auth === 'object' && rec.auth !== null ? {
          auth: {
            scheme: (rec.auth as Record<string, unknown>).scheme === 'header' || (rec.auth as Record<string, unknown>).scheme === 'query'
              ? (rec.auth as Record<string, unknown>).scheme as 'header' | 'query'
              : 'bearer',
            name: typeof (rec.auth as Record<string, unknown>).name === 'string' ? (rec.auth as Record<string, unknown>).name as string : '',
          },
        } : {}),
        // Structured catalog fields (backward compat: missing → defaults).
        ...(Array.isArray(rec.endpoints) ? { endpoints: rec.endpoints as EndpointSpec[] } : {}),
        ...(typeof rec.priority === 'number' ? { priority: rec.priority } : {}),
        ...(typeof rec.costPerCall === 'number' ? { costPerCall: rec.costPerCall } : {}),
        ...(typeof rec.costPerKiloToken === 'number' ? { costPerKiloToken: rec.costPerKiloToken } : {}),
        ...(typeof rec.costPerSecond === 'number' ? { costPerSecond: rec.costPerSecond } : {}),
        ...(typeof rec.avgLatencyMs === 'number' ? { avgLatencyMs: rec.avgLatencyMs } : {}),
        ...(typeof rec.qualityHint === 'string' ? { qualityHint: rec.qualityHint as AigcProvider['qualityHint'] } : {}),
      })
    }
    return providers
  } catch {
    return null
  }
}
