/**
 * The host-side AIGC canvas registry: per-session element table (prompts +
 * generated image/video/audio assets) plus edges connecting each input
 * element to its produced output. Published as `ctx.aigcCanvas`.
 *
 * Element identity:
 * - Every element (prompt / image / video / audio) has a `filePath` on disk.
 *   Prompt elements are written as `.txt` files; media elements as
 *   `.<ext>` files. The filePath is the **primary external identifier** —
 *   tools return filePath (not uuid), and tools accept filePath (not uuid)
 *   when referencing existing elements.
 * - Internally, elements are still uuid-keyed (for stable edges + dedup);
 *   `getElementByPath` resolves a filePath back to the element.
 *
 * Free positioning:
 * - Every element carries `x` / `y` canvas coordinates (world space). The
 *   model sets them when placing a file (`aigc_canvas_place`); the client
 *   drags them around and persists through the `canvas.move` API.
 *
 * Persistence:
 * - The in-memory table is mirrored to
 *   `<cwd>/.dsh-aigc-canvas/<sessionId>/canvas.json` after every mutation.
 * - Media / prompt files live alongside the JSON as `<uuid>.<ext>`.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, sep } from 'node:path'
import { AigcError } from './wire.js'

/** Discriminated union of element kinds the canvas stores. */
export type AigcElementKind = 'prompt' | 'image' | 'video' | 'audio'

/**
 * Semantic relation on an edge: WHY one element was wired to another.
 *
 * The 11 fixed enum values cover the common AIGC pipeline relationships
 * (direct input, references, first/last frames, style, mask, audio
 * tracks, variations/remixes/alternatives, and the ffmpeg edit chain).
 *
 * The relation drives:
 *  - Agent reasoning: `aigc_canvas_list_elements` returns edges with
 *    their `relation`, so the model can read the dependency graph.
 *  - Client rendering: each relation maps to a line style + label
 *    (solid/dashed/dotted + "首帧"/"风格" etc.), see CanvasView.renderEdge.
 *
 * Backward compat: edges loaded from old `canvas.json` files that predate
 * the `relation` field are normalized to `'input'` on hydrate.
 */
export type EdgeRelation =
  // Direct inputs (solid line)
  | 'input'            // generic input (e.g. t2i prompt → image)
  | 'first_frame'      // first-frame input to a video (fl2v)
  | 'last_frame'       // last-frame input to a video (fl2v)
  | 'audio_track'      // audio track added to a video
  // References (dashed line)
  | 'reference'        // generic reference (ref2v)
  | 'style'            // style reference (i2i style transfer)
  | 'mask'             // mask reference (local edit)
  // Variations / alternatives (dotted line)
  | 'variation_of'     // same prompt, different seed (reroll)
  | 'remix_of'         // changed prompt (reroll with prompt_delta)
  | 'alternative_of'   // A/B candidate within a variation cluster
  // Edit chain (bold solid line)
  | 'edited_from'      // ffmpeg edit chain (media_edit output → input)

/** All EdgeRelation values as a readonly array (for schema enum + validation). */
export const EDGE_RELATIONS: readonly EdgeRelation[] = [
  'input', 'first_frame', 'last_frame', 'audio_track',
  'reference', 'style', 'mask',
  'variation_of', 'remix_of', 'alternative_of',
  'edited_from',
] as const

/** Default relation when an old edge has none (backward compat). */
export const DEFAULT_EDGE_RELATION: EdgeRelation = 'input'

/** Coerce an unknown value to EdgeRelation, falling back to the default. */
export function coerceEdgeRelation(value: unknown): EdgeRelation {
  if (typeof value === 'string' && (EDGE_RELATIONS as readonly string[]).includes(value)) {
    return value as EdgeRelation
  }
  return DEFAULT_EDGE_RELATION
}

/** File extension for each media kind (no leading dot). */
export function extensionFor(kind: AigcElementKind): string {
  switch (kind) {
    case 'image': return 'png'
    case 'video': return 'mp4'
    case 'audio': return 'mp3'
    case 'prompt': return 'txt'
  }
}

