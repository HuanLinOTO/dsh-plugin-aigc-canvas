/**
 * @huanlin/dsh-plugin-aigc-canvas host half: the canvas registry, the provider
 * store (config + per-provider usage instructions), the fenced
 * `/aigc-canvas/api/*` JSON API (provider CRUD + canvas.list/move) +
 * `/aigc-canvas/file` media route + `/aigc-canvas/ws/canvas` push WebSocket,
 * and the `ctx.aigcCanvas` service.
 *
 * Model-facing tools (see tools.ts): aigc_get_provider_info, the generic
 * aigc_http_request (auto-attaches endpoint + apiKey per provider config),
 * aigc_provider_set_instructions (the model records its 调用说明 after
 * probing the API), aigc_canvas_place / aigc_canvas_link / aigc_canvas_unlink
 * (put files on the free canvas), and aigc_canvas_list_elements.
 *
 * Provider config is editable at runtime: the settings page posts to
 * `/aigc-canvas/api/providers.add|update|remove`, which updates the
 * ProviderStore. Tools read the provider through a getter so they always
 * see the latest configuration.
 */
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context } from './context-types.js'
import {
  Config,
  resolveAigcConfig,
  type AigcCanvasConfig,
  type AigcProvider,
  type ResolvedAigcConfig,
  type ResolvedAigcProvider,
} from './config.js'
import { ProviderStore } from './provider-store.js'
import {
  canvasDirFor,
  createAigcCanvasService,
  mimeTypeFor,
  type AigcCanvasService,
  type AigcElement,
} from './canvas-registry.js'
import type { AigcAgent, AigcUserMessage } from './context-types.js'
import { isTrustedApiRequest } from './trust-fence.js'
import { registerTools } from './tools.js'
import { AigcError, readJsonBody, requireString, writeError, writeJson, writeOk } from './wire.js'

export { Config }
export type { AigcCanvasConfig, AigcProvider, ResolvedAigcConfig, ResolvedAigcProvider }
export type { Context } from './context-types.js'
export type {
  AigcCanvasService,
  AigcElement,
  AigcEdge,
  AigcCanvasState,
  AigcElementKind,
} from './canvas-registry.js'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-aigc-canvas'

/** Services required before mounting. */
export const inject = ['webServer', 'sessions', 'agents', 'loader', 'tools']

/** The connection row's resolved trustedHosts (live read). */
function trustedHostsOf(ctx: Context): string[] {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name === 'connection') {
      const config = entry.options.config as { trustedHosts?: string[] } | undefined
      return config?.trustedHosts ?? []
    }
  }
  return []
}

/**
 * Resolve a session's authoritative working directory.
 * Throws when the session isn't registered yet (e.g. right after a
 * restart, before the session list is loaded) — this prevents the
 * canvas hydrate logic from silently reading the wrong directory and
 * caching an empty table.
 */
function sessionCwdOf(ctx: Context, sessionId: string): string {
  const session = ctx.sessions.get(sessionId)
  const headerCwd = session?.header.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  throw new AigcError('not-found', `session "${sessionId}" is not registered or has no cwd yet`, 404)
}

/** Wire shape for one provider (what the settings page reads/writes). */
type RuntimeProvider = ResolvedAigcProvider

/** Wire shape for the global settings. */
interface RuntimeGlobalSettings {
  requestTimeoutMs: number
  mediaSizeLimit: number
}

/** Convert a resolved config to the runtime global settings wire shape. */
function toGlobalSettings(resolved: ResolvedAigcConfig): RuntimeGlobalSettings {
  return {
    requestTimeoutMs: resolved.requestTimeoutMs,
    mediaSizeLimit: resolved.mediaSizeLimit,
  }
}

/**
 * Build a minimal user-role message and inject it into the agent's
 * next-step context (non-waking). Used to notify the model of user-
 * initiated canvas actions (deletions, drag-dropped files).
 */
