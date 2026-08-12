/**
 * Unit tests for the seven model-facing tools:
 * aigc_get_provider_info / aigc_http_request / aigc_provider_set_instructions /
 * aigc_canvas_place / aigc_canvas_link / aigc_canvas_unlink / aigc_canvas_list_elements.
 *
 * The stub provider endpoint produces synthetic media (no network). Real
 * endpoints are exercised against a mocked global fetch so the auth
 * attachment and response handling can be asserted deterministically.
 *
 * Tools are invoked directly (bypassing the host tool registry) so the
 * tests assert on the canonical return value — which uses `filePath`
 * as the element identifier (not uuid).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, stat, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAigcCanvasService, canvasDirFor, type AigcCanvasService } from '../src/canvas-registry.js'
import { registerTools, elementProjection, edgeProjection, titleOf, type ProviderInfo } from '../src/tools.js'
import { AigcError } from '../src/wire.js'
import type { ResolvedAigcProvider } from '../src/config.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

function execFor(sessionId: string): ToolRunContext {
  const ac = new AbortController()
  return {
    signal: ac.signal,
    callId: 'test-call',
    name: 'test',
    arguments: {},
    agent: { id: 'agent-1', session: { id: sessionId, header: {} } },
  } as ToolRunContext
}

interface MockTools {
  tools: { register(tool: unknown): () => void }
  registered: Map<string, { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> | unknown }>
}

function mockCtx(): MockTools {
  const registered = new Map<string, { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> | unknown }>()
  return {
    tools: {
      register(tool: unknown) {
        const t = tool as { name: string; execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> | unknown }
        registered.set(t.name, t)
        return () => { registered.delete(t.name) }
      },
    },
    registered,
  }
}

const STUB_PROVIDER: ResolvedAigcProvider = {
  id: 'stub', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '',
  auth: { scheme: 'bearer', name: '' }, builtin: true,
}

const REAL_PROVIDER: ResolvedAigcProvider = {
  id: 'real', name: 'Real API', endpoint: 'https://example.com', apiKey: 'sk-test', instructions: 'docs...',
  auth: { scheme: 'bearer', name: '' }, builtin: false,
}

function providerInfoList(providers: readonly ResolvedAigcProvider[]): readonly ProviderInfo[] {
  return providers.map((p, i) => ({
    id: p.id,
    name: p.name,
    endpoint: p.endpoint,
    instructions: p.instructions,
    isStub: p.endpoint === '' || p.endpoint === 'stub://aigc-backend',
    isDefault: i === 0,
  }))
}

/** A mutable instruction map backing the aigc_provider_set_instructions callback. */
function makeInstructionStore(providers: readonly ResolvedAigcProvider[]): {
  map: Map<string, string>
  set: (id: string, instructions: string) => { ok: boolean; error?: string }
} {
  const map = new Map<string, string>()
  for (const p of providers) map.set(p.id, p.instructions)
  return {
    map,
    set: (id, instructions) => {
      if (!map.has(id)) return { ok: false, error: `provider id not found: ${id}` }
      map.set(id, instructions)
      return { ok: true }
    },
  }
}

function registerAll(
  ctx: MockTools,
  providers: readonly ResolvedAigcProvider[],
  canvas: AigcCanvasService,
  cwd: string,
): { dispose: () => void; instructionStore: ReturnType<typeof makeInstructionStore> } {
  // Mutable provider list mirroring the host ProviderStore: set_instructions
  // writes through, and getProvider / listProviders read live values.
  const mutable = providers.map(p => ({ ...p }))
  const instructionStore = makeInstructionStore(mutable)
  const byId = new Map(mutable.map(p => [p.id, p]))
  const dispose = registerTools(
    ctx as unknown as Parameters<typeof registerTools>[0],
    (providerId?: string) => {
      if (providerId === undefined || providerId === '') return mutable[0]!
      const p = byId.get(providerId)
      if (p === undefined) {
        throw new AigcError('bad-request', `unknown provider_id "${providerId}"; call aigc_get_provider_info to list available providers`)
      }
      return p
    },
    (id, instructions) => {
      const result = instructionStore.set(id, instructions)
      if (result.ok) {
        const p = byId.get(id)
        if (p !== undefined) p.instructions = instructions
      }
      return result
    },
    () => providerInfoList(mutable),
    canvas,
    () => cwd,
    () => 5_000,
    () => 100 * 1024 * 1024,
  )
  return { dispose, instructionStore }
}

