/**
 * Pins the `plugins.row.config` key identity against the bundle's declared
 * names: the Plugins page matches the key by exact string
 * (`<package name>#<row id>`, row id passed through verbatim from the patch
 * insert line), and a mismatch fails silently — the row's configure entry
 * never appears (the dsh-interpreters incident).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ENTRY_ID, PACKAGE_NAME, ROW_CONFIG_KEY } from '../src/entry-identity.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** The row the bundle's patch inserts (`id` + `name` lines). */
function readPatchRow(): { id: string; name: string } {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const id = /^\s*- id: (.+)$/m.exec(patch)?.[1]
  const name = /^\s*name: '?(.+?)'?$/m.exec(patch)?.[1]
  if (id === undefined || name === undefined) throw new Error('cordis.patch.yml: no insert row id/name found')
  return { id, name }
}

describe('plugins.row.config key identity', () => {
  it('ENTRY_ID is the cordis.patch.yml insert row id, verbatim', () => {
    expect(ENTRY_ID).toBe(readPatchRow().id)
  })

  it('PACKAGE_NAME is the row module name and the package.json name', () => {
    const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(PACKAGE_NAME).toBe(name)
    expect(PACKAGE_NAME).toBe(readPatchRow().name)
  })

  it('ROW_CONFIG_KEY is <package name>#<row id>', () => {
    expect(ROW_CONFIG_KEY).toBe(`${PACKAGE_NAME}#${ENTRY_ID}`)
    expect(ROW_CONFIG_KEY).toBe('@huanlin/dsh-plugin-aigc-canvas#dsh-aigc-canvas')
  })
})