/** MIME type for each media kind (for the file route). */
export function mimeTypeFor(kind: AigcElementKind): string {
  switch (kind) {
    case 'image': return 'image/png'
    case 'video': return 'video/mp4'
    case 'audio': return 'audio/mpeg'
    case 'prompt': return 'text/plain; charset=utf-8'
  }
}

/** One node on the canvas. */
export interface AigcElement {
  /** Stable opaque handle (internal; used for edges). */
  uuid: string
  /** Owning conversation id. */
  sessionId: string
  /** Discriminator. */
  kind: AigcElementKind
  /** Display title (short human-readable label). */
  title: string
  /** Canvas position, world coordinates (infinite free canvas). */
  x: number
  /** Canvas position, world coordinates (infinite free canvas). */
  y: number
  /** Creation time (ms since epoch). */
  createdAt: number
  /** Tool that produced this element. */
  producedBy: string
  /**
   * Absolute path to the element file on disk. For prompt elements: the
   * `.txt` file containing the prompt text. For media elements: the media
   * file. This is the **primary external identifier** — tools return and
   * accept this path.
   */
  filePath: string
  /** For prompt elements: the prompt text (mirrored in the .txt file). */
  promptText?: string
  /** For media elements: byte size of the media file. */
  mediaSize?: number
  /** Freeform metadata bag (dimensions, duration, model, seed, ...). */
  meta?: Record<string, unknown>
  /**
   * Ultra-short model-supplied description of the element (a noun, an
   * adjective, or a short phrase — e.g. "orange cat", "sunset beach",
   * "fast cut"). Bounded to ~40 chars; shown on the node card under the
   * title and injected into context when the element is referenced.
   */
  description?: string
}

/** One edge: source element → target element (multi-to-one fan-in). */
export interface AigcEdge {
  /** Source element uuid (an input — prompt or reference). */
  source: string
  /** Target element uuid (the produced output). */
  target: string
  /**
   * Semantic relation describing WHY source → target was wired (e.g.
   * `first_frame` for a video's first-frame input, `style` for a style-
   * reference, `variation_of` for a reroll). See EdgeRelation for the
   * full enum.
   *
   * Edges loaded from old `canvas.json` files that predate this field
   * are normalized to `'input'` on hydrate (see coerceEdgeRelation).
   */
  relation: EdgeRelation
  /**
   * Optional short note supplementing the relation (free text). Useful
   * for edge cases the fixed enum doesn't cover, e.g. `relation: 'style'`
   * + `note: 'cyberpunk neon'`. Not used for rendering decisions (the
   * relation enum drives line style + label); shown only in detail views.
   */
  note?: string
}

/** The serializable canvas state for one session. */
export interface AigcCanvasState {
  sessionId: string
  elements: AigcElement[]
  edges: AigcEdge[]
}

/** Listener callback receives the session id that changed. */
export type AigcCanvasListener = (sessionId: string) => void

