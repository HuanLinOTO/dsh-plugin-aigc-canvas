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
import type { EndpointSpec } from '../src/endpoint-catalog.js'
import { getLogEntries, clearLogEntries, redactSecrets, type RequestLogEntry } from '../src/request-log.js'
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
  endpoints: [], priority: 100, costPerCall: 0, avgLatencyMs: 0, qualityHint: 'balanced',
}

const REAL_PROVIDER: ResolvedAigcProvider = {
  id: 'real', name: 'Real API', endpoint: 'https://example.com', apiKey: 'sk-test', instructions: 'docs...',
  auth: { scheme: 'bearer', name: '' }, builtin: false,
  endpoints: [], priority: 100, costPerCall: 0, avgLatencyMs: 0, qualityHint: 'balanced',
}

function providerInfoList(providers: readonly ResolvedAigcProvider[]): readonly ProviderInfo[] {
  return providers.map((p, i) => ({
    id: p.id,
    name: p.name,
    endpoint: p.endpoint,
    instructions: p.instructions,
    isStub: p.endpoint === '' || p.endpoint === 'stub://aigc-backend',
    isDefault: i === 0,
    endpoints: p.endpoints,
    priority: p.priority,
    costPerCall: p.costPerCall,
    avgLatencyMs: p.avgLatencyMs,
    qualityHint: p.qualityHint,
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
): { dispose: () => void; instructionStore: ReturnType<typeof makeInstructionStore>; endpointStore: ReturnType<typeof makeEndpointStore> } {
  // Mutable provider list mirroring the host ProviderStore: set_instructions
  // + set_endpoints write through, and getProvider / listProviders read live values.
  const mutable = providers.map(p => ({ ...p }))
  const instructionStore = makeInstructionStore(mutable)
  const endpointStore = makeEndpointStore(mutable)
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
    (id, endpoints) => {
      const result = endpointStore.set(id, endpoints)
      if (result.ok) {
        const p = byId.get(id)
        if (p !== undefined) {
          p.endpoints = [...endpoints]
          // Mirror ProviderStore: auto-derive instructions from endpoints.
          p.instructions = endpoints.length > 0
            ? endpoints.map(ep => `${ep.method} ${ep.path} -> ${ep.response.kind}`).join('\n')
            : p.instructions
        }
      }
      return result
    },
    () => providerInfoList(mutable),
    canvas,
    () => cwd,
    () => 5_000,
    () => 100 * 1024 * 1024,
  )
  return { dispose, instructionStore, endpointStore }
}

/** A mutable endpoint catalog backing the aigc_provider_set_endpoints callback. */
function makeEndpointStore(providers: readonly ResolvedAigcProvider[]): {
  map: Map<string, EndpointSpec[]>
  set: (id: string, endpoints: readonly EndpointSpec[]) => { ok: boolean; error?: string }
} {
  const map = new Map<string, EndpointSpec[]>()
  for (const p of providers) map.set(p.id, p.endpoints)
  return {
    map,
    set: (id, endpoints) => {
      if (!map.has(id)) return { ok: false, error: `provider id not found: ${id}` }
      map.set(id, [...endpoints])
      return { ok: true }
    },
  }
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

  it('edgeProjection resolves uuids to filePaths and includes the relation', () => {
    const lookup = (uuid: string) => uuid === 'a' ? { filePath: '/path/a.png' } as never : { filePath: '/path/b.mp4' } as never
    expect(edgeProjection({ source: 'a', target: 'b', relation: 'first_frame' }, lookup)).toEqual({
      source: '/path/a.png', target: '/path/b.mp4', relation: 'first_frame',
    })
  })

  it('edgeProjection defaults relation to "input" when missing (backward compat)', () => {
    const lookup = (uuid: string) => uuid === 'a' ? { filePath: '/path/a.png' } as never : { filePath: '/path/b.mp4' } as never
    expect(edgeProjection({ source: 'a', target: 'b' }, lookup)).toEqual({
      source: '/path/a.png', target: '/path/b.mp4', relation: 'input',
    })
  })

  it('edgeProjection coerces an invalid relation to "input"', () => {
    const lookup = () => ({ filePath: '/x.png' } as never)
    expect(edgeProjection({ source: 'a', target: 'b', relation: 'bogus' }, lookup).relation).toBe('input')
  })

  it('edgeProjection passes through the optional note', () => {
    const lookup = () => ({ filePath: '/x.png' } as never)
    expect(edgeProjection({ source: 'a', target: 'b', relation: 'style', note: 'cyberpunk' }, lookup)).toMatchObject({
      relation: 'style', note: 'cyberpunk',
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

  it('registers exactly thirteen tools', () => {
    expect(Array.from(ctx.registered.keys()).sort()).toEqual([
      'aigc_canvas_link',
      'aigc_canvas_list_elements',
      'aigc_canvas_place',
      'aigc_canvas_unlink',
      'aigc_get_endpoint_details',
      'aigc_get_provider_info',
      'aigc_http_request',
      'aigc_media_edit',
      'aigc_probe_endpoint',
      'aigc_provider_get_instructions',
      'aigc_provider_set_endpoints',
      'aigc_provider_set_instructions',
      'aigc_reroll',
    ])
  })

  it('aigc_get_provider_info returns the provider list with an instructions preview + capability summary', async () => {
    const tool = ctx.registered.get('aigc_get_provider_info')!
    const result = await tool.execute({}, execFor('s1')) as {
      providers: Array<{ id: string; name: string; endpoint: string; instructions: string; instructions_total_chars: number; isStub: boolean; isDefault: boolean; capabilities: string[]; endpoint_count: number; priority: number; qualityHint: string; costPerCall: number }>
      capabilityMap: Record<string, Array<{ providerId: string; priority: number }>>
    }
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0]!.id).toBe('stub')
    expect(result.providers[0]!.isStub).toBe(true)
    expect(result.providers[0]!.endpoint).toBe('stub://aigc-backend')
    expect(result.providers[0]!.isDefault).toBe(true)
    // The stub provider has empty instructions + no endpoints → empty capabilities.
    expect(result.providers[0]!.instructions).toBe('')
    expect(result.providers[0]!.instructions_total_chars).toBe(0)
    expect(result.providers[0]!.capabilities).toEqual([])
    expect(result.providers[0]!.endpoint_count).toBe(0)
    expect(result.providers[0]!.priority).toBe(100)
    expect(result.providers[0]!.qualityHint).toBe('balanced')
    expect(result.providers[0]!.costPerCall).toBe(0)
    // capabilityMap is empty when no provider has endpoints.
    expect(result.capabilityMap).toEqual({})
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

  it('aigc_provider_set_instructions stores instructions and exposes them via aigc_get_provider_info (preview)', async () => {
    const setTool = ctx.registered.get('aigc_provider_set_instructions')!
    const short = 'POST /v1/images/generations with { prompt, size }; returns image/png bytes'
    const setResult = await setTool.execute({
      provider_id: 'stub',
      instructions: short,
    }, execFor('s1'))
    expect(setResult).toEqual({ ok: true, provider_id: 'stub', total_chars: short.length })
    const infoTool = ctx.registered.get('aigc_get_provider_info')!
    const info = await infoTool.execute({}, execFor('s1')) as { providers: Array<{ instructions: string; instructions_total_chars: number }> }
    // Short instructions fit within the preview window → preview == full text.
    expect(info.providers[0]!.instructions).toBe(short)
    expect(info.providers[0]!.instructions_total_chars).toBe(short.length)
  })

  it('aigc_provider_set_instructions truncates the preview when instructions exceed the preview cap', async () => {
    const setTool = ctx.registered.get('aigc_provider_set_instructions')!
    // Build a >200 char instructions string with a recognizable tail.
    const head = 'POST /v1/images/generations { prompt, size } -> {data:[{b64_json}]}; '
    const tail = 'TAIL_MARKER_HERE'
    const filler = 'x'.repeat(220 - head.length - tail.length)
    const long = head + filler + tail
    expect(long.length).toBe(220)
    const setResult = await setTool.execute({ provider_id: 'stub', instructions: long }, execFor('s1'))
    expect(setResult).toMatchObject({ ok: true, total_chars: 220 })
    const infoTool = ctx.registered.get('aigc_get_provider_info')!
    const info = await infoTool.execute({}, execFor('s1')) as { providers: Array<{ instructions: string; instructions_total_chars: number }> }
    // Preview is truncated — the tail must NOT appear in the preview, only the head.
    expect(info.providers[0]!.instructions_total_chars).toBe(220)
    expect(info.providers[0]!.instructions.startsWith(head)).toBe(true)
    expect(info.providers[0]!.instructions).not.toContain(tail)
    expect(info.providers[0]!.instructions).toContain('220 chars total')
  })

  it('aigc_provider_set_instructions rejects instructions over the 1000-char limit', async () => {
    const setTool = ctx.registered.get('aigc_provider_set_instructions')!
    const tooLong = 'x'.repeat(1001)
    await expect(setTool.execute({ provider_id: 'stub', instructions: tooLong }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_provider_get_instructions returns the full instructions for one provider', async () => {
    const setTool = ctx.registered.get('aigc_provider_set_instructions')!
    const long = 'HEAD: ' + 'y'.repeat(300) + ' :TAIL'
    expect(long.length).toBeGreaterThan(200)
    await setTool.execute({ provider_id: 'stub', instructions: long }, execFor('s1'))
    const getTool = ctx.registered.get('aigc_provider_get_instructions')!
    const result = await getTool.execute({ provider_id: 'stub' }, execFor('s1')) as {
      provider_id: string; instructions: string; total_chars: number
    }
    expect(result.provider_id).toBe('stub')
    expect(result.total_chars).toBe(long.length)
    // The full text is returned — the tail marker must be present (it's stripped from the preview).
    expect(result.instructions).toBe(long)
    expect(result.instructions).toContain(':TAIL')
  })

  it('aigc_provider_get_instructions returns empty for an uninitialized provider', async () => {
    const getTool = ctx.registered.get('aigc_provider_get_instructions')!
    const result = await getTool.execute({ provider_id: 'stub' }, execFor('s1')) as {
      instructions: string; total_chars: number
    }
    expect(result.instructions).toBe('')
    expect(result.total_chars).toBe(0)
  })

  it('aigc_provider_get_instructions throws for unknown provider ids', async () => {
    const tool = ctx.registered.get('aigc_provider_get_instructions')!
    await expect(tool.execute({ provider_id: 'nope' }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_provider_set_instructions throws for unknown provider ids', async () => {
    const tool = ctx.registered.get('aigc_provider_set_instructions')!
    await expect(tool.execute({ provider_id: 'nope', instructions: 'x' }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_canvas_place places a generated file at (x, y) with prompt + meta + auto-recorded originalRequest', async () => {
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
    // User-supplied meta is preserved, with originalRequest merged in.
    expect(el.meta).toMatchObject({ width: 1024, height: 1024, model: 'flux' })
    expect(el.meta?.originalRequest).toMatchObject({
      providerId: 'stub',
      method: 'POST',
      path: '/v1/images/generations',
    })
    expect(el.meta?.originalRequest?.responseInfo?.kind).toBe('image')
    expect(el.meta?.originalRequest?.responseInfo?.status).toBe(200)
    expect(el.meta?.originalRequest?.responseInfo?.durationMs).toBeGreaterThanOrEqual(0)
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

  it('aigc_canvas_place coerces stringified JSON meta into an object (and still gets originalRequest)', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const generated = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"coerce"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: generated.file_path,
      x: 0, y: 0,
      meta: '{"size":"768x768","seed":42}' as unknown as Record<string, unknown>,
    }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    // Coerced user meta is preserved + originalRequest is merged in.
    expect(el.meta).toMatchObject({ size: '768x768', seed: 42 })
    expect(el.meta?.originalRequest).toBeDefined()
  })

  it('aigc_canvas_place populates meta.originalRequest even when user meta is absent', async () => {
    // When the model places a file produced by aigc_http_request WITHOUT
    // passing any meta of its own, the host still records originalRequest
    // so the element can be rerolled later.
    const httpTool = ctx.registered.get('aigc_http_request')!
    const generated = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"drop"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: generated.file_path,
      x: 0, y: 0,
      meta: 'not-json-at-all' as unknown as Record<string, unknown>,
    }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    // Non-object user meta is dropped silently, but originalRequest is still set.
    expect(el.meta?.originalRequest).toBeDefined()
    expect(el.meta?.originalRequest).toMatchObject({ providerId: 'stub', path: '/v1/images/generations' })
  })

  it('aigc_canvas_place leaves meta unset for files NOT from aigc_http_request (no snapshot)', async () => {
    // A file placed by drag-drop (canvas.upload API) or created externally
    // has no RequestSnapshot → meta stays undefined (no originalRequest).
    const dir = canvasDirFor(cwd, 's1')
    await mkdir(dir, { recursive: true })
    const externalFile = join(dir, 'external.png')
    await writeFile(externalFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'external', file_path: externalFile, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    expect(el.meta).toBeUndefined()
  })

  it('aigc_canvas_place consumes the snapshot (second place of same file has no originalRequest)', async () => {
    // The cache entry is consumed on first place — a second place of the
    // same file (rare but possible) won't get originalRequest. This bounds
    // memory growth: snapshots don't accumulate forever.
    const httpTool = ctx.registered.get('aigc_http_request')!
    const generated = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"twice"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const first = await placeTool.execute({ description: 'first', file_path: generated.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const second = await placeTool.execute({ description: 'second', file_path: generated.file_path, x: 100, y: 100 }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const firstEl = snap.elements.find(e => e.filePath === first.element_path)!
    const secondEl = snap.elements.find(e => e.filePath === second.element_path && e !== firstEl)
    expect(firstEl.meta?.originalRequest).toBeDefined()
    // Second place: snapshot was already consumed → no originalRequest.
    expect(secondEl?.meta?.originalRequest).toBeUndefined()
  })

  it('aigc_http_request records the unexpanded json_body (placeholders intact) in originalRequest', async () => {
    // When the model uses $base64 placeholders, the snapshot keeps the
    // UNEXPANDED form so reroll can re-resolve the reference at replay time.
    const httpTool = ctx.registered.get('aigc_http_request')!
    const refImg = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"ref"}' }, execFor('s1')) as { file_path: string }
    // Now call http_request with a $base64 placeholder referencing refImg.
    // Use /v1/models (returns JSON ack) so we can verify the body sent.
    const generated = await httpTool.execute({
      method: 'POST',
      path: '/v1/images/generations',
      json_body: { prompt: 'dance', image: { $base64: refImg.file_path }, size: '1024x1024' },
    }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: generated.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    const body = el.meta?.originalRequest?.body as { prompt: string; image: { $base64: string }; size: string } | undefined
    expect(body).toBeDefined()
    expect(body?.prompt).toBe('dance')
    expect(body?.size).toBe('1024x1024')
    // The placeholder is preserved (NOT expanded to base64) — reroll will re-resolve it.
    expect(body?.image).toEqual({ $base64: refImg.file_path })
  })

  it('aigc_http_request records the raw body string in originalRequest when body arg is used', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const generated = await httpTool.execute({
      method: 'POST',
      path: '/v1/images/generations',
      body: '{"prompt":"raw body test","size":"512x512"}',
    }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: generated.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const snap = canvas.snapshot('s1')
    const el = snap.elements.find(e => e.filePath === placed.element_path)!
    // For raw body inputs, the body is stored as the raw string (no parsing).
    expect(el.meta?.originalRequest?.body).toBe('{"prompt":"raw body test","size":"512x512"}')
  })

  it('aigc_canvas_list_elements exposes meta.originalRequest in the projection', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const generated = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"listed"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    await placeTool.execute({ description: 'test', file_path: generated.file_path, x: 0, y: 0 }, execFor('s1'))
    const listTool = ctx.registered.get('aigc_canvas_list_elements')!
    const result = await listTool.execute({}, execFor('s1')) as {
      elements: Array<{ meta?: { originalRequest?: { providerId: string; method: string; path: string } } }>
    }
    expect(result.elements[0]!.meta?.originalRequest).toMatchObject({
      providerId: 'stub',
      method: 'POST',
      path: '/v1/images/generations',
    })
  })

  it('aigc_canvas_place auto-wires edges from references (legacy string form, default relation)', async () => {
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
    // Legacy string form → default relation 'input'.
    for (const e of incoming) expect(e.relation).toBe('input')
  })

  it('aigc_canvas_place auto-wires edges with the structured { filePath, relation } form', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img1 = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"first"}' }, execFor('s1')) as { file_path: string }
    const img2 = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"last"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed1 = await placeTool.execute({ description: 'first', file_path: img1.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const placed2 = await placeTool.execute({ description: 'last', file_path: img2.file_path, x: 0, y: 200 }, execFor('s1')) as { element_path: string }
    const video = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"motion"}' }, execFor('s1')) as { file_path: string }
    const result = await placeTool.execute({ description: 'test', file_path: video.file_path,
      references: [
        { filePath: placed1.element_path, relation: 'first_frame' },
        { filePath: placed2.element_path, relation: 'last_frame', note: 'final pose' },
      ],
    }, execFor('s1')) as { element_path: string; linked_references: number }
    expect(result.linked_references).toBe(2)
    const snap = canvas.snapshot('s1')
    const videoEl = snap.elements.find(e => e.filePath === result.element_path)!
    const edges = snap.edges.filter(e => e.target === videoEl.uuid)
    expect(edges).toHaveLength(2)
    const ff = edges.find(e => e.source === placed1.element_path)! // source is uuid; we check by mapping below
    // The snapshot edges use uuids internally — verify via listElements tool which projects to filePaths.
    const listTool = ctx.registered.get('aigc_canvas_list_elements')!
    const listed = await listTool.execute({}, execFor('s1')) as { edges: Array<{ source: string; target: string; relation: string; note?: string }> }
    const incomingListed = listed.edges.filter(e => e.target === result.element_path)
    expect(incomingListed).toHaveLength(2)
    const ffListed = incomingListed.find(e => e.source === placed1.element_path)!
    expect(ffListed.relation).toBe('first_frame')
    const lfListed = incomingListed.find(e => e.source === placed2.element_path)!
    expect(lfListed.relation).toBe('last_frame')
    expect(lfListed.note).toBe('final pose')
  })

  it('aigc_canvas_place rejects references with an invalid relation enum', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"p"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'test', file_path: img.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const video = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"v"}' }, execFor('s1')) as { file_path: string }
    // Invalid relation value — coerceEdgeRelation falls back to 'input' silently (no error)
    // so the model can recover from a typo. Verify the fallback behavior.
    const result = await placeTool.execute({ description: 'test', file_path: video.file_path,
      references: [{ filePath: placed.element_path, relation: 'bogus-relation' }],
    }, execFor('s1')) as { linked_references: number }
    expect(result.linked_references).toBe(1)
    const listTool = ctx.registered.get('aigc_canvas_list_elements')!
    const listed = await listTool.execute({}, execFor('s1')) as { edges: Array<{ relation: string }> }
    expect(listed.edges[0]!.relation).toBe('input') // coerced from 'bogus-relation'
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
    const linked = await linkTool.execute({ source: a.element_path, target: b.element_path, relation: 'first_frame' }, execFor('s1')) as { linked: boolean; source: string; target: string; relation: string }
    expect(linked).toEqual({ linked: true, source: a.element_path, target: b.element_path, relation: 'first_frame' })
    // Re-linking the same pair with a DIFFERENT relation UPDATES it (not a no-op).
    await linkTool.execute({ source: a.element_path, target: b.element_path, relation: 'style' }, execFor('s1'))
    const snap = canvas.snapshot('s1')
    expect(snap.edges).toHaveLength(1)
    expect(snap.edges[0]!.relation).toBe('style')
    const unlinkTool = ctx.registered.get('aigc_canvas_unlink')!
    await unlinkTool.execute({ source: a.element_path, target: b.element_path }, execFor('s1'))
    expect(canvas.snapshot('s1').edges).toHaveLength(0)
  })

  it('aigc_canvas_link rejects an invalid relation enum value', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"p"}' }, execFor('s1')) as { file_path: string }
    const vid = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"v"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const a = await placeTool.execute({ description: 'test', file_path: img.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const b = await placeTool.execute({ description: 'test', file_path: vid.file_path, x: 300, y: 0 }, execFor('s1')) as { element_path: string }
    const linkTool = ctx.registered.get('aigc_canvas_link')!
    // The framework's schema validator (enum constraint) rejects the bogus
    // value before execute runs — any thrown error is acceptable.
    await expect(linkTool.execute({ source: a.element_path, target: b.element_path, relation: 'bogus' }, execFor('s1'))).rejects.toThrow()
  })

  it('aigc_canvas_link rejects a missing relation (relation is now required)', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"p"}' }, execFor('s1')) as { file_path: string }
    const vid = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"v"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const a = await placeTool.execute({ description: 'test', file_path: img.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const b = await placeTool.execute({ description: 'test', file_path: vid.file_path, x: 300, y: 0 }, execFor('s1')) as { element_path: string }
    const linkTool = ctx.registered.get('aigc_canvas_link')!
    // The framework's schema validator rejects before execute runs (relation
    // is required); any thrown error is acceptable here.
    await expect(linkTool.execute({ source: a.element_path, target: b.element_path } as never, execFor('s1'))).rejects.toThrow()
  })

  it('aigc_canvas_link accepts all 11 EdgeRelation enum values', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"p"}' }, execFor('s1')) as { file_path: string }
    const vid = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"v"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const a = await placeTool.execute({ description: 'test', file_path: img.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const b = await placeTool.execute({ description: 'test', file_path: vid.file_path, x: 300, y: 0 }, execFor('s1')) as { element_path: string }
    const linkTool = ctx.registered.get('aigc_canvas_link')!
    const relations = ['input', 'first_frame', 'last_frame', 'audio_track', 'reference', 'style', 'mask', 'variation_of', 'remix_of', 'alternative_of', 'edited_from']
    for (const relation of relations) {
      const result = await linkTool.execute({ source: a.element_path, target: b.element_path, relation }, execFor('s1')) as { relation: string }
      expect(result.relation).toBe(relation)
    }
    // All re-links update the SAME edge (no duplicates).
    expect(canvas.snapshot('s1').edges).toHaveLength(1)
  })

  it('aigc_canvas_list_elements returns positions + filePath-addressed edges with relation', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const img = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', body: '{"prompt":"one"}' }, execFor('s1')) as { file_path: string }
    const vid = await httpTool.execute({ method: 'POST', path: '/v1/videos/generations', body: '{"prompt":"v"}' }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const a = await placeTool.execute({ description: 'test', file_path: img.file_path, x: 50, y: 60, prompt: 'one' }, execFor('s1')) as { element_path: string }
    const b = await placeTool.execute({ description: 'test', file_path: vid.file_path, x: 400, y: 60 }, execFor('s1')) as { element_path: string }
    const linkTool = ctx.registered.get('aigc_canvas_link')!
    await linkTool.execute({ source: a.element_path, target: b.element_path, relation: 'first_frame' }, execFor('s1'))
    const tool = ctx.registered.get('aigc_canvas_list_elements')!
    const result = await tool.execute({}, execFor('s1')) as {
      elements: Array<{ filePath: string; kind: string; title: string; x: number; y: number; promptText?: string }>
      edges: Array<{ source: string; target: string; relation: string; note?: string }>
    }
    expect(result.elements).toHaveLength(2)
    expect(result.elements[0]!.x).toBe(50)
    expect(result.elements[0]!.y).toBe(60)
    expect(result.elements[0]!.promptText).toBe('one')
    expect(result.elements[0]!.filePath).toContain('.dsh-aigc-canvas')
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]!.source).toBe(a.element_path)
    expect(result.edges[0]!.target).toBe(b.element_path)
    expect(result.edges[0]!.relation).toBe('first_frame')
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

  it('dispose unregisters all thirteen tools', () => {
    expect(ctx.registered.size).toBe(13)
    dispose()
    expect(ctx.registered.size).toBe(0)
  })

  // ── aigc_get_endpoint_details / aigc_provider_set_endpoints / aigc_probe_endpoint ──

  /** One valid EndpointSpec for tests. */
  const T2I_SPEC: EndpointSpec = {
    path: '/v1/images/generations',
    method: 'POST',
    capability: 't2i',
    params: [
      { name: 'prompt', type: 'string', required: true },
      { name: 'size', type: 'string', default: '1024x1024' },
    ],
    response: { kind: 'b64_json_array', path: 'data[0].b64_json' },
    acceptsCanvasRef: true,
  }
  const T2V_SPEC: EndpointSpec = {
    path: '/v1/videos/generations',
    method: 'POST',
    capability: 't2v',
    params: [{ name: 'prompt', type: 'string', required: true }],
    response: { kind: 'url_field', path: 'data[0].url' },
  }

  it('aigc_provider_set_endpoints stores the structured catalog + auto-derives instructions', async () => {
    const tool = ctx.registered.get('aigc_provider_set_endpoints')!
    const result = await tool.execute({
      provider_id: 'stub',
      endpoints: [T2I_SPEC, T2V_SPEC],
    }, execFor('s1')) as { ok: boolean; provider_id: string; endpoint_count: number; derived_instructions_chars: number }
    expect(result.ok).toBe(true)
    expect(result.provider_id).toBe('stub')
    expect(result.endpoint_count).toBe(2)
    expect(result.derived_instructions_chars).toBeGreaterThan(0)
    // The auto-derived instructions should be visible via aigc_get_provider_info.
    const infoTool = ctx.registered.get('aigc_get_provider_info')!
    const info = await infoTool.execute({}, execFor('s1')) as {
      providers: Array<{ instructions: string; capabilities: string[]; endpoint_count: number }>
      capabilityMap: Record<string, unknown[]>
    }
    expect(info.providers[0]!.endpoint_count).toBe(2)
    expect(info.providers[0]!.capabilities).toContain('t2i')
    expect(info.providers[0]!.capabilities).toContain('t2v')
    expect(info.providers[0]!.instructions).toContain('/v1/images/generations')
    expect(info.capabilityMap.t2i).toHaveLength(1)
    expect(info.capabilityMap.t2v).toHaveLength(1)
  })

  it('aigc_provider_set_endpoints rejects invalid capability enum', async () => {
    const tool = ctx.registered.get('aigc_provider_set_endpoints')!
    await expect(tool.execute({
      provider_id: 'stub',
      endpoints: [{ path: '/x', method: 'POST', capability: 'bogus', response: { kind: 'json_text' } }],
    }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_provider_set_endpoints rejects invalid response.kind enum', async () => {
    const tool = ctx.registered.get('aigc_provider_set_endpoints')!
    await expect(tool.execute({
      provider_id: 'stub',
      endpoints: [{ path: '/x', method: 'POST', capability: 't2i', response: { kind: 'bogus' } }],
    }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_provider_set_endpoints rejects unknown provider ids', async () => {
    const tool = ctx.registered.get('aigc_provider_set_endpoints')!
    await expect(tool.execute({ provider_id: 'nope', endpoints: [] }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_get_endpoint_details returns the EndpointSpec[] for one capability', async () => {
    // Set endpoints first.
    const setTool = ctx.registered.get('aigc_provider_set_endpoints')!
    await setTool.execute({ provider_id: 'stub', endpoints: [T2I_SPEC, T2V_SPEC] }, execFor('s1'))
    const tool = ctx.registered.get('aigc_get_endpoint_details')!
    const result = await tool.execute({ provider_id: 'stub', capability: 't2i' }, execFor('s1')) as {
      provider_id: string; capability: string; endpoints: EndpointSpec[]
    }
    expect(result.provider_id).toBe('stub')
    expect(result.capability).toBe('t2i')
    expect(result.endpoints).toHaveLength(1)
    expect(result.endpoints[0]!.path).toBe('/v1/images/generations')
    expect(result.endpoints[0]!.response.kind).toBe('b64_json_array')
    expect(result.endpoints[0]!.response.path).toBe('data[0].b64_json')
  })

  it('aigc_get_endpoint_details returns empty for a capability the provider does not support', async () => {
    const tool = ctx.registered.get('aigc_get_endpoint_details')!
    const result = await tool.execute({ provider_id: 'stub', capability: 'tts' }, execFor('s1')) as {
      endpoints: EndpointSpec[]
    }
    expect(result.endpoints).toEqual([])
  })

  it('aigc_get_endpoint_details rejects invalid capability enum', async () => {
    const tool = ctx.registered.get('aigc_get_endpoint_details')!
    // The framework's schema validator (enum constraint) rejects 'bogus' before execute runs.
    await expect(tool.execute({ provider_id: 'stub', capability: 'bogus' }, execFor('s1'))).rejects.toThrow()
  })

  it('aigc_probe_endpoint detects OpenAI b64_json_array shape from a stub response', async () => {
    const tool = ctx.registered.get('aigc_probe_endpoint')!
    const result = await tool.execute({
      provider_id: 'stub',
      path: '/v1/images/generations',
      method: 'POST',
      test_body: { prompt: 'test', size: '1024x1024' },
    }, execFor('s1')) as {
      ok: boolean; status: number; content_type: string
      detected: { responseKind: string; responsePath?: string }
      body_preview: string
    }
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    // The stub returns {data:[{b64_json:...}]} JSON → detected as b64_json_array @ data[0].b64_json.
    expect(result.detected.responseKind).toBe('b64_json_array')
    expect(result.detected.responsePath).toBe('data[0].b64_json')
  })

  it('aigc_probe_endpoint detects binary from a stub video response', async () => {
    const tool = ctx.registered.get('aigc_probe_endpoint')!
    const result = await tool.execute({
      provider_id: 'stub',
      path: '/v1/videos/generations',
      method: 'POST',
      test_body: { prompt: 'test' },
    }, execFor('s1')) as {
      ok: boolean; detected: { responseKind: string }
    }
    expect(result.ok).toBe(true)
    // The stub returns video/mp4 binary → detected as binary.
    expect(result.detected.responseKind).toBe('binary')
  })

  it('aigc_probe_endpoint rejects unknown provider ids', async () => {
    const tool = ctx.registered.get('aigc_probe_endpoint')!
    await expect(tool.execute({ provider_id: 'nope', path: '/x' }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  // ── aigc_reroll ──────────────────────────────────────────────────────────

  /** Helper: generate + place an image element, return its filePath. */
  async function placeGeneratedImage(prompt: string): Promise<string> {
    const httpTool = ctx.registered.get('aigc_http_request')!
    const gen = await httpTool.execute({ method: 'POST', path: '/v1/images/generations', json_body: { prompt, size: '1024x1024', seed: 42 } }, execFor('s1')) as { file_path: string }
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'src', file_path: gen.file_path, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    return placed.element_path
  }

  it('aigc_reroll is registered', () => {
    expect(ctx.registered.get('aigc_reroll')).toBeDefined()
  })

  it('aigc_reroll throws when the source element has no meta.originalRequest', async () => {
    // Place an external file (not from aigc_http_request) → no originalRequest.
    const dir = canvasDirFor(cwd, 's1')
    await mkdir(dir, { recursive: true })
    const external = join(dir, 'external-reroll.png')
    await writeFile(external, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    const placed = await placeTool.execute({ description: 'ext', file_path: external, x: 0, y: 0 }, execFor('s1')) as { element_path: string }
    const rerollTool = ctx.registered.get('aigc_reroll')!
    await expect(rerollTool.execute({ source_element: placed.element_path }, execFor('s1'))).rejects.toThrow(AigcError)
  })

  it('aigc_reroll with no patch generates a variation_of edge to the source', async () => {
    const source = await placeGeneratedImage('a cat')
    const rerollTool = ctx.registered.get('aigc_reroll')!
    const result = await rerollTool.execute({ source_element: source }, execFor('s1')) as {
      elements: Array<{ filePath: string; kind: string }>; linked_to: string; relation: string
    }
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0]!.kind).toBe('image')
    expect(result.linked_to).toBe(source)
    expect(result.relation).toBe('variation_of')
    // The new element should be on the canvas + wired to the source with variation_of.
    const listTool = ctx.registered.get('aigc_canvas_list_elements')!
    const listed = await listTool.execute({}, execFor('s1')) as { edges: Array<{ source: string; target: string; relation: string }> }
    const rerollEdges = listed.edges.filter(e => e.target === result.elements[0]!.filePath)
    expect(rerollEdges).toHaveLength(1)
    expect(rerollEdges[0]!.source).toBe(source)
    expect(rerollEdges[0]!.relation).toBe('variation_of')
  })

  it('aigc_reroll with prompt_delta generates a remix_of edge', async () => {
    const source = await placeGeneratedImage('a cat')
    const rerollTool = ctx.registered.get('aigc_reroll')!
    const result = await rerollTool.execute({
      source_element: source,
      patch: { prompt_delta: ', sitting on a chair' },
    }, execFor('s1')) as { relation: string; elements: Array<{ filePath: string }> }
    expect(result.relation).toBe('remix_of')
    expect(result.elements).toHaveLength(1)
    // The new element should have the patched prompt in its meta.originalRequest.body.prompt.
    const listTool = ctx.registered.get('aigc_canvas_list_elements')!
    const listed = await listTool.execute({}, execFor('s1')) as { elements: Array<{ filePath: string; meta?: { originalRequest?: { body?: { prompt?: string } } } }> }
    const rerolledEl = listed.elements.find(e => e.filePath === result.elements[0]!.filePath)!
    expect(rerolledEl.meta?.originalRequest?.body?.prompt).toBe('a cat, sitting on a chair')
  })

  it('aigc_reroll with prompt_replace generates a remix_of edge', async () => {
    const source = await placeGeneratedImage('a cat')
    const rerollTool = ctx.registered.get('aigc_reroll')!
    const result = await rerollTool.execute({
      source_element: source,
      patch: { prompt_replace: 'a dog' },
    }, execFor('s1')) as { relation: string }
    expect(result.relation).toBe('remix_of')
  })

  it('aigc_reroll with seed-only patch generates a variation_of edge', async () => {
    const source = await placeGeneratedImage('a cat')
    const rerollTool = ctx.registered.get('aigc_reroll')!
    const result = await rerollTool.execute({
      source_element: source,
      patch: { seed: 999 },
    }, execFor('s1')) as { relation: string }
    expect(result.relation).toBe('variation_of')
  })

  it('aigc_reroll with count=4 wires alternative_of between all variants', async () => {
    const source = await placeGeneratedImage('a cat')
    const rerollTool = ctx.registered.get('aigc_reroll')!
    const result = await rerollTool.execute({
      source_element: source,
      count: 4,
    }, execFor('s1')) as { elements: Array<{ filePath: string }>; relation: string }
    expect(result.elements).toHaveLength(4)
    expect(result.relation).toBe('variation_of')
    const listTool = ctx.registered.get('aigc_canvas_list_elements')!
    const listed = await listTool.execute({}, execFor('s1')) as { edges: Array<{ source: string; target: string; relation: string }> }
    // 4 variation_of edges (source → each variant) + 4×3=12 alternative_of edges (each pair).
    const varEdges = listed.edges.filter(e => e.relation === 'variation_of')
    expect(varEdges).toHaveLength(4)
    const altEdges = listed.edges.filter(e => e.relation === 'alternative_of')
    expect(altEdges.length).toBe(12) // complete graph K4
  })

  it('aigc_reroll caps count at 8', async () => {
    const source = await placeGeneratedImage('a cat')
    const rerollTool = ctx.registered.get('aigc_reroll')!
    const result = await rerollTool.execute({
      source_element: source,
      count: 100, // should be capped to 8
    }, execFor('s1')) as { elements: Array<{ filePath: string }> }
    expect(result.elements).toHaveLength(8)
  })

  it('aigc_reroll places variants to the right of the source (grid layout)', async () => {
    const source = await placeGeneratedImage('a cat')
    // Move the source to a known position for the layout assertion.
    const placeTool = ctx.registered.get('aigc_canvas_place')!
    void placeTool // source is already at (0,0) from placeGeneratedImage
    const rerollTool = ctx.registered.get('aigc_reroll')!
    const result = await rerollTool.execute({ source_element: source, count: 2 }, execFor('s1')) as {
      elements: Array<{ x: number; y: number }>
    }
    // Both variants should be to the right of the source (x > 0 + 240 + 20 = 260).
    for (const el of result.elements) {
      expect(el.x).toBeGreaterThanOrEqual(260)
    }
  })

  it('aigc_reroll preserves the patched body in the new element\'s meta.originalRequest (re-rerollable)', async () => {
    const source = await placeGeneratedImage('a cat')
    const rerollTool = ctx.registered.get('aigc_reroll')!
    const result = await rerollTool.execute({
      source_element: source,
      patch: { prompt_replace: 'a dog', seed: 7 },
    }, execFor('s1')) as { elements: Array<{ filePath: string }> }
    // The new variant should have its own originalRequest (so it can be re-rerolled).
    const listTool = ctx.registered.get('aigc_canvas_list_elements')!
    const listed = await listTool.execute({}, execFor('s1')) as { elements: Array<{ filePath: string; meta?: { originalRequest?: { body?: { prompt?: string; seed?: number } } } }> }
    const variant = listed.elements.find(e => e.filePath === result.elements[0]!.filePath)!
    expect(variant.meta?.originalRequest?.body?.prompt).toBe('a dog')
    expect(variant.meta?.originalRequest?.body?.seed).toBe(7)
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

// ── Request log (per docs/product/04-ux-reliability.md §3) ─────────────────
describe('request log', () => {
  let cwd: string
  let canvas: AigcCanvasService
  let ctx: MockTools
  let dispose: () => void

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aigc-log-'))
    canvas = createAigcCanvasService(() => cwd)
    ctx = mockCtx()
    clearLogEntries('s1')
    dispose = registerAll(ctx, [STUB_PROVIDER], canvas, cwd).dispose
  })

  afterEach(async () => {
    dispose()
    clearLogEntries('s1')
    await rm(cwd, { recursive: true, force: true })
  })

  it('aigc_http_request logs an entry on success', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    await httpTool.execute({ method: 'POST', path: '/v1/images/generations', json_body: { prompt: 'test' } }, execFor('s1'))
    const entries = getLogEntries('s1')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe('http')
    expect(entries[0]!.providerId).toBe('stub')
    expect(entries[0]!.method).toBe('POST')
    expect(entries[0]!.path).toBe('/v1/images/generations')
    expect(entries[0]!.status).toBe(200)
    expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(0)
    // The produced file path should be recorded for "locate on canvas".
    expect(entries[0]!.elementPath).toBeDefined()
    expect(entries[0]!.size).toBeGreaterThan(0)
  })

  it('aigc_http_request logs an entry on failure (non-2xx)', async () => {
    // Use a real provider with mocked fetch to simulate a failure.
    const failCtx = mockCtx()
    const failRegister = registerAll(failCtx, [REAL_PROVIDER], canvas, cwd)
    try {
      const fetchMock = vi.fn<typeof fetch>()
      fetchMock.mockResolvedValue(new Response('quota exceeded', { status: 429, headers: { 'content-type': 'text/plain' } }))
      vi.stubGlobal('fetch', fetchMock)
      const httpTool = failCtx.registered.get('aigc_http_request')!
      await httpTool.execute({ method: 'POST', path: '/v1/images/generations', json_body: { prompt: 'x' } }, execFor('s1'))
      const entries = getLogEntries('s1')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.status).toBe(429)
      expect(entries[0]!.error).toContain('quota exceeded')
      expect(entries[0]!.elementPath).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
      failRegister.dispose()
    }
  })

  it('aigc_http_request redacts the apiKey from logged request headers', async () => {
    // Use a real provider with header auth + mocked fetch.
    const headerProvider: ResolvedAigcProvider = {
      ...REAL_PROVIDER,
      id: 'header-auth',
      auth: { scheme: 'header', name: 'x-api-key' },
    }
    const headerCtx = mockCtx()
    const headerRegister = registerAll(headerCtx, [headerProvider], canvas, cwd)
    try {
      const fetchMock = vi.fn<typeof fetch>()
      fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
      vi.stubGlobal('fetch', fetchMock)
      const httpTool = headerCtx.registered.get('aigc_http_request')!
      // Pass an extra header that should NOT be redacted.
      await httpTool.execute({
        method: 'POST',
        path: '/v1/test',
        headers: { 'x-custom': 'visible', 'x-api-key': 'should-not-appear' },
        json_body: { prompt: 'x' },
      }, execFor('s1'))
      const entries = getLogEntries('s1')
      expect(entries).toHaveLength(1)
      const loggedHeaders = entries[0]!.requestHeaders!
      // The custom header survives.
      expect(loggedHeaders['x-custom']).toBe('visible')
      // The api key header is redacted.
      expect(loggedHeaders['x-api-key']).toBe('***')
      // The apiKey value must NOT appear anywhere in the logged entry.
      const serialized = JSON.stringify(entries[0])
      expect(serialized).not.toContain('sk-test')
    } finally {
      vi.unstubAllGlobals()
      headerRegister.dispose()
    }
  })

  it('redactSecrets redacts bearer Authorization + sensitive header names', () => {
    const provider: ResolvedAigcProvider = {
      ...REAL_PROVIDER,
      auth: { scheme: 'bearer', name: '' },
    }
    const result = redactSecrets(
      { Authorization: 'Bearer sk-secret', 'x-api-key': 'also-secret', 'content-type': 'application/json', 'x-token': 'tok' },
      undefined,
      provider,
    )
    expect(result.headers!['Authorization']).toBe('Bearer ***')
    expect(result.headers!['x-api-key']).toBe('***')
    expect(result.headers!['x-token']).toBe('***')
    expect(result.headers!['content-type']).toBe('application/json')
  })

  it('clearLogEntries wipes the session log', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    await httpTool.execute({ method: 'POST', path: '/v1/images/generations', json_body: { prompt: 'x' } }, execFor('s1'))
    expect(getLogEntries('s1')).toHaveLength(1)
    clearLogEntries('s1')
    expect(getLogEntries('s1')).toHaveLength(0)
  })

  it('log entries are isolated per session', async () => {
    const httpTool = ctx.registered.get('aigc_http_request')!
    await httpTool.execute({ method: 'POST', path: '/v1/images/generations', json_body: { prompt: 'x' } }, execFor('s1'))
    await httpTool.execute({ method: 'POST', path: '/v1/images/generations', json_body: { prompt: 'y' } }, execFor('s2'))
    expect(getLogEntries('s1')).toHaveLength(1)
    expect(getLogEntries('s2')).toHaveLength(1)
    expect(getLogEntries('s1')[0]!.path).toBe('/v1/images/generations')
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

  it('aigc_http_request uses EndpointSpec.response to process the response (spec-driven b64 extraction)', async () => {
    // Configure a provider with an EndpointSpec for /v1/images/generations using
    // a NON-OpenAI path (result.image instead of data[0].b64_json). The spec-driven
    // extraction path should decode the b64 from result.image and save it as PNG.
    const customProvider: ResolvedAigcProvider = {
      ...REAL_PROVIDER,
      id: 'custom-spec',
      endpoints: [{
        path: '/v1/images/generations',
        method: 'POST',
        capability: 't2i',
        response: { kind: 'b64_json_field', path: 'result.image' },
      }],
    }
    const customCtx = mockCtx()
    const register = registerAll(customCtx, [customProvider], canvas, cwd)
    try {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const b64 = pngBytes.toString('base64')
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ result: { image: b64 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      const tool = customCtx.registered.get('aigc_http_request')!
      const result = await tool.execute({
        provider_id: 'custom-spec',
        method: 'POST',
        path: '/v1/images/generations',
        json_body: { prompt: 'test' },
      }, execFor('s1')) as { ok: boolean; kind: string; content_type: string; file_path: string; file_size: number }
      expect(result.ok).toBe(true)
      expect(result.kind).toBe('image')
      expect(result.content_type).toBe('image/png')
      expect(result.file_path).toMatch(/\.png$/)
      expect(result.file_size).toBe(pngBytes.byteLength)
    } finally {
      register.dispose()
    }
  })
})
