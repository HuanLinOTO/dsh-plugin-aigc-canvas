/**
 * Unit tests for the cross-session asset library (src/asset-library.ts).
 *
 * Each test points the library at a fresh temp dir (via setLibraryDir) so
 * the real ~/.dsh/aigc-canvas/library/ is never touched. The tests cover
 * the full CRUD lifecycle: init → promote → list → get → remove, plus
 * filtering and the atomic-write behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setLibraryDir,
  resetLibraryDir,
  initLibrary,
  promoteAsset,
  listAssets,
  getAsset,
  removeAsset,
  coerceAssetCategory,
  ASSET_CATEGORIES,
  type AssetCategory,
} from '../src/asset-library.js'
import { AigcError } from '../src/wire.js'

describe('asset-library', () => {
  let dir: string
  let srcDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aigc-lib-'))
    srcDir = await mkdtemp(join(tmpdir(), 'aigc-lib-src-'))
    setLibraryDir(dir)
  })

  afterEach(async () => {
    resetLibraryDir()
    await rm(dir, { recursive: true, force: true })
    await rm(srcDir, { recursive: true, force: true })
  })

  it('initLibrary creates images/ + prompts/ subdirs + an empty index.json', async () => {
    await initLibrary()
    const imagesInfo = await stat(join(dir, 'images')).catch(() => null)
    const promptsInfo = await stat(join(dir, 'prompts')).catch(() => null)
    const indexInfo = await stat(join(dir, 'index.json')).catch(() => null)
    expect(imagesInfo?.isDirectory()).toBe(true)
    expect(promptsInfo?.isDirectory()).toBe(true)
    expect(indexInfo?.isFile()).toBe(true)
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as { assets: unknown[] }
    expect(index.assets).toEqual([])
  })

  it('promoteAsset copies the source file into the library and records the asset', async () => {
    const src = join(srcDir, 'cat.png')
    await writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const asset = await promoteAsset({
      sourceFilePath: src,
      category: 'style-reference',
      title: 'cyberpunk cat',
      tags: ['cyberpunk', 'cat'],
      originalPrompt: 'a cat in cyberpunk style',
      sourceSessionId: 'sess-1',
      sourceElementPath: src,
    })
    expect(asset.id).toMatch(/^asset_/)
    expect(asset.type).toBe('image')
    expect(asset.title).toBe('cyberpunk cat')
    expect(asset.tags).toEqual(['cyberpunk', 'cat'])
    expect(asset.category).toBe('style-reference')
    expect(asset.originalPrompt).toBe('a cat in cyberpunk style')
    expect(asset.sourceSessionId).toBe('sess-1')
    expect(asset.filePath).toMatch(/^images\/asset_.*\.png$/)
    // The file was copied into the library.
    const copied = await readFile(join(dir, asset.filePath))
    expect(copied[0]).toBe(0x89)
    expect(copied[1]).toBe(0x50)
    // The index.json was updated.
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as { assets: Array<{ id: string }> }
    expect(index.assets).toHaveLength(1)
    expect(index.assets[0]!.id).toBe(asset.id)
  })

  it('listAssets returns all assets sorted by createdAt ascending', async () => {
    const src1 = join(srcDir, 'a.png')
    const src2 = join(srcDir, 'b.png')
    await writeFile(src1, Buffer.from([0x89, 0x50]))
    await writeFile(src2, Buffer.from([0x89, 0x50]))
    const a1 = await promoteAsset({ sourceFilePath: src1, category: 'style-reference', title: 'first' })
    // Small delay so createdAt differs.
    await new Promise(r => setTimeout(r, 5))
    const a2 = await promoteAsset({ sourceFilePath: src2, category: 'final-product', title: 'second' })
    const list = await listAssets()
    expect(list).toHaveLength(2)
    // Sorted ascending → first before second.
    expect(list[0]!.id).toBe(a1.id)
    expect(list[1]!.id).toBe(a2.id)
  })

  it('listAssets filters by category', async () => {
    const src1 = join(srcDir, 'a.png')
    const src2 = join(srcDir, 'b.png')
    await writeFile(src1, Buffer.from([0x89, 0x50]))
    await writeFile(src2, Buffer.from([0x89, 0x50]))
    await promoteAsset({ sourceFilePath: src1, category: 'style-reference', title: 'a' })
    await promoteAsset({ sourceFilePath: src2, category: 'final-product', title: 'b' })
    const list = await listAssets({ category: 'style-reference' })
    expect(list).toHaveLength(1)
    expect(list[0]!.category).toBe('style-reference')
  })

  it('listAssets filters by tags (AND-match)', async () => {
    const src1 = join(srcDir, 'a.png')
    const src2 = join(srcDir, 'b.png')
    const src3 = join(srcDir, 'c.png')
    await writeFile(src1, Buffer.from([0x89]))
    await writeFile(src2, Buffer.from([0x89]))
    await writeFile(src3, Buffer.from([0x89]))
    await promoteAsset({ sourceFilePath: src1, category: 'style-reference', title: 'a', tags: ['cyberpunk', 'cat'] })
    await promoteAsset({ sourceFilePath: src2, category: 'style-reference', title: 'b', tags: ['cyberpunk', 'dog'] })
    await promoteAsset({ sourceFilePath: src3, category: 'style-reference', title: 'c', tags: ['cat'] })
    const list = await listAssets({ tags: ['cyberpunk', 'cat'] })
    expect(list).toHaveLength(1)
    expect(list[0]!.title).toBe('a')
  })

  it('listAssets filters by search (case-insensitive over title + prompt + tags)', async () => {
    const src1 = join(srcDir, 'a.png')
    const src2 = join(srcDir, 'b.png')
    await writeFile(src1, Buffer.from([0x89]))
    await writeFile(src2, Buffer.from([0x89]))
    await promoteAsset({ sourceFilePath: src1, category: 'style-reference', title: 'Cyberpunk Cat', tags: ['neon'] })
    await promoteAsset({ sourceFilePath: src2, category: 'style-reference', title: 'plain', originalPrompt: 'a dog in CYBERPUNK city' })
    const list = await listAssets({ search: 'cyberpunk' })
    expect(list).toHaveLength(2)
  })

  it('listAssets filters by type', async () => {
    const imgSrc = join(srcDir, 'img.png')
    const txtSrc = join(srcDir, 'prompt.txt')
    await writeFile(imgSrc, Buffer.from([0x89]))
    await writeFile(txtSrc, 'a prompt')
    await promoteAsset({ sourceFilePath: imgSrc, category: 'style-reference', title: 'img' })
    await promoteAsset({ sourceFilePath: txtSrc, category: 'prompt-template', title: 'txt' })
    const images = await listAssets({ type: 'image' })
    const prompts = await listAssets({ type: 'prompt' })
    expect(images).toHaveLength(1)
    expect(images[0]!.title).toBe('img')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.title).toBe('txt')
    expect(prompts[0]!.filePath).toMatch(/^prompts\//)
  })

  it('getAsset returns the asset + absoluteFilePath', async () => {
    const src = join(srcDir, 'cat.png')
    await writeFile(src, Buffer.from([0x89, 0x50]))
    const promoted = await promoteAsset({ sourceFilePath: src, category: 'style-reference', title: 'cat' })
    const got = await getAsset(promoted.id)
    expect(got.id).toBe(promoted.id)
    expect(got.absoluteFilePath).toBe(join(dir, promoted.filePath))
    // The absolute path points at a real file.
    const info = await stat(got.absoluteFilePath)
    expect(info.isFile()).toBe(true)
  })

  it('getAsset throws AigcError not-found for an unknown id', async () => {
    await expect(getAsset('asset_nonexistent')).rejects.toThrow(AigcError)
    await expect(getAsset('asset_nonexistent')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('removeAsset deletes the file + index entry and returns true', async () => {
    const src = join(srcDir, 'cat.png')
    await writeFile(src, Buffer.from([0x89, 0x50]))
    const promoted = await promoteAsset({ sourceFilePath: src, category: 'style-reference', title: 'cat' })
    const absPath = join(dir, promoted.filePath)
    expect((await stat(absPath).catch(() => null))?.isFile()).toBe(true)
    const removed = await removeAsset(promoted.id)
    expect(removed).toBe(true)
    // File is gone.
    expect(await stat(absPath).catch(() => null)).toBeNull()
    // Index no longer lists it.
    const list = await listAssets()
    expect(list).toHaveLength(0)
  })

  it('removeAsset returns false for an unknown id (idempotent)', async () => {
    const removed = await removeAsset('asset_nonexistent')
    expect(removed).toBe(false)
  })

  it('promoteAsset throws AigcError when the source file does not exist', async () => {
    await expect(promoteAsset({
      sourceFilePath: join(srcDir, 'nope.png'),
      category: 'style-reference',
    })).rejects.toThrow(AigcError)
  })

  it('promoteAsset defaults the title to the source file basename (without ext)', async () => {
    const src = join(srcDir, 'my-cool-image.png')
    await writeFile(src, Buffer.from([0x89]))
    const asset = await promoteAsset({ sourceFilePath: src, category: 'style-reference' })
    expect(asset.title).toBe('my-cool-image')
  })

  it('coerceAssetCategory accepts all 5 categories', () => {
    for (const cat of ASSET_CATEGORIES) {
      expect(coerceAssetCategory(cat)).toBe(cat as AssetCategory)
    }
  })

  it('coerceAssetCategory throws AigcError for an invalid value', () => {
    expect(() => coerceAssetCategory('bogus')).toThrow(AigcError)
    expect(() => coerceAssetCategory(undefined)).toThrow(AigcError)
  })

  it('persists across "restarts" (a new initLibrary call reads the existing index)', async () => {
    const src = join(srcDir, 'cat.png')
    await writeFile(src, Buffer.from([0x89]))
    const promoted = await promoteAsset({ sourceFilePath: src, category: 'style-reference', title: 'cat' })
    // Simulate a restart: re-init the library (same dir) and list.
    await initLibrary()
    const list = await listAssets()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(promoted.id)
  })
})