/** The registry service published as `ctx.aigcCanvas`. */
export interface AigcCanvasService {
  /** Add a prompt element (writes a .txt file). Returns the new element. */
  addPrompt(sessionId: string, params: {
    title: string
    promptText: string
    producedBy: string
    x?: number
    y?: number
    meta?: Record<string, unknown>
    description?: string
  }, cwd: string): Promise<AigcElement>
  /** Add a media element (image/video/audio) with the given bytes on disk. */
  addMedia(sessionId: string, params: {
    kind: 'image' | 'video' | 'audio'
    title: string
    producedBy: string
    mediaBytes: Buffer
    x?: number
    y?: number
    meta?: Record<string, unknown>
    description?: string
  }, cwd: string): Promise<AigcElement>
  /**
   * Register an element for a file that already exists on disk inside the
   * session canvas directory (written by the model's http tool). The file
   * is not copied; the element references it in place.
   *
   * x/y are optional: when omitted the host picks a position automatically
   * (a left-aligned vertical column below the lowest existing element) so
   * newly placed elements land somewhere reasonable instead of all piling
   * at (0, 0).
   */
  placeFile(sessionId: string, params: {
    kind: 'image' | 'video' | 'audio' | 'prompt'
    filePath: string
    title: string
    producedBy: string
    x?: number
    y?: number
    promptText?: string
    meta?: Record<string, unknown>
    description?: string
    /** Uuids of reference elements — when x/y are omitted, the new element is placed to the right of them. */
    referenceUuids?: readonly string[]
  }, cwd: string): Promise<AigcElement>
  /** Move an element to a new canvas position (persisted + pushed). */
  updatePosition(sessionId: string, uuid: string, x: number, y: number): Promise<AigcElement>
  /**
   * Delete one element and any edges referencing it. The media file on
   * disk is NOT removed (the model may still reference its filePath);
   * only the canvas registration is dropped.
   */
  deleteElement(sessionId: string, uuid: string): Promise<void>
  /**
   * Wire edges from each input uuid to the target uuid (multi-to-one).
   *
   * Each input may carry an optional `relation` (defaults to `'input'`
   * when omitted) and `note`. If an edge already exists between the
   * same source → target, its `relation`/`note` are UPDATED in place
   * rather than skipped — so re-linking a pair with a new relation
   * (e.g. promoting an `'input'` to a `'first_frame'`) works as an
   * update, not a no-op.
   */
  wireEdges(sessionId: string, inputs: readonly { uuid: string; relation?: EdgeRelation; note?: string }[], targetUuid: string): Promise<void>
  /** Remove one edge (source → target). Idempotent. */
  unlink(sessionId: string, sourceUuid: string, targetUuid: string): Promise<void>
  /** Load the persisted state for one session (idempotent; used before sync reads). */
  ensureHydrated(sessionId: string): Promise<void>
  /** Look up one element by uuid (throws if not found or wrong session). */
  getElement(sessionId: string, uuid: string): AigcElement
  /** Look up one element by its filePath (throws if not found). */
  getElementByPath(sessionId: string, filePath: string): AigcElement
  /** Snapshot of one session's full canvas state (elements + edges). */
  snapshot(sessionId: string): AigcCanvasState
  /** Subscribe to canvas mutations for any session. Returns disposer. */
  subscribe(listener: AigcCanvasListener): () => void
  /** Subscribe to canvas mutations for one specific session. */
  subscribeSession(sessionId: string, listener: AigcCanvasListener): () => void
}

/** Folder name under the session cwd where canvas state + media live. */
const CANVAS_DIR = '.dsh-aigc-canvas'

/** Filename inside CANVAS_DIR for the per-session element+edge table. */
const CANVAS_JSON = 'canvas.json'

/** Default column X for auto-placed elements (left side of the canvas). */
const AUTO_PLACE_X = 32

/** Vertical gap between auto-placed elements (pixels of empty space). */
const AUTO_PLACE_GAP = 16

/** Horizontal gap between auto-placed columns. */
const AUTO_COL_GAP_X = 20

/**
 * Maximum column height before auto-placement wraps to a new column.
 * ~600px ≈ 3 image cards — keeps a long batch of generations in a
 * compact multi-column grid instead of one very tall column.
 */
const AUTO_COL_MAX_HEIGHT = 600

/** Horizontal gap between a referenced element and the new element placed to its right. */
const REFERENCE_GAP_X = 20

/**
 * Estimate the rendered height of one element card (world units).
 *
 * The card width is fixed at 240px (NODE_W_REF); media elements render
 * their content inside a 220px-wide area (240 − 2×10 padding). The
 * header row is ~26px, the title is ~18px, and media padding is ~8px.
 * Image/video aspect ratios default to 4:3 → 165px media height.
 *
 * These are approximate — the actual height depends on the media's
 * aspect ratio and the title length — but they're close enough that
 * auto-placed elements don't overlap.
 */
function estimatedCardHeight(kind: AigcElementKind): number {
  const header = 26
  const title = 18
  const mediaPadding = 8
  switch (kind) {
    case 'prompt': return header + title + 80 // short text block
    case 'audio': return header + title + 40 // audio control bar
    case 'image':
    case 'video':
      return header + title + mediaPadding + 165 // 220px wide × 4:3
  }
}

/** One auto-placement column: x position + current bottom edge. */
interface AutoColumn {
  x: number
  bottom: number
}

