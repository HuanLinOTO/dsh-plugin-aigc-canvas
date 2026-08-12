/**
 * Unit tests for the wire helpers: readJsonBody, writeOk/writeError,
 * requireString, optionalStringArray. The HTTP req/res are mocked with
 * minimal in-memory sinks.
 */
import { describe, expect, it } from 'vitest'
import { EventEmitter, PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AigcError,
  readJsonBody,
  writeJson,
  writeOk,
  writeError,
  requireString,
  optionalStringArray,
} from '../src/wire.js'

/** Build a fake IncomingMessage with a body. */
function fakeReq(body: string | Buffer): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage
  req.headers = {}
  if (typeof body === 'string') req.end(body)
  else req.end(body)
  return req
}

/** Build a fake ServerResponse that captures writes.
 * Returns an object whose `status` and `headers` are live properties
 * (not destructured copies) so the test can read them after writeHead runs.
 */
function fakeRes(): { res: ServerResponse; chunks: Buffer[]; status: () => number; headers: () => Record<string, string | string[]> } {
  const chunks: Buffer[] = []
  const state = { status: 0, headers: {} as Record<string, string | string[]> }
  const res = {
    writeHead(status: number, headers?: Record<string, string | string[]>): void {
      state.status = status
      if (headers !== undefined) Object.assign(state.headers, headers)
    },
    end(chunk?: unknown): void {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    },
  } as unknown as ServerResponse
  return { res, chunks, status: () => state.status, headers: () => state.headers }
}

describe('readJsonBody', () => {
  it('parses a JSON object body', async () => {
    const req = fakeReq('{"a":1}')
    await expect(readJsonBody(req)).resolves.toEqual({ a: 1 })
  })

  it('returns {} for an empty body', async () => {
    const req = fakeReq('')
    await expect(readJsonBody(req)).resolves.toEqual({})
  })

  it('throws AigcError on malformed JSON', async () => {
    const req = fakeReq('{not json')
    await expect(readJsonBody(req)).rejects.toThrow(AigcError)
  })

  it('throws AigcError when the body exceeds 1 MiB', async () => {
    const big = Buffer.alloc((1 << 20) + 10, 0x61)  // 'a' * (1MiB + 10)
    const req = fakeReq(big)
    await expect(readJsonBody(req)).rejects.toThrow('request body too large')
  })
})

describe('writeJson / writeOk / writeError', () => {
  it('writeJson writes status + JSON body', () => {
    const fr = fakeRes()
    writeJson(fr.res, 201, { ok: true })
    expect(fr.status()).toBe(201)
    expect(fr.headers()['content-type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(Buffer.concat(fr.chunks).toString('utf8'))).toEqual({ ok: true })
  })

  it('writeOk wraps the value in { ok: true, value }', () => {
    const fr = fakeRes()
    writeOk(fr.res, { a: 1 })
    expect(JSON.parse(Buffer.concat(fr.chunks).toString('utf8'))).toEqual({ ok: true, value: { a: 1 } })
  })

  it('writeError maps AigcError to its wire code + status', () => {
    const fr = fakeRes()
    writeError(fr.res, new AigcError('bad-request', 'nope', 400))
    expect(fr.status()).toBe(400)
    const parsed = JSON.parse(Buffer.concat(fr.chunks).toString('utf8'))
    expect(parsed).toEqual({ ok: false, error: { code: 'bad-request', message: 'nope' } })
  })

  it('writeError wraps unknown errors as internal/500', () => {
    const fr = fakeRes()
    writeError(fr.res, new Error('boom'))
    expect(fr.status()).toBe(500)
    const parsed = JSON.parse(Buffer.concat(fr.chunks).toString('utf8'))
    expect(parsed.error.code).toBe('internal')
    expect(parsed.error.message).toBe('boom')
  })
})

describe('requireString', () => {
  it('returns the value when it is a non-empty string', () => {
    expect(requireString({ a: 'x' }, 'a')).toBe('x')
  })

  it('throws AigcError when the value is missing', () => {
    expect(() => requireString({}, 'a')).toThrow(AigcError)
  })

  it('throws AigcError when the value is an empty string', () => {
    expect(() => requireString({ a: '' }, 'a')).toThrow(AigcError)
  })

  it('throws AigcError when the value is not a string', () => {
    expect(() => requireString({ a: 1 }, 'a')).toThrow(AigcError)
  })
})

describe('optionalStringArray', () => {
  it('returns [] when the field is absent', () => {
    expect(optionalStringArray({}, 'xs')).toEqual([])
  })

  it('returns the array when all items are non-empty strings', () => {
    expect(optionalStringArray({ xs: ['a', 'b'] }, 'xs')).toEqual(['a', 'b'])
  })

  it('throws AigcError when the value is not an array', () => {
    expect(() => optionalStringArray({ xs: 'a' }, 'xs')).toThrow(AigcError)
  })

  it('throws AigcError when an item is empty or non-string', () => {
    expect(() => optionalStringArray({ xs: ['a', ''] }, 'xs')).toThrow(AigcError)
    expect(() => optionalStringArray({ xs: ['a', 1] }, 'xs')).toThrow(AigcError)
  })
})
