/**
 * CompareView — floating overlay that lets the user compare 2-4 selected
 * canvas elements side by side and pick a winner.
 *
 * Per docs/product/04-ux-reliability.md §2:
 *  - All selected elements shown at the same scale, side by side
 *  - Each element shows: image/video, prompt, seed, cost, duration (from meta)
 *  - "Select as winner" button under each → calls setElementStatus(uuid,
 *    'ready', true) + archives the others
 *  - "Reject all" button → calls setElementStatus(uuid, 'rejected') for all
 *  - "Close" button → unmounts the overlay (handled by parent)
 *
 * The overlay is rendered as a fixed-position layer above the canvas
 * surface (z-index above the detail panel + log panel + toolbar). It
 * does NOT intercept canvas pointer events outside its own bounds.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/client/CompareView
 */
import { Component, createElement, useEffect, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import type { AigcElement, ElementStatus } from './api.js'
import { mediaUrlOf, setElementStatus } from './api.js'
import {
  formatCost,
  formatDurationShort,
  formatSeed,
  getElementCost,
  getElementDurationMs,
  getElementSeed,
} from './compare-helpers.js'
import css from './canvas.module.css'

/** Translation function type (from the DSH locale system). */
type Translate = (key: string) => string

/** Props for the compare view overlay. */
export interface CompareViewProps {
  /** Session id (used for the API calls + media URL construction). */
  sessionId: string
  /** Selected elements to compare (already validated to be 2-4 by the parent). */
  elements: readonly AigcElement[]
  /** Locale translate function. */
  t: Translate
  /** Called when the user clicks "Close" or presses Escape. */
  onClose: () => void
}

/**
 * The compare view overlay. Renders as a fixed-position layer above the
 * canvas. Winner/reject actions fire `setElementStatus` calls; the WS
 * push carries the authoritative state back into the canvas snapshot.
 */
export function CompareView({ sessionId, elements, t, onClose }: CompareViewProps): ReactNode {
  return createElement(CompareBoundary, { t, children: createElement(CompareViewInner, { sessionId, elements, t, onClose }) })
}

/** Inner component (wrapped by the boundary so a render error doesn't blank the canvas). */
function CompareViewInner({ sessionId, elements, t, onClose }: CompareViewProps): ReactNode {
  // Track which element (if any) the user just picked as winner, so we
  // can show a brief "archiving others…" state and disable buttons while
  // the WS push is in flight. Best-effort: failures are swallowed (the
  // next WS snapshot carries the authoritative state regardless).
  const [pendingWinner, setPendingWinner] = useState<string | undefined>(undefined)
  const [pendingReject, setPendingReject] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Close on Escape (per the doc's "Close" affordance — also lets keyboard
  // users dismiss the overlay).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * Pick one element as the winner: keep it as `ready` with the winner
   * flag, archive the others. Per doc 04 §2: "选 winner 后其他自动归档
   * (status = archived)".
   */
  const onPickWinner = async (winner: AigcElement): Promise<void> => {
    if (winner.uuid === undefined) return
    const winnerUuid = winner.uuid
    const losers = elements.filter(e => e.uuid !== undefined && e.uuid !== winnerUuid)
    setPendingWinner(winnerUuid)
    setError(null)
    try {
      // 1. Mark the winner: status stays 'ready', winner flag = true.
      await setElementStatus(sessionId, winnerUuid, 'ready', true)
      // 2. Archive the others. Fire-and-forget the parallel calls — the
      //    WS push carries the final state; we don't need to wait.
      await Promise.all(
        losers.map(e => setElementStatus(sessionId, e.uuid!, 'archived' as ElementStatus)),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPendingWinner(undefined)
    }
  }

  /**
   * Reject all: mark every selected element as `rejected`. Per doc 04 §2:
   * "全部否决 → 所有标 rejected".
   */
  const onRejectAll = async (): Promise<void> => {
    setPendingReject(true)
    setError(null)
    try {
      await Promise.all(
        elements.map(e => e.uuid !== undefined
          ? setElementStatus(sessionId, e.uuid, 'rejected')
          : Promise.resolve()),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPendingReject(false)
    }
  }

  // Header count: "已选 N 个" — the doc shows this on the canvas toolbar,
  // but it's also useful inside the overlay title for context.
  const count = elements.length

  return createElement(
    'div',
    {
      className: css.compareOverlay,
      // Stop wheel events from propagating to the canvas surface below
      // (the canvas zoom-on-wheel handler would otherwise zoom the canvas
      // while the user scrolls inside the compare view).
      onWheel: (e: React.WheelEvent<HTMLDivElement>) => e.stopPropagation(),
      // Stop pointer events from reaching the canvas surface (so dragging
      // inside the overlay doesn't pan the canvas).
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => e.stopPropagation(),
    },
    createElement(
      'div',
      { className: css.compareHeader },
      createElement('span', { className: css.compareTitle }, `${t('compareTitle')} (${count})`),
      createElement('button', {
        type: 'button',
        className: css.compareCloseButton,
        onClick: onClose,
        'aria-label': t('compareClose'),
      }, '×'),
    ),
    error !== null && createElement('div', { className: css.boundaryError }, error),
    createElement(
      'div',
      { className: css.compareGrid },
      ...elements.map(el => createElement(CompareCard, {
        key: el.uuid ?? el.filePath,
        element: el,
        sessionId,
        t,
        pending: pendingWinner === el.uuid || pendingReject,
        onPickWinner: () => { void onPickWinner(el) },
      })),
    ),
    createElement(
      'div',
      { className: css.compareFooter },
      createElement('button', {
        type: 'button',
        className: `${css.compareButtonDanger}`,
        onClick: () => { void onRejectAll() },
        disabled: pendingReject || pendingWinner !== undefined,
      }, t('compareRejectAll')),
      createElement('button', {
        type: 'button',
        className: css.compareButtonSecondary,
        onClick: onClose,
      }, t('compareClose')),
    ),
  )
}

/** One element card in the compare grid. */
function CompareCard(props: {
  element: AigcElement
  sessionId: string
  t: Translate
  pending: boolean
  onPickWinner: () => void
}): ReactNode {
  const { element: el, sessionId, t, pending, onPickWinner } = props
  const seed = getElementSeed(el)
  const cost = getElementCost(el)
  const durationMs = getElementDurationMs(el)
  // The card body height is determined by the tallest card in the row.
  // We use a fixed target media box so all cards line up — the media is
  // `object-fit: contain` so different aspect ratios still render fully.
  return createElement(
    'div',
    { className: css.compareCard },
    createElement(
      'div',
      { className: css.compareCardMedia },
      createElement(CompareMedia, { element: el, sessionId, t }),
    ),
    createElement(
      'div',
      { className: css.compareCardBody },
      el.promptText !== undefined && el.promptText !== ''
        ? createElement('pre', { className: css.comparePrompt }, el.promptText)
        : createElement('div', { className: css.comparePromptEmpty }, t('comparePrompt')),
      createElement(
        'div',
        { className: css.compareMetaRow },
        createElement('span', { className: css.compareMetaLabel }, `${t('compareSeed')}:`),
        createElement('span', { className: css.compareMetaValue }, formatSeed(seed)),
      ),
      createElement(
        'div',
        { className: css.compareMetaRow },
        createElement('span', { className: css.compareMetaLabel }, `${t('compareCost')}:`),
        createElement('span', { className: css.compareMetaValue }, formatCost(cost)),
      ),
      createElement(
        'div',
        { className: css.compareMetaRow },
        createElement('span', { className: css.compareMetaLabel }, `${t('compareDuration')}:`),
        createElement('span', { className: css.compareMetaValue }, formatDurationShort(durationMs)),
      ),
    ),
    createElement(
      'div',
      { className: css.compareCardFooter },
      createElement('button', {
        type: 'button',
        className: css.compareButtonPrimary,
        onClick: onPickWinner,
        disabled: pending || el.uuid === undefined,
        title: el.title,
      }, t('compareSelectWinner')),
    ),
  )
}

/** Renders the element's media (image / video / audio) at a fixed target size. */
function CompareMedia(props: { element: AigcElement; sessionId: string; t: Translate }): ReactNode {
  const { element: el, sessionId, t } = props
  if (el.kind === 'prompt') {
    // Prompts have no media; show the title as a centered text block so
    // the card still has visual presence in the compare row.
    return createElement('div', { className: css.compareMediaEmpty }, el.title)
  }
  if (el.uuid === undefined) {
    return createElement('div', { className: css.compareMediaEmpty }, t('compareNoMedia'))
  }
  const url = mediaUrlOf(sessionId, el.uuid)
  if (el.kind === 'image') {
    return createElement('img', {
      className: css.compareMediaImage,
      src: url,
      alt: el.title,
      loading: 'lazy',
      draggable: false,
    })
  }
  if (el.kind === 'video') {
    return createElement('video', {
      className: css.compareMediaVideo,
      src: url,
      controls: true,
      preload: 'metadata',
    })
  }
  // audio — native control inside the fixed-size media box
  return createElement('div', { className: css.compareMediaAudioWrap },
    createElement('audio', {
      className: css.compareMediaAudio,
      src: url,
      controls: true,
      preload: 'metadata',
    }),
  )
}

/** Error boundary so a render failure shows a strip instead of blanking the overlay. */
class CompareBoundary extends Component<{ children: ReactNode; t: Translate }, { error: string | null }> {
  override state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dsh-aigc-canvas] compare view error:', error, info.componentStack)
  }
  override render(): ReactNode {
    if (this.state.error !== null) {
      return createElement('div', { className: css.boundaryError, style: { margin: '8px' as unknown as CSSProperties['margin'] } }, `${this.props.t('loadError')}: ${this.state.error}`)
    }
    return this.props.children
  }
}