describe('titleOf', () => {
  it('returns the first line when shorter than 80 chars', () => {
    expect(titleOf('a short prompt')).toBe('a short prompt')
  })
  it('truncates long single-line prompts with an ellipsis', () => {
    expect(titleOf('a'.repeat(120))).toHaveLength(80)
    expect(titleOf('a'.repeat(120)).endsWith('…')).toBe(true)
  })
  it('uses only the first line for multi-line prompts', () => {
    expect(titleOf('line one\nline two')).toBe('line one')
  })
})

describe('elementProjection / edgeProjection', () => {
  it('elementProjection exposes filePath + position (not uuid) as the primary identifier', () => {
    const el = {
      uuid: 'u', sessionId: 's', kind: 'image' as const, title: 't', x: 10, y: 20, createdAt: 1, producedBy: 'tool',
      filePath: '/path/to/file.png', mediaSize: 10, meta: { width: 100 },
    }
    const p = elementProjection(el)
    expect(p.filePath).toBe('/path/to/file.png')
    expect(p.x).toBe(10)
    expect(p.y).toBe(20)
    expect(p).not.toHaveProperty('uuid')
    expect(p).not.toHaveProperty('sessionId')
  })

  it('edgeProjection resolves uuids to filePaths', () => {
    const lookup = (uuid: string) => uuid === 'a' ? { filePath: '/path/a.png' } as never : { filePath: '/path/b.mp4' } as never
    expect(edgeProjection({ source: 'a', target: 'b' }, lookup)).toEqual({
      source: '/path/a.png', target: '/path/b.mp4',
    })
  })
})