function notifyAgent(ctx: Context, sessionId: string, text: string, summary: string): void {
  const agent = ctx.agents.get(sessionId) as AigcAgent | undefined
  if (agent === undefined) return
  const message: AigcUserMessage = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-aigc-canvas', form: 'notice', summary: summary.slice(0, 120) },
  }
  agent.inject(message)
}

/** Infer element kind from a file extension (for drag-drop uploads). */
function kindForExtension(ext: string): 'image' | 'video' | 'audio' | 'prompt' {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return 'image'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(e)) return 'video'
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(e)) return 'audio'
  return 'prompt'
}

/** Build the JSON API method table. */
function buildApi(
  ctx: Context,
  canvas: AigcCanvasService,
  store: ProviderStore,
  getResolved: () => ResolvedAigcConfig,
): Record<string, (payload: unknown) => Promise<unknown> | unknown> {
  return {
    'canvas.list': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      await canvas.ensureHydrated(sessionId)
      return canvas.snapshot(sessionId)
    },
    'canvas.move': (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const uuid = requireString(payload, 'uuid')
      const record = payload as Record<string, unknown> | null
      const x = record?.x
      const y = record?.y
      if (typeof x !== 'number' || typeof y !== 'number') {
        throw new AigcError('bad-request', 'x and y are required numbers')
      }
      return canvas.updatePosition(sessionId, uuid, x, y)
    },
    'canvas.delete': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const uuid = requireString(payload, 'uuid')
      // Fetch the element BEFORE deleting so we can describe it in the
      // context-injection notice (title/kind/description).
      let el: AigcElement | undefined
      try { el = canvas.getElement(sessionId, uuid) } catch { /* not found — proceed to delete which will throw */ }
      await canvas.deleteElement(sessionId, uuid)
      if (el !== undefined) {
        const desc = el.description !== undefined ? ` ("${el.description}")` : ''
        notifyAgent(
          ctx,
          sessionId,
          `User deleted the canvas element "${el.title}"${desc} (${el.kind}, filePath: ${el.filePath}). It is no longer on the canvas — do not reference it in future aigc_canvas_place / aigc_canvas_link calls.`,
          `user deleted ${el.kind} "${el.title}"`,
        )
      }
      return { ok: true }
    },
    'canvas.upload': async (payload) => {
      // payload is { sessionId, fileName, mediaBase64, x?, y?, description? }
      const sessionId = requireString(payload, 'sessionId')
      const record = payload as Record<string, unknown> | null
      const fileName = typeof record?.fileName === 'string' ? record.fileName : ''
      const mediaBase64 = typeof record?.mediaBase64 === 'string' ? record.mediaBase64 : ''
      if (fileName === '' || mediaBase64 === '') {
        throw new AigcError('bad-request', 'fileName and mediaBase64 are required strings')
      }
      const bytes = Buffer.from(mediaBase64, 'base64')
      if (bytes.byteLength > getResolved().mediaSizeLimit) {
        throw new AigcError('fs-error', `uploaded file too large (${bytes.byteLength} bytes)`)
      }
      const cwd = sessionCwdOf(ctx, sessionId)
      const dir = canvasDirFor(cwd, sessionId)
      await mkdir(dir, { recursive: true })
      const uuid = randomUUID()
      const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : 'bin'
      const kind = kindForExtension(ext)
      const filePath = join(dir, `${uuid}.${ext}`)
      await writeFile(filePath, bytes)
      const title = fileName.replace(/\.[^.]+$/, '')
      const description = typeof record?.description === 'string' ? record.description.slice(0, 40) : undefined
      // Auto-place using the canvas service (no explicit x/y → host stacks).
      const el = await canvas.placeFile(sessionId, {
        kind,
        filePath,
        title,
        producedBy: 'user-upload',
        ...(typeof record?.x === 'number' ? { x: record.x } : {}),
        ...(typeof record?.y === 'number' ? { y: record.y } : {}),
        ...(description !== undefined ? { description } : {}),
      }, cwd)
      notifyAgent(
        ctx,
        sessionId,
        `User dragged a file onto the canvas: "${fileName}" (${kind}, ${bytes.byteLength} bytes). It is now placed as element "${el.title}" at (${el.x}, ${el.y}) with filePath ${el.filePath}. You can reference it in future generation calls.`,
        `user uploaded ${kind} "${el.title}"`,
      )
      return { ok: true, element: el }
    },
    'providers.list': () => {
      return { providers: store.list() }
    },
    'providers.add': (payload) => {
      const record = payload as { provider?: unknown } | null
      const provider = record?.provider
      if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
        throw new AigcError('bad-request', 'expected { provider: AigcProvider }')
      }
      const result = store.add(provider as AigcProvider)
      if (!result.ok) throw new AigcError('bad-request', result.error)
      return { providers: result.providers }
    },
    'providers.update': (payload) => {
      const record = payload as { provider?: unknown } | null
      const provider = record?.provider
      if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
        throw new AigcError('bad-request', 'expected { provider: AigcProvider }')
      }
      const result = store.update(provider as AigcProvider)
      if (!result.ok) throw new AigcError('bad-request', result.error)
      return { providers: result.providers }
    },
    'providers.remove': (payload) => {
      const record = payload as { id?: unknown } | null
      const id = record?.id
      if (typeof id !== 'string' || id === '') {
        throw new AigcError('bad-request', 'expected { id: string }')
      }
      const result = store.remove(id)
      if (!result.ok) throw new AigcError('bad-request', result.error)
      return { providers: result.providers }
    },
    'config.get': () => {
      return { ...toGlobalSettings(getResolved()), providers: store.list() }
    },
  }
}

