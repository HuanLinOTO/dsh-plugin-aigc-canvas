import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import z from "schemastery";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
//#region src/config.ts
/**
* Serializable configuration and defaults for the AIGC canvas host half.
* The `providers` array holds one or more AIGC provider configs (name /
* endpoint / apiKey / instructions), editable at runtime through the DSH
* GUI settings page; cordis.yml `config:` is the first-boot seed only.
*
* @module @dsh-external/dsh-aigc-canvas/config
*/
/** Provider id pattern: lowercase letters, digits, hyphens; must start with a letter. */
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Schemastery schema for the per-provider auth config. */
const ProviderAuthSchema = z.object({
	scheme: z.union([
		"bearer",
		"header",
		"query"
	]).description("How to attach the apiKey: bearer (Authorization: Bearer <key>), header (<name>: <key>), or query (<name>=<key>).").default("bearer"),
	name: z.string().description("Header name (scheme=header) or query param name (scheme=query). Ignored for bearer.").default("")
});
/** Schemastery schema for one provider. */
const ProviderSchema = z.object({
	id: z.string().description("Provider id (lowercase, hyphenated; used as the provider_id tool param).").default(""),
	name: z.string().description("Provider display name (e.g. \"Volcano Engine\", \"Jimeng\", \"MiniMax\").").default(""),
	endpoint: z.string().description("Provider API endpoint URL. Use \"stub://aigc-backend\" for the built-in stub.").default("stub://aigc-backend"),
	apiKey: z.string().description("Provider API key. Leave empty for the stub backend.").default(""),
	instructions: z.string().description("Free-form usage instructions for the agent (call aigc_get_provider_info to read).").default(""),
	auth: ProviderAuthSchema.description("How the aigc_http_request tool attaches the apiKey.").default({
		scheme: "bearer",
		name: ""
	}),
	builtin: z.boolean().description("Whether this provider is a builtin seed (cordis.yml).").default(false)
});
/** Schemastery schema for the plugin configuration. */
const Config = z.object({
	providers: z.array(ProviderSchema).description("One or more AIGC providers; the first is the default.").default([{
		id: "stub",
		name: "",
		endpoint: "stub://aigc-backend",
		apiKey: "",
		instructions: "",
		auth: {
			scheme: "bearer",
			name: ""
		},
		builtin: true
	}]),
	requestTimeoutMs: z.number().step(1).min(1e3).default(3e5),
	mediaSizeLimit: z.number().step(1).min(1024).default(104857600)
});
/** Returns true when the provider endpoint points at the built-in stub backend. */
function isStubEndpoint(endpoint) {
	return endpoint === "" || endpoint === "stub://aigc-backend";
}
/** Validate a provider id; returns an error message or undefined if valid. */
function validateProviderId(id) {
	if (id === "") return "provider id is required";
	if (!PROVIDER_ID_PATTERN.test(id)) return `invalid provider id: ${JSON.stringify(id)} (must be lowercase, hyphenated, start with a letter)`;
}
/** Migrate + resolve a single provider from config input. */
function resolveProvider(p) {
	const auth = p.auth ?? {};
	return {
		id: p.id,
		name: p.name ?? "",
		endpoint: p.endpoint ?? "stub://aigc-backend",
		apiKey: p.apiKey ?? "",
		instructions: p.instructions ?? "",
		auth: {
			scheme: auth.scheme ?? "bearer",
			name: auth.name ?? ""
		},
		builtin: p.builtin ?? false
	};
}
/** Apply direct-call defaults after Loader schema validation has normally run. */
function resolveAigcConfig(config) {
	const providers = (config?.providers ?? []).map(resolveProvider);
	if (providers.length === 0) providers.push({
		id: "stub",
		name: "",
		endpoint: "stub://aigc-backend",
		apiKey: "",
		instructions: "",
		auth: {
			scheme: "bearer",
			name: ""
		},
		builtin: true
	});
	return {
		providers,
		requestTimeoutMs: config?.requestTimeoutMs ?? 3e5,
		mediaSizeLimit: config?.mediaSizeLimit ?? 104857600
	};
}
//#endregion
//#region src/provider-store.ts
/**
* In-memory provider store with CRUD + disk persistence. Holds the
* canonical list of AIGC providers; tool registration and the settings-
* page RPC share one instance per plugin fiber. Persisted to
* `~/.dsh/aigc-canvas/providers.json` so restarts keep user-added
* providers and instructions.
*
* @module @dsh-external/dsh-aigc-canvas/provider-store
*/
/** Directory for persisted AIGC canvas state (under the DSH user dir). */
const DATA_DIR = join(homedir(), ".dsh", "aigc-canvas");
/** Path to the persisted providers JSON. */
const PROVIDERS_JSON = join(DATA_DIR, "providers.json");
/** Atomic write: mkdir + temp file + rename. */
async function writeJsonAtomic$1(path, value) {
	const tmp = `${path}.tmp-${process.pid}`;
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
		await rename(tmp, path);
	} catch {}
}
/**
* Mutable provider store. Owns the canonical provider list; the backend
* client map and RPC handlers share one instance per plugin fiber.
*
* Persistence: on construction the store loads `~/.dsh/aigc-canvas/
* providers.json` (if present) and merges it over the cordis.yml seed —
* persisted providers win, so user edits and deletions survive restarts.
* Every mutation writes the list back to disk (fire-and-forget).
*/
var ProviderStore = class {
	providers = /* @__PURE__ */ new Map();
	dataPath;
	/** Serializes disk writes so rapid mutations can't interleave. */
	persistChain = Promise.resolve();
	constructor(seed, dataPath = PROVIDERS_JSON) {
		this.dataPath = dataPath;
		const seedBuiltin = new Map(seed.map((p) => [p.id, p.builtin ?? false]));
		const sources = loadPersistedSync(dataPath) ?? seed;
		for (const p of sources) {
			const resolved = {
				id: p.id,
				name: p.name ?? "",
				endpoint: p.endpoint ?? "stub://aigc-backend",
				apiKey: p.apiKey ?? "",
				instructions: p.instructions ?? "",
				auth: {
					scheme: p.auth?.scheme ?? "bearer",
					name: p.auth?.name ?? ""
				},
				builtin: seedBuiltin.get(p.id) ?? false
			};
			this.providers.set(resolved.id, resolved);
		}
	}
	/** Snapshot of all providers, in insertion order. */
	list() {
		return [...this.providers.values()];
	}
	/** Look up one provider by id. */
	get(id) {
		return this.providers.get(id);
	}
	/** The default provider (first in insertion order); undefined if empty. */
	defaultProvider() {
		return this.providers.values().next().value;
	}
	/** Add a new provider. Returns failure for duplicate id or invalid shape. */
	add(provider) {
		const idError = validateProviderId(provider.id);
		if (idError !== void 0) return {
			ok: false,
			error: idError
		};
		if (this.providers.has(provider.id)) return {
			ok: false,
			error: `provider id already exists: ${provider.id}`
		};
		const stored = {
			id: provider.id,
			name: provider.name ?? "",
			endpoint: provider.endpoint ?? "stub://aigc-backend",
			apiKey: provider.apiKey ?? "",
			instructions: provider.instructions ?? "",
			auth: {
				scheme: provider.auth?.scheme ?? "bearer",
				name: provider.auth?.name ?? ""
			},
			builtin: false
		};
		this.providers.set(stored.id, stored);
		this.persist();
		return {
			ok: true,
			providers: this.list()
		};
	}
	/** Update an existing provider. Returns failure if the id is unknown. */
	update(provider) {
		const idError = validateProviderId(provider.id);
		if (idError !== void 0) return {
			ok: false,
			error: idError
		};
		const existing = this.providers.get(provider.id);
		if (existing === void 0) return {
			ok: false,
			error: `provider id not found: ${provider.id}`
		};
		const stored = {
			id: provider.id,
			name: provider.name ?? "",
			endpoint: provider.endpoint ?? "stub://aigc-backend",
			apiKey: provider.apiKey ?? "",
			instructions: provider.instructions ?? "",
			auth: {
				scheme: provider.auth?.scheme ?? existing.auth.scheme,
				name: provider.auth?.name ?? existing.auth.name
			},
			builtin: existing.builtin
		};
		this.providers.set(stored.id, stored);
		this.persist();
		return {
			ok: true,
			providers: this.list()
		};
	}
	/**
	* Replace a provider's usage instructions (called by the model's
	* aigc_provider_set_instructions tool after it probes the API).
	*/
	setInstructions(id, instructions) {
		const existing = this.providers.get(id);
		if (existing === void 0) return {
			ok: false,
			error: `provider id not found: ${id}`
		};
		const stored = {
			...existing,
			instructions
		};
		this.providers.set(stored.id, stored);
		this.persist();
		return {
			ok: true,
			providers: this.list()
		};
	}
	/** Remove a provider. Returns failure for unknown id. */
	remove(id) {
		if (!this.providers.delete(id)) return {
			ok: false,
			error: `provider id not found: ${id}`
		};
		this.persist();
		return {
			ok: true,
			providers: this.list()
		};
	}
	/**
	* Persist the current provider list to disk (fire-and-forget, serialized).
	* Only the user-editable fields are written; `builtin` is re-derived from
	* the seed on load. Failures are swallowed — the in-memory state stays
	* canonical. Each call snapshots the CURRENT list, so a burst of mutations
	* ends with the latest state on disk.
	*/
	persist() {
		const snapshot = [...this.providers.values()].map(({ builtin: _b, ...rest }) => rest);
		this.persistChain = this.persistChain.then(() => writeJsonAtomic$1(this.dataPath, snapshot)).catch(() => {});
	}
};
/** Read the persisted providers JSON; returns null when absent/unreadable. */
function loadPersistedSync(dataPath) {
	try {
		const raw = readFileSync(dataPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const providers = [];
		for (const item of parsed) {
			if (typeof item !== "object" || item === null) continue;
			const rec = item;
			if (typeof rec.id !== "string" || rec.id === "") continue;
			providers.push({
				id: rec.id,
				name: typeof rec.name === "string" ? rec.name : "",
				endpoint: typeof rec.endpoint === "string" ? rec.endpoint : "stub://aigc-backend",
				apiKey: typeof rec.apiKey === "string" ? rec.apiKey : "",
				instructions: typeof rec.instructions === "string" ? rec.instructions : "",
				...typeof rec.auth === "object" && rec.auth !== null ? { auth: {
					scheme: rec.auth.scheme === "header" || rec.auth.scheme === "query" ? rec.auth.scheme : "bearer",
					name: typeof rec.auth.name === "string" ? rec.auth.name : ""
				} } : {}
			});
		}
		return providers;
	} catch {
		return null;
	}
}
//#endregion
//#region src/wire.ts
/** One API failure with its wire code and HTTP status. */
var AigcError = class extends Error {
	code;
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20;
/** Read and parse the JSON request body (bounded; malformed → bad-request). */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new AigcError("bad-request", "request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new AigcError("bad-request", "request body is not valid JSON");
	}
}
/** Write a JSON response with the given status. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}
/** Write the success envelope. */
function writeOk(res, value) {
	writeJson(res, 200, {
		ok: true,
		value
	});
}
/** Write the failure envelope for any thrown value (unknown → internal 500). */
function writeError(res, error) {
	if (error instanceof AigcError) {
		writeJson(res, error.status, {
			ok: false,
			error: {
				code: error.code,
				message: error.message
			}
		});
		return;
	}
	writeJson(res, 500, {
		ok: false,
		error: {
			code: "internal",
			message: error instanceof Error ? error.message : String(error)
		}
	});
}
/** Narrow an unknown payload value to a string, else throw bad-request. */
function requireString(payload, key) {
	const value = payload?.[key];
	if (typeof value !== "string" || value === "") throw new AigcError("bad-request", `missing or invalid "${key}"`);
	return value;
}
//#endregion
//#region src/canvas-registry.ts
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
/** File extension for each media kind (no leading dot). */
function extensionFor(kind) {
	switch (kind) {
		case "image": return "png";
		case "video": return "mp4";
		case "audio": return "mp3";
		case "prompt": return "txt";
	}
}
/** MIME type for each media kind (for the file route). */
function mimeTypeFor(kind) {
	switch (kind) {
		case "image": return "image/png";
		case "video": return "video/mp4";
		case "audio": return "audio/mpeg";
		case "prompt": return "text/plain; charset=utf-8";
	}
}
/** Folder name under the session cwd where canvas state + media live. */
const CANVAS_DIR = ".dsh-aigc-canvas";
/** Filename inside CANVAS_DIR for the per-session element+edge table. */
const CANVAS_JSON = "canvas.json";
/** Default column X for auto-placed elements (left side of the canvas). */
const AUTO_PLACE_X = 32;
/** Vertical gap between auto-placed elements (pixels of empty space). */
const AUTO_PLACE_GAP = 16;
/** Horizontal gap between auto-placed columns. */
const AUTO_COL_GAP_X = 20;
/** Horizontal gap between a referenced element and the new element placed to its right. */
const REFERENCE_GAP_X = 20;
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
function estimatedCardHeight(kind) {
	switch (kind) {
		case "prompt": return 124;
		case "audio": return 84;
		case "image":
		case "video": return 217;
	}
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
function resolvePlacement(existing, x, y, references, kind) {
	if (x !== void 0 && y !== void 0 && Number.isFinite(x) && Number.isFinite(y)) return {
		x,
		y
	};
	if (references !== void 0 && references.length > 0) {
		let maxRight = -Infinity;
		let sumY = 0;
		for (const ref of references) {
			const right = ref.x + NODE_W_REF;
			if (right > maxRight) maxRight = right;
			sumY += ref.y + NODE_H_REF / 2;
		}
		const avgY = sumY / references.length;
		return {
			x: maxRight + REFERENCE_GAP_X,
			y: avgY - NODE_H_REF / 2
		};
	}
	const newHeight = estimatedCardHeight(kind ?? "image");
	const columns = [];
	let maxRight = -Infinity;
	for (const el of existing) {
		if (typeof el.x !== "number" || typeof el.y !== "number") continue;
		if (el.x > maxRight) maxRight = el.x;
		let col = columns.find((c) => Math.abs(c.x - el.x) < NODE_W_REF / 2);
		if (col === void 0) {
			col = {
				x: el.x,
				bottom: el.y + estimatedCardHeight(el.kind)
			};
			columns.push(col);
		} else {
			const bottom = el.y + estimatedCardHeight(el.kind);
			if (bottom > col.bottom) col.bottom = bottom;
		}
	}
	let best;
	for (const col of columns) if (col.bottom + AUTO_PLACE_GAP + newHeight <= 632) {
		if (best === void 0 || col.bottom < best.bottom) best = col;
	}
	if (best !== void 0) return {
		x: best.x,
		y: best.bottom + AUTO_PLACE_GAP
	};
	return {
		x: maxRight > -Infinity ? maxRight + NODE_W_REF + AUTO_COL_GAP_X : AUTO_PLACE_X,
		y: AUTO_PLACE_X
	};
}
/** Node dimensions mirrored from the client (for placement math only). */
const NODE_W_REF = 240;
const NODE_H_REF = 110;
/** Resolve the per-session canvas directory under the session cwd. */
function canvasDirFor(cwd, sessionId) {
	return join(cwd, CANVAS_DIR, sessionId);
}
/** Resolve the per-session canvas JSON path. */
function canvasJsonPath(cwd, sessionId) {
	return join(canvasDirFor(cwd, sessionId), CANVAS_JSON);
}
/** Resolve the per-session file path for one element (by uuid + kind). */
function elementFilePath(cwd, sessionId, uuid, kind) {
	return join(canvasDirFor(cwd, sessionId), `${uuid}.${extensionFor(kind)}`);
}
/** Atomically write a JSON file (temp file + rename). */
async function writeJsonAtomic(path, value) {
	const tmp = `${path}.tmp-${process.pid}`;
	try {
		await writeFile(tmp, JSON.stringify(value), "utf8");
		await rename(tmp, path);
	} catch (error) {
		await import("node:fs/promises").then(({ rm }) => rm(tmp, { force: true }).catch(() => {}));
		throw new AigcError("fs-error", `cannot persist canvas state: ${error instanceof Error ? error.message : String(error)}`, 500);
	}
}
/**
* Build the service. The `resolveCwd` callback threads the live session cwd;
* `mediaSizeLimit` bounds how large a placed file may be.
*/
function createAigcCanvasService(resolveCwd, mediaSizeLimit = () => 104857600) {
	const elementsBySession = /* @__PURE__ */ new Map();
	const edgesBySession = /* @__PURE__ */ new Map();
	const listeners = /* @__PURE__ */ new Set();
	const sessionListeners = /* @__PURE__ */ new Map();
	const hydrated = /* @__PURE__ */ new Set();
	const hydrating = /* @__PURE__ */ new Set();
	const notify = (sessionId) => {
		for (const fn of [...listeners]) fn(sessionId);
		const set = sessionListeners.get(sessionId);
		if (set !== void 0) for (const fn of [...set]) fn(sessionId);
	};
	const tableOf = (sessionId) => {
		let table = elementsBySession.get(sessionId);
		if (table === void 0) {
			table = /* @__PURE__ */ new Map();
			elementsBySession.set(sessionId, table);
		}
		return table;
	};
	const edgesOf = (sessionId) => {
		let edges = edgesBySession.get(sessionId);
		if (edges === void 0) {
			edges = [];
			edgesBySession.set(sessionId, edges);
		}
		return edges;
	};
	const hydrate = async (sessionId) => {
		if (hydrated.has(sessionId)) return;
		if (hydrating.has(sessionId)) {
			while (hydrating.has(sessionId)) await new Promise((resolve) => setTimeout(resolve, 5));
			return;
		}
		hydrating.add(sessionId);
		try {
			const path = canvasJsonPath(resolveCwd(sessionId), sessionId);
			let raw;
			try {
				raw = await readFile(path, "utf8");
			} catch (err) {
				if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") hydrated.add(sessionId);
				return;
			}
			const parsed = JSON.parse(raw);
			if (parsed.sessionId !== sessionId) {
				hydrated.add(sessionId);
				return;
			}
			const table = tableOf(sessionId);
			for (const el of Array.isArray(parsed.elements) ? parsed.elements : []) if (el && typeof el.uuid === "string") {
				if (typeof el.x !== "number") el.x = 0;
				if (typeof el.y !== "number") el.y = 0;
				table.set(el.uuid, el);
			}
			const edges = edgesOf(sessionId);
			for (const e of Array.isArray(parsed.edges) ? parsed.edges : []) if (e && typeof e.source === "string" && typeof e.target === "string") edges.push(e);
			hydrated.add(sessionId);
			notify(sessionId);
		} catch {} finally {
			hydrating.delete(sessionId);
		}
	};
	const persist = async (sessionId) => {
		const cwd = resolveCwd(sessionId);
		const dir = canvasDirFor(cwd, sessionId);
		await mkdir(dir, { recursive: true });
		const state = {
			sessionId,
			elements: Array.from(tableOf(sessionId).values()),
			edges: edgesOf(sessionId)
		};
		await writeJsonAtomic(canvasJsonPath(cwd, sessionId), state);
	};
	const addPrompt = async (sessionId, params, cwd) => {
		await hydrate(sessionId);
		const uuid = randomUUID();
		const filePath = elementFilePath(cwd, sessionId, uuid, "prompt");
		await mkdir(join(cwd, CANVAS_DIR, sessionId), { recursive: true });
		await writeFile(filePath, params.promptText, "utf8");
		const el = {
			uuid,
			sessionId,
			kind: "prompt",
			title: params.title,
			x: params.x ?? 0,
			y: params.y ?? 0,
			createdAt: Date.now(),
			producedBy: params.producedBy,
			filePath,
			promptText: params.promptText,
			...params.meta !== void 0 ? { meta: params.meta } : {},
			...params.description !== void 0 && params.description !== "" ? { description: params.description } : {}
		};
		tableOf(sessionId).set(el.uuid, el);
		await persist(sessionId);
		notify(sessionId);
		return el;
	};
	const addMedia = async (sessionId, params, cwd) => {
		await hydrate(sessionId);
		const uuid = randomUUID();
		const filePath = elementFilePath(cwd, sessionId, uuid, params.kind);
		await mkdir(join(cwd, CANVAS_DIR, sessionId), { recursive: true });
		await writeFile(filePath, params.mediaBytes);
		const el = {
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
			...params.meta !== void 0 ? { meta: params.meta } : {},
			...params.description !== void 0 && params.description !== "" ? { description: params.description } : {}
		};
		tableOf(sessionId).set(el.uuid, el);
		await persist(sessionId);
		notify(sessionId);
		return el;
	};
	const placeFile = async (sessionId, params, cwd) => {
		await hydrate(sessionId);
		const dir = canvasDirFor(cwd, sessionId);
		const resolved = isAbsolute(params.filePath) ? params.filePath : join(cwd, params.filePath);
		if (!isAbsoluteWithin(dir, resolved)) throw new AigcError("fs-error", `file path outside the session canvas directory: ${params.filePath}`);
		const info = await stat(resolved).catch(() => void 0);
		if (info === void 0 || !info.isFile()) throw new AigcError("fs-error", `file not found or not a regular file: ${params.filePath}`);
		if (info.size > 0 && info.size > mediaSizeLimit()) throw new AigcError("fs-error", `file too large to place on the canvas: ${info.size} bytes`);
		const table = tableOf(sessionId);
		const refPositions = [];
		if (params.referenceUuids !== void 0) for (const refUuid of params.referenceUuids) {
			const ref = table.get(refUuid);
			if (ref !== void 0) refPositions.push({
				x: ref.x,
				y: ref.y
			});
		}
		const pos = resolvePlacement(table.values(), params.x, params.y, refPositions.length > 0 ? refPositions : void 0, params.kind);
		const el = {
			uuid: randomUUID(),
			sessionId,
			kind: params.kind,
			title: params.title,
			x: pos.x,
			y: pos.y,
			createdAt: Date.now(),
			producedBy: params.producedBy,
			filePath: resolved,
			mediaSize: params.kind === "prompt" ? void 0 : info.size,
			...params.promptText !== void 0 ? { promptText: params.promptText } : {},
			...params.meta !== void 0 ? { meta: params.meta } : {},
			...params.description !== void 0 && params.description !== "" ? { description: params.description } : {}
		};
		tableOf(sessionId).set(el.uuid, el);
		await persist(sessionId);
		notify(sessionId);
		return el;
	};
	const updatePosition = async (sessionId, uuid, x, y) => {
		await hydrate(sessionId);
		const el = tableOf(sessionId).get(uuid);
		if (el === void 0) throw new AigcError("not-found", `element "${uuid}" not found in session "${sessionId}"`, 404);
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new AigcError("bad-request", "x and y must be finite numbers");
		el.x = x;
		el.y = y;
		await persist(sessionId);
		notify(sessionId);
		return el;
	};
	const deleteElement = async (sessionId, uuid) => {
		await hydrate(sessionId);
		const table = tableOf(sessionId);
		if (!table.has(uuid)) throw new AigcError("not-found", `element "${uuid}" not found in session "${sessionId}"`, 404);
		table.delete(uuid);
		const edges = edgesOf(sessionId);
		for (let i = edges.length - 1; i >= 0; i--) if (edges[i].source === uuid || edges[i].target === uuid) edges.splice(i, 1);
		await persist(sessionId);
		notify(sessionId);
	};
	const unlink = async (sessionId, sourceUuid, targetUuid) => {
		await hydrate(sessionId);
		const edges = edgesOf(sessionId);
		const index = edges.findIndex((e) => e.source === sourceUuid && e.target === targetUuid);
		if (index === -1) return;
		edges.splice(index, 1);
		await persist(sessionId);
		notify(sessionId);
	};
	const wireEdges = async (sessionId, inputUuids, targetUuid) => {
		await hydrate(sessionId);
		const table = tableOf(sessionId);
		if (!table.has(targetUuid)) throw new AigcError("not-found", `target element "${targetUuid}" not found in session "${sessionId}"`, 404);
		const edges = edgesOf(sessionId);
		for (const source of inputUuids) {
			if (!table.has(source)) throw new AigcError("not-found", `source element "${source}" not found in session "${sessionId}"`, 404);
			if (edges.some((e) => e.source === source && e.target === targetUuid)) continue;
			edges.push({
				source,
				target: targetUuid
			});
		}
		await persist(sessionId);
		notify(sessionId);
	};
	const getElement = (sessionId, uuid) => {
		const el = tableOf(sessionId).get(uuid);
		if (el === void 0) throw new AigcError("not-found", `element "${uuid}" not found in session "${sessionId}"`, 404);
		return el;
	};
	const getElementByPath = (sessionId, filePath) => {
		const table = tableOf(sessionId);
		for (const el of table.values()) if (el.filePath === filePath) return el;
		throw new AigcError("not-found", `element with filePath "${filePath}" not found in session "${sessionId}"`, 404);
	};
	const snapshot = (sessionId) => ({
		sessionId,
		elements: Array.from(tableOf(sessionId).values()),
		edges: edgesOf(sessionId)
	});
	const subscribe = (listener) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const subscribeSession = (sessionId, listener) => {
		let set = sessionListeners.get(sessionId);
		if (set === void 0) {
			set = /* @__PURE__ */ new Set();
			sessionListeners.set(sessionId, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) sessionListeners.delete(sessionId);
		};
	};
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
		subscribeSession
	};
}
/** True when `target` (absolute or relative) resolves inside `dir`. */
function isAbsoluteWithin(dir, target) {
	const resolved = isAbsolute(target) ? target : join(dir, target);
	const normalizedDir = dir.endsWith(sep) ? dir : `${dir}${sep}`;
	const a = resolved.toLowerCase();
	const b = normalizedDir.toLowerCase();
	return a === dir.toLowerCase() || a.startsWith(b);
}
//#endregion
//#region src/trust-fence.ts
function header(headers, name) {
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === void 0) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}
/**
* Decide whether one aigc-canvas request may reach the plugin routes.
* @param request - node HTTP request facts (headers).
* @param trustedHosts - non-loopback authorities this deployment serves.
* @returns true when the Host is ours (loopback or trusted) and browser markers are same-origin.
*/
function isTrustedApiRequest(request, trustedHosts) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/provider-http.ts
/** Cap on how much of a failure body is surfaced to the model. */
const FAILURE_TEXT_CAP = 4096;
/**
* Cap on inline text responses. The model-facing tool result is size-
* limited by the host framework (very small — a few hundred chars), so
* anything larger is saved to disk and the model gets a file_path with a
* short preview instead.
*/
const INLINE_TEXT_CAP = 2e3;
/** Directory containing the bundled stub assets (../assets from lib/). */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
/** Cached stub asset bytes, keyed by filename. */
const assetCache = /* @__PURE__ */ new Map();
/**
* Load a bundled stub asset, caching the result. Falls back to a synthetic
* minimal buffer if the asset file is missing (broken install) so the stub
* still functions — just with less pretty media.
*/
async function loadStubAsset(filename, fallback) {
	const cached = assetCache.get(filename);
	if (cached !== void 0) return cached;
	try {
		const bytes = await readFile(join(ASSETS_DIR, filename));
		const buf = Buffer.from(bytes);
		assetCache.set(filename, buf);
		return buf;
	} catch {
		const fb = fallback();
		assetCache.set(filename, fb);
		return fb;
	}
}
/** Synthetic 1×1 PNG (fallback when the bundled asset is missing). */
function fallbackPng() {
	const magic = Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]);
	const ihdr = Buffer.from([
		0,
		0,
		0,
		13,
		73,
		72,
		68,
		82,
		0,
		0,
		0,
		1,
		0,
		0,
		0,
		1,
		8,
		6,
		0,
		0,
		0,
		31,
		21,
		196,
		137
	]);
	const idat = Buffer.from([
		0,
		0,
		0,
		10,
		73,
		68,
		65,
		84,
		120,
		156,
		99,
		0,
		1,
		0,
		0,
		0,
		2,
		0,
		1
	]);
	const iend = Buffer.from([
		0,
		0,
		0,
		0,
		73,
		69,
		78,
		68,
		174,
		66,
		96,
		130
	]);
	return Buffer.concat([
		magic,
		ihdr,
		idat,
		iend
	]);
}
/** Synthetic minimal MP4 ftyp box (fallback when the bundled asset is missing). */
function fallbackMp4() {
	return Buffer.from([
		0,
		0,
		0,
		24,
		102,
		116,
		121,
		112,
		109,
		112,
		52,
		50,
		0,
		0,
		0,
		0,
		105,
		115,
		111,
		109,
		109,
		112,
		52,
		49
	]);
}
/** Synthetic minimal WAV (fallback when the bundled asset is missing). */
function fallbackWav() {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(8e3, 24);
	header.writeUInt32LE(16e3, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(0, 40);
	return header;
}
function classifyStubRoute(request) {
	const p = request.path.toLowerCase();
	if (/\/v1\/images\/(generations|edits|variations)/.test(p)) return "image";
	if (/\/v1\/audio\/speech/.test(p)) return "audio";
	if (/\/v1\/audio\/(transcriptions|translations)/.test(p)) return "transcription";
	if (/\/v1\/(chat\/completions|completions)/.test(p)) return "chat";
	if (/\/v1\/videos?\/(generations?|create)/.test(p)) return "video";
	if (/\bimages?\b|t2i|img2img|ref2i|2img/.test(p)) return "image";
	if (/\baudios?\b|t2music|tts|speech|voice|music|singing?/.test(p)) return "audio";
	if (/\bvideos?\b|t2v|img2video|fl2v|ref2v|2video|motion|clips?/.test(p)) return "video";
	return "other";
}
/** Parse the request body JSON; returns undefined on parse failure. */
function parseBody(request) {
	if (request.body === void 0 || request.body === "") return void 0;
	try {
		return JSON.parse(request.body);
	} catch {
		return;
	}
}
/** Extract the first user message content from a chat completions body. */
function extractUserMessage(body) {
	if (body === void 0) return "";
	const messages = body.messages;
	if (!Array.isArray(messages)) return "";
	for (const msg of messages) if (typeof msg === "object" && msg !== null && msg.role === "user") {
		const c = msg.content;
		if (typeof c === "string") return c;
	}
	return "";
}
/** Extract a short prompt snippet from the request body for the stub marker. */
function promptSnippet(request) {
	const body = parseBody(request);
	if (body === void 0) return "";
	const p = body.prompt ?? body.text ?? body.input ?? body.messages;
	if (typeof p === "string") return p.slice(0, 64);
	return "";
}
/** Execute one request against the provider (or the built-in stub). */
async function executeProviderRequest(provider, request, opts) {
	const path = request.path.trim();
	if (path === "") throw new AigcError("bad-request", "path is required (relative to the provider endpoint, starting with \"/\")");
	const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
	if (isStubEndpoint(provider.endpoint)) {
		if (isAbsolute) throw new AigcError("bad-request", `absolute URLs are not allowed in stub mode: ${path}`);
		if (!path.startsWith("/")) throw new AigcError("bad-request", `path must start with "/": ${path}`);
		const method = (request.method ?? (request.body !== void 0 ? "POST" : "GET")).toUpperCase();
		if (method === "GET" || method === "HEAD") return {
			ok: true,
			status: 200,
			kind: "json",
			contentType: "application/json; charset=utf-8",
			text: JSON.stringify({
				stub: true,
				hint: "Built-in stub backend. POST to OpenAI-compatible endpoints to receive sample media:",
				endpoints: {
					"/v1/images/generations": "Returns {created, data:[{b64_json}]} — OpenAI image generation format.",
					"/v1/images/edits": "Same response format as /v1/images/generations.",
					"/v1/audio/speech": "Returns audio/mpeg binary bytes directly.",
					"/v1/audio/transcriptions": "Returns {text} JSON.",
					"/v1/chat/completions": "Returns {choices:[{message:{content}}]} JSON.",
					"/v1/videos/generations": "Returns video/mp4 binary bytes directly."
				},
				provider: provider.id,
				path
			}, null, 2)
		};
		const route = classifyStubRoute(request);
		const snippet = promptSnippet(request);
		switch (route) {
			case "image": {
				const bytes = await loadStubAsset("stub-image.png", fallbackPng);
				return {
					ok: true,
					status: 200,
					kind: "json",
					contentType: "application/json; charset=utf-8",
					text: JSON.stringify({
						created: Math.floor(Date.now() / 1e3),
						data: [{ b64_json: bytes.toString("base64") }]
					})
				};
			}
			case "video": {
				const bytes = await loadStubAsset("stub-video.mp4", fallbackMp4);
				return {
					ok: true,
					status: 200,
					kind: "video",
					contentType: "video/mp4",
					bytes,
					size: bytes.byteLength
				};
			}
			case "audio": {
				const bytes = await loadStubAsset("stub-audio.mp3", fallbackWav);
				return {
					ok: true,
					status: 200,
					kind: "audio",
					contentType: "audio/mpeg",
					bytes,
					size: bytes.byteLength
				};
			}
			case "transcription": return {
				ok: true,
				status: 200,
				kind: "json",
				contentType: "application/json; charset=utf-8",
				text: JSON.stringify({ text: `[stub transcription] ${snippet || "(simulated audio transcript)"}` })
			};
			case "chat": {
				const body = parseBody(request);
				const model = typeof body?.model === "string" ? body.model : "gpt-4o";
				const userContent = extractUserMessage(body);
				return {
					ok: true,
					status: 200,
					kind: "json",
					contentType: "application/json; charset=utf-8",
					text: JSON.stringify({
						id: `chatcmpl-stub-${Date.now()}`,
						object: "chat.completion",
						created: Math.floor(Date.now() / 1e3),
						model,
						choices: [{
							index: 0,
							message: {
								role: "assistant",
								content: `[stub] Simulated response to: ${userContent.slice(0, 200)}`
							},
							finish_reason: "stop"
						}],
						usage: {
							prompt_tokens: 0,
							completion_tokens: 0,
							total_tokens: 0
						}
					})
				};
			}
			default: return {
				ok: true,
				status: 200,
				kind: "json",
				contentType: "application/json; charset=utf-8",
				text: JSON.stringify({
					stub: true,
					ok: true,
					path,
					method,
					provider: provider.id
				}, null, 2)
			};
		}
	}
	const method = (request.method ?? (request.body !== void 0 ? "POST" : "GET")).toUpperCase();
	let url;
	if (isAbsolute) {
		let pathUrl;
		try {
			pathUrl = new URL(path);
		} catch {
			throw new AigcError("bad-request", `invalid absolute URL: ${path}`);
		}
		let endpointUrl;
		try {
			endpointUrl = new URL(provider.endpoint);
		} catch {
			throw new AigcError("backend-error", `invalid provider endpoint URL: ${provider.endpoint}`, 502);
		}
		if (pathUrl.origin !== endpointUrl.origin) throw new AigcError("bad-request", `absolute URL must be same-origin as the provider endpoint (${endpointUrl.origin}): ${path}`);
		url = pathUrl;
	} else {
		if (!path.startsWith("/")) throw new AigcError("bad-request", `path must start with "/": ${path}`);
		try {
			url = new URL(`${provider.endpoint.replace(/\/+$/, "")}${path}`);
		} catch {
			throw new AigcError("backend-error", `invalid provider endpoint URL: ${provider.endpoint}`, 502);
		}
	}
	if (request.query !== void 0) for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
	const headers = new Headers({ ...request.headers ?? {} });
	const auth = provider.auth;
	if (auth.scheme === "bearer") headers.set("Authorization", `Bearer ${provider.apiKey}`);
	else if (auth.scheme === "header") headers.set(auth.name === "" ? "x-api-key" : auth.name, provider.apiKey);
	else url.searchParams.set(auth.name === "" ? "api_key" : auth.name, provider.apiKey);
	if (request.body !== void 0 && !headers.has("content-type")) headers.set("content-type", "application/json");
	let response;
	try {
		const abortSignals = [AbortSignal.timeout(opts.timeoutMs)];
		if (opts.signal !== void 0) abortSignals.push(opts.signal);
		const signal = abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0];
		response = await fetch(url, {
			method,
			headers,
			body: request.body,
			signal,
			redirect: "follow"
		});
	} catch (error) {
		if (error instanceof AigcError) throw error;
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new AigcError("backend-error", `provider request aborted (timeout ${opts.timeoutMs}ms or caller abort)`, 504);
		throw new AigcError("backend-error", `provider request failed: ${error instanceof Error ? error.message : String(error)}`, 502);
	}
	const contentType = response.headers.get("content-type") ?? "";
	const mediaType = contentType.split(";")[0].trim().toLowerCase();
	const status = response.status;
	if (status < 200 || status >= 300) return {
		ok: false,
		status,
		contentType,
		text: Buffer.from(await response.arrayBuffer()).toString("utf8").slice(0, FAILURE_TEXT_CAP)
	};
	if (mediaType.startsWith("image/")) {
		const bytes = Buffer.from(await response.arrayBuffer());
		return {
			ok: true,
			status,
			kind: "image",
			contentType,
			bytes,
			size: bytes.byteLength
		};
	}
	if (mediaType.startsWith("video/")) {
		const bytes = Buffer.from(await response.arrayBuffer());
		return {
			ok: true,
			status,
			kind: "video",
			contentType,
			bytes,
			size: bytes.byteLength
		};
	}
	if (mediaType.startsWith("audio/")) {
		const bytes = Buffer.from(await response.arrayBuffer());
		return {
			ok: true,
			status,
			kind: "audio",
			contentType,
			bytes,
			size: bytes.byteLength
		};
	}
	if (mediaType === "application/octet-stream" || mediaType === "" && !contentType.includes("json") && !contentType.includes("text")) {
		const bytes = Buffer.from(await response.arrayBuffer());
		return {
			ok: true,
			status,
			kind: "other",
			contentType,
			bytes,
			size: bytes.byteLength
		};
	}
	const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
	return {
		ok: true,
		status,
		kind: mediaType.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[") ? "json" : "text",
		contentType,
		text
	};
}
//#endregion
//#region src/media-edit.ts
/**
* Media editing via ffmpeg: the engine behind the `aigc_media_edit` tool.
*
* Supports a fixed set of operations (concat, clip, extract_audio,
* extract_frame, speed, resize, reverse, add_audio, images_to_video)
* selected by the `operation` parameter. All input files must live inside
* the session canvas directory; the output is written there too.
*
* Security: ffmpeg is run with an explicit argv (no shell), a bounded
* timeout, and abort-signal support. Input paths are validated to be
* within the canvas directory so the model can't touch arbitrary files.
*/
/** All operations as a readonly array (for schema enum + validation). */
const MEDIA_EDIT_OPERATIONS = [
	"concat",
	"clip",
	"extract_audio",
	"extract_frame",
	"speed",
	"resize",
	"reverse",
	"add_audio",
	"images_to_video"
];
/** Check that a path is within the canvas directory (security boundary). */
function assertWithinCanvas(dir, filePath) {
	const resolved = isAbsolute(filePath) ? filePath : join(dir, filePath);
	const normalizedDir = dir.endsWith(sep) ? dir : `${dir}${sep}`;
	const a = resolved.toLowerCase();
	const b = normalizedDir.toLowerCase();
	if (a !== dir.toLowerCase() && !a.startsWith(b)) throw new AigcError("bad-request", `input file outside the session canvas directory: ${filePath}`);
}
/** Locate the ffmpeg binary. Tries PATH first, then common Windows locations. */
async function findFfmpeg() {
	try {
		await runProcess("ffmpeg", ["-version"], 5e3);
		return "ffmpeg";
	} catch {
		const fallback = "D:\\Softwares\\ffmpeg\\bin\\ffmpeg.exe";
		try {
			await runProcess(fallback, ["-version"], 5e3);
			return fallback;
		} catch {
			throw new AigcError("backend-error", "ffmpeg not found in PATH or at the default location");
		}
	}
}
/** Run a child process with a timeout, returning on completion. */
function runProcess(cmd, args, timeoutMs, signal) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			windowsHide: true,
			signal
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new AigcError("backend-error", `process timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				stdout,
				stderr,
				code: code ?? -1
			});
		});
	});
}
/** Validate that a file exists and is a regular file. */
async function assertFileExists(filePath) {
	const info = await stat(filePath).catch(() => void 0);
	if (info === void 0 || !info.isFile()) throw new AigcError("bad-request", `input file not found or not a regular file: ${filePath}`);
}
/**
* Execute one media edit operation. Builds the ffmpeg argv, runs it, and
* writes the output to the canvas directory.
*
* @param request - the validated operation request.
* @param cwd - the session cwd (canvas dir = cwd/.dsh-aigc-canvas/sessionId/).
* @param sessionId - the session id (for the canvas dir path).
* @param opts - timeout + abort signal.
* @returns the output file path and timing info.
*/
async function executeMediaEdit(request, cwd, sessionId, opts) {
	const dir = canvasDirFor(cwd, sessionId);
	await mkdir(dir, { recursive: true });
	for (const input of request.inputs) {
		assertWithinCanvas(dir, input);
		await assertFileExists(input);
	}
	const ffmpeg = await findFfmpeg();
	const outputName = `${randomUUID()}.${request.outputExt}`;
	const outputPath = join(dir, outputName);
	const { args, inputCount } = buildFfmpegArgs(request, outputPath);
	const startMs = Date.now();
	let finalArgs;
	if (request.operation === "concat") {
		const listPath = join(dir, `${randomUUID()}.txt`);
		const listContent = request.inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
		await writeFile(listPath, listContent, "utf8");
		finalArgs = [
			"-y",
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			listPath,
			...args
		];
		try {
			const result = await runProcess(ffmpeg, finalArgs, opts.timeoutMs, opts.signal);
			if (result.code !== 0) throw new AigcError("backend-error", `ffmpeg concat failed (code ${result.code}): ${result.stderr.slice(0, 1e3)}`);
		} finally {
			await import("node:fs/promises").then(({ unlink }) => unlink(listPath).catch(() => {}));
		}
	} else if (request.operation === "images_to_video") {
		finalArgs = ["-y"];
		for (const input of request.inputs) finalArgs.push("-i", input);
		const n = request.inputs.length;
		const fps = request.fps ?? 2;
		const filterParts = [];
		for (let i = 0; i < n; i++) filterParts.push(`[${i}:v]setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
		const concatInputs = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
		filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=0[out]`);
		finalArgs.push("-filter_complex", filterParts.join(";"), "-map", "[out]", "-r", String(fps), ...args);
		const result = await runProcess(ffmpeg, finalArgs, opts.timeoutMs, opts.signal);
		if (result.code !== 0) throw new AigcError("backend-error", `ffmpeg images_to_video failed (code ${result.code}): ${result.stderr.slice(0, 1e3)}`);
	} else {
		finalArgs = ["-y"];
		for (const input of request.inputs) finalArgs.push("-i", input);
		finalArgs.push(...args);
		const result = await runProcess(ffmpeg, finalArgs, opts.timeoutMs, opts.signal);
		if (result.code !== 0) throw new AigcError("backend-error", `ffmpeg ${request.operation} failed (code ${result.code}): ${result.stderr.slice(0, 1e3)}`);
	}
	const outInfo = await stat(outputPath).catch(() => void 0);
	if (outInfo === void 0 || !outInfo.isFile() || outInfo.size === 0) throw new AigcError("backend-error", `ffmpeg produced no output file`);
	return {
		outputPath,
		operation: request.operation,
		durationMs: Date.now() - startMs
	};
}
/**
* Build the ffmpeg argv (excluding -y and -i flags) for one operation.
* Returns the args array and the number of inputs expected.
*/
function buildFfmpegArgs(request, outputPath) {
	switch (request.operation) {
		case "concat": return {
			args: [
				"-c:v",
				"libx264",
				"-crf",
				"28",
				"-preset",
				"fast",
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				outputPath
			],
			inputCount: request.inputs.length
		};
		case "clip": {
			const args = [];
			if (request.start !== void 0) args.push("-ss", String(request.start));
			const seekArgs = [];
			if (request.start !== void 0) seekArgs.push("-ss", String(request.start));
			if (request.duration !== void 0) seekArgs.push("-t", String(request.duration));
			else if (request.end !== void 0 && request.start !== void 0) seekArgs.push("-t", String(request.end - request.start));
			else if (request.end !== void 0) seekArgs.push("-to", String(request.end));
			return {
				args: [
					...seekArgs,
					"-c:v",
					"libx264",
					"-crf",
					"28",
					"-preset",
					"fast",
					"-c:a",
					"aac",
					"-b:a",
					"128k",
					outputPath
				],
				inputCount: 1
			};
		}
		case "extract_audio": return {
			args: [
				"-vn",
				"-c:a",
				"libmp3lame",
				"-b:a",
				"192k",
				outputPath
			],
			inputCount: 1
		};
		case "extract_frame": {
			const ts = request.timestamp ?? 0;
			return {
				args: [
					"-ss",
					String(ts),
					"-frames:v",
					"1",
					"-q:v",
					"2",
					outputPath
				],
				inputCount: 1
			};
		}
		case "speed": {
			const factor = request.speed ?? 1;
			if (factor <= 0) throw new AigcError("bad-request", "speed must be > 0");
			const pts = (1 / factor).toFixed(6);
			const atempo = Math.min(2, Math.max(.5, factor));
			return {
				args: [
					"-filter:v",
					`setpts=${pts}*PTS`,
					"-filter:a",
					`atempo=${atempo}`,
					"-c:v",
					"libx264",
					"-crf",
					"28",
					"-preset",
					"fast",
					"-c:a",
					"aac",
					outputPath
				],
				inputCount: 1
			};
		}
		case "resize": {
			const vf = [];
			if (request.width !== void 0 && request.height !== void 0) vf.push(`scale=${request.width}:${request.height}`);
			else if (request.width !== void 0) vf.push(`scale=${request.width}:-2`);
			else if (request.height !== void 0) vf.push(`scale=-2:${request.height}`);
			else throw new AigcError("bad-request", "resize requires width and/or height");
			return {
				args: [
					"-vf",
					vf.join(","),
					"-c:v",
					"libx264",
					"-crf",
					"28",
					"-preset",
					"fast",
					"-c:a",
					"copy",
					outputPath
				],
				inputCount: 1
			};
		}
		case "reverse": return {
			args: [
				"-vf",
				"reverse",
				"-af",
				"areverse",
				"-c:v",
				"libx264",
				"-crf",
				"28",
				"-preset",
				"fast",
				outputPath
			],
			inputCount: 1
		};
		case "add_audio": return {
			args: [
				"-map",
				"0:v:0",
				"-map",
				"1:a:0",
				"-c:v",
				"copy",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-shortest",
				outputPath
			],
			inputCount: 2
		};
		case "images_to_video": return {
			args: [
				"-c:v",
				"libx264",
				"-crf",
				"28",
				"-preset",
				"fast",
				"-pix_fmt",
				"yuv420p",
				outputPath
			],
			inputCount: request.inputs.length
		};
		default: throw new AigcError("bad-request", `unsupported operation: ${request.operation}`);
	}
}
//#endregion
//#region src/tools.ts
/**
* The seven model-facing AIGC canvas tools.
*
* Generation is provider-agnostic:
*   aigc_get_provider_info         — list configured providers (id, name,
*                                    endpoint, usage instructions, stub flag).
*                                    Call this FIRST. The provider apiKey is
*                                    NEVER shown; it is attached automatically
*                                    by aigc_http_request.
*   aigc_http_request              — send an HTTP request to a provider's API
*                                    (endpoint + apiKey auto-attached). Binary
*                                    responses (image/video/audio) are saved
*                                    to disk and returned as a filePath;
*                                    JSON/text responses are returned inline
*                                    (saved to a file when too large).
*   aigc_provider_set_instructions — record the provider's 调用说明 (how to
*                                    call the API: endpoints, params, auth)
*                                    so future sessions can use the provider.
*   aigc_canvas_place              — place a file (typically the filePath
*                                    aigc_http_request returned) onto the free
*                                    canvas at position (x, y); optionally
*                                    records the prompt/params (shown on
*                                    double-click) and auto-wires edges from
*                                    reference elements.
*   aigc_canvas_link / unlink      — create / remove an edge between two
*                                    elements (filePath-addressed).
*   aigc_canvas_list_elements      — snapshot of the session's canvas.
*
* Element identity:
*   Every element (prompt / image / video / audio) is identified by its
*   `filePath` on disk — tools return filePath (not uuid), and tools
*   accept filePath when referencing existing elements. The filePath is
*   an absolute path under `<cwd>/.dsh-aigc-canvas/<sessionId>/`.
*/
/** Pure text projection helper. */
function textRender(fn) {
	return (_args, value) => [{
		type: "text",
		text: fn(value)
	}];
}
/** Extract the calling agent or throw the canonical "no agent" error. */
function requireAgent(agent) {
	if (agent === void 0) throw new Error("aigc canvas tools require an initiating agent");
	return agent;
}
/** Resolve the calling agent's session id. */
function sessionIdOf(exec) {
	return requireAgent(exec.agent).session.id;
}
/**
* The model-facing shape of one element (no internal uuid, no media bytes).
* The `filePath` is the primary identifier the agent uses to reference
* the element in subsequent tool calls; `x`/`y` are the canvas position.
*/
function elementProjection(el) {
	return {
		filePath: el.filePath,
		kind: el.kind,
		title: el.title,
		x: el.x,
		y: el.y,
		createdAt: el.createdAt,
		producedBy: el.producedBy,
		...el.promptText !== void 0 ? { promptText: el.promptText } : {},
		...el.mediaSize !== void 0 ? { mediaSize: el.mediaSize } : {},
		...el.meta !== void 0 ? { meta: el.meta } : {}
	};
}
/** Edge projection: resolve uuids to filePaths so the agent can read the graph. */
function edgeProjection(edge, lookup) {
	return {
		source: lookup(edge.source)?.filePath ?? edge.source,
		target: lookup(edge.target)?.filePath ?? edge.target
	};
}
/** The `provider_id` parameter spec (shared by provider-scoped tools). */
const providerIdParam = {
	type: "string",
	description: "The provider id to use (call aigc_get_provider_info to list available providers). If omitted, the default (first) provider is used."
};
/** File extension for one binary kind produced by the http tool. */
function extensionForBinaryKind(kind, contentType) {
	const subtype = contentType.split(";")[0]?.trim().split("/")[1]?.toLowerCase() ?? "";
	switch (kind) {
		case "image": return [
			"png",
			"jpeg",
			"jpg",
			"webp",
			"gif"
		].includes(subtype) ? subtype : "png";
		case "video": return [
			"mp4",
			"webm",
			"mov",
			"ogg",
			"m4v"
		].includes(subtype) ? subtype : "mp4";
		case "audio": return [
			"mp3",
			"wav",
			"flac",
			"ogg",
			"m4a",
			"aac",
			"opus"
		].includes(subtype) ? subtype : "mp3";
		case "other": return "bin";
	}
}
/**
* Detect the OpenAI image-generation JSON response format and extract the
* base64-encoded image bytes from it:
*
*   { "created": 1234, "data": [{ "b64_json": "<base64>" }] }
*
* Returns null when the text is not this shape, so the caller can fall
* through to normal inline-text handling. Sniffs the decoded magic bytes
* to pick the right file extension (png / jpeg / webp / gif).
*/
function extractOpenAIB64Image(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const data = parsed.data;
	if (!Array.isArray(data) || data.length === 0) return null;
	const first = data[0];
	if (typeof first !== "object" || first === null) return null;
	const b64 = first.b64_json;
	if (typeof b64 !== "string" || b64.length === 0) return null;
	const bytes = Buffer.from(b64, "base64");
	if (bytes.byteLength < 8) return null;
	if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return {
		bytes,
		ext: "png",
		contentType: "image/png"
	};
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return {
		bytes,
		ext: "jpg",
		contentType: "image/jpeg"
	};
	if (bytes.byteLength >= 12 && bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP") return {
		bytes,
		ext: "webp",
		contentType: "image/webp"
	};
	if (bytes.slice(0, 6).toString("ascii") === "GIF89a" || bytes.slice(0, 6).toString("ascii") === "GIF87a") return {
		bytes,
		ext: "gif",
		contentType: "image/gif"
	};
	return {
		bytes,
		ext: "png",
		contentType: "image/png"
	};
}
/** Resolve the canvas kind for a placed file from its extension (or explicit). */
function kindForFile(filePath, kind) {
	if (kind !== void 0) {
		if (kind === "image" || kind === "video" || kind === "audio" || kind === "prompt") return kind;
		throw new AigcError("bad-request", `invalid kind "${kind}"; expected image, video, audio, or prompt`);
	}
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	if ([
		"png",
		"jpg",
		"jpeg",
		"webp",
		"gif",
		"bmp",
		"svg"
	].includes(ext)) return "image";
	if ([
		"mp4",
		"webm",
		"mov",
		"m4v",
		"ogv"
	].includes(ext)) return "video";
	if ([
		"mp3",
		"wav",
		"flac",
		"ogg",
		"m4a",
		"aac",
		"opus"
	].includes(ext)) return "audio";
	if (ext === "txt") return "prompt";
	throw new AigcError("bad-request", `cannot infer the element kind from "${filePath}"; pass the explicit kind parameter`);
}
/**
* Coerce the model-supplied `meta` argument into a plain object. The schema
* declares `type: 'json'` so the model may pass a stringified JSON blob by
* mistake; we parse it defensively. Non-object values (numbers, arrays,
* null) are dropped — meta is documented as a JSON object.
*/
function coerceMeta(meta) {
	if (meta === void 0 || meta === null) return void 0;
	if (typeof meta === "string") {
		if (meta.length === 0) return void 0;
		try {
			const parsed = JSON.parse(meta);
			return isPlainObject(parsed) ? parsed : void 0;
		} catch {
			return;
		}
	}
	return isPlainObject(meta) ? meta : void 0;
}
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
/**
* Walk a JSON body and replace `{"$base64": "<path>"}` placeholders with
* the base64-encoded file content, and `{"$data_uri": "<path>"}` with a
* full data URI string (`data:<mime>;base64,...`). The path must be inside
* the session canvas directory (security boundary).
*
* This lets the model reference canvas elements by file_path when an API
* expects base64 image data in the request body — without the model having
* to read or encode the file itself.
*/
async function expandBase64Placeholders(value, sessionId, cwd) {
	if (isPlainObject(value)) {
		const b64Path = value.$base64;
		if (typeof b64Path === "string") return await readAsBase64(b64Path, cwd, false);
		const dataUriPath = value.$data_uri;
		if (typeof dataUriPath === "string") return await readAsBase64(dataUriPath, cwd, true);
		const result = {};
		for (const [key, val] of Object.entries(value)) result[key] = await expandBase64Placeholders(val, sessionId, cwd);
		return result;
	}
	if (Array.isArray(value)) return Promise.all(value.map((item) => expandBase64Placeholders(item, sessionId, cwd)));
	return value;
}
/** Read a file, validate it's in the canvas dir, return base64 (or data URI). */
async function readAsBase64(filePath, cwd, asDataUri) {
	canvasDirFor(cwd, "");
	const resolved = isAbsolute(filePath) ? filePath : join(cwd, filePath);
	const canvasRoot = canvasDirFor(cwd, "");
	const normalizedRoot = canvasRoot.endsWith(sep) ? canvasRoot : `${canvasRoot}${sep}`;
	const a = resolved.toLowerCase();
	const b = normalizedRoot.toLowerCase();
	if (!a.startsWith(b)) throw new AigcError("bad-request", `$base64 file must be inside the session canvas directory: ${filePath}`);
	const info = await stat(resolved).catch(() => void 0);
	if (info === void 0 || !info.isFile()) throw new AigcError("bad-request", `$base64 file not found or not a regular file: ${filePath}`);
	const b64 = (await readFile(resolved)).toString("base64");
	if (!asDataUri) return b64;
	return `data:${mimeFromExt(filePath)};base64,${b64}`;
}
/** Infer a MIME type from a file extension (for data URIs). */
function mimeFromExt(filePath) {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "png") return "image/png";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "webp") return "image/webp";
	if (ext === "gif") return "image/gif";
	if (ext === "mp4") return "video/mp4";
	if (ext === "webm") return "video/webm";
	if (ext === "mp3") return "audio/mpeg";
	if (ext === "wav") return "audio/wav";
	return "application/octet-stream";
}
/**
* Register the seven tools against the host tool registry.
*
* @param ctx - host plugin context (carries the tools service).
* @param getProvider - live provider getter (takes optional provider id).
* @param setInstructions - persists usage instructions for one provider (the host's ProviderStore).
* @param listProviders - returns info for all providers (for aigc_get_provider_info).
* @param canvas - the canvas registry service (host-owned state).
* @param resolveCwd - live cwd resolver for one session id.
* @param getTimeoutMs - live per-request timeout for aigc_http_request.
* @param getMediaLimit - live cap on bytes the http tool may write to disk.
* @returns a disposer that unregisters all tools.
*/
function registerTools(ctx, getProvider, setInstructions, listProviders, canvas, resolveCwd, getTimeoutMs, getMediaLimit = () => 104857600) {
	const disposers = [];
	const register = (tool) => {
		disposers.push(ctx.tools.register(tool));
	};
	register(defineTool({
		name: "aigc_get_provider_info",
		description: "List all configured AIGC providers with their id, name, endpoint, usage instructions, and stub status. Call this FIRST before generating anything. To use a provider: call aigc_http_request with its id as provider_id — the endpoint and apiKey are attached automatically, so you never need to see or forward the apiKey. When a provider's instructions field is empty, probe its API yourself (aigc_http_request) and then record how to call it via aigc_provider_set_instructions (KEEP THE INSTRUCTIONS AS SHORT AS POSSIBLE — see that tool). When the endpoint is \"stub://aigc-backend\", aigc_http_request returns synthetic media (no real API calls) — useful for dry runs. Generated files are placed on the canvas with aigc_canvas_place (filePath + position), and elements can be linked with aigc_canvas_link.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { providers: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true,
								description: "The provider id (pass this as provider_id to aigc_http_request)."
							},
							name: {
								type: "string",
								required: true,
								description: "The provider display name."
							},
							endpoint: {
								type: "string",
								required: true,
								description: "The provider API endpoint URL. \"stub://aigc-backend\" = the built-in stub."
							},
							instructions: {
								type: "string",
								required: true,
								description: "Free-form usage instructions for calling the provider API (empty until initialized)."
							},
							isStub: {
								type: "boolean",
								required: true,
								description: "Whether the stub backend is active (no real API calls)."
							},
							isDefault: {
								type: "boolean",
								required: true,
								description: "Whether this is the default provider (used when provider_id is omitted)."
							}
						}
					}
				} }
			},
			render: (_args, value) => {
				const v = value;
				if (v.providers.length === 0) return [{
					type: "text",
					text: "No AIGC providers configured. Add one in the settings page."
				}];
				const lines = v.providers.map((p) => `  ${p.isDefault ? "* " : "  "}${p.id}  "${p.name || "(unnamed)"}"  endpoint: ${p.endpoint}  stub: ${p.isStub}` + (p.instructions !== "" ? `\n    instructions: ${p.instructions}` : "\n    instructions: (empty — probe the API with aigc_http_request, then record them via aigc_provider_set_instructions)"));
				return [{
					type: "text",
					text: `AIGC providers (${v.providers.length}):\n${lines.join("\n")}\n\nCall aigc_http_request with the desired provider's id; endpoint + apiKey are attached automatically.`
				}];
			}
		},
		execute: async (_args, exec) => {
			exec.signal.throwIfAborted();
			return Promise.resolve({ providers: listProviders() });
		}
	}));
	register(defineTool({
		name: "aigc_http_request",
		description: "Send one HTTP request to an AIGC provider's API. The provider's configured endpoint and apiKey are attached automatically (you must not pass them; the auth header/param cannot be overridden). The request path is relative to the provider endpoint, e.g. \"/v1/images/generations\"; a same-origin absolute URL (e.g. a provider-returned result_url) is also accepted. Binary responses (image / video / audio) are saved to disk under the session canvas directory and returned as a file_path; JSON/text responses are returned inline (and summarized or saved to a file when large). Non-2xx responses are returned as { ok: false } with the response body AND a sent_body_preview of the request, so you can read API errors and self-diagnose field-loss bugs. To embed a canvas element's file content as base64 in the request body, use the {\"$base64\": \"file_path\"} placeholder inside json_body OR body (both work). After you have a file_path, place it onto the canvas with aigc_canvas_place.",
		parameters: {
			provider_id: providerIdParam,
			method: {
				type: "string",
				description: "HTTP method. Defaults to POST when a body/json_body is provided, else GET.",
				enum: [
					"GET",
					"POST",
					"PUT",
					"PATCH",
					"DELETE"
				]
			},
			path: {
				type: "string",
				required: true,
				description: "Request path relative to the provider endpoint, starting with \"/\", e.g. \"/v1/images/generations\". An absolute URL is also accepted, but only when same-origin with the provider endpoint (same protocol+host+port) — use this to fetch provider-returned download URLs (e.g. a video result_url) that need the provider auth."
			},
			headers: {
				type: "object",
				description: "Extra request headers (string values). The provider auth header/param is attached automatically and cannot be overridden.",
				additionalProperties: true
			},
			query: {
				type: "object",
				description: "URL query parameters (string values), merged with any auth query param.",
				additionalProperties: true
			},
			json_body: {
				type: "json",
				description: "JSON request body as an object/array (preferred), or a JSON string. Serialized automatically. Use either json_body or body, not both. SPECIAL PLACEHOLDERS: to embed a canvas element's file content as base64 inside the JSON, use {\"$base64\": \"<file_path>\"} — the tool reads the file, base64-encodes it, and replaces the placeholder with the resulting string before sending. For a data URI (e.g. \"data:image/png;base64,...\"), use {\"$data_uri\": \"<file_path>\"}. The file_path must be an absolute path inside the session canvas directory (e.g. a file_path returned by a previous aigc_http_request or aigc_canvas_place call). Example: {\"model\":\"t2v\",\"image\":{\"$base64\":\"/path/to/ref.png\"},\"prompt\":\"dance\"}"
			},
			body: {
				type: "string",
				description: "Raw request body string (typically JSON text). Use either json_body or body, not both. The $base64 / $data_uri placeholders (see json_body) are also expanded here when the body is valid JSON — so you can inline binary content in a raw body too. Non-JSON bodies are sent as-is."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true,
						description: "Whether the provider returned 2xx."
					},
					status: {
						type: "integer",
						required: true,
						description: "The HTTP status code."
					},
					kind: {
						type: "string",
						required: true,
						enum: [
							"image",
							"video",
							"audio",
							"other",
							"json",
							"text"
						],
						description: "Response kind. image/video/audio/other = saved to disk (see file_path); json/text = returned inline (see text)."
					},
					content_type: {
						type: "string",
						required: true,
						description: "The response Content-Type header."
					},
					file_path: {
						type: "string",
						description: "Absolute path of the saved binary response (or of an oversized text response). Pass this to aigc_canvas_place."
					},
					file_size: {
						type: "integer",
						description: "Byte size of the saved file (when file_path is set)."
					},
					text: {
						type: "string",
						description: "Inline JSON/text response body (when kind is json or text)."
					},
					error: {
						type: "string",
						description: "Response body of a failed (non-2xx) request, truncated."
					},
					sent_body_preview: {
						type: "string",
						description: "First ~500 bytes of the request body actually sent (set on non-2xx responses, for diagnosing field-loss / encoding bugs)."
					}
				}
			},
			render: (_args, value) => {
				const v = value;
				if (!v.ok) {
					const sent = v.sent_body_preview !== void 0 ? `\n— sent body (first 500 bytes): ${v.sent_body_preview}` : "";
					return [{
						type: "text",
						text: `HTTP ${v.status} (${v.content_type}): ${(v.error ?? "(empty body)").slice(0, 500)}${sent}`
					}];
				}
				if (v.file_path !== void 0 && v.text !== void 0) return [{
					type: "text",
					text: `HTTP ${v.status}: ${v.kind} response truncated (full ${v.file_size} bytes at ${v.file_path}). Preview: ${v.text.slice(0, 300)}`
				}];
				if (v.file_path !== void 0) return [{
					type: "text",
					text: `HTTP ${v.status}: saved ${v.kind} response (${v.file_size} bytes, ${v.content_type}) to ${v.file_path}. Place it with aigc_canvas_place.`
				}];
				return [{
					type: "text",
					text: `HTTP ${v.status} ${v.kind} response: ${v.text ?? ""}`
				}];
			}
		},
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			if (args.json_body !== void 0 && args.body !== void 0) throw new AigcError("bad-request", "pass either json_body or body, not both");
			const sessionId = sessionIdOf(exec);
			const cwd = resolveCwd(sessionId);
			const provider = getProvider(args.provider_id);
			let body;
			if (args.json_body !== void 0) {
				let jsonValue = args.json_body;
				if (typeof jsonValue === "string") {
					if (jsonValue === "") body = void 0;
					else {
						try {
							jsonValue = JSON.parse(jsonValue);
						} catch (e) {
							throw new AigcError("bad-request", `json_body is a string but not valid JSON: ${e instanceof Error ? e.message : String(e)}. Pass an object/array, or use the body parameter for raw non-JSON text.`);
						}
						const expanded = await expandBase64Placeholders(jsonValue, sessionId, cwd);
						body = JSON.stringify(expanded);
					}
				} else {
					const expanded = await expandBase64Placeholders(jsonValue, sessionId, cwd);
					body = JSON.stringify(expanded);
				}
			} else if (args.body !== void 0) {
				if (/\$(?:base64|data_uri)\b/.test(args.body)) try {
					const expanded = await expandBase64Placeholders(JSON.parse(args.body), sessionId, cwd);
					body = JSON.stringify(expanded);
				} catch (e) {
					if (e instanceof AigcError) throw e;
					throw new AigcError("bad-request", `body contains $base64/$data_uri placeholders but is not valid JSON: ${e instanceof Error ? e.message : String(e)}. Use json_body for structured payloads with placeholders.`);
				}
				else body = args.body;
			}
			const result = await executeProviderRequest(provider, {
				method: args.method,
				path: args.path,
				headers: args.headers,
				query: args.query,
				body
			}, {
				timeoutMs: getTimeoutMs(),
				signal: exec.signal
			});
			if (!result.ok) return {
				ok: false,
				status: result.status,
				kind: "text",
				content_type: result.contentType,
				error: result.text,
				sent_body_preview: body !== void 0 ? body.slice(0, 500) : void 0
			};
			switch (result.kind) {
				case "json":
				case "text": {
					if (result.kind === "json") {
						const extracted = extractOpenAIB64Image(result.text);
						if (extracted !== null) {
							if (extracted.bytes.byteLength > getMediaLimit()) throw new AigcError("backend-error", `extracted image too large (${extracted.bytes.byteLength} bytes > ${getMediaLimit()} limit)`, 413);
							const filePath = await saveResponseToSession(extracted.bytes, extracted.ext, sessionId, cwd);
							return {
								ok: true,
								status: result.status,
								kind: "image",
								content_type: extracted.contentType,
								file_path: filePath,
								file_size: extracted.bytes.byteLength
							};
						}
					}
					if (result.text.length <= 2e3) return {
						ok: true,
						status: result.status,
						kind: result.kind,
						content_type: result.contentType,
						text: result.text
					};
					const filePath = await saveResponseToSession(result.text, result.kind === "json" ? "json" : "txt", sessionId, cwd);
					const preview = result.text.slice(0, INLINE_TEXT_CAP);
					return {
						ok: true,
						status: result.status,
						kind: result.kind,
						content_type: result.contentType,
						text: `${preview}\n… [response truncated; full ${Buffer.byteLength(result.text)} bytes saved to ${filePath} — read it with your file tools]`,
						file_path: filePath,
						file_size: Buffer.byteLength(result.text)
					};
				}
				default: {
					const ext = extensionForBinaryKind(result.kind, result.contentType);
					if (result.size > getMediaLimit()) throw new AigcError("backend-error", `provider response too large to save (${result.size} bytes > ${getMediaLimit()} limit)`, 413);
					const filePath = await saveResponseToSession(result.bytes, ext, sessionId, cwd);
					return {
						ok: true,
						status: result.status,
						kind: result.kind,
						content_type: result.contentType,
						file_path: filePath,
						file_size: result.size
					};
				}
			}
		}
	}));
	register(defineTool({
		name: "aigc_provider_set_instructions",
		description: "Record the usage instructions (调用说明) for one provider: the endpoints, request formats, parameters, and response shapes you discovered by probing the provider with aigc_http_request. Call this after initializing a provider so future sessions can generate with it directly. The instructions replace the provider's previous instructions (empty until first set). CRITICAL: KEEP THE INSTRUCTIONS AS SHORT AS POSSIBLE — a few words per endpoint is enough. Do NOT copy full API docs, examples, or verbose explanations. Prefer compact shorthand like \"POST /v1/images/generations {prompt,size} -> {data:[{b64_json}]}\" over full sentences. Every byte here is inlined into aigc_get_provider_info output on every call, so verbosity directly wastes context window. Aim for under 200 characters total.",
		parameters: {
			provider_id: {
				type: "string",
				required: true,
				description: "The provider id to update (from aigc_get_provider_info)."
			},
			instructions: {
				type: "string",
				required: true,
				description: "Compact usage instructions. BE TERSE — a few words per endpoint is enough; do not pad with prose, examples, or full docs. Drop any formatting guarantees (no need for valid JSON / Markdown / complete sentences). Shorthand like \"POST /v1/images/generations {prompt,size} -> {data:[{b64_json}]}\" is ideal. Target: under 200 chars. Fewer is better."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					provider_id: {
						type: "string",
						required: true
					}
				}
			},
			render: textRender((v) => `Saved usage instructions for provider "${v.provider_id}".`)
		},
		execute: (args) => {
			if (typeof args.provider_id !== "string" || args.provider_id === "") throw new AigcError("bad-request", "provider_id is required");
			if (typeof args.instructions !== "string" || args.instructions === "") throw new AigcError("bad-request", "instructions is required");
			getProvider(args.provider_id);
			const result = setInstructions(args.provider_id, args.instructions);
			if (!result.ok) throw new AigcError("bad-request", result.error ?? "cannot save instructions");
			return Promise.resolve({
				ok: true,
				provider_id: args.provider_id
			});
		}
	}));
	register(defineTool({
		name: "aigc_canvas_place",
		description: "Place a file (usually the file_path returned by aigc_http_request) onto the session's free canvas at position (x, y). The file must already exist inside the session canvas directory. Optionally record the prompt text and generation parameters (meta) — they are shown when the user double-clicks the element. Pass `references` (filePaths of existing elements the new one was generated from) to auto-wire edges from those elements to the new one. x and y are OPTIONAL: PREFER OMITTING THEM and letting the host auto-place. When references are given, the new element lands to the RIGHT of the rightmost reference (vertically centered on the references); otherwise it goes BELOW the lowest existing element in a left-aligned vertical column (this is the usual case for a sequence of independent generations). The client pans to bring it into view. DO NOT pass explicit x/y for routine placements — letting the host stack elements vertically keeps the canvas readable. Only set x/y when the user explicitly asks for a specific layout (e.g. \"place these side by side\").",
		parameters: {
			file_path: {
				type: "string",
				required: true,
				description: "Absolute path of the file to place (must be inside the session canvas directory, e.g. a file_path returned by aigc_http_request)."
			},
			x: {
				type: "number",
				description: "Canvas X coordinate (world space). OMIT for routine placement — the host auto-stacks new elements below the lowest existing one in a vertical column. Only set when the user explicitly requests a custom layout."
			},
			y: {
				type: "number",
				description: "Canvas Y coordinate (world space). OMIT for routine placement — the host auto-stacks new elements below the lowest existing one in a vertical column. Only set when the user explicitly requests a custom layout."
			},
			title: {
				type: "string",
				description: "Short display title. Defaults to the file name."
			},
			description: {
				type: "string",
				required: true,
				description: "ULTRA-SHORT description of this element: a noun, adjective, or short phrase (e.g. \"orange cat\", \"sunset beach\", \"fast cut\", \"low angle\"). MUST be under 40 chars. Do NOT write a full sentence. This is shown on the canvas card and used as a quick label. Drop articles and filler — \"sleeping cat\" not \"a cat that is sleeping\"."
			},
			kind: {
				type: "string",
				enum: [
					"image",
					"video",
					"audio",
					"prompt"
				],
				description: "Element kind. Inferred from the file extension when omitted."
			},
			prompt: {
				type: "string",
				description: "The prompt text used to generate this file (shown on double-click)."
			},
			meta: {
				type: "json",
				description: "Generation parameters / metadata as a JSON OBJECT (e.g. {\"size\":\"768x768\",\"seed\":42}). Shown on double-click. Do NOT pass a stringified JSON."
			},
			references: {
				type: "array",
				items: { type: "string" },
				description: "filePaths of existing canvas elements used as references; edges are wired from each reference to the new element."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					element_path: {
						type: "string",
						required: true,
						description: "The filePath of the placed element (the primary identifier)."
					},
					kind: {
						type: "string",
						required: true,
						enum: [
							"prompt",
							"image",
							"video",
							"audio"
						]
					},
					title: {
						type: "string",
						required: true
					},
					x: {
						type: "number",
						required: true
					},
					y: {
						type: "number",
						required: true
					},
					linked_references: {
						type: "integer",
						description: "How many reference edges were wired (0 when references omitted)."
					}
				}
			},
			render: textRender((v) => `Placed ${v.kind} element "${v.title}" at (${v.x}, ${v.y}) — filePath: ${v.element_path}${v.linked_references ? `, wired from ${v.linked_references} reference(s)` : ""}.`)
		},
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			const cwd = resolveCwd(sessionId);
			const kind = kindForFile(args.file_path, args.kind);
			if (args.x !== void 0 && !Number.isFinite(args.x)) throw new AigcError("bad-request", "x must be a finite number when provided");
			if (args.y !== void 0 && !Number.isFinite(args.y)) throw new AigcError("bad-request", "y must be a finite number when provided");
			if (typeof args.description !== "string" || args.description === "") throw new AigcError("bad-request", "description is required (a short noun/adjective phrase)");
			const description = args.description.slice(0, 40);
			const meta = coerceMeta(args.meta);
			let refUuids;
			if (args.references !== void 0 && args.references.length > 0) {
				refUuids = [];
				for (const refPath of args.references) {
					const refEl = canvas.getElementByPath(sessionId, refPath);
					refUuids.push(refEl.uuid);
				}
			}
			const el = await canvas.placeFile(sessionId, {
				kind,
				filePath: args.file_path,
				title: args.title ?? args.file_path.split(/[\\/]/).pop() ?? args.file_path,
				producedBy: "aigc_canvas_place",
				x: args.x,
				y: args.y,
				description,
				...args.prompt !== void 0 ? { promptText: args.prompt } : {},
				...meta !== void 0 ? { meta } : {},
				...refUuids !== void 0 ? { referenceUuids: refUuids } : {}
			}, cwd);
			let linked = 0;
			if (refUuids !== void 0 && refUuids.length > 0) {
				const filtered = refUuids.filter((u) => u !== el.uuid);
				if (filtered.length > 0) {
					await canvas.wireEdges(sessionId, filtered, el.uuid);
					linked = filtered.length;
				}
			}
			return {
				element_path: el.filePath,
				kind: el.kind,
				title: el.title,
				x: el.x,
				y: el.y,
				linked_references: linked
			};
		}
	}));
	register(defineTool({
		name: "aigc_canvas_link",
		description: "Create an edge from an existing source element to an existing target element (both filePath-addressed). Use this to record that one element was generated from (or depends on) another. Idempotent: linking the same pair twice is a no-op. Edges are rendered on the canvas as arrows from source to target.",
		parameters: {
			source: {
				type: "string",
				required: true,
				description: "filePath of the source element (the input / reference)."
			},
			target: {
				type: "string",
				required: true,
				description: "filePath of the target element (the produced output)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					linked: {
						type: "boolean",
						required: true
					},
					source: {
						type: "string",
						required: true
					},
					target: {
						type: "string",
						required: true
					}
				}
			},
			render: textRender((v) => `Linked ${v.source} → ${v.target}.`)
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			await canvas.ensureHydrated(sessionId);
			const sourceEl = canvas.getElementByPath(sessionId, args.source);
			const targetEl = canvas.getElementByPath(sessionId, args.target);
			return canvas.wireEdges(sessionId, [sourceEl.uuid], targetEl.uuid).then(() => ({
				linked: true,
				source: args.source,
				target: args.target
			}));
		}
	}));
	register(defineTool({
		name: "aigc_canvas_unlink",
		description: "Remove the edge from a source element to a target element (both filePath-addressed). Idempotent: unlinking a pair that is not linked is a no-op.",
		parameters: {
			source: {
				type: "string",
				required: true,
				description: "filePath of the source element."
			},
			target: {
				type: "string",
				required: true,
				description: "filePath of the target element."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					unlinked: {
						type: "boolean",
						required: true
					},
					source: {
						type: "string",
						required: true
					},
					target: {
						type: "string",
						required: true
					}
				}
			},
			render: textRender((v) => `Unlinked ${v.source} → ${v.target}.`)
		},
		execute: async (args, exec) => {
			const sessionId = sessionIdOf(exec);
			await canvas.ensureHydrated(sessionId);
			const sourceEl = canvas.getElementByPath(sessionId, args.source);
			const targetEl = canvas.getElementByPath(sessionId, args.target);
			return canvas.unlink(sessionId, sourceEl.uuid, targetEl.uuid).then(() => ({
				unlinked: true,
				source: args.source,
				target: args.target
			}));
		}
	}));
	register(defineTool({
		name: "aigc_canvas_list_elements",
		description: "List every element and edge currently on the canvas for the calling agent's session. Returns each element's filePath (the primary identifier), kind (prompt/image/video/audio), title, canvas position (x, y), producing tool, and metadata; and every edge (source filePath → target filePath). Use this to recover state after a long sequence of tool calls, to find a filePath to pass as a reference, or to choose a free spot on the canvas.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					elements: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								filePath: {
									type: "string",
									required: true
								},
								kind: {
									type: "string",
									required: true,
									enum: [
										"prompt",
										"image",
										"video",
										"audio"
									]
								},
								title: {
									type: "string",
									required: true
								},
								x: {
									type: "number",
									required: true
								},
								y: {
									type: "number",
									required: true
								},
								createdAt: {
									type: "integer",
									required: true
								},
								producedBy: {
									type: "string",
									required: true
								},
								promptText: { type: "string" },
								mediaSize: { type: "integer" },
								meta: { type: "json" }
							}
						}
					},
					edges: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								source: {
									type: "string",
									required: true
								},
								target: {
									type: "string",
									required: true
								}
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const v = value;
				if (v.elements.length === 0) return [{
					type: "text",
					text: "Canvas is empty for this session."
				}];
				const lines = v.elements.map((el) => `  ${el.filePath}  [${el.kind}]  @(${el.x}, ${el.y})  "${el.title}"`);
				return [{
					type: "text",
					text: `Canvas (${v.elements.length} elements, ${v.edges.length} edges):\n${lines.join("\n")}\nEdges:\n${v.edges.map((e) => `  ${e.source} → ${e.target}`).join("\n")}`
				}];
			}
		},
		execute: async (_args, exec) => {
			const sessionId = sessionIdOf(exec);
			await canvas.ensureHydrated(sessionId);
			const state = canvas.snapshot(sessionId);
			const lookup = (uuid) => canvas.getElement(sessionId, uuid);
			return Promise.resolve({
				elements: state.elements.map(elementProjection),
				edges: state.edges.map((e) => edgeProjection(e, lookup))
			});
		}
	}));
	register(defineTool({
		name: "aigc_media_edit",
		description: "Edit media files (video / audio / images) via ffmpeg. The operation is selected by the `operation` parameter. All input files must already exist inside the session canvas directory (use file_paths from aigc_http_request or previous aigc_canvas_place calls). The output is written to the canvas directory and returned as a file_path — pass it to aigc_canvas_place to put it on the canvas.\n\nOperations:\n  concat            — concatenate 2+ videos into one. inputs: [v1, v2, ...], output_ext: mp4.\n  clip              — trim a video by time. inputs: [video], output_ext: mp4. Pass start/end (seconds) or start/duration.\n  extract_audio     — extract the audio track from a video. inputs: [video], output_ext: mp3.\n  extract_frame     — grab one frame at a timestamp. inputs: [video], output_ext: png. Pass timestamp (seconds).\n  speed             — change playback speed. inputs: [video], output_ext: mp4. Pass speed (e.g. 2 = 2x faster, 0.5 = half speed).\n  resize            — resize a video. inputs: [video], output_ext: mp4. Pass width and/or height (pixels).\n  reverse           — reverse a video (and its audio). inputs: [video], output_ext: mp4.\n  add_audio         — replace/add audio on a video. inputs: [video, audio], output_ext: mp4.\n  images_to_video   — create a slideshow from images. inputs: [img1, img2, ...], output_ext: mp4. Pass fps (default 2).",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: MEDIA_EDIT_OPERATIONS,
				description: "The edit operation to perform."
			},
			inputs: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Input file paths (absolute, inside the session canvas directory). 1+ for most operations; 2+ for concat; exactly 2 for add_audio."
			},
			output_ext: {
				type: "string",
				required: true,
				description: "Output file extension without dot (e.g. mp4, mp3, png). Must match the operation: mp4 for video ops, mp3 for audio, png for frames."
			},
			start: {
				type: "number",
				description: "Start time in seconds (clip only)."
			},
			end: {
				type: "number",
				description: "End time in seconds (clip only)."
			},
			duration: {
				type: "number",
				description: "Duration in seconds (clip only; overrides end)."
			},
			speed: {
				type: "number",
				description: "Speed factor (speed only). 2 = 2x faster, 0.5 = half speed."
			},
			width: {
				type: "integer",
				description: "Target width in pixels (resize only)."
			},
			height: {
				type: "integer",
				description: "Target height in pixels (resize only)."
			},
			fps: {
				type: "integer",
				description: "Frames per second (images_to_video only, default 2)."
			},
			timestamp: {
				type: "number",
				description: "Timestamp in seconds to extract (extract_frame only)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					operation: {
						type: "string",
						required: true
					},
					file_path: {
						type: "string",
						required: true,
						description: "Absolute path of the output file. Pass this to aigc_canvas_place."
					},
					file_size: {
						type: "integer",
						required: true,
						description: "Output file size in bytes."
					},
					duration_ms: {
						type: "integer",
						required: true,
						description: "Processing time in milliseconds."
					}
				}
			},
			render: textRender((v) => `${v.operation} → ${v.file_path} (${v.file_size} bytes, ${v.duration_ms}ms). Place it with aigc_canvas_place.`)
		},
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			const sessionId = sessionIdOf(exec);
			const cwd = resolveCwd(sessionId);
			if (!MEDIA_EDIT_OPERATIONS.includes(args.operation)) throw new AigcError("bad-request", `unsupported operation: ${args.operation}`);
			const operation = args.operation;
			const minInputs = operation === "concat" ? 2 : operation === "add_audio" ? 2 : 1;
			if (!Array.isArray(args.inputs) || args.inputs.length < minInputs) throw new AigcError("bad-request", `operation "${operation}" requires at least ${minInputs} input(s)`);
			const result = await executeMediaEdit({
				operation,
				inputs: args.inputs,
				outputExt: args.output_ext,
				start: args.start,
				end: args.end,
				duration: args.duration,
				speed: args.speed,
				width: args.width,
				height: args.height,
				fps: args.fps,
				timestamp: args.timestamp
			}, cwd, sessionId, {
				timeoutMs: getTimeoutMs(),
				signal: exec.signal
			});
			const { stat: statFile } = await import("node:fs/promises");
			const outInfo = await statFile(result.outputPath);
			return {
				ok: true,
				operation: result.operation,
				file_path: result.outputPath,
				file_size: outInfo.size,
				duration_ms: result.durationMs
			};
		}
	}));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