/**
 * Pick a position for a new element. Priority:
 * 1. Explicit x/y (finite numbers) — always wins.
 * 2. Reference positions: place to the right of the rightmost reference,
 *    vertically centered on the average of the references' centers.
 * 3. Fallback: multi-column grid. Scans existing auto-placed elements
 *    (grouped by x into columns), finds the shortest column whose bottom
 *    + the new element's height stays under AUTO_COL_MAX_HEIGHT, and
 *    stacks below it. When no column has room, starts a new column to
 *    the right of the rightmost one.
 */
function resolvePlacement(
  existing: Iterable<AigcElement>,
  x: number | undefined,
  y: number | undefined,
  references?: readonly { x: number; y: number }[],
  kind?: AigcElementKind,
): { x: number; y: number } {
  if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y }
  }
  if (references !== undefined && references.length > 0) {
    let maxRight = -Infinity
    let sumY = 0
    for (const ref of references) {
      const right = ref.x + NODE_W_REF
      if (right > maxRight) maxRight = right
      sumY += ref.y + NODE_H_REF / 2
    }
    const avgY = sumY / references.length
    return {
      x: maxRight + REFERENCE_GAP_X,
      y: avgY - NODE_H_REF / 2,
    }
  }
  // Multi-column grid fallback. Group existing elements into columns by
  // their x coordinate (within NODE_W_REF/2 tolerance), compute each
  // column's bottom edge, then place the new element in the shortest
  // column that still has room; otherwise start a new column.
  const newHeight = estimatedCardHeight(kind ?? 'image')
  const columns: AutoColumn[] = []
  let maxRight = -Infinity
  for (const el of existing) {
    if (typeof el.x !== 'number' || typeof el.y !== 'number') continue
    if (el.x > maxRight) maxRight = el.x
    // Find an existing column matching this x (within tolerance).
    let col = columns.find(c => Math.abs(c.x - el.x!) < NODE_W_REF / 2)
    if (col === undefined) {
      col = { x: el.x, bottom: el.y + estimatedCardHeight(el.kind) }
      columns.push(col)
    } else {
      const bottom = el.y + estimatedCardHeight(el.kind)
      if (bottom > col.bottom) col.bottom = bottom
    }
  }
  // Try to find the shortest column with room for the new element.
  let best: AutoColumn | undefined
  for (const col of columns) {
    if (col.bottom + AUTO_PLACE_GAP + newHeight <= AUTO_PLACE_X + AUTO_COL_MAX_HEIGHT) {
      if (best === undefined || col.bottom < best.bottom) best = col
    }
  }
  if (best !== undefined) {
    return { x: best.x, y: best.bottom + AUTO_PLACE_GAP }
  }
  // No column has room — start a new one to the right of the rightmost.
  const newX = maxRight > -Infinity ? maxRight + NODE_W_REF + AUTO_COL_GAP_X : AUTO_PLACE_X
  return { x: newX, y: AUTO_PLACE_X }
}

/** Node dimensions mirrored from the client (for placement math only). */
const NODE_W_REF = 240
const NODE_H_REF = 110

/** In-memory table: sessionId → (uuid → element). */
type SessionTable = Map<string, AigcElement>

/** In-memory edges: sessionId → array of edges. */
type SessionEdges = Map<string, AigcEdge[]>

/** Resolve the per-session canvas directory under the session cwd. */
export function canvasDirFor(cwd: string, sessionId: string): string {
  return join(cwd, CANVAS_DIR, sessionId)
}

/** Resolve the per-session canvas JSON path. */
export function canvasJsonPath(cwd: string, sessionId: string): string {
  return join(canvasDirFor(cwd, sessionId), CANVAS_JSON)
}

/** Resolve the per-session file path for one element (by uuid + kind). */
export function elementFilePath(cwd: string, sessionId: string, uuid: string, kind: AigcElementKind): string {
  return join(canvasDirFor(cwd, sessionId), `${uuid}.${extensionFor(kind)}`)
}

/** Atomically write a JSON file (temp file + rename). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    await writeFile(tmp, JSON.stringify(value), 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(tmp, { force: true }).catch(() => {}))
    throw new AigcError('fs-error', `cannot persist canvas state: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}

/**
 * Build the service. The `resolveCwd` callback threads the live session cwd;
 * `mediaSizeLimit` bounds how large a placed file may be.
 */
