/**
 * One canvas node: renders the element's media (image / video / audio) or
 * its prompt text, plus a small header row with kind dot + label and the
 * creation time. Rendered inside the infinite-canvas world layer at its
 * (x, y) position; dragging is handled by the parent view (the node div
 * carries the drag pointer handlers). Double-click opens the detail panel.
 *
 * ZOOM / BLUR FIX
 * ---------------
 * The world layer is scaled via `transform: scale(s)`. Browsers decode
 * `<img>`/`<video>` at their CSS layout size (the card's 220px content
 * width), NOT the post-transform screen size — so zooming in upscales a
 * small decoded bitmap and the media looks blurry.
 *
 * To get crisp media at every zoom level, each img/video sets its CSS
 * width to `100% * scale` (the on-screen pixel width) and then applies
 * `transform: scale(1/scale)` to visually shrink back to the 220px layout
 * box. The browser then decodes at the larger size and the world
 * transform produces a 1:1 (or downscaled) screen image — sharp.
 *
 * The layout box still grows to `220*scale` wide, which would push
 * siblings and inflate the card. Negative `margin-right` / `margin-bottom`
 * (expressed as `%` of the container width = 220px) cancel the excess so
 * the effective layout footprint is unchanged. The bottom margin needs
 * the media's aspect ratio (h/w), captured from `onLoad`/`onLoadedMetadata`.
 */
import { createElement, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react'
import type { AigcElement } from './api.js'
import { mediaUrlOf } from './api.js'
import css from './canvas.module.css'

/** Translation function type (from the DSH locale system). */
type Translate = (key: string) => string

/** Short label for one element kind. */
function kindLabel(kind: AigcElement['kind'], t: Translate): string {
  switch (kind) {
    case 'prompt': return t('prompt')
    case 'image': return t('image')
    case 'video': return t('video')
    case 'audio': return t('audio')
  }
}

/** Format the createdAt timestamp as a short HH:MM:SS. */
function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => n < 10 ? `0${n}` : String(n)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Default aspect ratio (h/w) used before media metadata loads. 4:3 → 0.75. */
const DEFAULT_RATIO = 0.75

/**
 * One image element. Captures its natural aspect ratio on load so the
 * negative bottom margin (which cancels the layout-box inflation from the
 * counter-scale trick) can be computed from CSS variables alone.
 */
function MediaImage({ url, alt }: { url: string; alt: string }): ReactNode {
  const [ratio, setRatio] = useState(DEFAULT_RATIO)
  const onLoad = (e: SyntheticEvent<HTMLImageElement>): void => {
    const img = e.currentTarget
    if (img.naturalWidth > 0) {
      setRatio(img.naturalHeight / img.naturalWidth)
    }
  }
  return createElement('img', {
    className: css.mediaImage,
    src: url,
    alt,
    loading: 'lazy',
    draggable: false,
    onLoad,
    style: { ['--media-ratio' as string]: ratio } as CSSProperties,
  })
}

/**
 * One video element. Same counter-scale trick as MediaImage; the aspect
 * ratio comes from `loadedmetadata` (videoWidth / videoHeight).
 */
function MediaVideo({ url }: { url: string }): ReactNode {
  const [ratio, setRatio] = useState(DEFAULT_RATIO)
  const onLoadedMetadata = (e: SyntheticEvent<HTMLVideoElement>): void => {
    const v = e.currentTarget
    if (v.videoWidth > 0) {
      setRatio(v.videoHeight / v.videoWidth)
    }
  }
  return createElement('video', {
    className: css.mediaVideo,
    src: url,
    controls: true,
    preload: 'metadata',
    onLoadedMetadata,
    style: { ['--media-ratio' as string]: ratio } as CSSProperties,
  })
}

/** Render one element's media (or prompt text) based on its kind. */
function renderMedia(el: AigcElement): ReactNode {
  if (el.kind === 'prompt') {
    return createElement('pre', { className: css.promptText }, el.promptText ?? '')
  }
  // Media route needs the uuid (the host resolves uuid → filePath internally).
  // The uuid is present on every element the WS push delivers.
  if (el.uuid === undefined) return null
  const url = mediaUrlOf(el.sessionId ?? '', el.uuid)
  if (el.kind === 'image') {
    return createElement(MediaImage, { url, alt: el.title })
  }
  if (el.kind === 'video') {
    return createElement(MediaVideo, { url })
  }
  // audio — native control, no bitmap to sharpen
  return createElement('audio', {
    className: css.mediaAudio,
    src: url,
    controls: true,
    preload: 'metadata',
  })
}

export interface CanvasNodeProps {
  element: AigcElement
  t: Translate
}

/** One canvas node (fixed-width card; height follows content). */
export function CanvasNode({ element, t }: CanvasNodeProps): ReactNode {
  const kindDotClass = `${css.kindDot} ${css[`kindDot_${element.kind}`] ?? ''}`
  return createElement(
    'div',
    {
      className: css.node,
      'data-uuid': element.uuid ?? '',
      'data-filepath': element.filePath,
    },
    createElement(
      'div',
      { className: css.nodeHeader },
      createElement('span', { className: kindDotClass, 'aria-hidden': true }),
      createElement('span', { className: css.kindLabel }, kindLabel(element.kind, t)),
      createElement('span', { className: css.nodeTime }, formatTime(element.createdAt)),
    ),
    createElement('div', { className: css.nodeTitle }, element.title),
    element.description !== undefined && element.description !== ''
      ? createElement('div', { className: css.nodeDescription }, element.description)
      : null,
    createElement('div', { className: css.nodeMedia }, renderMedia(element)),
  )
}