/** Save a response body (bytes or text) into the session canvas directory. */
async function saveResponseToSession(content, ext, sessionId, cwd) {
	const dir = canvasDirFor(cwd, sessionId);
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, `${randomUUID()}.${ext}`);
	await writeFile(filePath, content);
	return filePath;
}
//#endregion
//#region src/index.ts
/**
* @dsh-external/dsh-aigc-canvas host half: the canvas registry, the provider
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
/** Plugin identity for cordis.yml rows. */
const name = "dsh-aigc-canvas";
/** Services required before mounting. */
const inject = [
	"httpServer",
	"sessions",
	"agents",
	"loader",
	"tools"
];
/** The connection row's resolved trustedHosts (live read). */
function trustedHostsOf(ctx) {
	for (const entry of ctx.loader.entries()) if (entry.options.name === "connection") return entry.options.config?.trustedHosts ?? [];
	return [];
}
/**
* Resolve a session's authoritative working directory.
* Throws when the session isn't registered yet (e.g. right after a
* restart, before the session list is loaded) — this prevents the
* canvas hydrate logic from silently reading the wrong directory and
* caching an empty table.
*/
function sessionCwdOf(ctx, sessionId) {
	const headerCwd = ctx.sessions.get(sessionId)?.header.cwd;
	if (headerCwd !== void 0 && headerCwd !== "") return headerCwd;
	throw new AigcError("not-found", `session "${sessionId}" is not registered or has no cwd yet`, 404);
}
/** Convert a resolved config to the runtime global settings wire shape. */
function toGlobalSettings(resolved) {
	return {
		requestTimeoutMs: resolved.requestTimeoutMs,
		mediaSizeLimit: resolved.mediaSizeLimit
	};
}
/**
* Build a minimal user-role message and inject it into the agent's
* next-step context (non-waking). Used to notify the model of user-
* initiated canvas actions (deletions, drag-dropped files).
*/
function notifyAgent(ctx, sessionId, text, summary) {
	const agent = ctx.agents.get(sessionId);
	if (agent === void 0) return;
	const message = {
		id: randomUUID(),
		role: "user",
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-aigc-canvas",
			form: "notice",
			summary: summary.slice(0, 120)
		}
	};
	agent.inject(message);
}
/** Infer element kind from a file extension (for drag-drop uploads). */
function kindForExtension(ext) {
	const e = ext.toLowerCase().replace(/^\./, "");
	if ([
		"png",
		"jpg",
		"jpeg",
		"gif",
		"webp",
		"bmp",
		"svg"
	].includes(e)) return "image";
	if ([
		"mp4",
		"webm",
		"mov",
		"avi",
		"mkv"
	].includes(e)) return "video";
	if ([
		"mp3",
		"wav",
		"ogg",
		"flac",
		"aac",
		"m4a"
	].includes(e)) return "audio";
	return "prompt";
}
/** Build the JSON API method table. */
function buildApi(ctx, canvas, store, getResolved) {
	return {
		"canvas.list": async (payload) => {
			const sessionId = requireString(payload, "sessionId");
			await canvas.ensureHydrated(sessionId);
			return canvas.snapshot(sessionId);
		},
		"canvas.move": (payload) => {
			const sessionId = requireString(payload, "sessionId");
			const uuid = requireString(payload, "uuid");
			const record = payload;
			const x = record?.x;
			const y = record?.y;
			if (typeof x !== "number" || typeof y !== "number") throw new AigcError("bad-request", "x and y are required numbers");
			return canvas.updatePosition(sessionId, uuid, x, y);
		},
		"canvas.delete": async (payload) => {
			const sessionId = requireString(payload, "sessionId");
			const uuid = requireString(payload, "uuid");
			let el;
			try {
				el = canvas.getElement(sessionId, uuid);
			} catch {}
			await canvas.deleteElement(sessionId, uuid);
			if (el !== void 0) {
				const desc = el.description !== void 0 ? ` ("${el.description}")` : "";
				notifyAgent(ctx, sessionId, `User deleted the canvas element "${el.title}"${desc} (${el.kind}, filePath: ${el.filePath}). It is no longer on the canvas — do not reference it in future aigc_canvas_place / aigc_canvas_link calls.`, `user deleted ${el.kind} "${el.title}"`);
			}
			return { ok: true };
		},
		"canvas.upload": async (payload) => {
			const sessionId = requireString(payload, "sessionId");
			const record = payload;
			const fileName = typeof record?.fileName === "string" ? record.fileName : "";
			const mediaBase64 = typeof record?.mediaBase64 === "string" ? record.mediaBase64 : "";
			if (fileName === "" || mediaBase64 === "") throw new AigcError("bad-request", "fileName and mediaBase64 are required strings");
			const bytes = Buffer.from(mediaBase64, "base64");
			if (bytes.byteLength > getResolved().mediaSizeLimit) throw new AigcError("fs-error", `uploaded file too large (${bytes.byteLength} bytes)`);
			const cwd = sessionCwdOf(ctx, sessionId);
			const dir = canvasDirFor(cwd, sessionId);
			await mkdir(dir, { recursive: true });
			const uuid = randomUUID();
			const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "bin";
			const kind = kindForExtension(ext);
			const filePath = join(dir, `${uuid}.${ext}`);
			await writeFile(filePath, bytes);
			const title = fileName.replace(/\.[^.]+$/, "");
			const description = typeof record?.description === "string" ? record.description.slice(0, 40) : void 0;
			const el = await canvas.placeFile(sessionId, {
				kind,
				filePath,
				title,
				producedBy: "user-upload",
				...typeof record?.x === "number" ? { x: record.x } : {},
				...typeof record?.y === "number" ? { y: record.y } : {},
				...description !== void 0 ? { description } : {}
			}, cwd);
			notifyAgent(ctx, sessionId, `User dragged a file onto the canvas: "${fileName}" (${kind}, ${bytes.byteLength} bytes). It is now placed as element "${el.title}" at (${el.x}, ${el.y}) with filePath ${el.filePath}. You can reference it in future generation calls.`, `user uploaded ${kind} "${el.title}"`);
			return {
				ok: true,
				element: el
			};
		},
		"providers.list": () => {
			return { providers: store.list() };
		},
		"providers.add": (payload) => {
			const provider = payload?.provider;
			if (provider === null || typeof provider !== "object" || Array.isArray(provider)) throw new AigcError("bad-request", "expected { provider: AigcProvider }");
			const result = store.add(provider);
			if (!result.ok) throw new AigcError("bad-request", result.error);
			return { providers: result.providers };
		},
		"providers.update": (payload) => {
			const provider = payload?.provider;
			if (provider === null || typeof provider !== "object" || Array.isArray(provider)) throw new AigcError("bad-request", "expected { provider: AigcProvider }");
			const result = store.update(provider);
			if (!result.ok) throw new AigcError("bad-request", result.error);
			return { providers: result.providers };
		},
		"providers.remove": (payload) => {
			const id = payload?.id;
			if (typeof id !== "string" || id === "") throw new AigcError("bad-request", "expected { id: string }");
			const result = store.remove(id);
			if (!result.ok) throw new AigcError("bad-request", result.error);
			return { providers: result.providers };
		},
		"config.get": () => {
			return {
				...toGlobalSettings(getResolved()),
				providers: store.list()
			};
		}
	};
}
/** Plugin body. */
function apply(ctx, config) {
	const resolved = resolveAigcConfig(config);
	const trustedHosts = trustedHostsOf(ctx);
	const fence = (req) => isTrustedApiRequest(req, trustedHosts);
	const mediaLimit = () => resolved.mediaSizeLimit;
	const canvas = createAigcCanvasService((sessionId) => sessionCwdOf(ctx, sessionId), mediaLimit);
	ctx.provide("aigcCanvas", canvas);
	const store = new ProviderStore(resolved.providers);
	const getResolved = () => ({
		providers: store.list(),
		requestTimeoutMs: resolved.requestTimeoutMs,
		mediaSizeLimit: resolved.mediaSizeLimit
	});
	const getProvider = (providerId) => {
		if (providerId !== void 0 && providerId !== "") {
			const provider = store.get(providerId);
			if (provider === void 0) throw new AigcError("bad-request", `unknown provider_id "${providerId}"; call aigc_get_provider_info to list available providers`);
			return provider;
		}
		const def = store.defaultProvider();
		if (def === void 0) throw new AigcError("bad-request", "no AIGC providers configured; add one in the settings page");
		return def;
	};
	const listProviders = () => {
		const list = store.list();
		const defaultId = store.defaultProvider()?.id;
		return list.map((p) => ({
			id: p.id,
			name: p.name,
			endpoint: p.endpoint,
			instructions: p.instructions,
			isStub: p.endpoint === "" || p.endpoint === "stub://aigc-backend",
			isDefault: p.id === defaultId
		}));
	};
	const api = buildApi(ctx, canvas, store, getResolved);
	ctx.effect(() => ctx.httpServer.register({
		kind: "prefix",
		path: "/aigc-canvas/api",
		handler: async (req, res) => {
			if (!fence(req)) {
				writeJson(res, 403, {
					ok: false,
					error: {
						code: "forbidden",
						message: "forbidden"
					}
				});
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: {
						code: "method-error",
						message: "method not allowed"
					}
				});
				return;
			}
			const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
			const method = pathname.startsWith("/aigc-canvas/api/") ? pathname.slice(17) : void 0;
			if (method === void 0 || method.includes("/")) {
				writeError(res, new AigcError("not-found", "unknown aigc-canvas API method", 404));
				return;
			}
			try {
				const payload = await readJsonBody(req);
				const handler = api[method];
				if (handler === void 0) throw new AigcError("not-found", `unknown aigc-canvas API method "${method}"`, 404);
				writeOk(res, await handler(payload));
			} catch (error) {
				writeError(res, error);
			}
		}
	}), "dsh-aigc-canvas: /aigc-canvas/api routes");
	ctx.effect(() => ctx.httpServer.register({
		kind: "prefix",
		path: "/aigc-canvas/file",
		handler: async (req, res) => {
			if (!fence(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method !== "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			try {
				const url = new URL(req.url ?? "/", "http://dsh.internal");
				const sessionId = url.searchParams.get("sessionId");
				const uuid = url.searchParams.get("uuid");
				if (sessionId === null || uuid === null) throw new AigcError("bad-request", "sessionId and uuid are required");
				await canvas.ensureHydrated(sessionId);
				const el = canvas.getElement(sessionId, uuid);
				if (el.filePath === void 0) throw new AigcError("not-found", `element "${uuid}" has no file`, 404);
				const dir = canvasDirFor(sessionCwdOf(ctx, sessionId), sessionId);
				if (!isAbsolute(el.filePath) || !el.filePath.startsWith(dir)) throw new AigcError("fs-error", "file path outside the session canvas directory", 403);
				const info = await stat(el.filePath);
				if (!info.isFile() || info.size > resolved.mediaSizeLimit) throw new AigcError("fs-error", "not a file or too large", 400);
				const type = mimeTypeFor(el.kind);
				const body = await readFile(el.filePath);
				const headers = {
					"content-type": type,
					"cache-control": "no-cache"
				};
				if (url.searchParams.get("download") === "1") headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(el.filePath))}`;
				res.writeHead(200, headers);
				res.end(body);
			} catch (error) {
				writeError(res, error);
			}
		}
	}), "dsh-aigc-canvas: /aigc-canvas/file media route");
	const wss = new WebSocketServer({ noServer: true });
	ctx.effect(() => ctx.httpServer.registerUpgrade({
		path: "/aigc-canvas/ws/canvas",
		handler: (req, socket, head) => {
			if (!fence(req)) {
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				attachCanvasPush(canvas, ws, req);
			});
		}
	}), "dsh-aigc-canvas: canvas push WebSocket");
	ctx.effect(() => registerTools(ctx, getProvider, (id, instructions) => store.setInstructions(id, instructions), listProviders, canvas, (sessionId) => sessionCwdOf(ctx, sessionId), () => resolved.requestTimeoutMs, () => resolved.mediaSizeLimit));
	ctx.effect(() => () => {
		wss.close();
	}, "dsh-aigc-canvas: teardown");
}
/** Push the live canvas state for one session to a connected canvas view. */
async function attachCanvasPush(canvas, ws, req) {
	try {
		const sessionId = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("sessionId");
		if (sessionId === null) {
			ws.close(1008, "sessionId is required");
			return;
		}
		const send = () => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(canvas.snapshot(sessionId)));
		};
		await canvas.ensureHydrated(sessionId);
		send();
		let retries = 0;
		const retryTimer = setInterval(() => {
			if (ws.readyState !== WebSocket.OPEN) {
				clearInterval(retryTimer);
				return;
			}
			retries++;
			if (canvas.snapshot(sessionId).elements.length > 0) {
				clearInterval(retryTimer);
				return;
			}
			if (retries >= 20) {
				clearInterval(retryTimer);
				return;
			}
			canvas.ensureHydrated(sessionId).then(() => send());
		}, 1e3);
		ws.on("close", () => {
			clearInterval(retryTimer);
		});
		ws.on("error", () => {
			clearInterval(retryTimer);
		});
		const unsubscribe = canvas.subscribeSession(sessionId, send);
		ws.on("close", () => {
			unsubscribe();
		});
		ws.on("error", () => {
			unsubscribe();
		});
	} catch (error) {
		ws.close(1011, error instanceof Error ? error.message : String(error));
	}
}
//#endregion
export { Config, apply, inject, name };