describe('registerTools (stub provider)', () => {
  let cwd: string
  let canvas: AigcCanvasService
  let ctx: MockTools
  let dispose: () => void

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-tools-'))
    canvas = createAigcCanvasService(() => cwd)
    ctx = mockCtx()
    dispose = registerAll(ctx, [STUB_PROVIDER], canvas, cwd).dispose
  })

  afterEach(async () => {
    dispose()
    await rm(cwd, { recursive: true, force: true })
  })

  it('registers exactly eight tools', () => {
    expect(Array.from(ctx.registered.keys()).sort()).toEqual([
      'aigc_canvas_link',
      'aigc_canvas_list_elements',
      'aigc_canvas_place',
      'aigc_canvas_unlink',
      'aigc_get_provider_info',
      'aigc_http_request',
      'aigc_media_edit',
      'aigc_provider_set_instructions',
    ])
  })

  it('aigc_get_provider_info returns the provider list', async () => {
    const tool = ctx.registered.get('aigc_get_provider_info')!
    const result = await tool.execute({}, execFor('s1')) as {
      providers: Array<{ id: string; name: string; endpoint: string; instructions: string; isStub: boolean; isDefault: boolean }>
    }
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0]!.id).toBe('stub')
    expect(result.providers[0]!.isStub).toBe(true)
    expect(result.providers[0]!.endpoint).toBe('stub://aigc-backend')
    expect(result.providers[0]!.isDefault).toBe(true)
  })

  it('aigc_http_request saves a synthetic image for a stub POST and returns a filePath', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      provider_id: 'stub',
      method: 'POST',
      path: '/v1/images/generations',
      json_body: { prompt: 'a cat' },
    }, execFor('s1')) as {
      ok: boolean; kind: string; content_type: string; file_path: string; file_size: number
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('image')
    expect(result.content_type).toBe('image/png')
    expect(result.file_path).toContain('.dsh-aigc-canvas')
    expect(result.file_path).toMatch(/\.png$/)
    const info = await stat(result.file_path)
    expect(info.size).toBe(result.file_size)
  })

  it('aigc_http_request defaults to POST when a body is provided (no method)', async () => {
    // Regression: when method is omitted but a body/json_body is present,
    // the request must default to POST — not GET. Otherwise the stub
    // returns the GET hint JSON instead of synthetic media, and real
    // providers reject GET-with-body.
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      provider_id: 'stub',
      path: '/v1/images/generations',
      json_body: { prompt: 'a cat' },
    }, execFor('s1')) as {
      ok: boolean; kind: string; file_path: string
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('image')
    expect(result.file_path).toMatch(/\.png$/)
  })

  it('aigc_http_request infers video for stub paths mentioning video', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"p"}' }, execFor('s1')) as {
      ok: boolean; kind: string; file_path: string
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('video')
    expect(result.file_path).toMatch(/\.mp4$/)
  })

  it('aigc_http_request returns video even when body contains an "image" field (regression)', async () => {
    // This was the original bug: a video-generation request whose body
    // includes an "image" field (img2video) was misclassified as image
    // because the old stubKindOf mixed path+body for keyword matching.
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      method: 'POST',
      path: '/v1/videos/generations',
      json_body: { image: 'D:\\test\\input.png', prompt: 'dancing girl', size: '1024x1024' },
    }, execFor('s1')) as {
      ok: boolean; kind: string; file_path: string; content_type: string
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('video')
    expect(result.content_type).toBe('video/mp4')
    expect(result.file_path).toMatch(/\.mp4$/)
  })

  it('aigc_http_request stub returns audio for t2music and tts paths', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    for (const path of ['/v1/t2music', '/v1/tts', '/v1/speech', '/v1/audio/synthesis']) {
      const result = await tool.execute({ method: 'POST', path, body: '{"prompt":"p"}' }, execFor('s1')) as {
        ok: boolean; kind: string; content_type: string; file_path: string
      }
      expect(result.ok).toBe(true)
      expect(result.kind).toBe('audio')
      expect(result.content_type).toBe('audio/mpeg')
      expect(result.file_path).toMatch(/\.mp3$/)
    }
  })

  it('aigc_http_request stub returns video for t2v / fl2v / ref2v paths', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    for (const path of ['/v1/t2v', '/v1/fl2v', '/v1/ref2v', '/v1/img2video']) {
      const result = await tool.execute({ method: 'POST', path, body: '{"prompt":"p"}' }, execFor('s1')) as {
        ok: boolean; kind: string; file_path: string
      }
      expect(result.ok).toBe(true)
      expect(result.kind).toBe('video')
      expect(result.file_path).toMatch(/\.mp4$/)
    }
  })

  it('aigc_http_request stub returns image for t2i and ref2i paths', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    for (const path of ['/v1/t2i', '/v1/ref2i', '/v1/img2img']) {
      const result = await tool.execute({ method: 'POST', path, body: '{"prompt":"p"}' }, execFor('s1')) as {
        ok: boolean; kind: string; file_path: string
      }
      expect(result.ok).toBe(true)
      expect(result.kind).toBe('image')
      expect(result.file_path).toMatch(/\.png$/)
    }
  })

  it('aigc_http_request stub auto-extracts b64_json from OpenAI image response', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      provider_id: 'stub',
      method: 'POST',
      path: '/v1/images/generations',
      json_body: { prompt: 'a cat', size: '1024x1024' },
    }, execFor('s1')) as {
      ok: boolean; kind: string; content_type: string; file_path: string; file_size: number
    }
    expect(result.ok).toBe(true)
    // The stub returns JSON {data:[{b64_json}]}, but the tool auto-extracts
    // the base64 payload to a .png file — so the model gets a file_path.
    expect(result.kind).toBe('image')
    expect(result.content_type).toBe('image/png')
    expect(result.file_path).toMatch(/\.png$/)
    const info = await stat(result.file_path)
    expect(info.size).toBe(result.file_size)
    // The saved file should be a real PNG (magic bytes).
    const buf = await readFile(result.file_path)
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50)
    expect(buf[2]).toBe(0x4e)
    expect(buf[3]).toBe(0x47)
  })

  it('aigc_http_request stub returns inline JSON for /v1/audio/transcriptions', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      method: 'POST',
      path: '/v1/audio/transcriptions',
      body: '{"file":"fake.mp3"}',
    }, execFor('s1')) as {
      ok: boolean; kind: string; text: string
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('json')
    const parsed = JSON.parse(result.text) as { text: string }
    expect(parsed.text).toContain('stub transcription')
  })

  it('aigc_http_request stub returns inline JSON for /v1/chat/completions', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      method: 'POST',
      path: '/v1/chat/completions',
      json_body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] },
    }, execFor('s1')) as {
      ok: boolean; kind: string; text: string
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('json')
    const parsed = JSON.parse(result.text) as { choices: Array<{ message: { content: string } }> }
    expect(parsed.choices).toHaveLength(1)
    expect(parsed.choices[0]!.message.content).toContain('hello')
  })

  it('aigc_http_request stub returns audio binary for /v1/audio/speech', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      method: 'POST',
      path: '/v1/audio/speech',
      json_body: { model: 'tts-1', input: 'hello', voice: 'alloy' },
    }, execFor('s1')) as {
      ok: boolean; kind: string; content_type: string; file_path: string
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('audio')
    expect(result.content_type).toBe('audio/mpeg')
    expect(result.file_path).toMatch(/\.mp3$/)
  })

  it('aigc_http_request returns inline JSON for a stub GET', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({ method: 'GET', path: '/v1/models' }, execFor('s1')) as {
      ok: boolean; kind: string; text: string
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('json')
    expect(result.text).toContain('"stub": true')
  })

  it('aigc_http_request rejects absolute URL paths in stub mode', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    await expect(tool.execute({ path: 'https://evil.example.com/steal', method: 'GET' }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_http_request rejects passing both body and json_body', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    await expect(tool.execute({ path: '/x', body: 'a', json_body: { a: 1 } }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_provider_set_instructions stores instructions and exposes them via aigc_get_provider_info', async () => {
    const setTool = ctx.registered.get('aigc_provider_set_instructions')!
    const setResult = await setTool.execute({
      provider_id: 'stub',
      instructions: 'POST /v1/images/generations with { prompt, size }; returns image/png bytes',
    }, execFor('s1'))
    expect(setResult).toEqual({ ok: true, provider_id: 'stub' })
    const infoTool = ctx.registered.get('aigc_get_provider_info')!
    const info = await infoTool.execute({}, execFor('s1')) as { providers: Array<{ instructions: string }> }
    expect(info.providers[0]!.instructions).toContain('/v1/images/generations')
  })

  it('aigc_provider_set_instructions throws for unknown provider ids', async () => {
    const tool = ctx.registered.get('aigc_provider_set_instructions')!
    await expect(tool.execute({ provider_id: 'nope', instructions: 'x' }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_canvas_place places a generated file at (x, y) with prompt + meta', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const generated = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"a red fox"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: generated.file_path,
      x: 120,
      y: 340,
      title: 'a red fox',
      prompt: 'a red fox in the snow',
      meta: { width: 1024, height: 1024, model: 'flux' },
    }, execFor('s1')) as {
      element_path: string; kind: string; title: string; x: number; y: number; linked_references: number
    }
    expect(placed.kind).toBe('image')
    expect(placed.element_path).toBe(generated.file_path)
    expect(placed.x).toBe(120)
    expect(placed.y).toBe(340)
    expect(placed.title).toBe('a red fox')
    expect(placed.linked_references).toBe(0)
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    expect(el.x).toBe(120)
    expect(el.y).toBe(340)
    expect(el.promptText).toBe('a red fox in the snow')
    expect(el.meta).toEqual({ width: 1024, height: 1024, model: 'flux' })
    expect(el.producedBy).toBe('aigc_canvas_place')
  })

  it('aigc_canvas_place auto-places when x/y are omitted (left column, below existing)', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const f1 = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"one"}' }, execFor('s1')) as { file_path: string }
    const f2 = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"two"}' }, execFor('s1')) as { file_path: string }
    const a = await placeTool.execute({ description: 'test', file_path: f1.file_path }, execFor('s1')) as { x: number; y: number }
    const b = await placeTool.execute({ description: 'test', file_path: f2.file_path }, execFor('s1')) as { x: number; y: number }
    // First auto-placed element lands at the origin fallback (32, 32).
    expect(a.x).toBe(32)
    expect(a.y).toBe(32)
    // Second auto-placed image lands below the first. The stride is the
    // estimated card height of an image card (~217px) + gap (16px) = 233.
    expect(b.x).toBe(32)
    expect(b.y).toBe(32 + 217 + 16)
  })

  it('aigc_canvas_place wraps to a new column when the first column is full', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    // Place 4 images. Each image card ≈ 217px + 16px gap = 233px stride.
    // Column max height threshold = AUTO_PLACE_X(32) + AUTO_COL_MAX_HEIGHT(600) = 632.
    // Col 1: y=32 (bottom=249), y=265 (bottom=482) — 482+16+217=715 > 632 → wrap
    // Col 2: y=32 (bottom=249), y=265 (bottom=482)
    const files: string[] = []
    for (let i = 0; i < 4; i++) {
      const f = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: `{"prompt":"img${i}"}` }, execFor('s1')) as { file_path: string }
      files.push(f.file_path)
    }
    const positions: { x: number; y: number }[] = []
    for (const f of files) {
      const p = await placeTool.execute({ description: 'test', file_path: f }, execFor('s1')) as { x: number; y: number }
      positions.push(p)
    }
    // First two in column 1 (x=32)
    expect(positions[0]!.x).toBe(32)
    expect(positions[1]!.x).toBe(32)
    expect(positions[0]!.y).toBe(32)
    expect(positions[1]!.y).toBe(32 + 217 + 16) // 265
    // Third wraps to column 2 (x = 32 + 240 + 20 = 292)
    expect(positions[2]!.x).toBe(292)
    expect(positions[2]!.y).toBe(32)
    // Fourth stacks below third in column 2
    expect(positions[3]!.x).toBe(292)
    expect(positions[3]!.y).toBe(32 + 217 + 16) // 265
  })

  it('aigc_canvas_place persists description and returns it', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const f = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"x"}' }, execFor('s1')) as { file_path: string }
    const placed = await placeTool.execute({ description: 'orange cat', file_path: f.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    expect(el.description).toBe('orange cat')
  })

  it('aigc_canvas_place rejects missing description', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const f = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"x"}' }, execFor('s1')) as { file_path: string }
    // The framework's schema validator rejects the call before execute runs
    // (description is required), so any thrown error is acceptable here.
    await expect(placeTool.execute({ file_path: f.file_path, x: 0, y: 0 } as never, execFor('s1'))).rejects.toThrow()
  })

  it('aigc_canvas_place coerces stringified JSON meta into an object', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const generated = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"coerce"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: generated.file_path,
      x: 0, y: 0,
      meta: '{"size":"768x768","seed":42}' as unknown as Record<string, unknown>,
    }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    expect(el.meta).toEqual({ size: '768x768', seed: 42 })
  })

  it('aigc_canvas_place drops non-object meta silently', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const generated = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"drop"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: generated.file_path,
      x: 0, y: 0,
      meta: 'not-json-at-all' as unknown as Record<string, unknown>,
    }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    expect(el.meta).toBeUndefined()
  })

  it('aigc_canvas_place auto-wires edges from references', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img1 = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"first"}' }, execFor('s1')) as { file_path: string }
    const img2 = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"last"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: img1.file_path,
      x: 0, y: 0,
    }, execFor('s1'))
    const placed2 = await placeTool.execute({ description: 'test', file_path: img2.file_path,
      x: 200, y: 0,
    }, execFor('s1'))
    const video = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"motion"}' }, execFor('s1')) as { file_path: string }
    const result = await placeTool.execute({ description: 'test', file_path: video.file_path,
      x: 400, y: 100,
      references: [placed.element_path as string, placed2.element_path as string],
    }, execFor('s1')) as { element_path: string; linked_references: number }
    expect(result.linked_references).toBe(2)
    const snap = canvas.snapshot('s1')
    const videoEl = snap.elements.find(e => e.filePath === result.element_path)!
    const incoming = snap.edges.filter(e => e.target === videoEl.uuid)
    expect(incoming).toHaveLength(2)
  })

  it('aigc_canvas_place auto-places to the right of references when x/y omitted', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    // Place two reference images at known positions.
    const img1 = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"ref1"}' }, execFor('s1')) as { file_path: string }
    const img2 = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"ref2"}' }, execFor('s1')) as { file_path: string }
    const ref1 = await placeTool.execute({ description: 'test', file_path: img1.file_path, x: 100, y: 200 }, execFor('s1')) as { element_path: string }
    const ref2 = await placeTool.execute({ description: 'test', file_path: img2.file_path, x: 100, y: 500 }, execFor('s1')) as { element_path: string }
    // Place a video referencing both — no explicit x/y. It should land
    // to the RIGHT of the rightmost reference (both at x=100, width 240,
    // so right edge = 340; plus gap 20 → x = 360). Y should be centered
    // on the average of the references' centers: (200+55, 500+55) / 2 = 405,
    // minus half node height (55) → y = 350.
    const video = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"out"}' }, execFor('s1')) as { file_path: string }
    const result = await placeTool.execute({ description: 'test', file_path: video.file_path,
      references: [ref1.element_path as string, ref2.element_path as string],
    }, execFor('s1')) as { x: number; y: number; linked_references: number }
    expect(result.linked_references).toBe(2)
    // Right of the rightmost reference: 100 + 240 + 20 = 360.
    expect(result.x).toBe(360)
    // Vertically centered on the references: avg center = (255 + 555) / 2 = 405;
    // top-left = 405 - 55 = 350.
    expect(result.y).toBe(350)
  })

  it('aigc_canvas_place rejects files outside the session canvas directory', async () => {
    const outside = join(tmpdir(), 'not-in-canvas.png')
    await writeFile(outside, Buffer.from([1, 2, 3]))
    try {
      const tool = ctx.registered.get('aigc_canvas_place')!
      await expect(tool.execute({ description: 'test', file_path: outside, x: 0, y: 0 }, execFor('s1'))).rejects.toThrow(AigcError)
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('aigc_canvas_place rejects unknown file extensions without an explicit kind', async () => {
    const dir = canvasDirFor(cwd, 's1')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'mystery.bin')
    await writeFile(file, Buffer.from([1]))
    const tool = ctx.registered.get('aigc_canvas_place')!
    await expect(tool.execute({ description: 'test', file_path: file, x: 0, y: 0 }, execFor('s1'))).rejects.toThrow(AigcError)
    await expect(tool.execute({ description: 'test', file_path: file, x: 0, y: 0, kind: 'image' }, execFor('s1'))).resolves.toMatchObject({ kind: 'image' })
  })

  it('aigc_canvas_link / aigc_canvas_unlink manage edges between placed elements', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"p"}' }, execFor('s1')) as { file_path: string }
    const vid = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"v"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const a = await placeTool.execute({ description: 'test', file_path: img.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const b = await placeTool.execute({ description: 'test', file_path: vid.file_path, x: 300, y: 0 }, execFor('s1')) as { element_path: string }
    const linkTool = ctx.registered.get('aigc_canvas_link')!
    const linked = await linkTool.execute({ source: a.element_path, target: b.element_path }, execFor('s1'))
    expect(linked).toEqual({ linked: true, source: a.element_path, target: b.element_path })
    // Idempotent: linking the same pair again does not duplicate.
    await linkTool.execute({ source: a.element_path, target: b.element_path }, execFor('s1'))
    const snap = canvas.snapshot('s1')
    expect(snap.edges).toHaveLength(1)
    const unlinkTool = ctx.registered.get('aigc_canvas_unlink')!
    await unlinkTool.execute({ source: a.element_path, target: b.element_path }, execFor('s1'))
    expect(canvas.snapshot('s1').edges).toHaveLength(0)
  })

  it('aigc_canvas_list_elements returns positions + filePath-addressed edges', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"one"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    await placeTool.execute({ description: 'test', file_path: img.file_path, x: 50, y: 60, prompt: 'one' }, execFor('s1'))
    const tool = ctx.registered.get('aigc_canvas_list_elements')!
    const result = await tool.execute({}, execFor('s1')) as {
      elements: Array<{ filePath: string; kind: string; title: string; x: number; y: number; promptText?: string }>
      edges: Array<{ source: string; target: string }>
    }
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0]!.x).toBe(50)
    expect(result.elements[0]!.y).toBe(60)
    expect(result.elements[0]!.promptText).toBe('one')
    expect(result.elements[0]!.filePath).toContain('.dsh-aigc-canvas')
    expect(result.edges).toHaveLength(0)
  })

  it('aigc_canvas_list_elements is isolated per session', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"one"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    await placeTool.execute({ description: 'test', file_path: img.file_path, x: 0, y: 0 }, execFor('s1'))
    const tool = ctx.registered.get('aigc_canvas_list_elements')!
    const s1 = await tool.execute({}, execFor('s1')) as { elements: unknown[] }
    const s2 = await tool.execute({}, execFor('s2')) as { elements: unknown[] }
    expect(s1.elements).toHaveLength(1)
    expect(s2.elements).toHaveLength(0)
  })

  it('tools honor exec.signal.aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const exec = {
      signal: ac.signal, callId: 'x', name: 'x', arguments: {},
      agent: { id: 'a', session: { id: 's1', header: {} } },
    } as ToolRunContext
    const tool = ctx.registered.get('aigc_http_request')!
    await expect(tool.execute({ path: '/v1/images/generations', method: 'POST' }, exec)).rejects.toThrow()
  })

  it('aigc_http_request expands $base64 placeholder in json_body', async () => {
    // Create a reference image via the stub.
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"ref"}' }, execFor('s1')) as { file_path: string }
    // Now call the stub again with a json_body that embeds the image via $base64.
    // The stub GET returns JSON; POST to /v1/models returns JSON ack — use that
    // to verify the request goes through with the expanded body.
    const result = await httpTool.execute({
      method: 'POST',
      path: '/v1/models',
      json_body: {
        model: 'test',
        image: { $base64: img.file_path },
        prompt: 'dance',
      },
    }, execFor('s1')) as { ok: boolean; kind: string; text: string }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('json')
  })

  it('aigc_http_request expands $data_uri placeholder in json_body', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"ref"}' }, execFor('s1')) as { file_path: string }
    const result = await httpTool.execute({
      method: 'POST',
      path: '/v1/models',
      json_body: {
        image: { $data_uri: img.file_path },
      },
    }, execFor('s1')) as { ok: boolean; kind: string }
    expect(result.ok).toBe(true)
  })

  it('aigc_http_request expands $base64 placeholder in raw body string', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"ref"}' }, execFor('s1')) as { file_path: string }
    // Pass a raw JSON body string with a $base64 placeholder. The tool should
    // parse it, expand the placeholder, and re-serialize — not pass the
    // placeholder through verbatim.
    const result = await httpTool.execute({
      method: 'POST',
      path: '/v1/models',
      body: JSON.stringify({ model: 'test', image: { $base64: img.file_path }, prompt: 'dance' }),
    }, execFor('s1')) as { ok: boolean; kind: string }
    expect(result.ok).toBe(true)
  })

  it('aigc_http_request passes non-JSON body through unchanged', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    // A body that is not JSON and contains no placeholders should pass through
    // verbatim (e.g. form-urlencoded content).
    const result = await httpTool.execute({
      method: 'POST',
      path: '/v1/models',
      body: 'plain-text-not-json',
    }, execFor('s1')) as { ok: boolean; kind: string }
    expect(result.ok).toBe(true)
  })

  it('aigc_http_request rejects $base64 with files outside the canvas dir', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const outside = join(tmpdir(), 'outside.png')
    await writeFile(outside, Buffer.from([1]))
    try {
      await expect(httpTool.execute({
        method: 'POST',
        path: '/v1/models',
        json_body: { image: { $base64: outside } },
      }, execFor('s1'))).rejects.toThrow(AigcError)
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('dispose unregisters all eight tools', () => {
    expect(ctx.registered.size).toBe(8)
    dispose()
    expect(ctx.registered.size).toBe(0)
  })

  it('aigc_media_edit is registered', () => {
    const tool = ctx.registered.get('aigc_media_edit')
    expect(tool).toBeDefined()
  })

  it('aigc_media_edit rejects unsupported operations', async () => {
    const tool = ctx.registered.get('aigc_media_edit')!
    await expect(tool.execute({
      operation: 'bogus',
      inputs: ['/fake.mp4'],
      output_ext: 'mp4',
    }, execFor('s1'))).rejects.toThrow()
  })

  it('aigc_media_edit rejects insufficient inputs for concat', async () => {
    const tool = ctx.registered.get('aigc_media_edit')!
    await expect(tool.execute({
      operation: 'concat',
      inputs: ['/fake.mp4'],
      output_ext: 'mp4',
    }, execFor('s1'))).rejects.toThrow()
  })
})

