/**
 * Per-session cost tracker: accumulates the cost of every aigc_http_request
 * call based on the provider's costPerCall / costPerKiloToken / costPerSecond
 * config. Per docs/product/04-ux-reliability.md §5.
 *
 * Per doc 06 decision 7: cost data comes from user-configured fixed costs
 * (costPerCall) + response-parsed costs (OpenAI usage fields) when available.
 * Not from rule-based calculation (costPerPixel etc.) — too much maintenance.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/cost-tracker
 */

/** One provider's cost config (subset of ResolvedAigcProvider). */
export interface ProviderCostConfig {
  /** Fixed cost per call in USD (0 when unknown). */
  costPerCall?: number
  /** Cost per 1k tokens in USD (for chat/transcription endpoints). */
  costPerKiloToken?: number
  /** Cost per second of video/audio in USD (for t2v/tts endpoints). */
  costPerSecond?: number
}

/** Per-session cost breakdown. */
export interface SessionCost {
  /** Total cost in USD across all providers. */
  total: number
  /** Cost by provider id. */
  byProvider: Record<string, number>
  /** Cost by capability (t2i/t2v/tts/...). */
  byCapability: Record<string, number>
  /** Number of billable calls. */
  callCount: number
}

/** Per-session cost storage. */
const costBySession = new Map<string, SessionCost>()

/** Get (or lazily create) the per-session cost tracker. */
function sessionCost(sessionId: string): SessionCost {
  let sc = costBySession.get(sessionId)
  if (sc === undefined) {
    sc = { total: 0, byProvider: {}, byCapability: {}, callCount: 0 }
    costBySession.set(sessionId, sc)
  }
  return sc
}

/**
 * Calculate the cost of one provider call based on the provider's cost config
 * + response info. Returns 0 when no cost config is available.
 */
export function calculateCallCost(
  config: ProviderCostConfig,
  responseInfo: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; durationSeconds?: number },
): number {
  // 1. Response-parsed cost (OpenAI usage) — most precise.
  if (config.costPerKiloToken !== undefined && responseInfo.usage?.total_tokens !== undefined) {
    return (responseInfo.usage.total_tokens / 1000) * config.costPerKiloToken
  }
  // 2. Per-second cost (video/audio duration).
  if (config.costPerSecond !== undefined && responseInfo.durationSeconds !== undefined) {
    return responseInfo.durationSeconds * config.costPerSecond
  }
  // 3. Fixed per-call cost (fallback).
  if (config.costPerCall !== undefined) {
    return config.costPerCall
  }
  return 0
}

/**
 * Record one call's cost into the session tracker.
 * Called by aigc_http_request after a successful provider call.
 */
export function recordCallCost(
  sessionId: string,
  providerId: string,
  capability: string | undefined,
  cost: number,
): void {
  if (cost <= 0) return
  const sc = sessionCost(sessionId)
  sc.total += cost
  sc.callCount += 1
  sc.byProvider[providerId] = (sc.byProvider[providerId] ?? 0) + cost
  if (capability !== undefined) {
    sc.byCapability[capability] = (sc.byCapability[capability] ?? 0) + cost
  }
}

/** Get the per-session cost summary (for the canvas header + log panel footer). */
export function getSessionCost(sessionId: string): SessionCost {
  return sessionCost(sessionId)
}

/** Clear the cost tracker for one session. */
export function clearSessionCost(sessionId: string): void {
  costBySession.delete(sessionId)
}
