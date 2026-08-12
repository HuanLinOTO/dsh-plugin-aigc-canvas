/**
 * Unit tests for the canvas registry: addPrompt / addMedia / wireEdges /
 * getElement / getElementByPath / snapshot / subscribe. Persistence is
 * exercised against a real tmp dir.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAigcCanvasService,
  canvasDirFor,
  canvasJsonPath,
  elementFilePath,
  extensionFor,
  mimeTypeFor,
  type AigcCanvasService,
} from '../src/canvas-registry.js'
import { AigcError } from '../src/wire.js'

describe('extensionFor / mimeTypeFor', () => {
  it('maps each kind to an extension', () => {
    expect(extensionFor('prompt')).toBe('txt')
    expect(extensionFor('image')).toBe('png')
    expect(extensionFor('video')).toBe('mp4')
    expect(extensionFor('audio')).toBe('mp3')
  })

  it('maps each kind to a MIME type', () => {
    expect(mimeTypeFor('prompt')).toBe('text/plain; charset=utf-8')
    expect(mimeTypeFor('image')).toBe('image/png')
    expect(mimeTypeFor('video')).toBe('video/mp4')
    expect(mimeTypeFor('audio')).toBe('audio/mpeg')
  })
})

describe('canvas path helpers', () => {
  it('canvasDirFor nests under cwd + .dsh-aigc-canvas + sessionId', () => {
    expect(canvasDirFor('/repo', 'sess-1')).toBe(join('/repo', '.dsh-aigc-canvas', 'sess-1'))
  })

  it('canvasJsonPath appends canvas.json', () => {
    expect(canvasJsonPath('/repo', 'sess-1')).toBe(join('/repo', '.dsh-aigc-canvas', 'sess-1', 'canvas.json'))
  })

  it('elementFilePath uses uuid + extension', () => {
    expect(elementFilePath('/repo', 's', 'abc', 'image')).toBe(join('/repo', '.dsh-aigc-canvas', 's', 'abc.png'))
    expect(elementFilePath('/repo', 's', 'abc', 'prompt')).toBe(join('/repo', '.dsh-aigc-canvas', 's', 'abc.txt'))
  })
})

describe('AigcCanvasService', () => {
  let cwd: string
  let service: AigcCanvasService

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-canvas-'))
    service = createAigcCanvasService(() => cwd)
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('addPrompt writes a .txt file and returns an element with filePath', async () => {
    const el = await service.addPrompt('s1', {
      title: 'a cat',
      promptText: 'a cat sitting on a chair',
      producedBy: 'aigc_text_to_image',
    }, cwd)
    expect(el.kind).toBe('prompt')
    expect(el.sessionId).toBe('s1')
    expect(el.promptText).toBe('a cat sitting on a chair')
    expect(el.filePath).toBe(join(cwd, '.dsh-aigc-canvas', 's1', `${el.uuid}.txt`))
    expect(el.uuid).toMatch(/^[0-9a-f-]+$/)
    // The .txt file should exist on disk with the prompt text.
    const onDisk = await readFile(el.filePath, 'utf8')
    expect(onDisk).toBe('a cat sitting on a chair')
  })

  it('addMedia writes the media file to disk and records its filePath', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const el = await service.addMedia('s1', {
      kind: 'image',
      title: 'an image',
      producedBy: 'aigc_text_to_image',
      mediaBytes: bytes,
    }, cwd)
    expect(el.kind).toBe('image')
    expect(el.mediaSize).toBe(bytes.byteLength)
    expect(el.filePath).toBe(join(cwd, '.dsh-aigc-canvas', 's1', `${el.uuid}.png`))
    const onDisk = await readFile(el.filePath)
    expect(onDisk.equals(bytes)).toBe(true)
  })

  it('wireEdges connects each input to the target (multi-to-one)', async () => {
    const prompt = await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    const ref1 = await service.addMedia('s1', { kind: 'image', title: 'r1', producedBy: 'tool', mediaBytes: Buffer.from([1]) }, cwd)
    const ref2 = await service.addMedia('s1', { kind: 'image', title: 'r2', producedBy: 'tool', mediaBytes: Buffer.from([2]) }, cwd)
    const out = await service.addMedia('s1', { kind: 'video', title: 'o', producedBy: 'tool', mediaBytes: Buffer.from([3]) }, cwd)
    await service.wireEdges('s1', [prompt.uuid, ref1.uuid, ref2.uuid], out.uuid)
    const snap = service.snapshot('s1')
    expect(snap.edges).toEqual([
      { source: prompt.uuid, target: out.uuid },
      { source: ref1.uuid, target: out.uuid },
      { source: ref2.uuid, target: out.uuid },
    ])
  })

  it('wireEdges skips duplicate edges (idempotent on retry)', async () => {
    const prompt = await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    const out = await service.addMedia('s1', { kind: 'image', title: 'o', producedBy: 'tool', mediaBytes: Buffer.from([1]) }, cwd)
    await service.wireEdges('s1', [prompt.uuid], out.uuid)
    await service.wireEdges('s1', [prompt.uuid], out.uuid)
    const snap = service.snapshot('s1')
    expect(snap.edges).toEqual([{ source: prompt.uuid, target: out.uuid }])
  })

  it('wireEdges throws when the target uuid does not exist', async () => {
    const prompt = await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    await expect(service.wireEdges('s1', [prompt.uuid], 'nonexistent-uuid')).rejects.toThrow(AigcError)
  })

  it('getElement throws AigcError when the uuid is not in the session', () => {
    expect(() => service.getElement('s1', 'nope')).toThrow(AigcError)
  })

  it('getElement returns the element when it exists', async () => {
    const el = await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    expect(service.getElement('s1', el.uuid).uuid).toBe(el.uuid)
  })

  it('getElementByPath resolves a filePath back to the element', async () => {
    const el = await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    const found = service.getElementByPath('s1', el.filePath)
    expect(found.uuid).toBe(el.uuid)
  })

  it('getElementByPath throws when the filePath is not on the canvas', async () => {
    await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    expect(() => service.getElementByPath('s1', '/nonexistent/path.png')).toThrow(AigcError)
  })

  it('snapshot is isolated per session', async () => {
    await service.addPrompt('s1', { title: 'p1', promptText: 'p1', producedBy: 'tool' }, cwd)
    await service.addPrompt('s2', { title: 'p2', promptText: 'p2', producedBy: 'tool' }, cwd)
    expect(service.snapshot('s1').elements).toHaveLength(1)
    expect(service.snapshot('s2').elements).toHaveLength(1)
    expect(service.snapshot('s1').elements[0]!.title).toBe('p1')
    expect(service.snapshot('s2').elements[0]!.title).toBe('p2')
  })

  it('addPrompt / addMedia default x and y to 0', async () => {
    const prompt = await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    const media = await service.addMedia('s1', { kind: 'image', title: 'm', producedBy: 'tool', mediaBytes: Buffer.from([1]) }, cwd)
    expect(prompt.x).toBe(0)
    expect(prompt.y).toBe(0)
    expect(media.x).toBe(0)
    expect(media.y).toBe(0)
  })

  it('addPrompt / addMedia honor explicit x and y', async () => {
    const el = await service.addMedia('s1', { kind: 'image', title: 'm', producedBy: 'tool', mediaBytes: Buffer.from([1]), x: 40, y: 90 }, cwd)
    expect(el.x).toBe(40)
    expect(el.y).toBe(90)
  })

  it('placeFile registers an existing file in the canvas dir at (x, y)', async () => {
    const dir = canvasDirFor(cwd, 's1')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'out.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const el = await service.placeFile('s1', {
      kind: 'image',
      filePath: file,
      title: 'placed',
      producedBy: 'aigc_canvas_place',
      x: 100,
      y: 200,
      promptText: 'the prompt',
      meta: { width: 512 },
    }, cwd)
    expect(el.kind).toBe('image')
    expect(el.x).toBe(100)
    expect(el.y).toBe(200)
    expect(el.promptText).toBe('the prompt')
    expect(el.meta).toEqual({ width: 512 })
    expect(el.filePath).toBe(file)
    expect(el.mediaSize).toBe(4)
    // The file is referenced in place — not copied.
    expect(el.filePath.endsWith('out.png')).toBe(true)
  })

  it('placeFile accepts relative paths inside the canvas dir', async () => {
    const dir = canvasDirFor(cwd, 's1')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'rel.png')
    await writeFile(file, Buffer.from([1]))
    const el = await service.placeFile('s1', { kind: 'image', filePath: '.dsh-aigc-canvas/s1/rel.png', title: 'r', producedBy: 't', x: 1, y: 2 }, cwd)
    expect(el.filePath).toBe(file)
  })

  it('placeFile rejects files outside the canvas dir', async () => {
    const outside = join(tmpdir(), 'outside.png')
    await writeFile(outside, Buffer.from([1]))
    try {
      await expect(service.placeFile('s1', { kind: 'image', filePath: outside, title: 'o', producedBy: 't', x: 0, y: 0 }, cwd)).rejects.toThrow(AigcError)
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('placeFile rejects missing files', async () => {
    await expect(service.placeFile('s1', { kind: 'image', filePath: join(cwd, '.dsh-aigc-canvas', 's1', 'nope.png'), title: 'n', producedBy: 't', x: 0, y: 0 }, cwd))
      .rejects.toThrow(AigcError)
  })

  it('placeFile enforces the media size limit', async () => {
    const limited = createAigcCanvasService(() => cwd, () => 10)
    const dir = canvasDirFor(cwd, 's1')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'big.png')
    await writeFile(file, Buffer.alloc(64))
    await expect(limited.placeFile('s1', { kind: 'image', filePath: file, title: 'b', producedBy: 't', x: 0, y: 0 }, cwd)).rejects.toThrow(AigcError)
  })

  it('updatePosition moves an element and persists the new position', async () => {
    const el = await service.addMedia('s1', { kind: 'image', title: 'm', producedBy: 'tool', mediaBytes: Buffer.from([1]), x: 5, y: 6 }, cwd)
    const moved = await service.updatePosition('s1', el.uuid, 300, -40)
    expect(moved.x).toBe(300)
    expect(moved.y).toBe(-40)
    expect(service.getElement('s1', el.uuid).x).toBe(300)
    const raw = await readFile(canvasJsonPath(cwd, 's1'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.elements[0].x).toBe(300)
    expect(parsed.elements[0].y).toBe(-40)
  })

  it('updatePosition throws for unknown uuids', async () => {
    await expect(service.updatePosition('s1', 'nope', 1, 2)).rejects.toThrow(AigcError)
  })

  it('updatePosition rejects non-finite coordinates', async () => {
    const el = await service.addMedia('s1', { kind: 'image', title: 'm', producedBy: 'tool', mediaBytes: Buffer.from([1]) }, cwd)
    await expect(service.updatePosition('s1', el.uuid, Number.NaN, 2)).rejects.toThrow(AigcError)
  })

  it('unlink removes one edge and is idempotent', async () => {
    const a = await service.addMedia('s1', { kind: 'image', title: 'a', producedBy: 'tool', mediaBytes: Buffer.from([1]) }, cwd)
    const b = await service.addMedia('s1', { kind: 'video', title: 'b', producedBy: 'tool', mediaBytes: Buffer.from([2]) }, cwd)
    await service.wireEdges('s1', [a.uuid], b.uuid)
    expect(service.snapshot('s1').edges).toHaveLength(1)
    await service.unlink('s1', a.uuid, b.uuid)
    expect(service.snapshot('s1').edges).toHaveLength(0)
    await service.unlink('s1', a.uuid, b.uuid)  // no-op
    expect(service.snapshot('s1').edges).toHaveLength(0)
  })

  it('deleteElement removes the element and its edges', async () => {
    const a = await service.addMedia('s1', { kind: 'image', title: 'a', producedBy: 'tool', mediaBytes: Buffer.from([1]) }, cwd)
    const b = await service.addMedia('s1', { kind: 'video', title: 'b', producedBy: 'tool', mediaBytes: Buffer.from([2]) }, cwd)
    const c = await service.addMedia('s1', { kind: 'image', title: 'c', producedBy: 'tool', mediaBytes: Buffer.from([3]) }, cwd)
    // a → b, b → c
    await service.wireEdges('s1', [a.uuid], b.uuid)
    await service.wireEdges('s1', [b.uuid], c.uuid)
    expect(service.snapshot('s1').elements).toHaveLength(3)
    expect(service.snapshot('s1').edges).toHaveLength(2)
    // Delete b: should remove b and both edges referencing it.
    await service.deleteElement('s1', b.uuid)
    const snap = service.snapshot('s1')
    expect(snap.elements).toHaveLength(2)
    expect(snap.elements.find(e => e.uuid === b.uuid)).toBeUndefined()
    expect(snap.edges).toHaveLength(0)
  })

  it('deleteElement throws for unknown uuids', async () => {
    await expect(service.deleteElement('s1', 'nope')).rejects.toThrow(AigcError)
  })

  it('hydrates legacy persisted data by normalizing missing x/y to 0', async () => {
    // Write a canvas.json without x/y (pre-free-canvas format).
    const dir = canvasDirFor(cwd, 's1')
    await mkdir(dir, { recursive: true })
    const legacyEl = { uuid: 'old-1', sessionId: 's1', kind: 'image', title: 'legacy', createdAt: 1, producedBy: 'old', filePath: join(dir, 'old-1.png') }
    await writeFile(canvasJsonPath(cwd, 's1'), JSON.stringify({ sessionId: 's1', elements: [legacyEl], edges: [] }))
    await writeFile(join(dir, 'old-1.png'), Buffer.from([1]))
    await service.ensureHydrated('s1')
    const el = service.getElement('s1', 'old-1')
    expect(el.x).toBe(0)
    expect(el.y).toBe(0)
  })

  it('persists state to canvas.json after every mutation', async () => {
    const el = await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    const path = canvasJsonPath(cwd, 's1')
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.sessionId).toBe('s1')
    expect(parsed.elements).toHaveLength(1)
    expect(parsed.elements[0].uuid).toBe(el.uuid)
    expect(parsed.elements[0].filePath).toBe(el.filePath)
  })

  it('subscribe fires on every mutation; subscribeSession only on its session', async () => {
    const allCalls: string[] = []
    const s1Calls: string[] = []
    const s2Calls: string[] = []
    const unsubAll = service.subscribe((sid) => allCalls.push(sid))
    const unsubS1 = service.subscribeSession('s1', (sid) => s1Calls.push(sid))
    const unsubS2 = service.subscribeSession('s2', (sid) => s2Calls.push(sid))
    await service.addPrompt('s1', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    await service.addPrompt('s2', { title: 'p', promptText: 'p', producedBy: 'tool' }, cwd)
    expect(allCalls).toEqual(['s1', 's2'])
    expect(s1Calls).toEqual(['s1'])
    expect(s2Calls).toEqual(['s2'])
    unsubAll()
    unsubS1()
    unsubS2()
    await service.addPrompt('s1', { title: 'p2', promptText: 'p2', producedBy: 'tool' }, cwd)
    expect(allCalls).toHaveLength(2)
  })
})
