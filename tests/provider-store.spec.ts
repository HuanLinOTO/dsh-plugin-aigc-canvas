/**
 * Unit tests for the ProviderStore disk persistence: seed merge, CRUD
 * write-through, and builtin restoration across instances.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderStore } from '../src/provider-store.js'
import type { AigcProvider } from '../src/config.js'

const SEED: readonly AigcProvider[] = [
  { id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: 'seed-instructions', builtin: true },
  { id: 'volcano', name: 'Volcano', endpoint: 'https://example.com', apiKey: 'sk-seed', instructions: '', builtin: true },
]

describe('ProviderStore persistence', () => {
  let dir: string
  let dataPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-aigc-store-'))
    dataPath = join(dir, 'providers.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('starts from the seed when no persisted file exists', () => {
    const store = new ProviderStore(SEED, dataPath)
    expect(store.list().map(p => p.id)).toEqual(['stub', 'volcano'])
    expect(store.get('stub')!.builtin).toBe(true)
    expect(store.get('stub')!.instructions).toBe('seed-instructions')
  })

  it('persists mutations to disk and restores them in a new instance', async () => {
    const store = new ProviderStore(SEED, dataPath)
    const added = store.add({
      id: 'minimax', name: 'MiniMax', endpoint: 'https://minimax.example', apiKey: 'sk-minimax', instructions: '',
    })
    expect(added.ok).toBe(true)
    store.update({ id: 'volcano', name: 'Volcano Renamed', endpoint: 'https://example.com', apiKey: 'sk-new', instructions: 'docs' })
    store.setInstructions('stub', 'updated-stub-docs')
    // Wait for the fire-and-forget write to land.
    await new Promise(resolve => setTimeout(resolve, 50))

    const disk = JSON.parse(await readFile(dataPath, 'utf8')) as Array<Record<string, unknown>>
    expect(disk.map(p => p.id)).toEqual(['stub', 'volcano', 'minimax'])
    expect(disk.find(p => p.id === 'stub')!.instructions).toBe('updated-stub-docs')
    expect(disk.find(p => p.id === 'volcano')!.name).toBe('Volcano Renamed')
    // builtin is never written to disk.
    expect(disk.find(p => p.id === 'stub')!.builtin).toBeUndefined()

    // New instance (simulating a restart) restores the mutated state.
    const restarted = new ProviderStore(SEED, dataPath)
    expect(restarted.list().map(p => p.id)).toEqual(['stub', 'volcano', 'minimax'])
    expect(restarted.get('stub')!.instructions).toBe('updated-stub-docs')
    expect(restarted.get('volcano')!.name).toBe('Volcano Renamed')
    // builtin flag is restored from the seed.
    expect(restarted.get('stub')!.builtin).toBe(true)
    expect(restarted.get('minimax')!.builtin).toBe(false)
  })

  it('a deletion survives a restart (persisted state wins over seed)', async () => {
    const store = new ProviderStore(SEED, dataPath)
    store.remove('volcano')
    await new Promise(resolve => setTimeout(resolve, 50))

    const restarted = new ProviderStore(SEED, dataPath)
    expect(restarted.list().map(p => p.id)).toEqual(['stub'])
  })
})
