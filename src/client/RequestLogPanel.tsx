/**
 * Floating request log panel: shows every aigc_http_request + aigc_media_edit
 * call (success or failure) so the user can debug failed generations from the
 * canvas UI. Per docs/product/04-ux-reliability.md §3.
 *
 * Features:
 *  - Toggle button in the canvas header (shows the entry count badge)
 *  - Floating panel (right side, like the detail panel) with the entry list
 *  - Each entry: timestamp + type icon + provider/path + status + duration + size
 *  - Click an entry to expand details (request headers/body + response preview;
 *    apiKey is already redacted on the host side)
 *  - "Clear" button wipes the session log
 *  - Failed entries (status >= 400) are highlighted in red
 *  - "Locate on canvas" button pans to the element produced by the request
 *    (when elementPath is set) — wired through a callback prop
 *
 * The panel polls /aigc-canvas/api/logs.list every 2s when open (lightweight;
 * avoids WS protocol changes). The host caps at 200 entries per session.
 */
import { Component, createElement, useEffect, useState, type ReactNode, type ErrorInfo } from 'react'
import type { RequestLogEntry } from './api.js'
import { fetchRequestLog, clearRequestLog } from './api.js'
import css from './canvas.module.css'

/** Translate function type (from the DSH locale system). */
type Translate = (key: string) => string

/** Props for the log panel. */
export interface RequestLogPanelProps {
  /** Session id (used for the API calls). */
  sessionId: string
  /** Locale translate function. */
  t: Translate
  /** Callback to pan the canvas to one element (by filePath). */
  locateElement: (filePath: string) => void
}

/** Format a timestamp as HH:MM:SS.mmm. */
function formatTime(ms: number): string {
  const d = new Date(ms)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const millis = String(d.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${millis}`
}

/** Format a byte size human-readably. */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '-'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Format a duration in ms. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** One collapsible log entry row. */
class LogEntryRow extends Component<{
  entry: RequestLogEntry
  t: Translate
  locateElement: (filePath: string) => void
}, { expanded: boolean }> {
  override state = { expanded: false }

  override render(): ReactNode {
    const { entry, t, locateElement } = this.props
    const failed = entry.status >= 400 || entry.error !== undefined
    const label = entry.type === 'http'
      ? `${entry.method ?? '?'} ${entry.path ?? '?'}`
      : `ffmpeg: ${entry.operation ?? '?'}`
    const provider = entry.providerId !== undefined ? `  ${entry.providerId}` : ''
    return createElement('div', { className: css.logRow },
      createElement('button', {
        type: 'button',
        className: `${css.logRowHeader} ${failed ? css.logRowFailed : ''}`,
        onClick: () => this.setState({ expanded: !this.state.expanded }),
      },
        createElement('span', { className: css.logTime }, formatTime(entry.timestamp)),
        createElement('span', { className: css.logLabel }, `${label}${provider}`),
        createElement('span', { className: css.logStatus }, String(entry.status)),
        createElement('span', { className: css.logDuration }, formatDuration(entry.durationMs)),
        createElement('span', { className: css.logSize }, formatSize(entry.size)),
        createElement('span', { className: css.logExpand }, this.state.expanded ? '▼' : '▶'),
      ),
      this.state.expanded && createElement('div', { className: css.logDetail },
        entry.error !== undefined && createElement('div', { className: css.logError }, `${t('logError')}: ${entry.error}`),
        entry.requestBodyPreview !== undefined && createElement('div', { className: css.logDetailBlock },
          createElement('span', { className: css.logDetailLabel }, t('logRequestBody')),
          createElement('pre', { className: css.logDetailPre }, entry.requestBodyPreview),
        ),
        entry.requestHeaders !== undefined && createElement('div', { className: css.logDetailBlock },
          createElement('span', { className: css.logDetailLabel }, t('logRequestHeaders')),
          createElement('pre', { className: css.logDetailPre }, JSON.stringify(entry.requestHeaders, null, 2)),
        ),
        entry.responseBodyPreview !== undefined && createElement('div', { className: css.logDetailBlock },
          createElement('span', { className: css.logDetailLabel }, t('logResponseBody')),
          createElement('pre', { className: css.logDetailPre }, entry.responseBodyPreview),
        ),
        entry.elementPath !== undefined && createElement('div', { className: css.logDetailBlock },
          createElement('span', { className: css.logDetailLabel }, t('logProducedFile')),
          createElement('code', { className: css.logFilePath }, entry.elementPath),
          createElement('button', {
            type: 'button',
            className: css.logLocateButton,
            onClick: () => locateElement(entry.elementPath!),
          }, t('logLocate')),
        ),
      ),
    )
  }
}

/** Error boundary so a render failure in the panel doesn't blank the canvas. */
class LogBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dsh-aigc-canvas] log panel error:', error, info.componentStack)
  }
  override render(): ReactNode {
    if (this.state.error !== null) {
      return createElement('div', { className: css.boundaryError }, `log panel: ${this.state.error}`)
    }
    return this.props.children
  }
}

/**
 * The request log panel. Renders as a floating panel on the right side of
 * the canvas. Polls the host every 2s for new entries while open.
 */
export function RequestLogPanel({ sessionId, t, locateElement }: RequestLogPanelProps): ReactNode {
  const [entries, setEntries] = useState<RequestLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const result = await fetchRequestLog(sessionId)
        if (!cancelled) {
          setEntries([...result.entries])
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void poll()
    const timer = setInterval(poll, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sessionId])

  const onClear = async (): Promise<void> => {
    try {
      await clearRequestLog(sessionId)
      setEntries([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return createElement(LogBoundary, null,
    createElement('div', { className: css.logPanel },
      createElement('div', { className: css.logPanelHeader },
        createElement('span', { className: css.logPanelTitle }, `${t('logTitle')} (${entries.length})`),
        createElement('button', {
          type: 'button',
          className: css.logPanelClear,
          onClick: () => { void onClear() },
          disabled: entries.length === 0,
        }, t('logClear')),
      ),
      error !== null && createElement('div', { className: css.boundaryError }, `${t('logError')}: ${error}`),
      loading && entries.length === 0
        ? createElement('div', { className: css.empty }, t('logLoading'))
        : entries.length === 0
          ? createElement('div', { className: css.empty }, t('logEmpty'))
          : createElement('div', { className: css.logList },
              ...[...entries].reverse().map(entry =>
                createElement(LogEntryRow, {
                  key: entry.id,
                  entry,
                  t,
                  locateElement,
                }),
              ),
            ),
    ),
  )
}
