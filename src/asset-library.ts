/**
 * Cross-session asset library: persists user-promoted canvas elements to
 * `~/.dsh/aigc-canvas/library/` so they survive session teardown and can
 * be referenced by future sessions (style references, prompt templates,
 * voice samples, final products, ...).
 *
 * Storage layout (per docs/product/04-ux-reliability.md §6):
 *   library/
 *   ├── index.json          # asset index (atomic write: temp + rename)
 *   ├── images/             # image / video / audio asset file copies
 *   └── prompts/            # prompt-template .txt asset file copies
 *
 * The module is self-contained: every function loads/saves the index to
 * disk directly. Callers (tools, JSON API) do not need to thread a store
 * instance through — they just call {@link promoteAsset} / {@link listAssets}
 * / {@link getAsset} / {@link removeAsset}.
 *
 * @module @dsh-external/dsh-aigc-canvas/asset-library
 */
import { homedir } from 'node:os'
import { dirname, join, extname, basename } from 'node:path'
import { mkdir, rename, writeFile, readFile, copyFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AigcError } from './wire.js'

/** Default root directory for the asset library (under the DSH user dir). */
const DEFAULT_LIBRARY_DIR = join(homedir(), '.dsh', 'aigc-canvas', 'library')

/** Mutable library root (overridable by tests via {@link setLibraryDir}). */
let libraryDir = DEFAULT_LIBRARY_DIR

/**
 * Override the library root directory. Tests use this to point at a temp
 * dir so they don't pollute the real `~/.dsh/aigc-canvas/library/`.
 * Production code never calls this.
 */
export function setLibraryDir(dir: string): void {
  libraryDir = dir
}

/** Reset the library root to the default (used by tests in afterEach). */
export function resetLibraryDir(): void {
  libraryDir = DEFAULT_LIBRARY_DIR
}

/** Resolve a path inside the library root. */
function libPath(...segments: string[]): string {
  return join(libraryDir, ...segments)
}

/** Asset categories per docs/product/04-ux-reliability.md §6. */
export const ASSET_CATEGORIES = [
  'style-reference',
  'subject-reference',
  'prompt-template',
  'voice-sample',
  'final-product',
] as const
export type AssetCategory = (typeof ASSET_CATEGORIES)[number]

/** Asset file type (derived from the file extension). */
export type AssetType = 'image' | 'prompt' | 'audio' | 'video'

/** One asset in the library (matches the index.json record shape). */
export interface Asset {
  id: string
  type: AssetType
  /** Relative path under the library root (e.g. "images/asset_abc.png"). */
  filePath: string
  title: string
  tags: string[]
  category: AssetCategory
  originalPrompt?: string
  sourceSessionId?: string
  sourceElementPath?: string
  createdAt: number
  metadata?: Record<string, unknown>
}

/** Index file shape (persisted as index.json). */
interface AssetIndex {
  assets: Asset[]
}

/** Coerce a value to {@link AssetCategory} (throws AigcError on invalid). */
export function coerceAssetCategory(value: unknown): AssetCategory {
  if (typeof value !== 'string' || !(ASSET_CATEGORIES as readonly string[]).includes(value)) {
    throw new AigcError('bad-request', `invalid asset category: ${String(value)}; expected one of ${(ASSET_CATEGORIES as readonly string[]).join(', ')}`)
  }
  return value as AssetCategory
}

/** Infer the asset type from a file extension. */
function typeForExtension(ext: string): AssetType {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return 'image'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv'].includes(e)) return 'video'
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'].includes(e)) return 'audio'
  return 'prompt'
}

/** Atomic write: mkdir + temp file + rename (mirrors provider-store.ts). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  } catch {
    // Best-effort: leave the temp file behind if rename fails.
  }
}

/** Type guard for the persisted index shape. */
function isAssetIndex(v: unknown): v is AssetIndex {
  if (typeof v !== 'object' || v === null) return false
  return Array.isArray((v as { assets?: unknown }).assets)
}

