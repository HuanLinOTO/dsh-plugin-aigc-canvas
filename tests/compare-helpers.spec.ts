/**
 * Unit tests for the compare-view pure helpers (per
 * docs/product/04-ux-reliability.md §2).
 *
 * The helpers tolerate:
 *  - `meta` being absent entirely (returns undefined → UI shows "—")
 *  - non-numeric values for numeric fields (string-encoded numbers OK)
 *  - alternate key names (random_seed / costUsd / durationSeconds / duration)
 *
 * These are pure functions → no React, no DOM, no need for jsdom.
 */
import { describe, expect, it } from 'vitest'
import {
  formatCost,
  formatDurationShort,
  formatSeed,
  getElementCost,
  getElementDurationMs,
  getElementSeed,
  readNumber,
} from '../src/client/compare-helpers.js'
import type { AigcElement } from '../src/client/api.js'

/** Build a minimal element with a meta field (helper). */
function el(kind: AigcElement['kind'], meta?: Record<string, unknown>): AigcElement {
  return {
    filePath: '/path/to/el',
    kind,
    title: 'test',
    x: 0,
    y: 0,
    createdAt: 0,
    producedBy: 'test',
    ...(meta !== undefined ? { meta } : {}),
  }
}

describe('readNumber', () => {
  it('returns the number when the field is a finite number', () => {
    expect(readNumber({ seed: 42 }, 'seed')).toBe(42)
    expect(readNumber({ seed: 0 }, 'seed')).toBe(0)
    expect(readNumber({ seed: -1.5 }, 'seed')).toBe(-1.5)
  })
  it('parses string-encoded numbers', () => {
    expect(readNumber({ seed: '42' }, 'seed')).toBe(42)
    expect(readNumber({ seed: '3.14' }, 'seed')).toBe(3.14)
  })
  it('returns undefined for non-numeric strings', () => {
    expect(readNumber({ seed: 'abc' }, 'seed')).toBeUndefined()
    expect(readNumber({ seed: '' }, 'seed')).toBeUndefined()
  })
  it('returns undefined for missing / null / undefined / object / array values', () => {
    expect(readNumber({ seed: null }, 'seed')).toBeUndefined()
    expect(readNumber({ seed: undefined }, 'seed')).toBeUndefined()
    expect(readNumber({}, 'seed')).toBeUndefined()
    expect(readNumber({ seed: { a: 1 } }, 'seed')).toBeUndefined()
    expect(readNumber({ seed: [1, 2] }, 'seed')).toBeUndefined()
    expect(readNumber({ seed: true }, 'seed')).toBeUndefined()
  })
  it('returns undefined when meta itself is undefined', () => {
    expect(readNumber(undefined, 'seed')).toBeUndefined()
  })
  it('rejects NaN and Infinity', () => {
    expect(readNumber({ seed: Number.NaN }, 'seed')).toBeUndefined()
    expect(readNumber({ seed: Number.POSITIVE_INFINITY }, 'seed')).toBeUndefined()
    expect(readNumber({ seed: Number.NEGATIVE_INFINITY }, 'seed')).toBeUndefined()
  })
})

describe('getElementSeed', () => {
  it('reads the canonical "seed" key', () => {
    expect(getElementSeed(el('image', { seed: 42 }))).toBe(42)
  })
  it('falls back to "random_seed"', () => {
    expect(getElementSeed(el('image', { random_seed: 7 }))).toBe(7)
  })
  it('prefers "seed" over "random_seed"', () => {
    expect(getElementSeed(el('image', { seed: 1, random_seed: 2 }))).toBe(1)
  })
  it('returns undefined when meta is absent', () => {
    expect(getElementSeed(el('image'))).toBeUndefined()
  })
  it('returns undefined when neither key is present', () => {
    expect(getElementSeed(el('image', { size: '1024x1024' }))).toBeUndefined()
  })
})

describe('getElementCost', () => {
  it('reads the "cost" key', () => {
    expect(getElementCost(el('image', { cost: 0.02 }))).toBe(0.02)
  })
  it('falls back to "costUsd"', () => {
    expect(getElementCost(el('image', { costUsd: 0.05 }))).toBe(0.05)
  })
  it('prefers "cost" over "costUsd"', () => {
    expect(getElementCost(el('image', { cost: 0.01, costUsd: 0.02 }))).toBe(0.01)
  })
  it('returns undefined when meta is absent', () => {
    expect(getElementCost(el('image'))).toBeUndefined()
  })
})

describe('getElementDurationMs', () => {
  it('reads durationMs directly', () => {
    expect(getElementDurationMs(el('image', { durationMs: 3400 }))).toBe(3400)
  })
  it('converts durationSeconds to ms', () => {
    expect(getElementDurationMs(el('video', { durationSeconds: 5 }))).toBe(5000)
  })
  it('falls back to "duration" (image → ms as-is)', () => {
    expect(getElementDurationMs(el('image', { duration: 200 }))).toBe(200)
  })
  it('falls back to "duration" (video → seconds → ms)', () => {
    expect(getElementDurationMs(el('video', { duration: 5 }))).toBe(5000)
  })
  it('falls back to "duration" (audio → seconds → ms)', () => {
    expect(getElementDurationMs(el('audio', { duration: 3 }))).toBe(3000)
  })
  it('prefers durationMs over durationSeconds and duration', () => {
    expect(getElementDurationMs(el('image', { durationMs: 100, durationSeconds: 1, duration: 50 }))).toBe(100)
  })
  it('prefers durationSeconds over duration', () => {
    expect(getElementDurationMs(el('image', { durationSeconds: 1, duration: 50 }))).toBe(1000)
  })
  it('returns undefined when meta is absent', () => {
    expect(getElementDurationMs(el('image'))).toBeUndefined()
  })
})

describe('formatCost', () => {
  it('renders a USD value as $X.XX', () => {
    expect(formatCost(0.02)).toBe('$0.02')
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(0)).toBe('$0.00')
  })
  it('uses 4 decimal places for tiny costs (< $0.01)', () => {
    expect(formatCost(0.001)).toBe('$0.0010')
    expect(formatCost(0.0001)).toBe('$0.0001')
  })
  it('renders "—" when undefined', () => {
    expect(formatCost(undefined)).toBe('—')
  })
})

describe('formatDurationShort', () => {
  it('renders sub-second durations as "Xms"', () => {
    expect(formatDurationShort(200)).toBe('200ms')
    expect(formatDurationShort(999)).toBe('999ms')
  })
  it('renders >= 1s durations as "X.Xs"', () => {
    expect(formatDurationShort(1000)).toBe('1.0s')
    expect(formatDurationShort(3400)).toBe('3.4s')
    expect(formatDurationShort(65000)).toBe('65.0s')
  })
  it('renders "—" when undefined', () => {
    expect(formatDurationShort(undefined)).toBe('—')
  })
})

describe('formatSeed', () => {
  it('renders the seed as a string', () => {
    expect(formatSeed(42)).toBe('42')
    expect(formatSeed(0)).toBe('0')
  })
  it('renders "—" when undefined', () => {
    expect(formatSeed(undefined)).toBe('—')
  })
})
