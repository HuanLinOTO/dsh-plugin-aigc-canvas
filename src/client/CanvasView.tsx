/**
 * The infinite canvas view: a free, pannable + zoomable surface where
 * elements live at arbitrary world positions (x, y) and edges render as
 * smooth curves between right/left ports.
 *
 * Interactions:
 *  - drag an element: moves it (persisted via the canvas.move API on release)
 *  - drag the background: pans the viewport
 *  - wheel: zooms around the cursor (clamped 0.2×–4×)
 *  - zoom slider / +/- buttons in the header: zoom from center
 *  - minimap (bottom-right): click/drag to pan; shows element outlines + viewport frame
 *  - double-click an element: opens the detail panel (prompt + params + path)
 *
 * The WS push delivers authoritative snapshots; dragged positions are
 * applied locally as drafts during the gesture and confirmed by the push
 * (the host notifies after persisting the move).
 */
import { Component, createElement, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ErrorInfo, type ReactNode, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ChangeEvent as ReactChangeEvent } from 'react'
import type { AigcCanvasState, AigcEdge, AigcElement } from './api.js'
import { CanvasStore } from './store.js'
import { CanvasNode } from './CanvasNode.js'
import css from './canvas.module.css'

/** Translation function type (from the DSH locale system). */
type Translate = (key: string) => string

/** Error boundary so a render failure shows a strip instead of blanking. */
class CanvasBoundary extends Component<{ children: ReactNode; t: Translate }, { error: string | null }> {
  override state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dsh-aigc-canvas] render error:', error, info.componentStack)
  }
  override render(): ReactNode {
    if (this.state.error !== null) {
      return createElement('div', { className: css.boundaryError }, `${this.props.t('loadError')}: ${this.state.error}`)
    }
    return this.props.children
  }
}

/** Viewport state: world→screen is `screen = world * scale + (x, y)`. */
interface Viewport {
  x: number
  y: number
  scale: number
}

const MIN_SCALE = 0.2
const MAX_SCALE = 4

/** Fixed node box for edge anchoring (world units). Must match CSS .nodeBox width. */
const NODE_W = 240
const NODE_H = 110

/** Zoom at the cursor position, keeping the world point under the cursor fixed. */
function zoomAt(viewport: Viewport, cx: number, cy: number, factor: number): Viewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewport.scale * factor))
  const worldX = (cx - viewport.x) / viewport.scale
  const worldY = (cy - viewport.y) / viewport.scale
  return { scale, x: cx - worldX * scale, y: cy - worldY * scale }
}

/** Build a uuid → element map. */
function elementMap(elements: readonly AigcElement[]): Map<string, AigcElement> {
  const map = new Map<string, AigcElement>()
  for (const el of elements) {
    if (el.uuid !== undefined) map.set(el.uuid, el)
  }
  return map
}

/** Position resolver: returns draft position if dragging, else the element's own. */
type PosResolver = (uuid: string) => { x: number; y: number } | undefined

/** Port radius (the small circle drawn at each connection point). */
const PORT_R = 5

/**
 * One smooth-curve edge: exits the source's right-center port, curves
 * through two control points, enters the target's left-center port.
 * Drawn as an SVG cubic-bezier path + two port circles + an arrowhead.
 *
 * The control points sit on the horizontal axis at a fixed offset from
 * each port so the curve bows out smoothly regardless of distance —
 * looks like a relaxed S when the ports are vertically offset.
 *
 * Uses the position resolver so the edge follows live drag positions
 * (drafts) in real time, not just the persisted snapshot.
 */