/** Load the index from disk (returns an empty index when absent/unreadable). */
async function loadIndex(): Promise<AssetIndex> {
  try {
    const raw = await readFile(libPath('index.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isAssetIndex(parsed) ? parsed : { assets: [] }
  } catch {
    return { assets: [] }
  }
}

/** Serializes disk writes so rapid mutations can't interleave. */
let persistChain: Promise<void> = Promise.resolve()

/** Persist the index to disk (serialized; swallows errors like ProviderStore). */
function persistIndex(index: AssetIndex): void {
  const snapshot = { assets: [...index.assets] }
  persistChain = persistChain
    .then(() => writeJsonAtomic(libPath('index.json'), snapshot))
    .catch(() => {})
}

/**
 * Ensure the library directory structure exists. Idempotent — safe to call
 * before every operation. Creates `images/` and `prompts/` subdirectories
 * and an empty `index.json` when absent.
 */
export async function initLibrary(): Promise<void> {
  await mkdir(libPath('images'), { recursive: true })
  await mkdir(libPath('prompts'), { recursive: true })
  const indexPath = libPath('index.json')
  try {
    await stat(indexPath)
  } catch {
    await writeJsonAtomic(indexPath, { assets: [] })
  }
}

/** Parameters for {@link promoteAsset}. */
export interface PromoteAssetParams {
  /** Absolute path of the source file (the canvas element's filePath). */
  sourceFilePath: string
  category: AssetCategory
  title?: string
  tags?: string[]
  originalPrompt?: string
  sourceSessionId?: string
  sourceElementPath?: string
  metadata?: Record<string, unknown>
}

/**
 * Promote one canvas element (file copy) to the library. The source file
 * is copied (not moved) into `library/images/` or `library/prompts/`, and
 * a new {@link Asset} record is appended to `index.json`.
 *
 * The copy is independent of the original session — deleting the session
 * canvas dir afterwards leaves the library asset intact.
 */
export async function promoteAsset(params: PromoteAssetParams): Promise<Asset> {
  await initLibrary()
  const info = await stat(params.sourceFilePath).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    throw new AigcError('bad-request', `source file not found or not a regular file: ${params.sourceFilePath}`)
  }
  const ext = extname(params.sourceFilePath)
  const type = typeForExtension(ext)
  const id = `asset_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const subdir = type === 'prompt' ? 'prompts' : 'images'
  const destRel = `${subdir}/${id}${ext}`
  await copyFile(params.sourceFilePath, libPath(destRel))
  const asset: Asset = {
    id,
    type,
    filePath: destRel,
    title: params.title ?? basename(params.sourceFilePath, ext),
    tags: params.tags ?? [],
    category: params.category,
    createdAt: Date.now(),
    ...(params.originalPrompt !== undefined ? { originalPrompt: params.originalPrompt } : {}),
    ...(params.sourceSessionId !== undefined ? { sourceSessionId: params.sourceSessionId } : {}),
    ...(params.sourceElementPath !== undefined ? { sourceElementPath: params.sourceElementPath } : {}),
    ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
  }
  const index = await loadIndex()
  index.assets.push(asset)
  persistIndex(index)
  await persistChain
  return asset
}

/** Optional filters for {@link listAssets}. */
export interface ListAssetsFilter {
  type?: AssetType
  category?: AssetCategory
  /** Assets matching ALL of these tags are returned. */
  tags?: string[]
  /** Case-insensitive substring search over title + originalPrompt + tags. */
  search?: string
}

/**
 * List assets with optional filters. Filters are AND-combined. The result
 * is sorted by `createdAt` ascending (oldest first) for stable display.
 */
export async function listAssets(filter?: ListAssetsFilter): Promise<Asset[]> {
  const index = await loadIndex()
  let result = index.assets
  if (filter?.type !== undefined) {
    result = result.filter(a => a.type === filter.type)
  }
  if (filter?.category !== undefined) {
    result = result.filter(a => a.category === filter.category)
  }
  if (filter?.tags !== undefined && filter.tags.length > 0) {
    result = result.filter(a => filter.tags!.every(t => a.tags.includes(t)))
  }
  if (filter?.search !== undefined && filter.search !== '') {
    const q = filter.search.toLowerCase()
    result = result.filter(a =>
      a.title.toLowerCase().includes(q)
      || (a.originalPrompt ?? '').toLowerCase().includes(q)
      || a.tags.some(t => t.toLowerCase().includes(q)),
    )
  }
  return [...result].sort((a, b) => a.createdAt - b.createdAt)
}

/** Result of {@link getAsset}: the asset record + its absolute filePath. */
export interface AssetWithPath extends Asset {
  /** Absolute path of the asset file on disk (for direct reference). */
  absoluteFilePath: string
}

/**
 * Get one asset by id. Returns the asset record plus its absolute file
 * path (so the caller — tool or API — can hand the path to aigc_http_request's
 * `$base64` placeholder or to a file-serving route).
 */
export async function getAsset(assetId: string): Promise<AssetWithPath> {
  const index = await loadIndex()
  const asset = index.assets.find(a => a.id === assetId)
  if (asset === undefined) {
    throw new AigcError('not-found', `asset not found: ${assetId}`, 404)
  }
  return { ...asset, absoluteFilePath: libPath(asset.filePath) }
}

/**
 * Remove an asset: deletes the file copy from disk and removes the record
 * from the index. Returns false when the id is unknown (idempotent on the
 * index side; orphaned files from a crashed promote are best-effort cleaned).
 */
export async function removeAsset(assetId: string): Promise<boolean> {
  const index = await loadIndex()
  const idx = index.assets.findIndex(a => a.id === assetId)
  if (idx === -1) return false
  const [asset] = index.assets.splice(idx, 1)
  await rm(libPath(asset.filePath), { force: true }).catch(() => {})
  persistIndex(index)
  await persistChain
  return true
}

/**
 * Resolve an asset's relative filePath to an absolute path. Used by tools
 * that already hold the asset record and just need the disk path.
 */
export function resolveAssetPath(relativePath: string): string {
  return libPath(relativePath)
}