export function createAigcCanvasService(
  resolveCwd: (sessionId: string) => string,
  mediaSizeLimit: () => number = () => 100 * 1024 * 1024,
): AigcCanvasService {
  const elementsBySession = new Map<string, SessionTable>()
  const edgesBySession = new Map<string, AigcEdge[]>()
  const listeners = new Set<AigcCanvasListener>()
  const sessionListeners = new Map<string, Set<AigcCanvasListener>>()
  const hydrated = new Set<string>()
  const hydrating = new Set<string>()

  const notify = (sessionId: string): void => {
    for (const fn of [...listeners]) fn(sessionId)
    const set = sessionListeners.get(sessionId)
    if (set !== undefined) for (const fn of [...set]) fn(sessionId)
  }

  const tableOf = (sessionId: string): SessionTable => {
    let table = elementsBySession.get(sessionId)
    if (table === undefined) {
      table = new Map()
      elementsBySession.set(sessionId, table)
    }
    return table
  }

  const edgesOf = (sessionId: string): AigcEdge[] => {
    let edges = edgesBySession.get(sessionId)
    if (edges === undefined) {
      edges = []
      edgesBySession.set(sessionId, edges)
    }
    return edges
  }

  const hydrate = async (sessionId: string): Promise<void> => {
    if (hydrated.has(sessionId)) return
    // Track in-flight hydration to avoid concurrent double-reads.
    if (hydrating.has(sessionId)) {
      // Wait for the in-flight hydration to finish.
      while (hydrating.has(sessionId)) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      return
    }
    hydrating.add(sessionId)
    try {
      const cwd = resolveCwd(sessionId)
      const path = canvasJsonPath(cwd, sessionId)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (err) {
        // File not found = new session with no persisted canvas data yet.
        // This is the normal case — mark as hydrated so we don't keep
        // retrying readFile on every snapshot call.
        if (err !== null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
          hydrated.add(sessionId)
        }
        // Any other error (wrong cwd, permission, etc.) — don't mark as
        // hydrated so the next access can retry once the session's cwd
        // is properly registered.
        return
      }
      const parsed = JSON.parse(raw) as AigcCanvasState
      if (parsed.sessionId !== sessionId) {
        hydrated.add(sessionId)
        return
      }
      const table = tableOf(sessionId)
      for (const el of Array.isArray(parsed.elements) ? parsed.elements : []) {
        if (el && typeof el.uuid === 'string') {
          // Old persisted data predates positions: normalize missing x/y to 0.
          if (typeof el.x !== 'number') el.x = 0
          if (typeof el.y !== 'number') el.y = 0
          table.set(el.uuid, el)
        }
      }
      const edges = edgesOf(sessionId)
      for (const e of Array.isArray(parsed.edges) ? parsed.edges : []) {
        if (e && typeof e.source === 'string' && typeof e.target === 'string') {
          // Backward compat: old canvas.json files predating EdgeRelation
          // have no `relation` field — normalize to the default 'input'.
          e.relation = coerceEdgeRelation(e.relation)
          edges.push(e)
        }
      }
      hydrated.add(sessionId)
      // Notify listeners so any connected WS client sees the loaded data.
      notify(sessionId)
    } catch {
      // JSON parse error or other unexpected failure — don't mark as
      // hydrated so the next access can retry.
    } finally {
      hydrating.delete(sessionId)
    }
  }

  const persist = async (sessionId: string): Promise<void> => {
    const cwd = resolveCwd(sessionId)
    const dir = canvasDirFor(cwd, sessionId)
    await mkdir(dir, { recursive: true })
    const state: AigcCanvasState = {
      sessionId,
      elements: Array.from(tableOf(sessionId).values()),
      edges: edgesOf(sessionId),
    }
    await writeJsonAtomic(canvasJsonPath(cwd, sessionId), state)
  }

  const addPrompt: AigcCanvasService['addPrompt'] = async (sessionId, params, cwd) => {
    await hydrate(sessionId)
    const uuid = randomUUID()
    const filePath = elementFilePath(cwd, sessionId, uuid, 'prompt')
    // Write the prompt text to disk so the element has a real filePath.
    await mkdir(join(cwd, CANVAS_DIR, sessionId), { recursive: true })
    await writeFile(filePath, params.promptText, 'utf8')
    const el: AigcElement = {
      uuid,
      sessionId,
      kind: 'prompt',
      title: params.title,
      x: params.x ?? 0,
      y: params.y ?? 0,
      createdAt: Date.now(),
      producedBy: params.producedBy,
      filePath,
      promptText: params.promptText,
      ...(params.meta !== undefined ? { meta: params.meta } : {}),
      ...(params.description !== undefined && params.description !== '' ? { description: params.description } : {}),
    }
    tableOf(sessionId).set(el.uuid, el)
    await persist(sessionId)
    notify(sessionId)
    return el
  }

  const addMedia: AigcCanvasService['addMedia'] = async (sessionId, params, cwd) => {
    await hydrate(sessionId)
    const uuid = randomUUID()
    const filePath = elementFilePath(cwd, sessionId, uuid, params.kind)
    await mkdir(join(cwd, CANVAS_DIR, sessionId), { recursive: true })
    await writeFile(filePath, params.mediaBytes)
    const el: AigcElement = {
      uuid,
      sessionId,
      kind: params.kind,
      title: params.title,
      x: params.x ?? 0,
      y: params.y ?? 0,
      createdAt: Date.now(),
      producedBy: params.producedBy,
      filePath,
      mediaSize: params.mediaBytes.byteLength,
      ...(params.meta !== undefined ? { meta: params.meta } : {}),
      ...(params.description !== undefined && params.description !== '' ? { description: params.description } : {}),
    }
    tableOf(sessionId).set(el.uuid, el)
    await persist(sessionId)
    notify(sessionId)
    return el
  }

  const placeFile: AigcCanvasService['placeFile'] = async (sessionId, params, cwd) => {
    await hydrate(sessionId)
    const dir = canvasDirFor(cwd, sessionId)
    // Normalize to an absolute path first (join with an absolute target
    // would produce a broken concatenation), then enforce containment.
    const resolved = isAbsolute(params.filePath) ? params.filePath : join(cwd, params.filePath)
    if (!isAbsoluteWithin(dir, resolved)) {
      throw new AigcError('fs-error', `file path outside the session canvas directory: ${params.filePath}`)
    }
    const info = await stat(resolved).catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      throw new AigcError('fs-error', `file not found or not a regular file: ${params.filePath}`)
    }
    if (info.size > 0 && info.size > mediaSizeLimit()) {
      throw new AigcError('fs-error', `file too large to place on the canvas: ${info.size} bytes`)
    }
    const table = tableOf(sessionId)
    // Resolve reference positions (if any) so the new element can be
    // auto-placed to the right of its references instead of falling to
    // the bottom of the column.
    const refPositions: { x: number; y: number }[] = []
    if (params.referenceUuids !== undefined) {
      for (const refUuid of params.referenceUuids) {
        const ref = table.get(refUuid)
        if (ref !== undefined) refPositions.push({ x: ref.x, y: ref.y })
      }
    }
    const pos = resolvePlacement(
      table.values(),
      params.x,
      params.y,
      refPositions.length > 0 ? refPositions : undefined,
      params.kind,
    )
    const uuid = randomUUID()
    const el: AigcElement = {
      uuid,
      sessionId,
      kind: params.kind,
      title: params.title,
      x: pos.x,
      y: pos.y,
      createdAt: Date.now(),
      producedBy: params.producedBy,
      filePath: resolved,
      mediaSize: params.kind === 'prompt' ? undefined : info.size,
      ...(params.promptText !== undefined ? { promptText: params.promptText } : {}),
      ...(params.meta !== undefined ? { meta: params.meta } : {}),
      ...(params.description !== undefined && params.description !== '' ? { description: params.description } : {}),
    }
    tableOf(sessionId).set(el.uuid, el)
    await persist(sessionId)
    notify(sessionId)
    return el
  }

  const updatePosition: AigcCanvasService['updatePosition'] = async (sessionId, uuid, x, y) => {
    await hydrate(sessionId)
    const table = tableOf(sessionId)
    const el = table.get(uuid)
    if (el === undefined) {
      throw new AigcError('not-found', `element "${uuid}" not found in session "${sessionId}"`, 404)
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AigcError('bad-request', 'x and y must be finite numbers')
    }
    el.x = x
    el.y = y
    await persist(sessionId)
    notify(sessionId)
    return el
  }

  const deleteElement: AigcCanvasService['deleteElement'] = async (sessionId, uuid) => {
    await hydrate(sessionId)
    const table = tableOf(sessionId)
    if (!table.has(uuid)) {
      throw new AigcError('not-found', `element "${uuid}" not found in session "${sessionId}"`, 404)
    }
    table.delete(uuid)
    // Drop any edges that reference the deleted element (as source or target).
    const edges = edgesOf(sessionId)
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i]!.source === uuid || edges[i]!.target === uuid) {
        edges.splice(i, 1)
      }
    }
    await persist(sessionId)
    notify(sessionId)
  }

  const unlink: AigcCanvasService['unlink'] = async (sessionId, sourceUuid, targetUuid) => {
    await hydrate(sessionId)
    const edges = edgesOf(sessionId)
    const index = edges.findIndex(e => e.source === sourceUuid && e.target === targetUuid)
    if (index === -1) return
    edges.splice(index, 1)
    await persist(sessionId)
    notify(sessionId)
  }

  const wireEdges: AigcCanvasService['wireEdges'] = async (sessionId, inputs, targetUuid) => {
    await hydrate(sessionId)
    const table = tableOf(sessionId)
    if (!table.has(targetUuid)) {
      throw new AigcError('not-found', `target element "${targetUuid}" not found in session "${sessionId}"`, 404)
    }
    const edges = edgesOf(sessionId)
    for (const input of inputs) {
      if (!table.has(input.uuid)) {
        throw new AigcError('not-found', `source element "${input.uuid}" not found in session "${sessionId}"`, 404)
      }
      const relation = input.relation ?? DEFAULT_EDGE_RELATION
      const existing = edges.find(e => e.source === input.uuid && e.target === targetUuid)
      if (existing !== undefined) {
        // Update relation + note in place so re-linking with a new relation
        // (e.g. promoting 'input' → 'first_frame') works as an update.
        existing.relation = relation
        if (input.note !== undefined) existing.note = input.note
      } else {
        edges.push({
          source: input.uuid,
          target: targetUuid,
          relation,
          ...(input.note !== undefined ? { note: input.note } : {}),
        })
      }
    }
    await persist(sessionId)
    notify(sessionId)
  }

  const getElement: AigcCanvasService['getElement'] = (sessionId, uuid) => {
    const table = tableOf(sessionId)
    const el = table.get(uuid)
    if (el === undefined) {
      throw new AigcError('not-found', `element "${uuid}" not found in session "${sessionId}"`, 404)
    }
    return el
  }

  const getElementByPath: AigcCanvasService['getElementByPath'] = (sessionId, filePath) => {
    const table = tableOf(sessionId)
    for (const el of table.values()) {
      // Normalize comparison: both paths should be absolute. Use exact match.
      if (el.filePath === filePath) return el
    }
    throw new AigcError('not-found', `element with filePath "${filePath}" not found in session "${sessionId}"`, 404)
  }

  const snapshot: AigcCanvasService['snapshot'] = (sessionId) => ({
    sessionId,
    elements: Array.from(tableOf(sessionId).values()),
    edges: edgesOf(sessionId),
  })

  const subscribe: AigcCanvasService['subscribe'] = (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const subscribeSession: AigcCanvasService['subscribeSession'] = (sessionId, listener) => {
    let set = sessionListeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      sessionListeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) sessionListeners.delete(sessionId)
    }
  }

  return {
    addPrompt,
    addMedia,
    placeFile,
    updatePosition,
    deleteElement,
    wireEdges,
    unlink,
    ensureHydrated: hydrate,
    getElement,
    getElementByPath,
    snapshot,
    subscribe,
    subscribeSession,
  }
}

/** True when `target` (absolute or relative) resolves inside `dir`. */
function isAbsoluteWithin(dir: string, target: string): boolean {
  const resolved = isAbsolute(target) ? target : join(dir, target)
  const normalizedDir = dir.endsWith(sep) ? dir : `${dir}${sep}`
  const a = resolved.toLowerCase()
  const b = normalizedDir.toLowerCase()
  return a === dir.toLowerCase() || a.startsWith(b)
}