function renderEdge(edge: AigcEdge, resolvePos: PosResolver): ReactNode {
  const srcPos = resolvePos(edge.source)
  const tgtPos = resolvePos(edge.target)
  if (srcPos === undefined || tgtPos === undefined) return null
  // Source port: right-center of the source card.
  const sx = srcPos.x + NODE_W
  const sy = srcPos.y + NODE_H / 2
  // Target port: left-center of the target card.
  const tx = tgtPos.x
  const ty = tgtPos.y + NODE_H / 2
  // Control-point offset: half the horizontal gap, clamped so short
  // gaps still bow nicely and very long gaps don't over-extend.
  const dx = Math.abs(tx - sx)
  const offset = Math.max(40, Math.min(dx * 0.5, 160))
  // Cubic bezier: C1 to the right of source, C2 to the left of target.
  const c1x = sx + offset
  const c1y = sy
  const c2x = tx - offset
  const c2y = ty
  const d = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`
  // Arrowhead pointing right (into the target port).
  const arrow = 9
  const wing = arrow * 0.55
  const baseX = tx - arrow
  const ly = ty - wing
  const ry = ty + wing
  const arrowPath = `M ${tx} ${ty} L ${baseX} ${ly} L ${baseX} ${ry} Z`
  return createElement('g', { key: `${edge.source}:${edge.target}` },
    createElement('path', { d, className: css.edgeLine, fill: 'none' }),
    createElement('path', { d: arrowPath, className: css.edgeArrow }),
    createElement('circle', { cx: sx, cy: sy, r: PORT_R, className: css.edgePort }),
    createElement('circle', { cx: tx, cy: ty, r: PORT_R, className: css.edgePort }),
  )
}

export interface CanvasViewProps {
  store: CanvasStore
  t: Translate
}

/**
 * The infinite canvas view.
 * @param props - store + locale translate.
 * @returns the canvas element.
 */
export function CanvasView({ store, t }: CanvasViewProps): ReactNode {
  const state: AigcCanvasState = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  const [drafts, setDrafts] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map())
  const [selected, setSelected] = useState<AigcElement | undefined>(undefined)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; uuid: string } | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<{ x: number; y: number } | undefined>(undefined)
  const [uploading, setUploading] = useState(false)
  const surfaceRef = useRef<HTMLElement | null>(null)

  // Track the previous snapshot's element uuids so we can detect when new
  // elements appear (model just placed something) and pan the viewport to
  // bring the newest one into view at "center-left" of the visible area.
  const prevUuidsRef = useRef<Set<string>>(new Set())

  // Pan gesture (drag on empty background).
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; orig: Viewport } | null>(null)
  // Element drag gesture.
  const dragRef = useRef<{ pointerId: number; uuid: string; startX: number; startY: number; origX: number; origY: number } | null>(null)

  // Wheel: zooms around the cursor (clamped 0.2×–4×). Pan is via
  // dragging the background. Needs a non-passive listener.
  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = surface.getBoundingClientRect()
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      setViewport(prev => zoomAt(prev, cx, cy, factor))
    }
    surface.addEventListener('wheel', onWheel, { passive: false })
    return () => surface.removeEventListener('wheel', onWheel)
  }, [])

  // Clean up stale drafts: once the persisted snapshot confirms an
  // element's position matches its draft, the draft is no longer needed
  // (posOf will return the persisted position, which is the same). This
  // prevents drafts from accumulating indefinitely and ensures that a
  // subsequent drag of the same element starts from the right position.
  useEffect(() => {
    if (drafts.size === 0) return
    const lookup = elementMap(state.elements)
    const stale: string[] = []
    for (const [uuid, draftPos] of drafts) {
      const el = lookup.get(uuid)
      if (el !== undefined && el.x === draftPos.x && el.y === draftPos.y) {
        stale.push(uuid)
      }
    }
    if (stale.length > 0) {
      setDrafts(prev => {
        const next = new Map(prev)
        for (const uuid of stale) next.delete(uuid)
        return next
      })
    }
  }, [state, drafts])

  // Auto-pan to newly placed elements. When the snapshot gains an element
  // the model just placed it; if it isn't visible in the current viewport,
  // pan JUST ENOUGH to bring it into view (with a margin). Unlike the old
  // center-at-25%/40% approach, this keeps existing elements visible when
  // a vertical column grows downward — only the minimal offset is applied.
  useEffect(() => {
    if (panRef.current !== null || dragRef.current !== null) return
    const surface = surfaceRef.current
    if (surface === null) return
    const prev = prevUuidsRef.current
    let newest: AigcElement | undefined
    for (const el of state.elements) {
      if (el.uuid !== undefined && !prev.has(el.uuid)) {
        newest = el
      }
    }
    const nextUuids = new Set<string>()
    for (const el of state.elements) {
      if (el.uuid !== undefined) nextUuids.add(el.uuid)
    }
    prevUuidsRef.current = nextUuids
    if (newest === undefined) return
    const rect = surface.getBoundingClientRect()
    const margin = 32
    const screenX = newest.x * viewport.scale + viewport.x
    const screenY = newest.y * viewport.scale + viewport.y
    const elemW = NODE_W * viewport.scale
    const elemH = NODE_H * viewport.scale
    let panX = 0
    let panY = 0
    // Below visible area → pan down just enough.
    if (screenY + elemH > rect.height - margin) {
      panY = (screenY + elemH) - (rect.height - margin)
    }
    // Above visible area → pan up just enough.
    if (screenY < margin) {
      panY = screenY - margin
    }
    // Right of visible area → pan right just enough.
    if (screenX + elemW > rect.width - margin) {
      panX = (screenX + elemW) - (rect.width - margin)
    }
    // Left of visible area → pan left just enough.
    if (screenX < margin) {
      panX = screenX - margin
    }
    if (panX !== 0 || panY !== 0) {
      setViewport(prev => ({ ...prev, x: prev.x - panX, y: prev.y - panY }))
    }
  }, [state, viewport.scale])

  // Track the surface dimensions for the minimap viewport frame.
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null) return
    const update = (): void => {
      const rect = surface.getBoundingClientRect()
      setSurfaceSize({ width: rect.width, height: rect.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  /** Zoom to a target scale, keeping the center of the viewport fixed. */
  const zoomToCenter = (newScale: number): void => {
    const surface = surfaceRef.current
    if (surface === null) return
    const rect = surface.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    setViewport(prev => {
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale))
      const worldX = (cx - prev.x) / prev.scale
      const worldY = (cy - prev.y) / prev.scale
      return { scale: s, x: cx - worldX * s, y: cy - worldY * s }
    })
  }

  const onSurfacePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (dragRef.current !== null) return
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      orig: viewport,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onSurfacePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const pan = panRef.current
    if (pan !== null && pan.pointerId === event.pointerId) {
      setViewport({
        ...pan.orig,
        x: pan.orig.x + (event.clientX - pan.startX),
        y: pan.orig.y + (event.clientY - pan.startY),
      })
      return
    }
    const drag = dragRef.current
    if (drag !== null && drag.pointerId === event.pointerId) {
      setDrafts(prev => {
        const next = new Map(prev)
        next.set(drag.uuid, {
          x: drag.origX + (event.clientX - drag.startX) / viewport.scale,
          y: drag.origY + (event.clientY - drag.startY) / viewport.scale,
        })
        return next
      })
    }
  }

  const onSurfacePointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const pan = panRef.current
    if (pan !== null && pan.pointerId === event.pointerId) {
      panRef.current = null
      return
    }
    const drag = dragRef.current
    if (drag !== null && drag.pointerId === event.pointerId) {
      dragRef.current = null
      const pos = drafts.get(drag.uuid)
      if (pos !== undefined && (pos.x !== drag.origX || pos.y !== drag.origY)) {
        void store.move(drag.uuid, pos.x, pos.y)
        // Intentionally do NOT delete the draft here. The draft keeps the
        // element pinned at the drop position until the WS push arrives
        // with the persisted snapshot. Deleting now would snap the element
        // back to its old position, then forward again when the push lands
        // — visible as a two-frame jitter. A cleanup effect below removes
        // the draft once the snapshot confirms the new position.
      }
    }
  }

  const onNodePointerDown = (event: ReactPointerEvent<HTMLElement>, el: AigcElement): void => {
    if (el.uuid === undefined) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      uuid: el.uuid,
      startX: event.clientX,
      startY: event.clientY,
      origX: el.x,
      origY: el.y,
    }
  }

  // Right-click on a node → context menu with Delete.
  const onNodeContextMenu = (event: ReactMouseEvent<HTMLElement>, el: AigcElement): void => {
    if (el.uuid === undefined) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, uuid: el.uuid })
  }

  // Click anywhere → close the context menu.
  const onSurfaceClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (contextMenu !== undefined) {
      event.stopPropagation()
      setContextMenu(undefined)
    }
  }

  // Delete the element from the context menu.
  const onDeleteElement = (uuid: string): void => {
    setContextMenu(undefined)
    if (selected?.uuid === uuid) setSelected(undefined)
    void store.deleteElement(uuid)
  }

  // Drag-drop files onto the canvas surface.
  // stopPropagation() is critical: the canvas lives inside better-sidebar's
  // LeafView, whose onDragOver unconditionally calls preventDefault() and
  // shows a 5-zone layout overlay (without checking dataTransfer.types).
  // Without stopPropagation, file drags trigger that overlay and the drop
  // gets swallowed by the parent's onDrop.
  const onSurfaceDragOver = (event: React.DragEvent<HTMLElement>): void => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (rect !== undefined) {
        const sx = event.clientX - rect.left
        const sy = event.clientY - rect.top
        // Convert screen → world coords.
        const wx = (sx - viewport.x) / viewport.scale
        const wy = (sy - viewport.y) / viewport.scale
        setDropTarget({ x: wx, y: wy })
      }
    }
  }

  const onSurfaceDragLeave = (event: React.DragEvent<HTMLElement>): void => {
    // Only clear if leaving the surface itself (not a child).
    if (event.currentTarget === event.target) {
      event.stopPropagation()
      setDropTarget(undefined)
    }
  }

  const onSurfaceDrop = async (event: React.DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(undefined)
    const files = event.dataTransfer.files
    if (files.length === 0) return
    const rect = surfaceRef.current?.getBoundingClientRect()
    const sx = event.clientX - (rect?.left ?? 0)
    const sy = event.clientY - (rect?.top ?? 0)
    const wx = (sx - viewport.x) / viewport.scale
    const wy = (sy - viewport.y) / viewport.scale
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const buf = await file.arrayBuffer()
        // Convert ArrayBuffer → base64 in chunks to avoid stack overflow
        // (String.fromCharCode(...spread) blows the call stack for large files).
        const bytes = new Uint8Array(buf)
        let binary = ''
        const chunk = 0x8000
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
        }
        const mediaBase64 = btoa(binary)
        await store.uploadFile(file.name, mediaBase64, { x: wx, y: wy })
      }
    } finally {
      setUploading(false)
    }
  }

  const lookup = elementMap(state.elements)
  // Position resolver that checks drafts first (live drag position) then
  // falls back to the element's persisted position. Used by both the node
  // boxes and the edge renderer so connections follow dragged nodes in
  // real time — not only after the drag ends.
  const resolvePos: PosResolver = (uuid: string) => {
    const draft = drafts.get(uuid)
    if (draft !== undefined) return draft
    const el = lookup.get(uuid)
    if (el !== undefined) return { x: el.x, y: el.y }
    return undefined
  }
  const posOf = (el: AigcElement): { x: number; y: number } => {
    if (el.uuid !== undefined) {
      const draft = drafts.get(el.uuid)
      if (draft !== undefined) return draft
    }
    return { x: el.x, y: el.y }
  }

  return createElement(
    'div',
    { className: css.canvas },
    createElement(
      'div',
      { className: css.header },
      createElement('span', { className: css.title }, t('title')),
      createElement('span', { className: css.count }, `${state.elements.length} ${t('elementCount')}`),
      createElement('span', { className: css.count }, `${state.edges.length} ${t('edgeCount')}`),
      createElement('span', { className: css.zoom }, `${Math.round(viewport.scale * 100)}%`),
      createElement('button', {
        type: 'button',
        className: css.iconButton,
        onClick: () => zoomToCenter(viewport.scale * 0.8),
        title: t('zoomOut'),
        'aria-label': t('zoomOut'),
      }, '−'),
      createElement('input', {
        type: 'range',
        className: css.zoomSlider,
        min: Math.round(MIN_SCALE * 100),
        max: Math.round(MAX_SCALE * 100),
        value: Math.round(viewport.scale * 100),
        onChange: (e: ReactChangeEvent<HTMLInputElement>) => zoomToCenter(Number(e.target.value) / 100),
        'aria-label': t('zoom'),
      }),
      createElement('button', {
        type: 'button',
        className: css.iconButton,
        onClick: () => zoomToCenter(viewport.scale * 1.25),
        title: t('zoomIn'),
        'aria-label': t('zoomIn'),
      }, '+'),
      createElement(
        'button',
        {
          type: 'button',
          className: css.iconButton,
          onClick: () => { void store.refresh() },
          title: t('refresh'),
          'aria-label': t('refresh'),
        },
        '↻',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: css.iconButton,
          onClick: () => setViewport({ x: 0, y: 0, scale: 1 }),
          title: t('resetView'),
          'aria-label': t('resetView'),
        },
        '⤢',
      ),
    ),
    createElement(
      'div',
      {
        className: css.surface,
        ref: surfaceRef,
        onPointerDown: onSurfacePointerDown,
        onPointerMove: onSurfacePointerMove,
        onPointerUp: onSurfacePointerUp,
        onPointerCancel: onSurfacePointerUp,
        onDoubleClick: () => setSelected(undefined),
        onClick: onSurfaceClick,
        onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
          // Right-click on empty background → prevent default browser menu.
          event.preventDefault()
        },
        onDragOver: onSurfaceDragOver,
        onDragLeave: onSurfaceDragLeave,
        onDrop: (event: React.DragEvent<HTMLElement>) => { void onSurfaceDrop(event) },
      },
      state.elements.length === 0
        ? createElement('div', { className: css.empty }, createElement('span', null, t('empty')), createElement('span', { className: css.emptyHint }, t('emptyHint')))
        : createElement(
            'div',
            {
              className: css.world,
              style: {
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                // Expose the current zoom to descendants so media elements
                // (img/video) can counter-scale: they set their CSS width to
                // `100% * scale` (so the browser decodes at the larger screen
                // resolution instead of the layout width), then transform
                // `scale(1/scale)` to visually shrink back to the layout box.
                // Without this, zooming in shows blurry media because the
                // browser decodes the image at the small layout size and the
                // world transform upscales the bitmap.
                ['--canvas-scale' as string]: viewport.scale,
              } as CSSProperties,
            },
            createElement(
              'svg',
              {
                className: css.edgeLayer,
                'aria-hidden': true,
              },
              ...state.edges.map(edge => renderEdge(edge, resolvePos)),
            ),
            ...state.elements.map(el => {
              const pos = posOf(el)
              return createElement(
                'div',
                {
                  key: el.uuid ?? el.filePath,
                  className: `${css.nodeBox} ${el.uuid !== undefined ? css.nodeBoxDraggable : ''}`,
                  style: { transform: `translate(${pos.x}px, ${pos.y}px)` },
                  onPointerDown: event => onNodePointerDown(event, el),
                  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
                    event.stopPropagation()
                    setSelected(el)
                  },
                  onContextMenu: event => onNodeContextMenu(event, el),
                },
                createElement(CanvasNode, { element: el, t }),
              )
            }),
          ),
      // Drop indicator: shows where the dropped file will land (world coords).
      dropTarget !== undefined
        ? createElement('div', {
            className: css.dropIndicator,
            style: {
              transform: `translate(${dropTarget.x * viewport.scale + viewport.x}px, ${dropTarget.y * viewport.scale + viewport.y}px) scale(${viewport.scale})`,
            },
          })
        : null,
      // Upload overlay
      uploading
        ? createElement('div', { className: css.uploadOverlay }, t('uploading'))
        : null,
    ),
    selected !== undefined
      ? createElement(DetailPanel, { element: selected, t, onClose: () => setSelected(undefined) })
      : null,
    // Right-click context menu
    contextMenu !== undefined
      ? createElement(ContextMenu, {
          x: contextMenu.x,
          y: contextMenu.y,
          items: [
            { label: t('delete'), onClick: () => onDeleteElement(contextMenu.uuid) },
          ],
          onClose: () => setContextMenu(undefined),
        })
      : null,
    // Minimap: bottom-right overview showing element outlines + viewport frame.
    state.elements.length > 0
      ? createElement(Minimap, {
          elements: state.elements,
          viewport,
          surfaceSize,
          setViewport,
        })
      : null,
  )
}

/** A minimal fixed-position context menu (right-click). */
function ContextMenu(props: {
  x: number
  y: number
  items: Array<{ label: string; onClick: () => void }>
  onClose: () => void
}): ReactNode {
  // Close on any outside click or Escape.
  useEffect(() => {
    const onDown = (): void => props.onClose()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') props.onClose() }
    window.addEventListener('pointerdown', onDown, { once: true })
    window.addEventListener('keydown', onKey, { once: true })
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [props])
  return createElement(
    'div',
    {
      className: css.contextMenu,
      style: { left: props.x, top: props.y },
      // Stop the outside-click handler from firing on the menu itself.
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => e.stopPropagation(),
    },
    ...props.items.map((item, i) =>
      createElement('button', {
        key: i,
        type: 'button',
        className: css.contextMenuItem,
        onClick: () => { item.onClick() },
      }, item.label),
    ),
  )
}

/** The double-click detail panel: prompt + generation params + path. */
function DetailPanel({ element, t, onClose }: { element: AigcElement; t: Translate; onClose: () => void }): ReactNode {
  // Defensive: meta may have been persisted as a string by an older build
  // or sneak through the schema as a non-object. Only render entries when
  // we have a real plain object; otherwise show the raw value (if primitive)
  // or skip the section entirely.
  const meta = element.meta
  const metaEntries: Array<[string, unknown]> = Array.isArray(meta) || meta === null || typeof meta !== 'object'
    ? []
    : Object.entries(meta as Record<string, unknown>)
  return createElement(
    'div',
    { className: css.detailPanel },
    createElement(
      'div',
      { className: css.detailHeader },
      createElement('span', { className: css.detailTitle }, element.title),
      createElement('button', { type: 'button', className: css.detailClose, onClick: onClose, 'aria-label': t('detailClose') }, '×'),
    ),
    createElement(
      'div',
      { className: css.detailBody },
      element.promptText !== undefined
        ? createElement(
            'div',
            { className: css.detailBlock },
            createElement('span', { className: css.detailLabel }, t('detailPrompt')),
            createElement('pre', { className: css.detailPrompt }, element.promptText),
          )
        : null,
      metaEntries.length > 0
        ? createElement(
            'div',
            { className: css.detailBlock },
            createElement('span', { className: css.detailLabel }, t('detailParams')),
            createElement(
              'dl',
              { className: css.metaList },
              ...metaEntries.flatMap(([k, v]) => [
                createElement('dt', { key: `${k}-k`, className: css.metaKey }, k),
                createElement('dd', { key: `${k}-v`, className: css.metaValue }, formatMetaValue(v)),
              ]),
            ),
          )
        : null,
      createElement(
        'div',
        { className: css.detailBlock },
        createElement('span', { className: css.detailLabel }, t('generatedBy')),
        createElement('span', { className: css.detailValue }, element.producedBy),
      ),
      createElement(
        'div',
        { className: css.detailBlock },
        createElement('span', { className: css.detailLabel }, t('detailPosition')),
        createElement('span', { className: css.detailValue }, `(${Math.round(element.x)}, ${Math.round(element.y)})`),
      ),
      createElement(
        'div',
        { className: css.detailBlock },
        createElement('span', { className: css.detailLabel }, t('detailPath')),
        createElement('code', { className: css.filePath }, element.filePath),
      ),
    ),
  )
}

function formatMetaValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return ''
  try { return JSON.stringify(v) } catch { return String(v) }
}

// ── Minimap ──────────────────────────────────────────────────────────────

const MINIMAP_W = 168
const MINIMAP_H = 120
const MINIMAP_PAD = 6

/** Color dot per element kind in the minimap. */
const KIND_COLOR: Record<AigcElement['kind'], string> = {
  image: '#4caf50',
  video: '#ff9800',
  audio: '#ab47bc',
  prompt: '#6b8cff',
}

/**
 * Bottom-right minimap: shows all elements as small colored rectangles and
 * the current viewport as a frame. Click/drag to pan the viewport.
 */
function Minimap(props: {
  elements: readonly AigcElement[]
  viewport: Viewport
  surfaceSize: { width: number; height: number }
  setViewport: (fn: (prev: Viewport) => Viewport) => void
}): ReactNode {
  const { elements, viewport, surfaceSize, setViewport } = props
  const minimapRef = useRef<HTMLDivElement | null>(null)

  // Compute world bounding box: union of all elements + the current viewport.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + NODE_W)
    maxY = Math.max(maxY, el.y + NODE_H)
  }
  if (surfaceSize.width > 0 && surfaceSize.height > 0) {
    const vpMinX = -viewport.x / viewport.scale
    const vpMinY = -viewport.y / viewport.scale
    const vpMaxX = vpMinX + surfaceSize.width / viewport.scale
    const vpMaxY = vpMinY + surfaceSize.height / viewport.scale
    minX = Math.min(minX, vpMinX)
    minY = Math.min(minY, vpMinY)
    maxX = Math.max(maxX, vpMaxX)
    maxY = Math.max(maxY, vpMaxY)
  }
  // Guard against empty (shouldn't happen — caller checks, but be safe).
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null
  // Add a small padding around the content.
  minX -= 40
  minY -= 40
  maxX += 40
  maxY += 40
  const worldW = maxX - minX
  const worldH = maxY - minY
  const miniScale = Math.min(
    (MINIMAP_W - MINIMAP_PAD * 2) / worldW,
    (MINIMAP_H - MINIMAP_PAD * 2) / worldH,
  )
  const offsetX = (MINIMAP_W - worldW * miniScale) / 2
  const offsetY = (MINIMAP_H - worldH * miniScale) / 2
  const toMiniX = (wx: number): number => offsetX + (wx - minX) * miniScale
  const toMiniY = (wy: number): number => offsetY + (wy - minY) * miniScale

  // Viewport frame in minimap coords.
  const vpX = toMiniX(-viewport.x / viewport.scale)
  const vpY = toMiniY(-viewport.y / viewport.scale)
  const vpW = (surfaceSize.width / viewport.scale) * miniScale
  const vpH = (surfaceSize.height / viewport.scale) * miniScale

  // Click/drag on minimap → center the viewport on the clicked world point.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const pan = (clientX: number, clientY: number): void => {
      const rect = minimapRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const mx = clientX - rect.left
      const my = clientY - rect.top
      // Convert minimap coords → world coords.
      const worldX = (mx - offsetX) / miniScale + minX
      const worldY = (my - offsetY) / miniScale + minY
      // Center viewport on this world point.
      setViewport(prev => ({
        ...prev,
        x: surfaceSize.width / 2 - worldX * prev.scale,
        y: surfaceSize.height / 2 - worldY * prev.scale,
      }))
    }
    pan(event.clientX, event.clientY)
    const onMove = (e: PointerEvent): void => pan(e.clientX, e.clientY)
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return createElement(
    'div',
    {
      className: css.minimap,
      ref: minimapRef,
      onPointerDown,
    },
    createElement(
      'svg',
      { width: MINIMAP_W, height: MINIMAP_H, className: css.minimapSvg },
      // Element rectangles.
      ...elements.map(el =>
        createElement('rect', {
          key: el.uuid ?? el.filePath,
          x: toMiniX(el.x),
          y: toMiniY(el.y),
          width: Math.max(2, NODE_W * miniScale),
          height: Math.max(2, NODE_H * miniScale),
          rx: 2,
          fill: KIND_COLOR[el.kind],
          fillOpacity: 0.35,
          stroke: KIND_COLOR[el.kind],
          strokeOpacity: 0.7,
          strokeWidth: 1,
        }),
      ),
      // Viewport frame: a semi-transparent fill + solid border so it's
      // clearly visible against the element rectangles.
      createElement('rect', {
        x: vpX,
        y: vpY,
        width: vpW,
        height: vpH,
        fill: 'var(--dsw-alias-label-primary)',
        fillOpacity: 0.08,
        stroke: 'var(--dsw-alias-label-primary)',
        strokeOpacity: 0.8,
        strokeWidth: 2,
        rx: 2,
      }),
    ),
  )
}

/** Wrapped export so the tab component can mount the boundary once. */
export function CanvasViewWithBoundary(props: CanvasViewProps): ReactNode {
  return createElement(CanvasBoundary, { t: props.t, children: createElement(CanvasView, props) })
}
