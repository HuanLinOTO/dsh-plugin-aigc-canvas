/**
 * Unit tests for the ProviderStore: seed construction, headless (in-memory)
 * CRUD, read-through persistence, builtin handling, and validation.
 */
import { describe, expect, it } from 'vitest'
import { ProviderStore, type ProviderPersistence } from '../src/provider-store.js'
import type { AigcProvider, ResolvedAigcProvider } from '../src/config.js'

const SEED: readonly ResolvedAigcProvider[] = [
  { id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: 'seed-instructions', auth: { scheme: 'bearer', name: '' }, builtin: true },
  { id: 'volcano', name: 'Volcano', endpoint: 'https://example.com', apiKey: 'sk-seed', instructions: '', auth: { scheme: 'bearer', name: '' }, builtin: true },
]

describe('ProviderStore (headless, no persistence)', () => {
  it('starts from the seed', () => {
    const store = new ProviderStore(SEED)
    expect(store.list().map(p => p.id)).toEqual(['stub', 'volcano'])
    expect(store.get('stub')!.builtin).toBe(true)
    expect(store.get('stub')!.instructions).toBe('seed-instructions')
    expect(store.defaultProvider()!.id).toBe('stub')
  })

  it('mutates the in-memory list and keeps it across calls', async () => {
    const store = new ProviderStore(SEED)
    const added = await store.add({ id: 'minimax', name: 'MiniMax', endpoint: 'https://minimax.example', apiKey: 'sk-minimax', instructions: '' })
    expect(added.ok).toBe(true)
    expect(store.list().map(p => p.id)).toEqual(['stub', 'volcano', 'minimax'])
    // User-added providers are never builtin.
    expect(store.get('minimax')!.builtin).toBe(false)

    const updated = await store.update({ id: 'volcano', name: 'Volcano Renamed', apiKey: 'sk-new', instructions: 'docs' })
    expect(updated.ok).toBe(true)
    expect(store.get('volcano')!.name).toBe('Volcano Renamed')
    // An update cannot flip the builtin flag.
    expect(store.get('volcano')!.builtin).toBe(true)

    const removed = await store.remove('volcano')
    expect(removed.ok).toBe(true)
    expect(store.list().map(p => p.id)).toEqual(['stub', 'minimax'])
  })

  it('rejects duplicate ids, invalid ids, and unknown ids', async () => {
    const store = new ProviderStore(SEED)
    expect((await store.add({ id: 'stub' })).ok).toBe(false)
    expect((await store.add({ id: 'Bad_Id' })).ok).toBe(false)
    expect((await store.update({ id: 'ghost', name: '' })).ok).toBe(false)
    expect((await store.remove('ghost')).ok).toBe(false)
    expect((await store.setInstructions('ghost', 'x')).ok).toBe(false)
  })

  it('setInstructions keeps the rest of the provider intact', async () => {
    const store = new ProviderStore(SEED)
    const result = await store.setInstructions('stub', 'updated-stub-docs')
    expect(result.ok).toBe(true)
    expect(store.get('stub')!.instructions).toBe('updated-stub-docs')
    expect(store.get('stub')!.builtin).toBe(true)
  })
})

/** In-memory persistence face: `committed` reads/writes the value source() serves. */
interface FakePersistence extends ProviderPersistence {
  committed: readonly AigcProvider[]
  failNext(): void
}

/** Build an in-memory persistence face over a mutable committed list. */
function fakePersistence(initial: readonly AigcProvider[]): FakePersistence {
  let committed = [...initial]
  let failures = 0
  return {
    get committed() { return committed },
    set committed(list) { committed = [...list] },
    failNext() { failures += 1 },
    source: () => [...committed],
    persist: async (providers) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('settings write refused')
      }
      committed = [...providers]
    },
  }
}

describe('ProviderStore (read-through persistence)', () => {
  it('mutations commit through the persistence face', async () => {
    const face = fakePersistence(SEED)
    const store = new ProviderStore(SEED)
    store.attachPersistence(face)

    const added = await store.add({ id: 'minimax', name: 'MiniMax', endpoint: 'https://minimax.example', apiKey: 'sk-minimax', instructions: '' })
    expect(added.ok).toBe(true)
    expect(added.providers!.map(p => p.id)).toEqual(['stub', 'volcano', 'minimax'])
    expect(face.committed.map(p => p.id)).toEqual(['stub', 'volcano', 'minimax'])
    expect(store.get('minimax')!.apiKey).toBe('sk-minimax')
  })

  it('external edits of the committed list are visible immediately (read-through)', async () => {
    const face = fakePersistence(SEED)
    const store = new ProviderStore(SEED)
    store.attachPersistence(face)

    // Another writer (the settings page / model tool) commits a new list.
    face.committed = [
      { id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: 'externally-updated', auth: { scheme: 'bearer', name: '' }, builtin: true },
    ]
    expect(store.list().map(p => p.id)).toEqual(['stub'])
    expect(store.get('stub')!.instructions).toBe('externally-updated')
    expect(store.defaultProvider()!.id).toBe('stub')
  })

  it('a refused persistence write reports failure and leaves the committed state untouched', async () => {
    const face = fakePersistence(SEED)
    const store = new ProviderStore(SEED)
    store.attachPersistence(face)

    face.failNext()
    const result = await store.add({ id: 'minimax', name: 'MiniMax' })
    expect(result.ok).toBe(false)
    expect(face.committed.map(p => p.id)).toEqual(['stub', 'volcano'])
    expect(store.list().map(p => p.id)).toEqual(['stub', 'volcano'])
  })

  it('resolves defaults and deduplicates hand-edited committed lists', async () => {
    const face = fakePersistence([
      { id: 'raw', name: 'Raw' },
      { id: 'raw', name: 'Duplicate' },
      { id: 'bad', name: 'Skipped', endpoint: '' },
    ] as unknown as readonly AigcProvider[])
    const store = new ProviderStore(SEED)
    store.attachPersistence(face)

    const list = store.list()
    expect(list.map(p => p.id)).toEqual(['raw', 'bad'])
    // Defaults filled; duplicates keep the first occurrence.
    expect(list[0]!.endpoint).toBe('stub://aigc-backend')
    expect(list[0]!.auth).toEqual({ scheme: 'bearer', name: '' })
    expect(list[0]!.name).toBe('Raw')
  })

  it('update keeps existing auth members the edit omits', async () => {
    const face = fakePersistence([
      { id: 'volcano', name: 'Volcano', endpoint: 'https://example.com', apiKey: 'sk', instructions: '', auth: { scheme: 'header', name: 'x-api-key' }, builtin: true },
    ])
    const store = new ProviderStore(SEED)
    store.attachPersistence(face)

    const result = await store.update({ id: 'volcano', name: 'Renamed', endpoint: 'https://example.com', apiKey: 'sk', instructions: '' })
    expect(result.ok).toBe(true)
    expect(store.get('volcano')!.auth).toEqual({ scheme: 'header', name: 'x-api-key' })
    expect(store.get('volcano')!.name).toBe('Renamed')
  })
})
