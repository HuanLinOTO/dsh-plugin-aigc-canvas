/**
 * Unit tests for the settings bridge (installAigcSettings) and the one-time
 * legacy providers.json import.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  importLegacyProviders,
  installAigcSettings,
  SETTINGS_NAMESPACE,
  type AigcSettingsBridge,
} from '../src/settings.js'
import type { AigcEntryConfig, AigcProvider } from '../src/config.js'
import type { AigcSettingsForms, Context } from '../src/context-types.js'

/** Recording fake of the settings service face. */
function fakeSettings(): AigcSettingsForms & {
  updates: Array<{ ns: string; patch: object }>
  configured: Array<{ auto?: boolean }>
  failNext: boolean
} {
  return {
    updates: [],
    configured: [],
    failNext: false,
    configure(presentation) {
      this.configured.push(presentation)
      return () => {}
    },
    update(ns, patch) {
      if (this.failNext) return Promise.reject(new Error('write refused'))
      this.updates.push({ ns, patch })
      return Promise.resolve()
    },
  }
}

/** Minimal ctx/sctx pair driving installAigcSettings synchronously. */
function harness(entry: { providers?: { get(): unknown } }, legacyPath: string): {
  bridge: AigcSettingsBridge
  settings: ReturnType<typeof fakeSettings>
  ready: boolean
} {
  const settings = fakeSettings()
  let ready = false
  const ctx = {
    fiber: { uid: 1 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    inject: (_deps: readonly string[], callback: (ctx: Context) => void): void => {
      const sctx = {
        settings,
        effect: (fn: () => () => void): void => { fn() },
      }
      callback(sctx as unknown as Context)
    },
  }
  // The fake volatile reference returns arbitrary values on purpose (the
  // bridge must read it defensively), so the entry is cast to its face type.
  const bridge = installAigcSettings(ctx as unknown as Context, entry as AigcEntryConfig, {
    legacyPath,
    onReady: () => { ready = true },
  })
  return { bridge, settings, ready }
}

describe('installAigcSettings', () => {
  const legacyPath = join(tmpdir(), 'dsh-aigc-settings-spec-absent.json')

  it('declares the own-page policy (auto: false) against the plugin fiber', () => {
    const { settings } = harness({}, legacyPath)
    expect(settings.configured).toEqual([{ auto: false }])
  })

  it('source() reads the live volatile reference on every call', () => {
    let value: unknown = [{ id: 'a', name: 'A' }]
    const { bridge } = harness({ providers: { get: () => value } }, legacyPath)
    expect(bridge.source()).toEqual([{ id: 'a', name: 'A' }])
    // A committed settings edit updates the reference in place.
    value = [{ id: 'b', name: 'B' }]
    expect(bridge.source()).toEqual([{ id: 'b', name: 'B' }])
  })

  it('source() returns [] for a non-array reference', () => {
    const { bridge } = harness({ providers: { get: () => undefined } }, legacyPath)
    expect(bridge.source()).toEqual([])
  })

  it('persist() commits through settings.update under the entry namespace', async () => {
    const { bridge, settings } = harness({}, legacyPath)
    const providers: readonly AigcProvider[] = [{ id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '' }]
    await bridge.persist(providers)
    expect(settings.updates).toEqual([{ ns: SETTINGS_NAMESPACE, patch: { providers } }])
    expect(bridge.writable).toBe(true)
  })

  it('exposes writable=false and a no-op persist before the settings provider mounts', async () => {
    const ctx = {
      fiber: { uid: 1 },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      inject: (_deps: readonly string[], _cb: (ctx: Context) => void): void => {
        // Never mounts the settings service (headless assembly).
      },
    }
    const bridge = installAigcSettings(ctx as unknown as Context, undefined)
    expect(bridge.writable).toBe(false)
    expect(bridge.source()).toEqual([])
    await bridge.persist([{ id: 'x', name: '' }]) // no-op, does not throw
  })

  it('invokes onReady once the settings provider mounts', () => {
    const { ready } = harness({}, legacyPath)
    expect(ready).toBe(true)
  })
})

describe('importLegacyProviders', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-aigc-legacy-'))
    path = join(dir, 'providers.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('imports a legacy file once: update + rename to .imported', async () => {
    await writeFile(path, JSON.stringify([
      { id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: 'docs' },
      { id: 'volcano', name: 'Volcano', endpoint: 'https://example.com', apiKey: 'sk-x', instructions: '', auth: { scheme: 'header', name: 'x-api-key' } },
    ]), 'utf8')
    const settings = fakeSettings()
    const logs: string[] = []
    await importLegacyProviders(path, settings, { info: (m: string) => logs.push(String(m)), warn: () => {}, error: () => {} })

    expect(settings.updates).toHaveLength(1)
    const patch = settings.updates[0]!.patch as { providers: AigcProvider[] }
    expect(patch.providers.map(p => p.id)).toEqual(['stub', 'volcano'])
    expect(patch.providers[1]!.auth).toEqual({ scheme: 'header', name: 'x-api-key' })
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.imported`)).toBe(true)
    // A second run is a no-op (the file is gone).
    await importLegacyProviders(path, settings, { info: () => {}, warn: () => {}, error: () => {} })
    expect(settings.updates).toHaveLength(1)
  })

  it('skips malformed items and non-object bodies', async () => {
    await writeFile(path, JSON.stringify([
      { id: 'ok', name: 'OK' },
      { name: 'no id' },
      'garbage',
    ]), 'utf8')
    const settings = fakeSettings()
    await importLegacyProviders(path, settings, { info: () => {}, warn: () => {}, error: () => {} })
    const patch = settings.updates[0]!.patch as { providers: AigcProvider[] }
    expect(patch.providers.map(p => p.id)).toEqual(['ok'])
  })

  it('renames a non-array file without updating', async () => {
    await writeFile(path, '{"not":"an array"}', 'utf8')
    const settings = fakeSettings()
    await importLegacyProviders(path, settings, { info: () => {}, warn: () => {}, error: () => {} })
    expect(settings.updates).toHaveLength(0)
    expect(existsSync(`${path}.imported`)).toBe(true)
  })

  it('logs a warning instead of throwing when the update fails', async () => {
    await writeFile(path, JSON.stringify([{ id: 'ok', name: 'OK' }]), 'utf8')
    const settings = fakeSettings()
    settings.failNext = true
    const warnings: unknown[] = []
    await importLegacyProviders(path, settings, { info: () => {}, warn: (...args: unknown[]) => warnings.push(args), error: () => {} })
    expect(warnings).toHaveLength(1)
  })
})
