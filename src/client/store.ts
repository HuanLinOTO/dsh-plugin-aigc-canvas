/**
 * Canvas view store: subscribes to the host push WebSocket for one session
 * and exposes a synchronous snapshot through useSyncExternalStore. Replays
 * the latest snapshot on reconnect; falls back to a one-shot HTTP fetch
 * when the WS is unavailable so a deployment without the upgrade route
 * still renders the canvas (with manual refresh).
 *
 * The store is per-session: the better-sidebar tab instantiates one per
 * scope.sessionId, and disposes it on tab close (the WS closes with it).
 */
import { deleteCanvasElement, fetchCanvas, moveCanvasElement, uploadCanvasFile, canvasWsUrl, type AigcCanvasState } from './api.js'

/** Empty canvas state used as the pre-load placeholder. */
function emptyState(sessionId: string): AigcCanvasState {
  return { sessionId, elements: [], edges: [] }
}

interface StoreOptions {
  sessionId: string
}

/** One store instance per tab activation. */
export class CanvasStore {
  /** The session id this store is bound to. */
  readonly sessionId: string
  private state: AigcCanvasState
  private listeners = new Set<() => void>()
  private ws: WebSocket | undefined
  private reconnectTimer: number | undefined
  private disposed = false
  private fetchAbort: AbortController | undefined

  constructor(private readonly opts: StoreOptions) {
    this.sessionId = opts.sessionId
    this.state = emptyState(opts.sessionId)
    // Kick off the initial HTTP fetch (gives a snapshot before the WS opens)
    // and the WS subscription (drives live updates).
    void this.refresh()
    this.openWs()
  }

  /** Snapshot reader for useSyncExternalStore. */
  getSnapshot = (): AigcCanvasState => this.state

  /** Subscribe listener; returns disposer. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Force a refresh (e.g. user clicked a refresh button). */
  async refresh(): Promise<void> {
    if (this.disposed) return
    this.fetchAbort?.abort()
    const ac = new AbortController()
    this.fetchAbort = ac
    try {
      const next = await fetchCanvas(this.opts.sessionId, ac.signal)
      if (!this.disposed) this.setState(next)
    } catch {
      // WS will catch up; the fetch is a best-effort priming read.
    }
  }

  /**
   * Persist a dragged element's new position. The authoritative snapshot
   * arrives over the WS push (the host notifies after persisting), so no
   * local state update is applied here.
   */
  async move(uuid: string, x: number, y: number): Promise<void> {
    if (this.disposed) return
    try {
      await moveCanvasElement(this.opts.sessionId, uuid, x, y)
    } catch {
      // Best-effort: the next WS snapshot carries the host's authoritative state.
    }
  }

  /** Delete an element (right-click → Delete). Best-effort; WS push catches up. */
  async deleteElement(uuid: string): Promise<void> {
    if (this.disposed) return
    try {
      await deleteCanvasElement(this.opts.sessionId, uuid)
    } catch {
      // Best-effort: the next WS snapshot carries the host's authoritative state.
    }
  }

  /** Upload a drag-dropped file and place it on the canvas. */
  async uploadFile(fileName: string, mediaBase64: string, opts?: { x?: number; y?: number }): Promise<void> {
    if (this.disposed) return
    try {
      await uploadCanvasFile(this.opts.sessionId, fileName, mediaBase64, opts)
    } catch {
      // Best-effort: the next WS snapshot carries the host's authoritative state.
    }
  }

  /** Tear down: close WS, abort any in-flight fetch, drop listeners. */
  dispose(): void {
    this.disposed = true
    this.fetchAbort?.abort()
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.ws !== undefined) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = undefined
    }
    this.listeners.clear()
  }

  private setState(next: AigcCanvasState): void {
    this.state = next
    for (const fn of [...this.listeners]) fn()
  }

  private openWs(): void {
    if (this.disposed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(canvasWsUrl(this.opts.sessionId))
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as AigcCanvasState
        if (parsed && typeof parsed.sessionId === 'string') this.setState(parsed)
      } catch {
        // Ignore malformed frames — the host only sends valid JSON snapshots.
      }
    }
    ws.onclose = () => {
      if (this.disposed) return
      this.ws = undefined
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      try { ws.close() } catch { /* close handler will run */ }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    if (this.reconnectTimer !== undefined) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      this.openWs()
    }, 2000)
  }
}
