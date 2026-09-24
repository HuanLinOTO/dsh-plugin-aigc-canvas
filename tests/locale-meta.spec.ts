/**
 * Plugins-page localized metadata guard (DSH 0.1.7-rc.1 locale meta contract).
 *
 * The Plugins page reads `locale/*.json` through the package exports map at
 * boot without running plugin code: `en.json` anchors the mechanism (without
 * it, localization is silently skipped), every sibling `.json` file must be
 * exported or the row shows a visible metadata error, and an empty or
 * whitespace `meta.title` / `meta.description` becomes a diagnostic. These
 * tests turn a broken locale file or a drifted exports/files entry into a
 * red test run instead of a silent page error.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const localeDir = join(root, 'locale')

/** Language id shape accepted for locale filenames (mirrors app-boot). */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

function readMeta(file: string): { title: unknown; description: unknown } {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const meta = (parsed as { meta?: unknown } | null | undefined)?.meta
  expect(
    meta !== null && typeof meta === 'object' && !Array.isArray(meta),
    `${file}: meta must be a non-array object`,
  ).toBe(true)
  const { title, description } = meta as Record<string, unknown>
  return { title, description }
}

describe('Plugins-page locale metadata', () => {
  it('locale/en.json exists (the anchor file)', () => {
    expect(readdirSync(localeDir).map(name => join('locale', name))).toContain(join('locale', 'en.json'))
  })

  it('every locale file is language-id-named JSON with non-empty meta.title and meta.description', () => {
    const files = readdirSync(localeDir).filter(name => name.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      expect(name.slice(0, -5), `${name}: filename must be a language id`).toMatch(LANGUAGE_ID)
      const meta = readMeta(join(localeDir, name))
      for (const [field, value] of Object.entries(meta)) {
        expect(typeof value, `${name}: meta.${field} must be a string`).toBe('string')
        expect(String(value).trim(), `${name}: meta.${field} must be non-empty`).not.toBe('')
      }
    }
  })

  it('package.json exports and files cover the whole locale directory', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      files: string[]
    }
    // A glob, not only en.json: an unexported zh.json surfaces as a metadata error.
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(pkg.files).toContain('locale/')
  })
})