/** Plugin body. */
export function apply(ctx: Context, config?: AigcCanvasConfig): void {
  const resolved = resolveAigcConfig(config)
  const trustedHosts = trustedHostsOf(ctx)
  const fence = (req: IncomingMessage): boolean => isTrustedApiRequest(req, trustedHosts)
  const mediaLimit = (): number => resolved.mediaSizeLimit
  const canvas = createAigcCanvasService((sessionId) => sessionCwdOf(ctx, sessionId), mediaLimit)
  ctx.provide('aigcCanvas', canvas)

  // Provider store (in-memory; settings-page CRUD + the model's
  // aigc_provider_set_instructions both write through it).
  const store = new ProviderStore(resolved.providers)

  const getResolved = (): ResolvedAigcConfig => ({
    providers: store.list(),
    requestTimeoutMs: resolved.requestTimeoutMs,
    mediaSizeLimit: resolved.mediaSizeLimit,
  })

  // Provider lookup for tools: by provider id, falling back to the default.
  const getProvider = (providerId?: string): ResolvedAigcProvider => {
    if (providerId !== undefined && providerId !== '') {
      const provider = store.get(providerId)
      if (provider === undefined) {
        throw new AigcError('bad-request', `unknown provider_id "${providerId}"; call aigc_get_provider_info to list available providers`)
      }
      return provider
    }
    const def = store.defaultProvider()
    if (def === undefined) {
      throw new AigcError('bad-request', 'no AIGC providers configured; add one in the settings page')
    }
    return def
  }

  // Provider info list for the aigc_get_provider_info tool.
  const listProviders = (): readonly { id: string; name: string; endpoint: string; instructions: string; isStub: boolean; isDefault: boolean }[] => {
    const list = store.list()
    const defaultId = store.defaultProvider()?.id
    return list.map(p => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      instructions: p.instructions,
      isStub: p.endpoint === '' || p.endpoint === 'stub://aigc-backend',
      isDefault: p.id === defaultId,
    }))
  }

  const api = buildApi(ctx, canvas, store, getResolved)

  // ── JSON API ────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/aigc-canvas/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/aigc-canvas/api/') ? pathname.slice('/aigc-canvas/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new AigcError('not-found', 'unknown aigc-canvas API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new AigcError('not-found', `unknown aigc-canvas API method "${method}"`, 404)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-aigc-canvas: /aigc-canvas/api routes')

  // ── Media route ─────────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/aigc-canvas/file',
    handler: async (req, res) => {
      if (!fence(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const uuid = url.searchParams.get('uuid')
        if (sessionId === null || uuid === null) throw new AigcError('bad-request', 'sessionId and uuid are required')
        await canvas.ensureHydrated(sessionId)
        const el = canvas.getElement(sessionId, uuid)
        if (el.filePath === undefined) {
          throw new AigcError('not-found', `element "${uuid}" has no file`, 404)
        }
        const cwd = sessionCwdOf(ctx, sessionId)
        const dir = canvasDirFor(cwd, sessionId)
        if (!isAbsolute(el.filePath) || !el.filePath.startsWith(dir)) {
          throw new AigcError('fs-error', 'file path outside the session canvas directory', 403)
        }
        const info = await stat(el.filePath)
        if (!info.isFile() || info.size > resolved.mediaSizeLimit) {
          throw new AigcError('fs-error', 'not a file or too large', 400)
        }
        const type = mimeTypeFor(el.kind)
        const body = await readFile(el.filePath)
        const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-cache' }
        if (url.searchParams.get('download') === '1') {
          headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(el.filePath))}`
        }
        res.writeHead(200, headers)
        res.end(body)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-aigc-canvas: /aigc-canvas/file media route')

  // ── Canvas push WebSocket ───────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/aigc-canvas/ws/canvas',
    handler: (req, socket, head) => {
      if (!fence(req)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void attachCanvasPush(canvas, ws, req)
      })
    },
  }), 'dsh-aigc-canvas: canvas push WebSocket')

  // ── Register the seven model-facing tools ───────────────────────────────
  ctx.effect(() => registerTools(
    ctx,
    getProvider,
    (id, instructions) => store.setInstructions(id, instructions),
    listProviders,
    canvas,
    (sessionId) => sessionCwdOf(ctx, sessionId),
    () => resolved.requestTimeoutMs,
    () => resolved.mediaSizeLimit,
  ))

  ctx.effect(() => () => {
    wss.close()
  }, 'dsh-aigc-canvas: teardown')
}

/** Push the live canvas state for one session to a connected canvas view. */
async function attachCanvasPush(
  canvas: AigcCanvasService,
  ws: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) {
      ws.close(1008, 'sessionId is required')
      return
    }
    const send = (): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(canvas.snapshot(sessionId)))
      }
    }
    // Initial hydration. The session might not be registered yet (e.g.
    // right after a dsh restart, before the session list is loaded), so
    // retry a few times with a short delay until the session's cwd is
    // available and the persisted canvas.json (if any) is loaded.
    await canvas.ensureHydrated(sessionId)
    send()
    let retries = 0
    const retryTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(retryTimer)
        return
      }
      retries++
      const snap = canvas.snapshot(sessionId)
      if (snap.elements.length > 0) {
        // Data loaded — stop retrying.
        clearInterval(retryTimer)
        return
      }
      if (retries >= 20) {
        // Give up after ~20 seconds.
        clearInterval(retryTimer)
        return
      }
      // Re-attempt hydration (no-op if already hydrated).
      void canvas.ensureHydrated(sessionId).then(() => send())
    }, 1000)
    ws.on('close', () => { clearInterval(retryTimer) })
    ws.on('error', () => { clearInterval(retryTimer) })
    const unsubscribe = canvas.subscribeSession(sessionId, send)
    ws.on('close', () => { unsubscribe() })
    ws.on('error', () => { unsubscribe() })
  } catch (error) {
    ws.close(1011, error instanceof Error ? error.message : String(error))
  }
}
