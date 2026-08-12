/**
 * Pure helpers for the compare view (per docs/product/04-ux-reliability.md §2).
 *
 * The canvas element's `meta` is a free-form JSON object the agent writes
 * when placing a generated asset. Common keys seen in the wild:
 *   - `seed`           — the generation seed (integer)
 *   - `size`           — image/video size string (e.g. "1024x1024")
 *   - `durationSeconds`— video/audio length (number; host-written)
 *   - `cost`           — USD cost of the call (number; host-written when
 *                       cost tracking is wired into the placement path)
 *   - `costUsd`        — alternate key some agents use
 *   - `durationMs`     — wall-clock duration of the provider call (number)
 *
 * These helpers tolerate missing keys, wrong types, and `meta` being
 * absent entirely — they return `undefined` so the UI can render "—".
 *
 * @module @dsh-external/dsh-aigc-canvas/client/compare-helpers
 */
import type { AigcElement } from './api.js'

/**
 * Read a numeric field from a free-form meta object, tolerating:
 *  - missing key
 *  - non-numeric value (string-encoded numbers are accepted; everything
 *    else returns undefined)
 *  - `null` / `undefined`
 *
 * Strings are accepted because the agent sometimes writes `"seed": "42"`
 * (JSON-object values sneak through as strings when the model wraps them
 * in quotes).
 */
export function readNumber(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  if (meta === undefined) return undefined
  const v = meta[key]
  if (v === null || v === undefined) return undefined
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n) && v.trim() !== '') return n
  }
  return undefined
}

/**
 * Extract the generation seed from an element's meta.
 *
 * Looks at `seed` (the canonical key) and falls back to `random_seed`
 * (some providers use that name). Returns undefined when neither is a
 * finite number.
 */
export function getElementSeed(el: AigcElement): number | undefined {
  const m = el.meta
  if (m === undefined) return undefined
  return readNumber(m, 'seed') ?? readNumber(m, 'random_seed')
}

/**
 * Extract the USD cost of producing one element from its meta.
 *
 * Looks at `cost`, then `costUsd`. Returns undefined when neither is a
 * finite number (the agent doesn't always set this — the host's
 * cost-tracker is the source of truth, but it isn't yet written back
 * into meta on placement).
 */
export function getElementCost(el: AigcElement): number | undefined {
  const m = el.meta
  if (m === undefined) return undefined
  return readNumber(m, 'cost') ?? readNumber(m, 'costUsd')
}

/**
 * Extract the wall-clock duration (in ms) of producing one element.
 *
 * Looks at `durationMs` (host convention) and falls back to
 * `durationSeconds` × 1000 (some agents write the duration in seconds).
 * Returns undefined when neither is set.
 */
export function getElementDurationMs(el: AigcElement): number | undefined {
  const m = el.meta
  if (m === undefined) return undefined
  const ms = readNumber(m, 'durationMs')
  if (ms !== undefined) return ms
  const seconds = readNumber(m, 'durationSeconds')
  if (seconds !== undefined) return seconds * 1000
  // Some agents write just `duration` and expect the unit to be inferred
  // from the kind (video → seconds, audio → seconds, image → ms). Treat
  // `duration` as ms for images and seconds for video/audio (matches the
  // doc 04 §2 mock-up which shows "3.4s" for image generations — that
  // is actually the wall-clock time, not the media length, so ms is
  // correct for images).
  const raw = readNumber(m, 'duration')
  if (raw === undefined) return undefined
  if (el.kind === 'video' || el.kind === 'audio') return raw * 1000
  return raw
}

/** Format a USD cost as a short `$X.XX` string, or "—" when unknown. */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return '—'
  // 0 is a real value (free call) — render as $0.00, not a tiny cost.
  if (usd === 0) return '$0.00'
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** Format a duration in ms as `X.Xs` (or `XXXms` when < 1s). Returns "—" when undefined. */
export function formatDurationShort(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Format a seed value (integer) as a string, or "—" when undefined. */
export function formatSeed(seed: number | undefined): string {
  if (seed === undefined) return '—'
  return String(seed)
}