describe('registerTools (real endpoint through mocked fetch)', () => {
  let cwd: string
  let canvas: AigcCanvasService
  let ctx: MockTools
  let dispose: () => void
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-tools-real-'))
    canvas = createAigcCanvasService(() => cwd)
    ctx = mockCtx()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    dispose = registerAll(ctx, [REAL_PROVIDER], canvas, cwd).dispose
  })

  afterEach(async () => {
    dispose()
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  })

  it('attaches Authorization: Bearer and returns inline JSON for a 2xx response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ url: 'x' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({ method: 'POST', path: '/v1/images/generations', json_body: { prompt: 'p' } }, execFor('s1')) as {
      ok: boolean; kind: string; text: string
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('json')
    expect(result.text).toContain('"data"')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://example.com/v1/images/generations')
    const headers = new Headers(init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer sk-test')
    expect(headers.get('content-type')).toBe('application/json')
    expect(init?.body).toBe(JSON.stringify({ prompt: 'p' }))
  })

  it('saves binary image responses to disk', async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({ method: 'GET', path: '/v1/images/1234' }, execFor('s1')) as {
      ok: boolean; kind: string; file_path: string; file_size: number
    }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('image')
    expect(result.file_path).toMatch(/\.png$/)
    expect(result.file_size).toBe(8)
  })

  it('returns ok:false with the body for non-2xx responses', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }))
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({ method: 'POST', path: '/v1/images/generations', body: '{}' }, execFor('s1')) as {
      ok: boolean; status: number; error: string
    }
    expect(result.ok).toBe(false)
    expect(result.status).toBe(429)
    expect(result.error).toContain('quota exceeded')
  })

  it('returns sent_body_preview on non-2xx so the model can self-diagnose field loss', async () => {
    fetchMock.mockResolvedValue(new Response('no access to model', {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    }))
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      method: 'POST',
      path: '/v1/videos/generations',
      json_body: { model: 't2v', prompt: 'dance' },
    }, execFor('s1')) as {
      ok: boolean; status: number; sent_body_preview?: string
    }
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.sent_body_preview).toBe(JSON.stringify({ model: 't2v', prompt: 'dance' }))
  })

  it('serializes json_body object correctly (no double-quoting)', async () => {
    // Regression: when json_body is an object, JSON.stringify must produce
    // a clean JSON object string — not a double-quoted string literal.
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const tool = ctx.registered.get('aigc_http_request')!
    await tool.execute({
      method: 'POST',
      path: '/v1/videos/generations',
      json_body: { model: 't2v', task: 'video', prompt: 'dance' },
    }, execFor('s1'))
    const [, init] = fetchMock.mock.calls[0]!
    // The body sent to fetch must be a JSON object string, NOT a
    // JSON-string-literal (which would happen if we JSON.stringify'd a string).
    expect(init?.body).toBe('{"model":"t2v","task":"video","prompt":"dance"}')
    expect(() => JSON.parse(init?.body as string)).not.toThrow()
    const parsed = JSON.parse(init?.body as string) as { model: string }
    expect(parsed.model).toBe('t2v')
  })

  it('parses json_body when the model passes a JSON string instead of an object', async () => {
    // Regression for the "model is empty" 403 bug: when the model passes
    // json_body as a string (e.g. "{\"model\":\"x\"}"), the tool must parse
    // it first — otherwise JSON.stringify(string) double-wraps it and every
    // field is lost server-side.
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const tool = ctx.registered.get('aigc_http_request')!
    await tool.execute({
      method: 'POST',
      path: '/v1/videos/generations',
      json_body: '{"model":"t2v","prompt":"dance"}',
    }, execFor('s1'))
    const [, init] = fetchMock.mock.calls[0]!
    // The sent body must be a clean JSON object, not a string literal.
    expect(init?.body).toBe('{"model":"t2v","prompt":"dance"}')
    const parsed = JSON.parse(init?.body as string) as { model: string; prompt: string }
    expect(parsed.model).toBe('t2v')
    expect(parsed.prompt).toBe('dance')
  })

  it('rejects json_body strings that are not valid JSON', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    await expect(tool.execute({
      method: 'POST',
      path: '/v1/models',
      json_body: 'not-json',
    }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('accepts same-origin absolute URLs', async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    const tool = ctx.registered.get('aigc_http_request')!
    const result = await tool.execute({
      method: 'GET',
      path: 'https://example.com/v1/videos/123/content',
    }, execFor('s1')) as { ok: boolean; kind: string }
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('image')
    const [url] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://example.com/v1/videos/123/content')
  })

  it('rejects cross-origin absolute URLs', async () => {
    const tool = ctx.registered.get('aigc_http_request')!
    await expect(tool.execute({
      method: 'GET',
      path: 'https://evil.example.com/steal',
    }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('supports custom header auth via the provider auth config', async () => {
    const customProvider: ResolvedAigcProvider = {
      ...REAL_PROVIDER,
      id: 'custom',
      auth: { scheme: 'header', name: 'x-volc-key' },
    }
    const customCtx = mockCtx()
    const register = registerAll(customCtx, [customProvider], canvas, cwd)
    try {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
      const tool = customCtx.registered.get('aigc_http_request')!
      await tool.execute({ method: 'GET', path: '/v1/models' }, execFor('s1'))
      const [, init] = fetchMock.mock.calls[0]!
      const headers = new Headers(init?.headers)
      expect(headers.get('x-volc-key')).toBe('sk-test')
      expect(headers.get('Authorization')).toBeNull()
    } finally {
      register.dispose()
    }
  })

  it('supports query auth via the provider auth config', async () => {
    const queryProvider: ResolvedAigcProvider = {
      ...REAL_PROVIDER,
      id: 'query',
      auth: { scheme: 'query', name: 'api_key' },
    }
    const queryCtx = mockCtx()
    const register = registerAll(queryCtx, [queryProvider], canvas, cwd)
    try {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
      const tool = queryCtx.registered.get('aigc_http_request')!
      await tool.execute({ method: 'GET', path: '/v1/models' }, execFor('s1'))
      const [url] = fetchMock.mock.calls[0]!
      expect(String(url)).toContain('api_key=sk-test')
    } finally {
      register.dispose()
    }
  })

  it('get_provider_info reports isStub=false for real endpoints', async () => {
    const tool = ctx.registered.get('aigc_get_provider_info')!
    const result = await tool.execute({}, execFor('s1')) as {
      providers: Array<{ id: string; isStub: boolean; endpoint: string }>
    }
    expect(result.providers[0]!.isStub).toBe(false)
    expect(result.providers[0]!.endpoint).toBe('https://example.com')
  })
})
