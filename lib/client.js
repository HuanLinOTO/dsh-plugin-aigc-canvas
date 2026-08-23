window.__ModuleLoader__.load({
	id: "@huanlin/dsh-plugin-aigc-canvas",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/**
		* Typed fetch wrapper over the /aigc-canvas JSON API.
		*/
		/** One wire failure. */
		var AigcApiError = class extends Error {
			code;
			constructor(code, message) {
				super(message);
				this.code = code;
			}
		};
		async function call(method, payload, signal) {
			let response;
			try {
				response = await fetch(`/aigc-canvas/api/${method}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					signal
				});
			} catch (error) {
				throw new AigcApiError("network", error instanceof Error ? error.message : String(error));
			}
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === void 0) throw new AigcApiError(parsed?.error?.code ?? "http", parsed?.error?.message ?? `HTTP ${response.status}`);
			return parsed.value;
		}
		/** Fetch the canvas state (elements + edges) for one session. */
		function fetchCanvas(sessionId, signal) {
			return call("canvas.list", { sessionId }, signal);
		}
		/** Persist one element's new canvas position (after a client drag). */
		function moveCanvasElement(sessionId, uuid, x, y, signal) {
			return call("canvas.move", {
				sessionId,
				uuid,
				x,
				y
			}, signal);
		}
		/** Delete one element from the canvas (also removes its edges). */
		function deleteCanvasElement(sessionId, uuid, signal) {
			return call("canvas.delete", {
				sessionId,
				uuid
			}, signal);
		}
		/** Upload a file (drag-dropped onto the canvas) and place it as a new element. */
		function uploadCanvasFile(sessionId, fileName, mediaBase64, opts, signal) {
			return call("canvas.upload", {
				sessionId,
				fileName,
				mediaBase64,
				...opts
			}, signal);
		}
		/** Fetch the full runtime config (providers + global settings). */
		function fetchConfig(signal) {
			return call("config.get", {}, signal);
		}
		/** Add a new provider. */
		function addProvider(provider, signal) {
			return call("providers.add", { provider }, signal);
		}
		/** Update an existing provider. */
		function updateProvider(provider, signal) {
			return call("providers.update", { provider }, signal);
		}
		/** Remove a provider by id. */
		function removeProvider(id, signal) {
			return call("providers.remove", { id }, signal);
		}
		/** Build the media URL for one element's media file (by uuid; the host resolves to the file). */
		function mediaUrlOf(sessionId, uuid, download = false) {
			const params = new URLSearchParams({
				sessionId,
				uuid
			});
			if (download) params.set("download", "1");
			return `/aigc-canvas/file?${params.toString()}`;
		}
		/** Build the WebSocket URL for the canvas push endpoint. */
		function canvasWsUrl(sessionId) {
			return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/aigc-canvas/ws/canvas?sessionId=${encodeURIComponent(sessionId)}`;
		}
		//#endregion
		//#region src/client/store.ts
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
		/** Empty canvas state used as the pre-load placeholder. */
		function emptyState(sessionId) {
			return {
				sessionId,
				elements: [],
				edges: []
			};
		}
		/** One store instance per tab activation. */
		var CanvasStore = class {
			opts;
			/** The session id this store is bound to. */
			sessionId;
			state;
			listeners = /* @__PURE__ */ new Set();
			ws;
			reconnectTimer;
			disposed = false;
			fetchAbort;
			constructor(opts) {
				this.opts = opts;
				this.sessionId = opts.sessionId;
				this.state = emptyState(opts.sessionId);
				this.refresh();
				this.openWs();
			}
			/** Snapshot reader for useSyncExternalStore. */
			getSnapshot = () => this.state;
			/** Subscribe listener; returns disposer. */
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			/** Force a refresh (e.g. user clicked a refresh button). */
			async refresh() {
				if (this.disposed) return;
				this.fetchAbort?.abort();
				const ac = new AbortController();
				this.fetchAbort = ac;
				try {
					const next = await fetchCanvas(this.opts.sessionId, ac.signal);
					if (!this.disposed) this.setState(next);
				} catch {}
			}
			/**
			* Persist a dragged element's new position. The authoritative snapshot
			* arrives over the WS push (the host notifies after persisting), so no
			* local state update is applied here.
			*/
			async move(uuid, x, y) {
				if (this.disposed) return;
				try {
					await moveCanvasElement(this.opts.sessionId, uuid, x, y);
				} catch {}
			}
			/** Delete an element (right-click → Delete). Best-effort; WS push catches up. */
			async deleteElement(uuid) {
				if (this.disposed) return;
				try {
					await deleteCanvasElement(this.opts.sessionId, uuid);
				} catch {}
			}
			/** Upload a drag-dropped file and place it on the canvas. */
			async uploadFile(fileName, mediaBase64, opts) {
				if (this.disposed) return;
				try {
					await uploadCanvasFile(this.opts.sessionId, fileName, mediaBase64, opts);
				} catch {}
			}
			/** Tear down: close WS, abort any in-flight fetch, drop listeners. */
			dispose() {
				this.disposed = true;
				this.fetchAbort?.abort();
				if (this.reconnectTimer !== void 0) {
					window.clearTimeout(this.reconnectTimer);
					this.reconnectTimer = void 0;
				}
				if (this.ws !== void 0) {
					try {
						this.ws.close();
					} catch {}
					this.ws = void 0;
				}
				this.listeners.clear();
			}
			setState(next) {
				this.state = next;
				for (const fn of [...this.listeners]) fn();
			}
			openWs() {
				if (this.disposed) return;
				let ws;
				try {
					ws = new WebSocket(canvasWsUrl(this.opts.sessionId));
				} catch {
					this.scheduleReconnect();
					return;
				}
				this.ws = ws;
				ws.onmessage = (event) => {
					try {
						const parsed = JSON.parse(event.data);
						if (parsed && typeof parsed.sessionId === "string") this.setState(parsed);
					} catch {}
				};
				ws.onclose = () => {
					if (this.disposed) return;
					this.ws = void 0;
					this.scheduleReconnect();
				};
				ws.onerror = () => {
					try {
						ws.close();
					} catch {}
				};
			}
			scheduleReconnect() {
				if (this.disposed) return;
				if (this.reconnectTimer !== void 0) return;
				this.reconnectTimer = window.setTimeout(() => {
					this.reconnectTimer = void 0;
					this.openWs();
				}, 2e3);
			}
		};
		//#endregion
		//#region \0dsh-css:D:\Projects\deepseek-harness\dsh-aigc-canvas\src\client\canvas.module.css.mjs
		const css$1 = "/* dsh-aigc-canvas client styles.\r\n *\r\n * Renders inside a better-sidebar tab panel. Follows the DSH core design\r\n * language: `--dsw-alias-*` semantic tokens, `--dsw-font-*` typography,\r\n * 36px header bar + 24x24 r6 icon buttons (mirror of SubagentView), 8px\r\n * radius cards on `--dsw-alias-bg-layer-2`, no aggressive borders —\r\n * hover/active fills carry the interaction state.\r\n */\r\n\r\n.i0op5y_canvas {\r\n  position: relative;\r\n  display: flex;\r\n  flex-direction: column;\r\n  height: 100%;\r\n  font: var(--dsw-font-s-14);\r\n  color: var(--dsw-alias-label-primary);\r\n  background: transparent;\r\n}\r\n\r\n/* ── Header bar (mirror SubagentView: 36px h, 0 8px 0 12px) ────────────── */\r\n\r\n.i0op5y_header {\r\n  flex: none;\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n  height: 36px;\r\n  padding: 0 8px 0 12px;\r\n}\r\n\r\n.i0op5y_title {\r\n  flex: 1;\r\n  min-width: 0;\r\n  font: var(--dsw-font-s-14);\r\n  color: var(--dsw-alias-label-secondary);\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.i0op5y_count {\r\n  flex: none;\r\n  font: var(--dsw-font-xxxs-11);\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.i0op5y_zoom {\r\n  flex: none;\r\n  min-width: 36px;\r\n  text-align: center;\r\n  font: var(--dsw-font-xxxs-11);\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.i0op5y_iconButton {\r\n  flex: none;\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  width: 24px;\r\n  height: 24px;\r\n  border: none;\r\n  border-radius: 6px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-secondary);\r\n  cursor: pointer;\r\n  font: var(--dsw-font-s-14);\r\n  line-height: 1;\r\n}\r\n\r\n.i0op5y_iconButton:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n/* Zoom slider in the header. */\r\n.i0op5y_zoomSlider {\r\n  flex: none;\r\n  width: 80px;\r\n  height: 4px;\r\n  -webkit-appearance: none;\r\n  appearance: none;\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  border-radius: 2px;\r\n  outline: none;\r\n  cursor: pointer;\r\n}\r\n\r\n.i0op5y_zoomSlider::-webkit-slider-thumb {\r\n  -webkit-appearance: none;\r\n  appearance: none;\r\n  width: 12px;\r\n  height: 12px;\r\n  border-radius: 50%;\r\n  background: var(--dsw-alias-label-secondary);\r\n  cursor: pointer;\r\n}\r\n\r\n.i0op5y_zoomSlider::-moz-range-thumb {\r\n  width: 12px;\r\n  height: 12px;\r\n  border: none;\r\n  border-radius: 50%;\r\n  background: var(--dsw-alias-label-secondary);\r\n  cursor: pointer;\r\n}\r\n\r\n/* ── Infinite canvas surface ───────────────────────────────────────────── */\r\n\r\n.i0op5y_surface {\r\n  flex: 1 1 auto;\r\n  position: relative;\r\n  overflow: hidden;\r\n  touch-action: none;\r\n  cursor: grab;\r\n  background-color: transparent;\r\n  background-image:\r\n    radial-gradient(var(--dsw-alias-border-l2) 1px, transparent 1px);\r\n  background-size: 24px 24px;\r\n}\r\n\r\n.i0op5y_surface:active {\r\n  cursor: grabbing;\r\n}\r\n\r\n.i0op5y_world {\r\n  position: absolute;\r\n  left: 0;\r\n  top: 0;\r\n  transform-origin: 0 0;\r\n}\r\n\r\n.i0op5y_edgeLayer {\r\n  position: absolute;\r\n  left: 0;\r\n  top: 0;\r\n  width: 1px;\r\n  height: 1px;\r\n  overflow: visible;\r\n  pointer-events: none;\r\n}\r\n\r\n.i0op5y_edgeLine {\r\n  stroke: var(--dsw-alias-label-tertiary);\r\n  stroke-width: 2.5;\r\n  stroke-opacity: 0.55;\r\n  fill: none;\r\n  stroke-linecap: round;\r\n  stroke-linejoin: round;\r\n}\r\n\r\n.i0op5y_edgeArrow {\r\n  fill: var(--dsw-alias-label-tertiary);\r\n  fill-opacity: 0.6;\r\n  stroke: var(--dsw-alias-label-tertiary);\r\n  stroke-width: 1;\r\n  stroke-opacity: 0.6;\r\n}\r\n\r\n.i0op5y_edgePort {\r\n  fill: var(--dsw-alias-bg-layer-2);\r\n  stroke: var(--dsw-alias-label-tertiary);\r\n  stroke-width: 2;\r\n  stroke-opacity: 0.7;\r\n}\r\n\r\n.i0op5y_nodeBox {\r\n  position: absolute;\r\n  left: 0;\r\n  top: 0;\r\n  width: 240px;\r\n}\r\n\r\n.i0op5y_nodeBoxDraggable {\r\n  cursor: move;\r\n  touch-action: none;\r\n}\r\n\r\n.i0op5y_empty {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 2px;\r\n  padding: 24px 16px;\r\n  font: var(--dsw-font-xxs-12);\r\n  color: var(--dsw-alias-label-tertiary);\r\n  text-align: center;\r\n}\r\n\r\n.i0op5y_emptyHint {\r\n  font: var(--dsw-font-xxxs-11);\r\n  color: var(--dsw-alias-label-dimmed);\r\n}\r\n\r\n/* ── Node card (8px radius, bg-layer-2, no aggressive borders) ─────────── */\r\n\r\n.i0op5y_node {\r\n  border-radius: 8px;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  overflow: hidden;\r\n}\r\n\r\n.i0op5y_nodeHeader {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 6px;\r\n  padding: 6px 10px;\r\n}\r\n\r\n.i0op5y_kindDot {\r\n  flex: none;\r\n  width: 6px;\r\n  height: 6px;\r\n  border-radius: 50%;\r\n  background: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.i0op5y_kindDot_image { background: #4caf50; }\r\n.i0op5y_kindDot_video { background: #ff9800; }\r\n.i0op5y_kindDot_audio { background: #ab47bc; }\r\n.i0op5y_kindDot_prompt { background: #6b8cff; }\r\n\r\n.i0op5y_kindLabel {\r\n  font: var(--dsw-font-xxxs-11);\r\n  color: var(--dsw-alias-label-tertiary);\r\n  text-transform: lowercase;\r\n}\r\n\r\n.i0op5y_nodeTime {\r\n  margin-left: auto;\r\n  font: var(--dsw-font-xxxs-11);\r\n  color: var(--dsw-alias-label-dimmed);\r\n}\r\n\r\n.i0op5y_nodeTitle {\r\n  padding: 0 10px 4px;\r\n  font: var(--dsw-font-s-14);\r\n  color: var(--dsw-alias-label-primary);\r\n  word-break: break-word;\r\n}\r\n\r\n.i0op5y_nodeDescription {\r\n  padding: 0 10px 4px;\r\n  font: var(--dsw-font-xxs-12);\r\n  color: var(--dsw-alias-label-tertiary);\r\n  font-style: italic;\r\n  word-break: break-word;\r\n}\r\n\r\n.i0op5y_nodeMedia {\r\n  padding: 0 10px 8px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  max-width: 100%;\r\n}\r\n\r\n.i0op5y_promptText {\r\n  margin: 0;\r\n  padding: 6px 8px;\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  border-radius: 6px;\r\n  font: var(--dsw-font-xxs-12);\r\n  font-family: var(--ds-font-family-code);\r\n  white-space: pre-wrap;\r\n  word-break: break-word;\r\n  max-height: 200px;\r\n  overflow-y: auto;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.i0op5y_mediaImage {\r\n  /* Counter-scale trick: decode at the on-screen pixel size (layout width\r\n   * × zoom) so zooming in stays crisp, then visually shrink back to the\r\n   * layout box. `--canvas-scale` is set on the world layer by CanvasView;\r\n   * `--media-ratio` (h/w) is set on each img by CanvasNode after onLoad.\r\n   *\r\n   * width = 100% × scale        → layout box (e.i0op5y_g. 880px at 4× zoom)\r\n   * transform: scale(1/scale)   → visual 220px (back to layout box size)\r\n   * margin-right: 100% × (1-s)  → cancel horizontal layout inflation\r\n   * margin-bottom: 100% × ratio × (1-s) → cancel vertical layout inflation\r\n   *\r\n   * Percentages on margin resolve against the containing block's WIDTH\r\n   * (the 220px card content area), so `100%` = 220px here — which is\r\n   * exactly the visual width, making the math work out. */\r\n  width: calc(100% * var(--canvas-scale, 1));\r\n  max-width: none;\r\n  height: auto;\r\n  transform: scale(calc(1 / var(--canvas-scale, 1)));\r\n  transform-origin: top left;\r\n  margin-right: calc(100% * (1 - var(--canvas-scale, 1)));\r\n  margin-bottom: calc(100% * var(--media-ratio, 0.75) * (1 - var(--canvas-scale, 1)));\r\n  border-radius: 4px;\r\n  display: block;\r\n}\r\n\r\n.i0op5y_mediaVideo {\r\n  width: calc(100% * var(--canvas-scale, 1));\r\n  max-width: none;\r\n  height: auto;\r\n  transform: scale(calc(1 / var(--canvas-scale, 1)));\r\n  transform-origin: top left;\r\n  margin-right: calc(100% * (1 - var(--canvas-scale, 1)));\r\n  margin-bottom: calc(100% * var(--media-ratio, 0.75) * (1 - var(--canvas-scale, 1)));\r\n  border-radius: 4px;\r\n  display: block;\r\n}\r\n\r\n.i0op5y_mediaAudio {\r\n  width: 100%;\r\n  display: block;\r\n}\r\n\r\n.i0op5y_boundaryError {\r\n  margin: 8px;\r\n  padding: 8px 12px;\r\n  font: var(--dsw-font-xxs-12);\r\n  color: var(--dsw-alias-state-error-primary);\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  border-radius: 6px;\r\n}\r\n\r\n/* ── Detail panel (elevated surface, mirror Modal/Panel aesthetic) ─────── */\r\n\r\n.i0op5y_detailPanel {\r\n  position: absolute;\r\n  right: 8px;\r\n  top: 44px;\r\n  bottom: 8px;\r\n  width: 280px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  border-radius: 12px;\r\n  box-shadow: var(--dsw-shadow-lv3);\r\n  z-index: 10;\r\n  overflow: hidden;\r\n  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);\r\n  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);\r\n}\r\n\r\n.i0op5y_detailHeader {\r\n  flex: none;\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n  padding: 8px 10px;\r\n}\r\n\r\n.i0op5y_detailTitle {\r\n  flex: 1 1 auto;\r\n  min-width: 0;\r\n  font: var(--dsw-font-s-14);\r\n  color: var(--dsw-alias-label-primary);\r\n  word-break: break-word;\r\n}\r\n\r\n.i0op5y_detailClose {\r\n  flex: none;\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  width: 24px;\r\n  height: 24px;\r\n  border: none;\r\n  border-radius: 6px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-secondary);\r\n  cursor: pointer;\r\n  font: var(--dsw-font-s-14);\r\n  line-height: 1;\r\n}\r\n\r\n.i0op5y_detailClose:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.i0op5y_detailBody {\r\n  flex: 1 1 auto;\r\n  min-height: 0;\r\n  overflow-y: auto;\r\n  padding: 0 10px 10px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 10px;\r\n}\r\n\r\n.i0op5y_detailBlock {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  min-width: 0;\r\n}\r\n\r\n.i0op5y_detailLabel {\r\n  font: var(--dsw-font-xxxs-11);\r\n  color: var(--dsw-alias-label-tertiary);\r\n  text-transform: lowercase;\r\n}\r\n\r\n.i0op5y_detailPrompt {\r\n  margin: 0;\r\n  padding: 6px 8px;\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  border-radius: 6px;\r\n  font: var(--dsw-font-xxs-12);\r\n  font-family: var(--ds-font-family-code);\r\n  white-space: pre-wrap;\r\n  word-break: break-word;\r\n  max-height: 160px;\r\n  overflow-y: auto;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.i0op5y_detailValue {\r\n  font: var(--dsw-font-xxs-12);\r\n  color: var(--dsw-alias-label-secondary);\r\n  word-break: break-word;\r\n}\r\n\r\n.i0op5y_metaList {\r\n  margin: 0;\r\n  padding: 0;\r\n  display: grid;\r\n  grid-template-columns: auto 1fr;\r\n  gap: 2px 8px;\r\n  font: var(--dsw-font-xxxs-11);\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.i0op5y_metaKey {\r\n  font: var(--dsw-font-xxxs-strong-11);\r\n  color: var(--dsw-alias-label-secondary);\r\n  text-transform: lowercase;\r\n}\r\n\r\n.i0op5y_metaValue {\r\n  margin: 0;\r\n  color: var(--dsw-alias-label-secondary);\r\n  word-break: break-all;\r\n  font-family: var(--ds-font-family-code);\r\n}\r\n\r\n.i0op5y_filePath {\r\n  display: block;\r\n  font: var(--dsw-font-xxxs-11);\r\n  font-family: var(--ds-font-family-code);\r\n  color: var(--dsw-alias-label-tertiary);\r\n  word-break: break-all;\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  padding: 4px 6px;\r\n  border-radius: 4px;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n}\r\n\r\n/* ── Minimap (bottom-right overview) ──────────────────────────────────── */\r\n\r\n.i0op5y_minimap {\r\n  position: absolute;\r\n  right: 8px;\r\n  bottom: 8px;\r\n  z-index: 5;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  border-radius: 8px;\r\n  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);\r\n  padding: 4px;\r\n  cursor: pointer;\r\n  overflow: hidden;\r\n}\r\n\r\n.i0op5y_minimapSvg {\r\n  display: block;\r\n  pointer-events: none;\r\n}\r\n\r\n/* ── Right-click context menu ─────────────────────────────────────────── */\r\n\r\n.i0op5y_contextMenu {\r\n  position: fixed;\r\n  z-index: 20;\r\n  min-width: 120px;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  border-radius: 8px;\r\n  box-shadow: var(--dsw-shadow-lv3);\r\n  padding: 4px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 2px;\r\n}\r\n\r\n.i0op5y_contextMenuItem {\r\n  display: block;\r\n  width: 100%;\r\n  padding: 6px 10px;\r\n  border: none;\r\n  border-radius: 6px;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-primary);\r\n  font: var(--dsw-font-xxs-12);\r\n  text-align: left;\r\n  cursor: pointer;\r\n}\r\n\r\n.i0op5y_contextMenuItem:hover {\r\n  background: var(--dsw-alias-state-error-bg);\r\n  color: var(--dsw-alias-state-error-primary);\r\n}\r\n\r\n/* ── Drag-drop indicator + upload overlay ─────────────────────────────── */\r\n\r\n.i0op5y_dropIndicator {\r\n  position: absolute;\r\n  left: 0;\r\n  top: 0;\r\n  width: 240px;\r\n  height: 110px;\r\n  border: 2px dashed var(--dsw-alias-label-secondary);\r\n  border-radius: 8px;\r\n  background: var(--dsw-alias-interactive-bg-hover);\r\n  opacity: 0.5;\r\n  pointer-events: none;\r\n  transform-origin: 0 0;\r\n}\r\n\r\n.i0op5y_uploadOverlay {\r\n  position: absolute;\r\n  inset: 0;\r\n  z-index: 15;\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  background: var(--dsw-alias-bg-layer-1);\r\n  opacity: 0.6;\r\n  font: var(--dsw-font-s-14);\r\n  color: var(--dsw-alias-label-secondary);\r\n  pointer-events: none;\r\n}\r\n";
		const tagId$1 = "@huanlin/dsh-plugin-aigc-canvas/canvas.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@huanlin/dsh-plugin-aigc-canvas";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var canvas_module_css_default = {
			"canvas": "i0op5y_canvas",
			"header": "i0op5y_header",
			"title": "i0op5y_title",
			"count": "i0op5y_count",
			"zoom": "i0op5y_zoom",
			"iconButton": "i0op5y_iconButton",
			"zoomSlider": "i0op5y_zoomSlider",
			"surface": "i0op5y_surface",
			"world": "i0op5y_world",
			"edgeLayer": "i0op5y_edgeLayer",
			"edgeLine": "i0op5y_edgeLine",
			"edgeArrow": "i0op5y_edgeArrow",
			"edgePort": "i0op5y_edgePort",
			"nodeBox": "i0op5y_nodeBox",
			"nodeBoxDraggable": "i0op5y_nodeBoxDraggable",
			"empty": "i0op5y_empty",
			"emptyHint": "i0op5y_emptyHint",
			"node": "i0op5y_node",
			"nodeHeader": "i0op5y_nodeHeader",
			"kindDot": "i0op5y_kindDot",
			"kindDot_image": "i0op5y_kindDot_image",
			"kindDot_video": "i0op5y_kindDot_video",
			"kindDot_audio": "i0op5y_kindDot_audio",
			"kindDot_prompt": "i0op5y_kindDot_prompt",
			"kindLabel": "i0op5y_kindLabel",
			"nodeTime": "i0op5y_nodeTime",
			"nodeTitle": "i0op5y_nodeTitle",
			"nodeDescription": "i0op5y_nodeDescription",
			"nodeMedia": "i0op5y_nodeMedia",
			"promptText": "i0op5y_promptText",
			"mediaImage": "i0op5y_mediaImage",
			"g": "i0op5y_g",
			"mediaVideo": "i0op5y_mediaVideo",
			"mediaAudio": "i0op5y_mediaAudio",
			"boundaryError": "i0op5y_boundaryError",
			"detailPanel": "i0op5y_detailPanel",
			"detailHeader": "i0op5y_detailHeader",
			"detailTitle": "i0op5y_detailTitle",
			"detailClose": "i0op5y_detailClose",
			"detailBody": "i0op5y_detailBody",
			"detailBlock": "i0op5y_detailBlock",
			"detailLabel": "i0op5y_detailLabel",
			"detailPrompt": "i0op5y_detailPrompt",
			"detailValue": "i0op5y_detailValue",
			"metaList": "i0op5y_metaList",
			"metaKey": "i0op5y_metaKey",
			"metaValue": "i0op5y_metaValue",
			"filePath": "i0op5y_filePath",
			"minimap": "i0op5y_minimap",
			"minimapSvg": "i0op5y_minimapSvg",
			"contextMenu": "i0op5y_contextMenu",
			"contextMenuItem": "i0op5y_contextMenuItem",
			"dropIndicator": "i0op5y_dropIndicator",
			"uploadOverlay": "i0op5y_uploadOverlay"
		};
		//#endregion
		//#region src/client/CanvasNode.tsx
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
		/** Short label for one element kind. */
		function kindLabel(kind, t) {
			switch (kind) {
				case "prompt": return t("prompt");
				case "image": return t("image");
				case "video": return t("video");
				case "audio": return t("audio");
			}
		}
		/** Format the createdAt timestamp as a short HH:MM:SS. */
		function formatTime(ms) {
			const d = new Date(ms);
			const pad = (n) => n < 10 ? `0${n}` : String(n);
			return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		}
		/** Default aspect ratio (h/w) used before media metadata loads. 4:3 → 0.75. */
		const DEFAULT_RATIO = .75;
		/**
		* One image element. Captures its natural aspect ratio on load so the
		* negative bottom margin (which cancels the layout-box inflation from the
		* counter-scale trick) can be computed from CSS variables alone.
		*/
		function MediaImage({ url, alt }) {
			const [ratio, setRatio] = (0, react.useState)(DEFAULT_RATIO);
			const onLoad = (e) => {
				const img = e.currentTarget;
				if (img.naturalWidth > 0) setRatio(img.naturalHeight / img.naturalWidth);
			};
			return (0, react.createElement)("img", {
				className: canvas_module_css_default.mediaImage,
				src: url,
				alt,
				loading: "lazy",
				draggable: false,
				onLoad,
				style: { ["--media-ratio"]: ratio }
			});
		}
		/**
		* One video element. Same counter-scale trick as MediaImage; the aspect
		* ratio comes from `loadedmetadata` (videoWidth / videoHeight).
		*/
		function MediaVideo({ url }) {
			const [ratio, setRatio] = (0, react.useState)(DEFAULT_RATIO);
			const onLoadedMetadata = (e) => {
				const v = e.currentTarget;
				if (v.videoWidth > 0) setRatio(v.videoHeight / v.videoWidth);
			};
			return (0, react.createElement)("video", {
				className: canvas_module_css_default.mediaVideo,
				src: url,
				controls: true,
				preload: "metadata",
				onLoadedMetadata,
				style: { ["--media-ratio"]: ratio }
			});
		}
		/** Render one element's media (or prompt text) based on its kind. */
		function renderMedia(el) {
			if (el.kind === "prompt") return (0, react.createElement)("pre", { className: canvas_module_css_default.promptText }, el.promptText ?? "");
			if (el.uuid === void 0) return null;
			const url = mediaUrlOf(el.sessionId ?? "", el.uuid);
			if (el.kind === "image") return (0, react.createElement)(MediaImage, {
				url,
				alt: el.title
			});
			if (el.kind === "video") return (0, react.createElement)(MediaVideo, { url });
			return (0, react.createElement)("audio", {
				className: canvas_module_css_default.mediaAudio,
				src: url,
				controls: true,
				preload: "metadata"
			});
		}
		/** One canvas node (fixed-width card; height follows content). */
		function CanvasNode({ element, t }) {
			const kindDotClass = `${canvas_module_css_default.kindDot} ${canvas_module_css_default[`kindDot_${element.kind}`] ?? ""}`;
			return (0, react.createElement)("div", {
				className: canvas_module_css_default.node,
				"data-uuid": element.uuid ?? "",
				"data-filepath": element.filePath
			}, (0, react.createElement)("div", { className: canvas_module_css_default.nodeHeader }, (0, react.createElement)("span", {
				className: kindDotClass,
				"aria-hidden": true
			}), (0, react.createElement)("span", { className: canvas_module_css_default.kindLabel }, kindLabel(element.kind, t)), (0, react.createElement)("span", { className: canvas_module_css_default.nodeTime }, formatTime(element.createdAt))), (0, react.createElement)("div", { className: canvas_module_css_default.nodeTitle }, element.title), element.description !== void 0 && element.description !== "" ? (0, react.createElement)("div", { className: canvas_module_css_default.nodeDescription }, element.description) : null, (0, react.createElement)("div", { className: canvas_module_css_default.nodeMedia }, renderMedia(element)));
		}
		//#endregion
		//#region src/client/CanvasView.tsx
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
		/** Error boundary so a render failure shows a strip instead of blanking. */
		var CanvasBoundary = class extends react.Component {
			state = { error: null };
			static getDerivedStateFromError(error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
			componentDidCatch(error, info) {
				console.error("[dsh-aigc-canvas] render error:", error, info.componentStack);
			}
			render() {
				if (this.state.error !== null) return (0, react.createElement)("div", { className: canvas_module_css_default.boundaryError }, `${this.props.t("loadError")}: ${this.state.error}`);
				return this.props.children;
			}
		};
		const MIN_SCALE = .2;
		const MAX_SCALE = 4;
		/** Fixed node box for edge anchoring (world units). Must match CSS .nodeBox width. */
		const NODE_W = 240;
		const NODE_H = 110;
		/** Zoom at the cursor position, keeping the world point under the cursor fixed. */
		function zoomAt(viewport, cx, cy, factor) {
			const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewport.scale * factor));
			const worldX = (cx - viewport.x) / viewport.scale;
			const worldY = (cy - viewport.y) / viewport.scale;
			return {
				scale,
				x: cx - worldX * scale,
				y: cy - worldY * scale
			};
		}
		/** Build a uuid → element map. */
		function elementMap(elements) {
			const map = /* @__PURE__ */ new Map();
			for (const el of elements) if (el.uuid !== void 0) map.set(el.uuid, el);
			return map;
		}
		/** Port radius (the small circle drawn at each connection point). */
		const PORT_R = 5;
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
		function renderEdge(edge, resolvePos) {
			const srcPos = resolvePos(edge.source);
			const tgtPos = resolvePos(edge.target);
			if (srcPos === void 0 || tgtPos === void 0) return null;
			const sx = srcPos.x + NODE_W;
			const sy = srcPos.y + NODE_H / 2;
			const tx = tgtPos.x;
			const ty = tgtPos.y + NODE_H / 2;
			const dx = Math.abs(tx - sx);
			const offset = Math.max(40, Math.min(dx * .5, 160));
			const d = `M ${sx} ${sy} C ${sx + offset} ${sy}, ${tx - offset} ${ty}, ${tx} ${ty}`;
			const arrow = 9;
			const wing = arrow * .55;
			const baseX = tx - arrow;
			const arrowPath = `M ${tx} ${ty} L ${baseX} ${ty - wing} L ${baseX} ${ty + wing} Z`;
			return (0, react.createElement)("g", { key: `${edge.source}:${edge.target}` }, (0, react.createElement)("path", {
				d,
				className: canvas_module_css_default.edgeLine,
				fill: "none"
			}), (0, react.createElement)("path", {
				d: arrowPath,
				className: canvas_module_css_default.edgeArrow
			}), (0, react.createElement)("circle", {
				cx: sx,
				cy: sy,
				r: PORT_R,
				className: canvas_module_css_default.edgePort
			}), (0, react.createElement)("circle", {
				cx: tx,
				cy: ty,
				r: PORT_R,
				className: canvas_module_css_default.edgePort
			}));
		}
		/**
		* The infinite canvas view.
		* @param props - store + locale translate.
		* @returns the canvas element.
		*/
		function CanvasView({ store, t }) {
			const state = (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot, store.getSnapshot);
			const [viewport, setViewport] = (0, react.useState)({
				x: 0,
				y: 0,
				scale: 1
			});
			const [drafts, setDrafts] = (0, react.useState)(/* @__PURE__ */ new Map());
			const [selected, setSelected] = (0, react.useState)(void 0);
			const [contextMenu, setContextMenu] = (0, react.useState)(void 0);
			const [dropTarget, setDropTarget] = (0, react.useState)(void 0);
			const [uploading, setUploading] = (0, react.useState)(false);
			const surfaceRef = (0, react.useRef)(null);
			const prevUuidsRef = (0, react.useRef)(/* @__PURE__ */ new Set());
			const panRef = (0, react.useRef)(null);
			const dragRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const surface = surfaceRef.current;
				if (surface === null) return;
				const onWheel = (event) => {
					event.preventDefault();
					const rect = surface.getBoundingClientRect();
					const cx = event.clientX - rect.left;
					const cy = event.clientY - rect.top;
					const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
					setViewport((prev) => zoomAt(prev, cx, cy, factor));
				};
				surface.addEventListener("wheel", onWheel, { passive: false });
				return () => surface.removeEventListener("wheel", onWheel);
			}, []);
			(0, react.useEffect)(() => {
				if (drafts.size === 0) return;
				const lookup = elementMap(state.elements);
				const stale = [];
				for (const [uuid, draftPos] of drafts) {
					const el = lookup.get(uuid);
					if (el !== void 0 && el.x === draftPos.x && el.y === draftPos.y) stale.push(uuid);
				}
				if (stale.length > 0) setDrafts((prev) => {
					const next = new Map(prev);
					for (const uuid of stale) next.delete(uuid);
					return next;
				});
			}, [state, drafts]);
			(0, react.useEffect)(() => {
				if (panRef.current !== null || dragRef.current !== null) return;
				const surface = surfaceRef.current;
				if (surface === null) return;
				const prev = prevUuidsRef.current;
				let newest;
				for (const el of state.elements) if (el.uuid !== void 0 && !prev.has(el.uuid)) newest = el;
				const nextUuids = /* @__PURE__ */ new Set();
				for (const el of state.elements) if (el.uuid !== void 0) nextUuids.add(el.uuid);
				prevUuidsRef.current = nextUuids;
				if (newest === void 0) return;
				const rect = surface.getBoundingClientRect();
				const margin = 32;
				const screenX = newest.x * viewport.scale + viewport.x;
				const screenY = newest.y * viewport.scale + viewport.y;
				const elemW = NODE_W * viewport.scale;
				const elemH = NODE_H * viewport.scale;
				let panX = 0;
				let panY = 0;
				if (screenY + elemH > rect.height - margin) panY = screenY + elemH - (rect.height - margin);
				if (screenY < margin) panY = screenY - margin;
				if (screenX + elemW > rect.width - margin) panX = screenX + elemW - (rect.width - margin);
				if (screenX < margin) panX = screenX - margin;
				if (panX !== 0 || panY !== 0) setViewport((prev) => ({
					...prev,
					x: prev.x - panX,
					y: prev.y - panY
				}));
			}, [state, viewport.scale]);
			const [surfaceSize, setSurfaceSize] = (0, react.useState)({
				width: 0,
				height: 0
			});
			(0, react.useEffect)(() => {
				const surface = surfaceRef.current;
				if (surface === null) return;
				const update = () => {
					const rect = surface.getBoundingClientRect();
					setSurfaceSize({
						width: rect.width,
						height: rect.height
					});
				};
				update();
				const observer = new ResizeObserver(update);
				observer.observe(surface);
				return () => observer.disconnect();
			}, []);
			/** Zoom to a target scale, keeping the center of the viewport fixed. */
			const zoomToCenter = (newScale) => {
				const surface = surfaceRef.current;
				if (surface === null) return;
				const rect = surface.getBoundingClientRect();
				const cx = rect.width / 2;
				const cy = rect.height / 2;
				setViewport((prev) => {
					const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
					const worldX = (cx - prev.x) / prev.scale;
					const worldY = (cy - prev.y) / prev.scale;
					return {
						scale: s,
						x: cx - worldX * s,
						y: cy - worldY * s
					};
				});
			};
			const onSurfacePointerDown = (event) => {
				if (dragRef.current !== null) return;
				panRef.current = {
					pointerId: event.pointerId,
					startX: event.clientX,
					startY: event.clientY,
					orig: viewport
				};
				event.currentTarget.setPointerCapture(event.pointerId);
			};
			const onSurfacePointerMove = (event) => {
				const pan = panRef.current;
				if (pan !== null && pan.pointerId === event.pointerId) {
					setViewport({
						...pan.orig,
						x: pan.orig.x + (event.clientX - pan.startX),
						y: pan.orig.y + (event.clientY - pan.startY)
					});
					return;
				}
				const drag = dragRef.current;
				if (drag !== null && drag.pointerId === event.pointerId) setDrafts((prev) => {
					const next = new Map(prev);
					next.set(drag.uuid, {
						x: drag.origX + (event.clientX - drag.startX) / viewport.scale,
						y: drag.origY + (event.clientY - drag.startY) / viewport.scale
					});
					return next;
				});
			};
			const onSurfacePointerUp = (event) => {
				const pan = panRef.current;
				if (pan !== null && pan.pointerId === event.pointerId) {
					panRef.current = null;
					return;
				}
				const drag = dragRef.current;
				if (drag !== null && drag.pointerId === event.pointerId) {
					dragRef.current = null;
					const pos = drafts.get(drag.uuid);
					if (pos !== void 0 && (pos.x !== drag.origX || pos.y !== drag.origY)) store.move(drag.uuid, pos.x, pos.y);
				}
			};
			const onNodePointerDown = (event, el) => {
				if (el.uuid === void 0) return;
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				dragRef.current = {
					pointerId: event.pointerId,
					uuid: el.uuid,
					startX: event.clientX,
					startY: event.clientY,
					origX: el.x,
					origY: el.y
				};
			};
			const onNodeContextMenu = (event, el) => {
				if (el.uuid === void 0) return;
				event.preventDefault();
				event.stopPropagation();
				setContextMenu({
					x: event.clientX,
					y: event.clientY,
					uuid: el.uuid
				});
			};
			const onSurfaceClick = (event) => {
				if (contextMenu !== void 0) {
					event.stopPropagation();
					setContextMenu(void 0);
				}
			};
			const onDeleteElement = (uuid) => {
				setContextMenu(void 0);
				if (selected?.uuid === uuid) setSelected(void 0);
				store.deleteElement(uuid);
			};
			const onSurfaceDragOver = (event) => {
				if (event.dataTransfer.types.includes("Files")) {
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "copy";
					const rect = surfaceRef.current?.getBoundingClientRect();
					if (rect !== void 0) {
						const sx = event.clientX - rect.left;
						const sy = event.clientY - rect.top;
						const wx = (sx - viewport.x) / viewport.scale;
						const wy = (sy - viewport.y) / viewport.scale;
						setDropTarget({
							x: wx,
							y: wy
						});
					}
				}
			};
			const onSurfaceDragLeave = (event) => {
				if (event.currentTarget === event.target) {
					event.stopPropagation();
					setDropTarget(void 0);
				}
			};
			const onSurfaceDrop = async (event) => {
				event.preventDefault();
				event.stopPropagation();
				setDropTarget(void 0);
				const files = event.dataTransfer.files;
				if (files.length === 0) return;
				const rect = surfaceRef.current?.getBoundingClientRect();
				const sx = event.clientX - (rect?.left ?? 0);
				const sy = event.clientY - (rect?.top ?? 0);
				const wx = (sx - viewport.x) / viewport.scale;
				const wy = (sy - viewport.y) / viewport.scale;
				setUploading(true);
				try {
					for (const file of Array.from(files)) {
						const buf = await file.arrayBuffer();
						const bytes = new Uint8Array(buf);
						let binary = "";
						const chunk = 32768;
						for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
						const mediaBase64 = btoa(binary);
						await store.uploadFile(file.name, mediaBase64, {
							x: wx,
							y: wy
						});
					}
				} finally {
					setUploading(false);
				}
			};
			const lookup = elementMap(state.elements);
			const resolvePos = (uuid) => {
				const draft = drafts.get(uuid);
				if (draft !== void 0) return draft;
				const el = lookup.get(uuid);
				if (el !== void 0) return {
					x: el.x,
					y: el.y
				};
			};
			const posOf = (el) => {
				if (el.uuid !== void 0) {
					const draft = drafts.get(el.uuid);
					if (draft !== void 0) return draft;
				}
				return {
					x: el.x,
					y: el.y
				};
			};
			return (0, react.createElement)("div", { className: canvas_module_css_default.canvas }, (0, react.createElement)("div", { className: canvas_module_css_default.header }, (0, react.createElement)("span", { className: canvas_module_css_default.title }, t("title")), (0, react.createElement)("span", { className: canvas_module_css_default.count }, `${state.elements.length} ${t("elementCount")}`), (0, react.createElement)("span", { className: canvas_module_css_default.count }, `${state.edges.length} ${t("edgeCount")}`), (0, react.createElement)("span", { className: canvas_module_css_default.zoom }, `${Math.round(viewport.scale * 100)}%`), (0, react.createElement)("button", {
				type: "button",
				className: canvas_module_css_default.iconButton,
				onClick: () => zoomToCenter(viewport.scale * .8),
				title: t("zoomOut"),
				"aria-label": t("zoomOut")
			}, "−"), (0, react.createElement)("input", {
				type: "range",
				className: canvas_module_css_default.zoomSlider,
				min: Math.round(MIN_SCALE * 100),
				max: Math.round(400),
				value: Math.round(viewport.scale * 100),
				onChange: (e) => zoomToCenter(Number(e.target.value) / 100),
				"aria-label": t("zoom")
			}), (0, react.createElement)("button", {
				type: "button",
				className: canvas_module_css_default.iconButton,
				onClick: () => zoomToCenter(viewport.scale * 1.25),
				title: t("zoomIn"),
				"aria-label": t("zoomIn")
			}, "+"), (0, react.createElement)("button", {
				type: "button",
				className: canvas_module_css_default.iconButton,
				onClick: () => {
					store.refresh();
				},
				title: t("refresh"),
				"aria-label": t("refresh")
			}, "↻"), (0, react.createElement)("button", {
				type: "button",
				className: canvas_module_css_default.iconButton,
				onClick: () => setViewport({
					x: 0,
					y: 0,
					scale: 1
				}),
				title: t("resetView"),
				"aria-label": t("resetView")
			}, "⤢")), (0, react.createElement)("div", {
				className: canvas_module_css_default.surface,
				ref: surfaceRef,
				onPointerDown: onSurfacePointerDown,
				onPointerMove: onSurfacePointerMove,
				onPointerUp: onSurfacePointerUp,
				onPointerCancel: onSurfacePointerUp,
				onDoubleClick: () => setSelected(void 0),
				onClick: onSurfaceClick,
				onContextMenu: (event) => {
					event.preventDefault();
				},
				onDragOver: onSurfaceDragOver,
				onDragLeave: onSurfaceDragLeave,
				onDrop: (event) => {
					onSurfaceDrop(event);
				}
			}, state.elements.length === 0 ? (0, react.createElement)("div", { className: canvas_module_css_default.empty }, (0, react.createElement)("span", null, t("empty")), (0, react.createElement)("span", { className: canvas_module_css_default.emptyHint }, t("emptyHint"))) : (0, react.createElement)("div", {
				className: canvas_module_css_default.world,
				style: {
					transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
					["--canvas-scale"]: viewport.scale
				}
			}, (0, react.createElement)("svg", {
				className: canvas_module_css_default.edgeLayer,
				"aria-hidden": true
			}, ...state.edges.map((edge) => renderEdge(edge, resolvePos))), ...state.elements.map((el) => {
				const pos = posOf(el);
				return (0, react.createElement)("div", {
					key: el.uuid ?? el.filePath,
					className: `${canvas_module_css_default.nodeBox} ${el.uuid !== void 0 ? canvas_module_css_default.nodeBoxDraggable : ""}`,
					style: { transform: `translate(${pos.x}px, ${pos.y}px)` },
					onPointerDown: (event) => onNodePointerDown(event, el),
					onDoubleClick: (event) => {
						event.stopPropagation();
						setSelected(el);
					},
					onContextMenu: (event) => onNodeContextMenu(event, el)
				}, (0, react.createElement)(CanvasNode, {
					element: el,
					t
				}));
			})), dropTarget !== void 0 ? (0, react.createElement)("div", {
				className: canvas_module_css_default.dropIndicator,
				style: { transform: `translate(${dropTarget.x * viewport.scale + viewport.x}px, ${dropTarget.y * viewport.scale + viewport.y}px) scale(${viewport.scale})` }
			}) : null, uploading ? (0, react.createElement)("div", { className: canvas_module_css_default.uploadOverlay }, t("uploading")) : null), selected !== void 0 ? (0, react.createElement)(DetailPanel, {
				element: selected,
				t,
				onClose: () => setSelected(void 0)
			}) : null, contextMenu !== void 0 ? (0, react.createElement)(ContextMenu, {
				x: contextMenu.x,
				y: contextMenu.y,
				items: [{
					label: t("delete"),
					onClick: () => onDeleteElement(contextMenu.uuid)
				}],
				onClose: () => setContextMenu(void 0)
			}) : null, state.elements.length > 0 ? (0, react.createElement)(Minimap, {
				elements: state.elements,
				viewport,
				surfaceSize,
				setViewport
			}) : null);
		}
		/** A minimal fixed-position context menu (right-click). */
		function ContextMenu(props) {
			(0, react.useEffect)(() => {
				const onDown = () => props.onClose();
				const onKey = (e) => {
					if (e.key === "Escape") props.onClose();
				};
				window.addEventListener("pointerdown", onDown, { once: true });
				window.addEventListener("keydown", onKey, { once: true });
				return () => {
					window.removeEventListener("pointerdown", onDown);
					window.removeEventListener("keydown", onKey);
				};
			}, [props]);
			return (0, react.createElement)("div", {
				className: canvas_module_css_default.contextMenu,
				style: {
					left: props.x,
					top: props.y
				},
				onPointerDown: (e) => e.stopPropagation()
			}, ...props.items.map((item, i) => (0, react.createElement)("button", {
				key: i,
				type: "button",
				className: canvas_module_css_default.contextMenuItem,
				onClick: () => {
					item.onClick();
				}
			}, item.label)));
		}
		/** The double-click detail panel: prompt + generation params + path. */
		function DetailPanel({ element, t, onClose }) {
			const meta = element.meta;
			const metaEntries = Array.isArray(meta) || meta === null || typeof meta !== "object" ? [] : Object.entries(meta);
			return (0, react.createElement)("div", { className: canvas_module_css_default.detailPanel }, (0, react.createElement)("div", { className: canvas_module_css_default.detailHeader }, (0, react.createElement)("span", { className: canvas_module_css_default.detailTitle }, element.title), (0, react.createElement)("button", {
				type: "button",
				className: canvas_module_css_default.detailClose,
				onClick: onClose,
				"aria-label": t("detailClose")
			}, "×")), (0, react.createElement)("div", { className: canvas_module_css_default.detailBody }, element.promptText !== void 0 ? (0, react.createElement)("div", { className: canvas_module_css_default.detailBlock }, (0, react.createElement)("span", { className: canvas_module_css_default.detailLabel }, t("detailPrompt")), (0, react.createElement)("pre", { className: canvas_module_css_default.detailPrompt }, element.promptText)) : null, metaEntries.length > 0 ? (0, react.createElement)("div", { className: canvas_module_css_default.detailBlock }, (0, react.createElement)("span", { className: canvas_module_css_default.detailLabel }, t("detailParams")), (0, react.createElement)("dl", { className: canvas_module_css_default.metaList }, ...metaEntries.flatMap(([k, v]) => [(0, react.createElement)("dt", {
				key: `${k}-k`,
				className: canvas_module_css_default.metaKey
			}, k), (0, react.createElement)("dd", {
				key: `${k}-v`,
				className: canvas_module_css_default.metaValue
			}, formatMetaValue(v))]))) : null, (0, react.createElement)("div", { className: canvas_module_css_default.detailBlock }, (0, react.createElement)("span", { className: canvas_module_css_default.detailLabel }, t("generatedBy")), (0, react.createElement)("span", { className: canvas_module_css_default.detailValue }, element.producedBy)), (0, react.createElement)("div", { className: canvas_module_css_default.detailBlock }, (0, react.createElement)("span", { className: canvas_module_css_default.detailLabel }, t("detailPosition")), (0, react.createElement)("span", { className: canvas_module_css_default.detailValue }, `(${Math.round(element.x)}, ${Math.round(element.y)})`)), (0, react.createElement)("div", { className: canvas_module_css_default.detailBlock }, (0, react.createElement)("span", { className: canvas_module_css_default.detailLabel }, t("detailPath")), (0, react.createElement)("code", { className: canvas_module_css_default.filePath }, element.filePath))));
		}
		function formatMetaValue(v) {
			if (typeof v === "string") return v;
			if (typeof v === "number" || typeof v === "boolean") return String(v);
			if (v === null || v === void 0) return "";
			try {
				return JSON.stringify(v);
			} catch {
				return String(v);
			}
		}
		const MINIMAP_W = 168;
		const MINIMAP_H = 120;
		/** Color dot per element kind in the minimap. */
		const KIND_COLOR = {
			image: "#4caf50",
			video: "#ff9800",
			audio: "#ab47bc",
			prompt: "#6b8cff"
		};
		/**
		* Bottom-right minimap: shows all elements as small colored rectangles and
		* the current viewport as a frame. Click/drag to pan the viewport.
		*/
		function Minimap(props) {
			const { elements, viewport, surfaceSize, setViewport } = props;
			const minimapRef = (0, react.useRef)(null);
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const el of elements) {
				minX = Math.min(minX, el.x);
				minY = Math.min(minY, el.y);
				maxX = Math.max(maxX, el.x + NODE_W);
				maxY = Math.max(maxY, el.y + NODE_H);
			}
			if (surfaceSize.width > 0 && surfaceSize.height > 0) {
				const vpMinX = -viewport.x / viewport.scale;
				const vpMinY = -viewport.y / viewport.scale;
				const vpMaxX = vpMinX + surfaceSize.width / viewport.scale;
				const vpMaxY = vpMinY + surfaceSize.height / viewport.scale;
				minX = Math.min(minX, vpMinX);
				minY = Math.min(minY, vpMinY);
				maxX = Math.max(maxX, vpMaxX);
				maxY = Math.max(maxY, vpMaxY);
			}
			if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
			minX -= 40;
			minY -= 40;
			maxX += 40;
			maxY += 40;
			const worldW = maxX - minX;
			const worldH = maxY - minY;
			const miniScale = Math.min(156 / worldW, 108 / worldH);
			const offsetX = (MINIMAP_W - worldW * miniScale) / 2;
			const offsetY = (MINIMAP_H - worldH * miniScale) / 2;
			const toMiniX = (wx) => offsetX + (wx - minX) * miniScale;
			const toMiniY = (wy) => offsetY + (wy - minY) * miniScale;
			const vpX = toMiniX(-viewport.x / viewport.scale);
			const vpY = toMiniY(-viewport.y / viewport.scale);
			const vpW = surfaceSize.width / viewport.scale * miniScale;
			const vpH = surfaceSize.height / viewport.scale * miniScale;
			const onPointerDown = (event) => {
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				const pan = (clientX, clientY) => {
					const rect = minimapRef.current?.getBoundingClientRect();
					if (rect === void 0) return;
					const mx = clientX - rect.left;
					const my = clientY - rect.top;
					const worldX = (mx - offsetX) / miniScale + minX;
					const worldY = (my - offsetY) / miniScale + minY;
					setViewport((prev) => ({
						...prev,
						x: surfaceSize.width / 2 - worldX * prev.scale,
						y: surfaceSize.height / 2 - worldY * prev.scale
					}));
				};
				pan(event.clientX, event.clientY);
				const onMove = (e) => pan(e.clientX, e.clientY);
				const onUp = () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			};
			return (0, react.createElement)("div", {
				className: canvas_module_css_default.minimap,
				ref: minimapRef,
				onPointerDown
			}, (0, react.createElement)("svg", {
				width: MINIMAP_W,
				height: MINIMAP_H,
				className: canvas_module_css_default.minimapSvg
			}, ...elements.map((el) => (0, react.createElement)("rect", {
				key: el.uuid ?? el.filePath,
				x: toMiniX(el.x),
				y: toMiniY(el.y),
				width: Math.max(2, NODE_W * miniScale),
				height: Math.max(2, NODE_H * miniScale),
				rx: 2,
				fill: KIND_COLOR[el.kind],
				fillOpacity: .35,
				stroke: KIND_COLOR[el.kind],
				strokeOpacity: .7,
				strokeWidth: 1
			})), (0, react.createElement)("rect", {
				x: vpX,
				y: vpY,
				width: vpW,
				height: vpH,
				fill: "var(--dsw-alias-label-primary)",
				fillOpacity: .08,
				stroke: "var(--dsw-alias-label-primary)",
				strokeOpacity: .8,
				strokeWidth: 2,
				rx: 2
			})));
		}
		/** Wrapped export so the tab component can mount the boundary once. */
		function CanvasViewWithBoundary(props) {
			return (0, react.createElement)(CanvasBoundary, {
				t: props.t,
				children: (0, react.createElement)(CanvasView, props)
			});
		}
		//#endregion
		//#region \0dsh-css:D:\Projects\deepseek-harness\dsh-aigc-canvas\src\client\SettingsPage.module.css.mjs
		const css = "/* AIGC canvas settings section, in the settings-panel design language shared\r\n * with ModelsSection / GeneralSection / yet-another-subagent: 14/22 body,\r\n * 12/18 caption, 16/24 title, capsule controls (h36 r18 primary, h28 r14\r\n * secondary), 32px fields, border-l2 hairlines, and the editor as a filled\r\n * module on the panel fill.\r\n *\r\n * Every color resolves through a --dsw-alias-* token (no literal colors). */\r\n\r\n.o6nt8s_section {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 12px;\r\n  max-width: 720px;\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.o6nt8s_title {\r\n  margin: 0;\r\n  font-size: 16px;\r\n  line-height: 24px;\r\n  font-weight: 500;\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.o6nt8s_intro {\r\n  margin: 0;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.o6nt8s_error {\r\n  margin: 0;\r\n  padding: 8px 12px;\r\n  border: 1px solid var(--dsw-alias-state-error-primary);\r\n  border-radius: 8px;\r\n  background: var(--dsw-alias-interactive-bg-hover-danger);\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-state-error-primary);\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: space-between;\r\n  gap: 8px;\r\n}\r\n\r\n.o6nt8s_errorDismiss {\r\n  flex: none;\r\n  border: none;\r\n  background: transparent;\r\n  color: inherit;\r\n  font-size: 16px;\r\n  line-height: 1;\r\n  cursor: pointer;\r\n  padding: 0 4px;\r\n}\r\n\r\n.o6nt8s_rows {\r\n  list-style: none;\r\n  margin: 12px 0 0;\r\n  padding: 0;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n}\r\n\r\n/* A configured provider: outlined on the panel fill, matching the rowCard\r\n * chrome in ModelsSection. */\r\n.o6nt8s_rowCard {\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 12px;\r\n  padding: 12px 14px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 12px;\r\n}\r\n\r\n.o6nt8s_rowHead {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 10px;\r\n}\r\n\r\n/* Chevron toggle: a small square with two borders, rotated to point right\r\n * (collapsed) or down (expanded). Pure CSS, no icon font. */\r\n.o6nt8s_chevronButton {\r\n  flex: none;\r\n  width: 24px;\r\n  height: 24px;\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  border: none;\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-secondary);\r\n  cursor: pointer;\r\n  padding: 0;\r\n  border-radius: 4px;\r\n}\r\n\r\n.o6nt8s_chevronButton:hover {\r\n  background: var(--dsw-alias-interactive-bg-hover-solid);\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n/* Spacer that occupies the chevron slot on cards without a toggle (e.o6nt8s_g. the\r\n * new-draft card, which is always expanded). Keeps row-head alignment. */\r\n.o6nt8s_chevronSpacer {\r\n  flex: none;\r\n  width: 24px;\r\n  height: 24px;\r\n}\r\n\r\n.o6nt8s_chevron {\r\n  width: 7px;\r\n  height: 7px;\r\n  border-right: 1.5px solid currentColor;\r\n  border-bottom: 1.5px solid currentColor;\r\n  transform: rotate(-45deg);\r\n  transition: transform 0.15s ease;\r\n}\r\n\r\n.o6nt8s_chevronExpanded {\r\n  transform: rotate(45deg);\r\n}\r\n\r\n.o6nt8s_rowIdentity {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: 6px;\r\n  min-width: 0;\r\n  flex: 1 1 auto;\r\n  flex-wrap: wrap;\r\n}\r\n\r\n.o6nt8s_rowName {\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  font-weight: 500;\r\n  color: var(--dsw-alias-label-primary);\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.o6nt8s_rowNamePlaceholder {\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  font-weight: 500;\r\n  color: var(--dsw-alias-label-tertiary);\r\n  font-style: italic;\r\n}\r\n\r\n/* Builtin badge: uses DSH <Pill> with a brand-colored override to mark\r\n * seed providers. */\r\n.o6nt8s_builtinBadge {\r\n  height: 18px;\r\n  padding: 0 6px;\r\n  border-radius: 4px;\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  font-weight: 500;\r\n  background: var(--dsw-alias-brand-primary);\r\n  color: var(--dsw-alias-label-primary-foreground);\r\n  letter-spacing: 0.02em;\r\n}\r\n\r\n/* Default provider badge. */\r\n.o6nt8s_defaultBadge {\r\n  height: 18px;\r\n  padding: 0 6px;\r\n  border-radius: 4px;\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  font-weight: 500;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n/* Stub/real mode badge. */\r\n.o6nt8s_stubBadge {\r\n  height: 18px;\r\n  padding: 0 6px;\r\n  border-radius: 4px;\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  font-weight: 500;\r\n  background: var(--dsw-alias-bg-layer-2);\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.o6nt8s_realBadge {\r\n  height: 18px;\r\n  padding: 0 6px;\r\n  border-radius: 4px;\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  font-weight: 500;\r\n  background: var(--dsw-alias-state-success-primary);\r\n  color: var(--dsw-alias-label-primary-foreground);\r\n}\r\n\r\n.o6nt8s_rowId {\r\n  flex: none;\r\n  padding: 1px 6px;\r\n  border: 1px solid var(--dsw-alias-border-l3);\r\n  border-radius: 4px;\r\n  font-size: 11px;\r\n  line-height: 16px;\r\n  font-family: var(--dsw-font-markdown-code-block-small, monospace);\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.o6nt8s_rowActions {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  margin-left: auto;\r\n  flex: none;\r\n}\r\n\r\n/* Editor surface: a filled module on the panel, matching ModelsSection's\r\n * editor chrome (bg-module-platform, r12, p14/16). */\r\n.o6nt8s_editor {\r\n  border-radius: 12px;\r\n  background: var(--dsw-alias-bg-module-platform);\r\n  padding: 14px 16px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 14px;\r\n}\r\n\r\n.o6nt8s_field {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 6px;\r\n}\r\n\r\n.o6nt8s_fieldLabel {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: 10px;\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  font-weight: 500;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n/* Input: matching ModelsSection .o6nt8s_input — h32, r8, border-l2, bg-layer-1. */\r\n.o6nt8s_input {\r\n  box-sizing: border-box;\r\n  width: 100%;\r\n  height: 32px;\r\n  padding: 0 10px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 8px;\r\n  font: inherit;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  background: var(--dsw-alias-bg-layer-1);\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.o6nt8s_input:focus {\r\n  outline: none;\r\n  border-color: var(--dsw-alias-brand-primary);\r\n}\r\n\r\n.o6nt8s_input::placeholder {\r\n  color: var(--dsw-alias-label-dimmed);\r\n}\r\n\r\n.o6nt8s_input:disabled {\r\n  opacity: 0.6;\r\n  cursor: default;\r\n}\r\n\r\n.o6nt8s_textarea {\r\n  box-sizing: border-box;\r\n  width: 100%;\r\n  min-height: 64px;\r\n  padding: 6px 10px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 8px;\r\n  font: inherit;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  background: var(--dsw-alias-bg-layer-1);\r\n  color: var(--dsw-alias-label-primary);\r\n  resize: vertical;\r\n}\r\n\r\n.o6nt8s_textarea:focus {\r\n  outline: none;\r\n  border-color: var(--dsw-alias-brand-primary);\r\n}\r\n\r\n.o6nt8s_textarea::placeholder {\r\n  color: var(--dsw-alias-label-dimmed);\r\n}\r\n\r\n/* Auth scheme row: scheme select + optional name input side by side. */\r\n.o6nt8s_authRow {\r\n  display: flex;\r\n  gap: 8px;\r\n}\r\n\r\n.o6nt8s_authRow .o6nt8s_input {\r\n  flex: 1 1 auto;\r\n}\r\n\r\n/* Select: same chrome as .o6nt8s_input. */\r\n.o6nt8s_select {\r\n  box-sizing: border-box;\r\n  flex: 0 0 auto;\r\n  min-width: 130px;\r\n  height: 32px;\r\n  padding: 0 10px;\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 8px;\r\n  font: inherit;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  background: var(--dsw-alias-bg-layer-1);\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.o6nt8s_select:focus {\r\n  outline: none;\r\n  border-color: var(--dsw-alias-brand-primary);\r\n}\r\n\r\n/* Caption labels under fields. */\r\n.o6nt8s_desc {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n.o6nt8s_hint {\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n/* Buttons: capsule controls matching ModelsSection (h36 r18 primary,\r\n * h28 r14 secondary in row context). */\r\n.o6nt8s_primaryButton,\r\n.o6nt8s_secondaryButton,\r\n.o6nt8s_dangerButton,\r\n.o6nt8s_addBlockButton {\r\n  box-sizing: border-box;\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 4px;\r\n  height: 36px;\r\n  padding: 0 14px;\r\n  border: none;\r\n  border-radius: 18px;\r\n  font: inherit;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  cursor: pointer;\r\n}\r\n\r\n.o6nt8s_primaryButton {\r\n  background: var(--dsw-alias-button-primary-fill);\r\n  color: var(--dsw-alias-label-primary-foreground);\r\n}\r\n\r\n.o6nt8s_primaryButton:hover:not(:disabled) {\r\n  background: var(--dsw-alias-button-primary-hover);\r\n}\r\n\r\n.o6nt8s_secondaryButton,\r\n.o6nt8s_addBlockButton {\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  background: transparent;\r\n  color: var(--dsw-alias-label-primary);\r\n}\r\n\r\n.o6nt8s_secondaryButton:hover:not(:disabled),\r\n.o6nt8s_addBlockButton:hover:not(:disabled) {\r\n  background: var(--dsw-alias-interactive-bg-hover-solid);\r\n}\r\n\r\n.o6nt8s_dangerButton {\r\n  background: transparent;\r\n  color: var(--dsw-alias-state-error-primary);\r\n}\r\n\r\n.o6nt8s_dangerButton:hover:not(:disabled) {\r\n  background: var(--dsw-alias-interactive-bg-hover-danger);\r\n}\r\n\r\n/* Row-context buttons go dense (h28 r14, 12/18). */\r\n.o6nt8s_rowActions .o6nt8s_secondaryButton,\r\n.o6nt8s_rowActions .o6nt8s_dangerButton {\r\n  height: 28px;\r\n  padding: 0 10px;\r\n  border-radius: 14px;\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n}\r\n\r\n.o6nt8s_rowActions .o6nt8s_primaryButton {\r\n  height: 28px;\r\n  padding: 0 10px;\r\n  border-radius: 14px;\r\n  font-size: 12px;\r\n  line-height: 18px;\r\n}\r\n\r\n.o6nt8s_primaryButton:disabled,\r\n.o6nt8s_secondaryButton:disabled,\r\n.o6nt8s_dangerButton:disabled,\r\n.o6nt8s_addBlockButton:disabled {\r\n  opacity: 0.4;\r\n  cursor: default;\r\n}\r\n\r\n.o6nt8s_primaryButton:focus-visible,\r\n.o6nt8s_secondaryButton:focus-visible,\r\n.o6nt8s_dangerButton:focus-visible,\r\n.o6nt8s_addBlockButton:focus-visible {\r\n  outline: none;\r\n  box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);\r\n}\r\n\r\n/* Add-provider action: a full-width dashed-outline place card matching\r\n * ModelsSection's addBlock. */\r\n.o6nt8s_addBlockButton {\r\n  width: 100%;\r\n  margin-top: 12px;\r\n  border-style: dashed;\r\n  border-radius: 12px;\r\n  height: 40px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.o6nt8s_addBlockButton:hover:not(:disabled) {\r\n  color: var(--dsw-alias-label-primary);\r\n  border-color: var(--dsw-alias-brand-primary);\r\n}\r\n\r\n/* Empty state. */\r\n.o6nt8s_empty {\r\n  margin: 0;\r\n  padding: 24px 12px;\r\n  text-align: center;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n\r\n/* Modal confirm body text. */\r\n.o6nt8s_confirmText {\r\n  margin: 0;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n.o6nt8s_loading {\r\n  padding: 12px;\r\n  font-size: 14px;\r\n  line-height: 22px;\r\n  color: var(--dsw-alias-label-tertiary);\r\n}\r\n";
		const tagId = "@huanlin/dsh-plugin-aigc-canvas/SettingsPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@huanlin/dsh-plugin-aigc-canvas";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var SettingsPage_module_css_default = {
			"section": "o6nt8s_section",
			"title": "o6nt8s_title",
			"intro": "o6nt8s_intro",
			"error": "o6nt8s_error",
			"errorDismiss": "o6nt8s_errorDismiss",
			"rows": "o6nt8s_rows",
			"rowCard": "o6nt8s_rowCard",
			"rowHead": "o6nt8s_rowHead",
			"chevronButton": "o6nt8s_chevronButton",
			"g": "o6nt8s_g",
			"chevronSpacer": "o6nt8s_chevronSpacer",
			"chevron": "o6nt8s_chevron",
			"chevronExpanded": "o6nt8s_chevronExpanded",
			"rowIdentity": "o6nt8s_rowIdentity",
			"rowName": "o6nt8s_rowName",
			"rowNamePlaceholder": "o6nt8s_rowNamePlaceholder",
			"builtinBadge": "o6nt8s_builtinBadge",
			"defaultBadge": "o6nt8s_defaultBadge",
			"stubBadge": "o6nt8s_stubBadge",
			"realBadge": "o6nt8s_realBadge",
			"rowId": "o6nt8s_rowId",
			"rowActions": "o6nt8s_rowActions",
			"editor": "o6nt8s_editor",
			"field": "o6nt8s_field",
			"fieldLabel": "o6nt8s_fieldLabel",
			"input": "o6nt8s_input",
			"textarea": "o6nt8s_textarea",
			"authRow": "o6nt8s_authRow",
			"select": "o6nt8s_select",
			"desc": "o6nt8s_desc",
			"hint": "o6nt8s_hint",
			"primaryButton": "o6nt8s_primaryButton",
			"secondaryButton": "o6nt8s_secondaryButton",
			"dangerButton": "o6nt8s_dangerButton",
			"addBlockButton": "o6nt8s_addBlockButton",
			"empty": "o6nt8s_empty",
			"confirmText": "o6nt8s_confirmText",
			"loading": "o6nt8s_loading"
		};
		//#endregion
		//#region src/client/SettingsPage.tsx
		/**
		* SettingsPage — the AIGC canvas settings section: provider list CRUD.
		*
		* Visual language: matches ModelsSection / GeneralSection / yet-another-subagent —
		* outlined rowCard per provider (border-l2, r12, p12/14), filled editor surface
		* (bg-module-platform, r12, p14/16), capsule controls (h36 r18 primary,
		* h28 r14 secondary), 32px fields with border-l2 / bg-layer-1, 12/18 caption
		* labels. Every color resolves through --dsw-alias-* tokens.
		*
		* Each provider card is collapsible (chevron in the row head); the editor
		* surface is hidden when collapsed. Builtin providers (cordis.yml seed) carry
		* a `builtin`/`内置` badge next to the title. The "+ Add provider" button at
		* the bottom reveals an inline draft card with all fields editable (including
		* id) and Create / Cancel actions.
		*
		* Real providers carry an "initialize" (初始化) action: it sends a prepared
		* message to the current conversation so the agent probes the API with
		* aigc_http_request and records the usage instructions via
		* aigc_provider_set_instructions. The editor also exposes the auth scheme
		* (bearer / custom header / query param) the aigc_http_request tool uses to
		* attach the apiKey.
		*
		* @module @huanlin/dsh-plugin-aigc-canvas/client/SettingsPage
		*/
		/** Default shape for a brand-new draft (before the user fills in id/name). */
		function emptyDraft() {
			return {
				id: "",
				name: "",
				endpoint: "stub://aigc-backend",
				apiKey: "",
				instructions: "",
				auth: {
					scheme: "bearer",
					name: ""
				},
				builtin: false
			};
		}
		/**
		* Render the AIGC provider settings page.
		* @param props - settings.section runtime share + locale + inject.
		* @returns the page element.
		*/
		function SettingsPage({ t, send }) {
			const [providers, setProviders] = (0, react.useState)([]);
			const [drafts, setDrafts] = (0, react.useState)([]);
			const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [addingNew, setAddingNew] = (0, react.useState)(false);
			const [newDraft, setNewDraft] = (0, react.useState)(emptyDraft());
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(void 0);
			const [confirmDelete, setConfirmDelete] = (0, react.useState)(void 0);
			const refresh = (0, react.useCallback)(async () => {
				setLoading(true);
				setError(void 0);
				try {
					const result = await fetchConfig();
					setProviders(result.providers);
					setDrafts(result.providers.map((p) => ({
						...p,
						auth: { ...p.auth }
					})));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setLoading(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const add = (0, react.useCallback)(async () => {
				if (newDraft.id === "") return;
				try {
					const result = await addProvider(newDraft);
					setProviders(result.providers);
					setDrafts(result.providers.map((p) => ({
						...p,
						auth: { ...p.auth }
					})));
					setExpanded(/* @__PURE__ */ new Set([...expanded, newDraft.id]));
					setAddingNew(false);
					setNewDraft(emptyDraft());
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}, [expanded, newDraft]);
			const update = (0, react.useCallback)(async (draft) => {
				try {
					const result = await updateProvider(draft);
					setProviders(result.providers);
					setDrafts(result.providers.map((p) => ({
						...p,
						auth: { ...p.auth }
					})));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}, []);
			const remove = (0, react.useCallback)(async (id) => {
				try {
					const result = await removeProvider(id);
					setProviders(result.providers);
					setDrafts(result.providers.map((p) => ({
						...p,
						auth: { ...p.auth }
					})));
					const next = new Set(expanded);
					next.delete(id);
					setExpanded(next);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}, [expanded]);
			const init = (0, react.useCallback)(async (provider) => {
				const label = provider.name === "" ? provider.id : provider.name;
				const text = t("row.initPrompt").replace("{name}", label).replace("{id}", provider.id);
				try {
					await send(text);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}, [send, t]);
			const patchDraft = (id, patch) => {
				setDrafts((prev) => prev.map((d) => d.id === id ? {
					...d,
					...patch
				} : d));
			};
			const toggleExpand = (id) => {
				const next = new Set(expanded);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				setExpanded(next);
			};
			const cancelNew = () => {
				setAddingNew(false);
				setNewDraft(emptyDraft());
			};
			const defaultId = providers.length > 0 ? providers[0]?.id : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: SettingsPage_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: SettingsPage_module_css_default.title,
						children: t("settingsTitle")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: SettingsPage_module_css_default.intro,
						children: t("settingsIntro")
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: SettingsPage_module_css_default.error,
						children: [error, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SettingsPage_module_css_default.errorDismiss,
							onClick: () => setError(void 0),
							children: "×"
						})]
					}),
					loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: SettingsPage_module_css_default.loading,
						children: t("settingsLoading")
					}) : providers.length === 0 && !addingNew ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: SettingsPage_module_css_default.empty,
						children: t("settingsEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
						className: SettingsPage_module_css_default.rows,
						children: [drafts.map((draft) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderCard, {
							draft,
							expanded: expanded.has(draft.id),
							isDefault: draft.id === defaultId,
							t,
							onToggle: () => toggleExpand(draft.id),
							onPatch: (patch) => patchDraft(draft.id, patch),
							onSave: () => void update(draft),
							onDelete: () => setConfirmDelete(draft.id),
							onInit: () => void init(draft)
						}, draft.id)), addingNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderCard, {
							draft: newDraft,
							expanded: true,
							isNew: true,
							isDefault: false,
							t,
							onPatch: (patch) => setNewDraft((prev) => ({
								...prev,
								...patch
							})),
							onCreate: () => void add(),
							onCancel: cancelNew
						}, "__new__")]
					}),
					!loading && !addingNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: SettingsPage_module_css_default.addBlockButton,
						onClick: () => setAddingNew(true),
						children: t("settingsAdd")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: confirmDelete !== void 0,
						onClose: () => {
							setConfirmDelete(void 0);
						},
						title: t("row.deleteConfirm"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SettingsPage_module_css_default.secondaryButton,
							onClick: () => {
								setConfirmDelete(void 0);
							},
							children: t("row.cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SettingsPage_module_css_default.dangerButton,
							onClick: () => {
								if (confirmDelete !== void 0) remove(confirmDelete);
								setConfirmDelete(void 0);
							},
							children: t("row.delete")
						})] }),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: SettingsPage_module_css_default.confirmText,
							children: t("row.deleteConfirm")
						})
					})
				]
			});
		}
		function ProviderCard({ draft, expanded, isNew, isDefault, t, onToggle, onPatch, onSave, onDelete, onCreate, onCancel, onInit }) {
			const isStub = draft.endpoint === "" || draft.endpoint === "stub://aigc-backend";
			const patchAuth = (patch) => {
				onPatch({ auth: {
					...draft.auth,
					...patch
				} });
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: SettingsPage_module_css_default.rowCard,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: SettingsPage_module_css_default.rowHead,
					children: [
						!isNew && onToggle !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SettingsPage_module_css_default.chevronButton,
							onClick: onToggle,
							"aria-label": expanded ? t("row.collapse") : t("row.expand"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: expanded ? `${SettingsPage_module_css_default.chevron} ${SettingsPage_module_css_default.chevronExpanded}` : SettingsPage_module_css_default.chevron,
								"aria-hidden": "true"
							})
						}),
						isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: SettingsPage_module_css_default.chevronSpacer,
							"aria-hidden": "true"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SettingsPage_module_css_default.rowIdentity,
							children: [
								isNew ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.rowNamePlaceholder,
									children: t("settingsAdd")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.rowName,
									children: draft.name === "" ? draft.id : draft.name
								}),
								draft.builtin && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									className: SettingsPage_module_css_default.builtinBadge,
									children: t("badge.builtin")
								}),
								isDefault && !isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									className: SettingsPage_module_css_default.defaultBadge,
									children: t("badge.default")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									className: isStub ? SettingsPage_module_css_default.stubBadge : SettingsPage_module_css_default.realBadge,
									children: isStub ? t("badge.stub") : t("badge.real")
								}),
								!isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: SettingsPage_module_css_default.rowId,
									children: draft.id
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: SettingsPage_module_css_default.rowActions,
							children: isNew ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: SettingsPage_module_css_default.primaryButton,
								onClick: onCreate,
								disabled: draft.id === "",
								children: t("row.create")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: SettingsPage_module_css_default.secondaryButton,
								onClick: onCancel,
								children: t("row.cancel")
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								!isStub && onInit !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: SettingsPage_module_css_default.secondaryButton,
									onClick: onInit,
									children: t("row.init")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: SettingsPage_module_css_default.secondaryButton,
									onClick: onSave,
									children: t("row.save")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: SettingsPage_module_css_default.dangerButton,
									onClick: onDelete,
									children: t("row.delete")
								})
							] })
						})
					]
				}), expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: SettingsPage_module_css_default.editor,
					children: [
						isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: SettingsPage_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.fieldLabel,
									children: t("row.id")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: SettingsPage_module_css_default.input,
									value: draft.id,
									placeholder: t("row.idPlaceholder"),
									onChange: (e) => onPatch({ id: e.target.value })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.hint,
									children: t("row.idHint")
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: SettingsPage_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SettingsPage_module_css_default.fieldLabel,
								children: t("row.name")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: SettingsPage_module_css_default.input,
								value: draft.name,
								placeholder: t("row.namePlaceholder"),
								onChange: (e) => onPatch({ name: e.target.value })
							})]
						})] }),
						!isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: SettingsPage_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SettingsPage_module_css_default.fieldLabel,
								children: t("row.name")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: SettingsPage_module_css_default.input,
								value: draft.name,
								placeholder: t("row.namePlaceholder"),
								onChange: (e) => onPatch({ name: e.target.value })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: SettingsPage_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.fieldLabel,
									children: t("row.endpoint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: SettingsPage_module_css_default.input,
									value: draft.endpoint,
									placeholder: t("row.endpointPlaceholder"),
									onChange: (e) => onPatch({ endpoint: e.target.value })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.desc,
									children: t("row.endpointDesc")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: SettingsPage_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.fieldLabel,
									children: t("row.apiKey")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: SettingsPage_module_css_default.input,
									type: "password",
									autoComplete: "off",
									value: draft.apiKey,
									placeholder: t("row.apiKeyPlaceholder"),
									onChange: (e) => onPatch({ apiKey: e.target.value })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.desc,
									children: t("row.apiKeyDesc")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SettingsPage_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.fieldLabel,
									children: t("row.auth")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SettingsPage_module_css_default.authRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: SettingsPage_module_css_default.select,
										value: draft.auth.scheme,
										onChange: (e) => patchAuth({ scheme: e.target.value }),
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "bearer",
												children: t("row.authBearer")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "header",
												children: t("row.authHeader")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "query",
												children: t("row.authQuery")
											})
										]
									}), draft.auth.scheme !== "bearer" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: SettingsPage_module_css_default.input,
										value: draft.auth.name,
										placeholder: draft.auth.scheme === "header" ? "x-api-key" : "api_key",
										onChange: (e) => patchAuth({ name: e.target.value })
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.desc,
									children: t("row.authDesc")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: SettingsPage_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.fieldLabel,
									children: t("row.instructions")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: SettingsPage_module_css_default.textarea,
									value: draft.instructions,
									placeholder: t("row.instructionsPlaceholder"),
									rows: 8,
									onChange: (e) => onPatch({ instructions: e.target.value })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.desc,
									children: t("row.instructionsDesc")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SettingsPage_module_css_default.hint,
									children: t("row.instructionsHint")
								})
							]
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* i18n dictionaries for the AIGC canvas plugin.
		*
		* @module @huanlin/dsh-plugin-aigc-canvas/client/locales
		*/
		const NS = "dsh-aigc-canvas";
		const zh = {
			tabTitle: "AIGC 画布",
			title: "AIGC 画布",
			empty: "画布是空的。模型通过 aigc_http_request 调用供应商 API 生成素材,再用 aigc_canvas_place 把文件放到画布的任意位置。",
			emptyHint: "可在右侧设置页配置供应商,然后让模型开始生成。",
			prompt: "提示词",
			image: "图片",
			video: "视频",
			audio: "音频",
			meta: "元信息",
			generatedBy: "生成方式",
			edgeCount: "条连线",
			elementCount: "个元素",
			loadError: "加载画布失败",
			disconnected: "已断开,正在重连…",
			reconnecting: "正在重连…",
			refresh: "刷新",
			resetView: "重置视图",
			zoom: "缩放",
			zoomIn: "放大",
			zoomOut: "缩小",
			detailClose: "关闭",
			detailPrompt: "提示词",
			detailParams: "生成参数",
			detailPosition: "位置",
			detailPath: "文件路径",
			delete: "删除",
			deleteElement: "删除元素",
			dropHint: "拖放文件到画布",
			uploading: "上传中…",
			settingsNav: "AIGC 画布",
			settingsTitle: "AIGC 供应商",
			settingsIntro: "配置一个或多个 AIGC 供应商。每个供应商可独立设置名称、API 地址、密钥、鉴权方式和调用说明。模型通过 aigc_get_provider_info 读取供应商列表,用 aigc_http_request 调用 API(自动携带 endpoint 和 apiKey),生成的文件用 aigc_canvas_place 放到画布上。",
			settingsEmpty: "暂无供应商,请在下方添加。",
			settingsAdd: "+ 添加供应商",
			settingsLoading: "加载中…",
			settingsError: "错误",
			"row.id": "ID",
			"row.name": "名称",
			"row.endpoint": "API 地址",
			"row.apiKey": "API Key",
			"row.instructions": "调用说明",
			"row.idPlaceholder": "volcano / jimeng / minimax",
			"row.namePlaceholder": "显示名(如\"火山引擎\")",
			"row.endpointPlaceholder": "stub://aigc-backend",
			"row.apiKeyPlaceholder": "sk-...",
			"row.instructionsPlaceholder": "调用说明由 Agent 初始化供应商时自动撰写(点击卡片上的\"初始化\"按钮)...",
			"row.idHint": "小写字母、数字、连字符;必须以字母开头。作为 provider_id 传给 aigc_http_request",
			"row.endpointDesc": "供应商 API 地址。填 stub://aigc-backend 使用内置 stub(合成测试媒体,不调真实 API)",
			"row.apiKeyDesc": "供应商 API 密钥。stub 后端不需要。模型看不到密钥,由 aigc_http_request 自动附加",
			"row.instructionsDesc": "Agent 通过 aigc_get_provider_info 工具读取此字段,决定如何调用该供应商的 API",
			"row.instructionsHint": "💡 点击卡片上的\"初始化\"按钮,Agent 会用 aigc_http_request 探测 API 并自动撰写调用说明",
			"row.save": "保存",
			"row.delete": "删除",
			"row.deleteConfirm": "确定删除此供应商?",
			"row.expand": "展开",
			"row.collapse": "收起",
			"row.create": "创建",
			"row.cancel": "取消",
			"row.init": "初始化",
			"row.initPrompt": "请帮我初始化 AIGC 供应商「{name}」(id: {id}):先用 aigc_get_provider_info 查看配置,再用 aigc_http_request 探测它的 API(apiKey 会自动附加,无需手动传入),最后调用 aigc_provider_set_instructions 把调用说明保存下来,方便以后直接使用。",
			"row.auth": "鉴权方式",
			"row.authBearer": "Bearer 头",
			"row.authHeader": "自定义 Header",
			"row.authQuery": "URL 参数",
			"row.authDesc": "aigc_http_request 自动附加 apiKey 的方式。默认 Authorization: Bearer <key>;选择自定义 Header 或 URL 参数时需填写名称",
			"badge.builtin": "内置",
			"badge.stub": "stub 模式",
			"badge.real": "真实 API",
			"badge.default": "默认"
		};
		const en = {
			tabTitle: "AIGC Canvas",
			title: "AIGC Canvas",
			empty: "Canvas is empty. The agent calls provider APIs via aigc_http_request and places the generated files anywhere on the canvas with aigc_canvas_place.",
			emptyHint: "Configure a provider in the settings tab on the right, then ask the agent to generate something.",
			prompt: "Prompt",
			image: "Image",
			video: "Video",
			audio: "Audio",
			meta: "Metadata",
			generatedBy: "Generated by",
			edgeCount: "edges",
			elementCount: "elements",
			loadError: "Failed to load canvas",
			disconnected: "Disconnected, reconnecting…",
			reconnecting: "Reconnecting…",
			refresh: "Refresh",
			resetView: "Reset view",
			zoom: "Zoom",
			zoomIn: "Zoom in",
			zoomOut: "Zoom out",
			detailClose: "Close",
			detailPrompt: "Prompt",
			detailParams: "Generation params",
			detailPosition: "Position",
			detailPath: "File path",
			delete: "Delete",
			deleteElement: "Delete element",
			dropHint: "Drop files onto canvas",
			uploading: "Uploading…",
			settingsNav: "AIGC Canvas",
			settingsTitle: "AIGC Providers",
			settingsIntro: "Configure one or more AIGC providers. Each provider has its own name, API endpoint, key, auth scheme, and usage instructions. The agent reads the provider list via aigc_get_provider_info, calls the API via aigc_http_request (endpoint + apiKey attached automatically), and places generated files onto the canvas with aigc_canvas_place.",
			settingsEmpty: "No providers configured. Add one below.",
			settingsAdd: "+ Add provider",
			settingsLoading: "Loading…",
			settingsError: "Error",
			"row.id": "ID",
			"row.name": "Name",
			"row.endpoint": "Endpoint",
			"row.apiKey": "API Key",
			"row.instructions": "Instructions",
			"row.idPlaceholder": "volcano / jimeng / minimax",
			"row.namePlaceholder": "Display name (e.g. \"Volcano Engine\")",
			"row.endpointPlaceholder": "stub://aigc-backend",
			"row.apiKeyPlaceholder": "sk-...",
			"row.instructionsPlaceholder": "The agent writes these when you initialize the provider (click \"Initialize\" on the card)...",
			"row.idHint": "Lowercase letters, digits, hyphens; must start with a letter. Used as the provider_id parameter to aigc_http_request",
			"row.endpointDesc": "Provider API URL. Use stub://aigc-backend for the built-in stub (synthetic test media, no real API calls)",
			"row.apiKeyDesc": "Provider API key. Not needed for the stub backend. The agent never sees it — aigc_http_request attaches it automatically",
			"row.instructionsDesc": "The agent reads this field via the aigc_get_provider_info tool to decide how to call the provider API",
			"row.instructionsHint": "💡 Click \"Initialize\" on the card: the agent probes the API with aigc_http_request and writes the instructions itself",
			"row.save": "Save",
			"row.delete": "Delete",
			"row.deleteConfirm": "Delete this provider?",
			"row.expand": "Expand",
			"row.collapse": "Collapse",
			"row.create": "Create",
			"row.cancel": "Cancel",
			"row.init": "Initialize",
			"row.initPrompt": "Please initialize the AIGC provider \"{name}\" (id: {id}): first call aigc_get_provider_info to see its config, then probe its API with aigc_http_request (the apiKey is attached automatically — do not pass it yourself), and finally call aigc_provider_set_instructions to save the usage instructions so it can be used directly later.",
			"row.auth": "Auth scheme",
			"row.authBearer": "Bearer header",
			"row.authHeader": "Custom header",
			"row.authQuery": "URL query param",
			"row.authDesc": "How aigc_http_request attaches the apiKey. Default: Authorization: Bearer <key>. For custom header or URL query param, fill in the name",
			"badge.builtin": "builtin",
			"badge.stub": "stub mode",
			"badge.real": "real API",
			"badge.default": "default"
		};
		//#endregion
		//#region src/client/dictionaries.ts
		const dicts = {
			ja: {
				tabTitle: "AIGC キャンバス",
				title: "AIGC キャンバス",
				empty: "キャンバスは空です。エージェントが aigc_http_request でプロバイダー API を呼び出して素材を生成し、aigc_canvas_place で生成されたファイルをキャンバスの任意の場所に配置します。",
				emptyHint: "右側の設定タブでプロバイダーを設定してから、エージェントに生成を依頼してください。",
				prompt: "プロンプト",
				image: "画像",
				video: "動画",
				audio: "音声",
				meta: "メタ情報",
				generatedBy: "生成方法",
				edgeCount: "本のエッジ",
				elementCount: "個の要素",
				loadError: "キャンバスの読み込みに失敗しました",
				disconnected: "切断されました。再接続中…",
				reconnecting: "再接続中…",
				refresh: "更新",
				resetView: "ビューをリセット",
				zoom: "ズーム",
				zoomIn: "拡大",
				zoomOut: "縮小",
				detailClose: "閉じる",
				detailPrompt: "プロンプト",
				detailParams: "生成パラメータ",
				detailPosition: "位置",
				detailPath: "ファイルパス",
				delete: "削除",
				deleteElement: "要素を削除",
				dropHint: "ファイルをキャンバスにドロップ",
				uploading: "アップロード中…",
				settingsNav: "AIGC キャンバス",
				settingsTitle: "AIGC プロバイダー",
				settingsIntro: "1 つ以上の AIGC プロバイダーを設定します。各プロバイダーに名前、API アドレス、キー、認証方式、呼び出し手順を個別に設定できます。エージェントは aigc_get_provider_info でプロバイダー一覧を読み取り、aigc_http_request で API を呼び出し（endpoint と apiKey は自動的に付与されます）、生成されたファイルは aigc_canvas_place でキャンバスに配置します。",
				settingsEmpty: "プロバイダーが設定されていません。下から追加してください。",
				settingsAdd: "+ プロバイダーを追加",
				settingsLoading: "読み込み中…",
				settingsError: "エラー",
				"row.id": "ID",
				"row.name": "名前",
				"row.endpoint": "API アドレス",
				"row.apiKey": "API キー",
				"row.instructions": "呼び出し手順",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "表示名（例：「火山引擎」）",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "呼び出し手順はプロバイダー初期化時にエージェントが自動作成します（カードの「初期化」ボタンをクリック）...",
				"row.idHint": "小文字の英字、数字、ハイフン。英字で始まる必要があります。aigc_http_request の provider_id パラメータとして使用されます",
				"row.endpointDesc": "プロバイダーの API アドレス。stub://aigc-backend は組み込みの stub（合成テストメディアを生成し、実際の API を呼び出しません）を使用します",
				"row.apiKeyDesc": "プロバイダーの API キー。stub バックエンドでは不要です。エージェントはキーを見ることができず、aigc_http_request が自動的に付与します",
				"row.instructionsDesc": "エージェントは aigc_get_provider_info ツールでこのフィールドを読み取り、そのプロバイダー API の呼び出し方を決定します",
				"row.instructionsHint": "💡 カードの「初期化」ボタンをクリック:エージェントが aigc_http_request で API を調査し、呼び出し手順を自動的に作成します",
				"row.save": "保存",
				"row.delete": "削除",
				"row.deleteConfirm": "このプロバイダーを削除しますか？",
				"row.expand": "展開",
				"row.collapse": "折りたたむ",
				"row.create": "作成",
				"row.cancel": "キャンセル",
				"row.init": "初期化",
				"row.initPrompt": "AIGC プロバイダー「{name}」(id: {id}) を初期化してください:まず aigc_get_provider_info で設定を確認し、次に aigc_http_request で API を調査してください（apiKey は自動付与されるため手動で渡さないでください）。最後に aigc_provider_set_instructions で呼び出し手順を保存しておくと、以後そのまま利用できます。",
				"row.auth": "認証方式",
				"row.authBearer": "Bearer ヘッダー",
				"row.authHeader": "カスタムヘッダー",
				"row.authQuery": "URL パラメータ",
				"row.authDesc": "aigc_http_request が apiKey を付与する方式。既定は Authorization: Bearer <key>。カスタムヘッダーまたは URL パラメータを選ぶ場合は名前を入力してください",
				"badge.builtin": "組み込み",
				"badge.stub": "stub モード",
				"badge.real": "実 API",
				"badge.default": "既定"
			},
			de: {
				tabTitle: "AIGC-Leinwand",
				title: "AIGC-Leinwand",
				empty: "Die Leinwand ist leer. Der Agent ruft die API des Anbieters über aigc_http_request auf, um Assets zu generieren, und legt die erzeugten Dateien mit aigc_canvas_place an beliebiger Stelle auf der Leinwand ab.",
				emptyHint: "Konfiguriere einen Anbieter im Einstellungs-Tab rechts und bitte den Agenten dann, etwas zu generieren.",
				prompt: "Prompt",
				image: "Bild",
				video: "Video",
				audio: "Audio",
				meta: "Metadaten",
				generatedBy: "Generierungsmethode",
				edgeCount: "Kanten",
				elementCount: "Elemente",
				loadError: "Leinwand konnte nicht geladen werden",
				disconnected: "Getrennt, Verbindung wird wiederhergestellt…",
				reconnecting: "Verbindung wird wiederhergestellt…",
				refresh: "Aktualisieren",
				resetView: "Ansicht zurücksetzen",
				zoom: "Zoom",
				zoomIn: "Vergrößern",
				zoomOut: "Verkleinern",
				detailClose: "Schließen",
				detailPrompt: "Prompt",
				detailParams: "Generierungsparameter",
				detailPosition: "Position",
				detailPath: "Dateipfad",
				delete: "Löschen",
				deleteElement: "Element löschen",
				dropHint: "Dateien auf die Leinwand ziehen",
				uploading: "Hochladen…",
				settingsNav: "AIGC-Leinwand",
				settingsTitle: "AIGC-Anbieter",
				settingsIntro: "Konfiguriere einen oder mehrere AIGC-Anbieter. Jeder Anbieter hat eigene Einstellungen für Name, API-Adresse, Schlüssel, Authentifizierung und Aufrufanweisungen. Der Agent liest die Anbieterliste über aigc_get_provider_info, ruft die API über aigc_http_request auf (endpoint + apiKey werden automatisch angehängt) und legt die generierten Dateien mit aigc_canvas_place auf der Leinwand ab.",
				settingsEmpty: "Keine Anbieter konfiguriert. Füge unten einen hinzu.",
				settingsAdd: "+ Anbieter hinzufügen",
				settingsLoading: "Wird geladen…",
				settingsError: "Fehler",
				"row.id": "ID",
				"row.name": "Name",
				"row.endpoint": "API-Adresse",
				"row.apiKey": "API-Schlüssel",
				"row.instructions": "Aufrufanweisungen",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Anzeigename (z. B. „火山引擎“)",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "Die Anweisungen schreibt der Agent, wenn du den Anbieter initialisierst (klicke „Initialisieren“ auf der Karte)...",
				"row.idHint": "Kleinbuchstaben, Ziffern, Bindestriche; muss mit einem Buchstaben beginnen. Wird als provider_id-Parameter an aigc_http_request übergeben",
				"row.endpointDesc": "API-Adresse des Anbieters. Verwende stub://aigc-backend für den eingebauten Stub (synthetische Testmedien, keine echten API-Aufrufe)",
				"row.apiKeyDesc": "API-Schlüssel des Anbieters. Für den Stub-Backend nicht nötig. Der Agent sieht den Schlüssel nie — aigc_http_request hängt ihn automatisch an",
				"row.instructionsDesc": "Der Agent liest dieses Feld über das aigc_get_provider_info-Tool, um zu entscheiden, wie die API des Anbieters aufzurufen ist",
				"row.instructionsHint": "💡 Klicke „Initialisieren“ auf der Karte: Der Agent testet die API mit aigc_http_request und schreibt die Anweisungen selbst",
				"row.save": "Speichern",
				"row.delete": "Löschen",
				"row.deleteConfirm": "Diesen Anbieter löschen?",
				"row.expand": "Erweitern",
				"row.collapse": "Einklappen",
				"row.create": "Erstellen",
				"row.cancel": "Abbrechen",
				"row.init": "Initialisieren",
				"row.initPrompt": "Bitte initialisiere den AIGC-Anbieter „{name}“ (id: {id}): Rufe zuerst aigc_get_provider_info auf, um die Konfiguration zu sehen, teste dann die API mit aigc_http_request (der apiKey wird automatisch angehängt — übergib ihn nicht selbst) und rufe schließlich aigc_provider_set_instructions auf, um die Anweisungen zu speichern.",
				"row.auth": "Authentifizierungsschema",
				"row.authBearer": "Bearer-Header",
				"row.authHeader": "Benutzerdefinierter Header",
				"row.authQuery": "URL-Abfrageparameter",
				"row.authDesc": "Wie aigc_http_request den apiKey anhängt. Standard: Authorization: Bearer <key>. Bei benutzerdefiniertem Header oder URL-Parameter den Namen ausfüllen",
				"badge.builtin": "integriert",
				"badge.stub": "Stub-Modus",
				"badge.real": "echte API",
				"badge.default": "Standard"
			},
			fr: {
				tabTitle: "Toile AIGC",
				title: "Toile AIGC",
				empty: "La toile est vide. L’agent appelle les API du fournisseur via aigc_http_request pour générer les ressources, puis place les fichiers générés n’importe où sur la toile avec aigc_canvas_place.",
				emptyHint: "Configurez un fournisseur dans l’onglet des paramètres à droite, puis demandez à l’agent de générer quelque chose.",
				prompt: "Invite",
				image: "Image",
				video: "Vidéo",
				audio: "Audio",
				meta: "Métadonnées",
				generatedBy: "Méthode de génération",
				edgeCount: "arêtes",
				elementCount: "éléments",
				loadError: "Échec du chargement de la toile",
				disconnected: "Déconnecté, reconnexion…",
				reconnecting: "Reconnexion en cours…",
				refresh: "Actualiser",
				resetView: "Réinitialiser la vue",
				zoom: "Zoom",
				zoomIn: "Agrandir",
				zoomOut: "Réduire",
				detailClose: "Fermer",
				detailPrompt: "Invite",
				detailParams: "Paramètres de génération",
				detailPosition: "Position",
				detailPath: "Chemin du fichier",
				delete: "Supprimer",
				deleteElement: "Supprimer l’élément",
				dropHint: "Déposez des fichiers sur la toile",
				uploading: "Téléversement…",
				settingsNav: "Toile AIGC",
				settingsTitle: "Fournisseurs AIGC",
				settingsIntro: "Configurez un ou plusieurs fournisseurs AIGC. Chaque fournisseur a son propre nom, endpoint API, clé, schéma d’authentification et instructions d’appel. L’agent lit la liste des fournisseurs via aigc_get_provider_info, appelle l’API via aigc_http_request (endpoint et apiKey attachés automatiquement) et place les fichiers générés sur la toile avec aigc_canvas_place.",
				settingsEmpty: "Aucun fournisseur configuré. Ajoutez-en un ci-dessous.",
				settingsAdd: "+ Ajouter un fournisseur",
				settingsLoading: "Chargement…",
				settingsError: "Erreur",
				"row.id": "ID",
				"row.name": "Nom",
				"row.endpoint": "Endpoint",
				"row.apiKey": "Clé API",
				"row.instructions": "Instructions",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Nom affiché (ex. «火山引擎»)",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "L’agent les écrit lors de l’initialisation du fournisseur (cliquez sur « Initialiser » sur la carte)...",
				"row.idHint": "Lettres minuscules, chiffres, tirets ; doit commencer par une lettre. Utilisé comme paramètre provider_id d’aigc_http_request",
				"row.endpointDesc": "Adresse API du fournisseur. Utilisez stub://aigc-backend pour le stub intégré (contenus de test synthétiques, aucun appel API réel)",
				"row.apiKeyDesc": "Clé API du fournisseur. Inutile pour le backend stub. L’agent ne la voit jamais — aigc_http_request l’attache automatiquement",
				"row.instructionsDesc": "L’agent lit ce champ via l’outil aigc_get_provider_info pour décider comment appeler l’API du fournisseur",
				"row.instructionsHint": "💡 Cliquez sur « Initialiser » sur la carte : l’agent sonde l’API avec aigc_http_request et écrit lui-même les instructions",
				"row.save": "Enregistrer",
				"row.delete": "Supprimer",
				"row.deleteConfirm": "Supprimer ce fournisseur ?",
				"row.expand": "Développer",
				"row.collapse": "Réduire",
				"row.create": "Créer",
				"row.cancel": "Annuler",
				"row.init": "Initialiser",
				"row.initPrompt": "Veuillez initialiser le fournisseur AIGC « {name} » (id : {id}) : appelez d’abord aigc_get_provider_info pour voir sa configuration, puis sondez son API avec aigc_http_request (le apiKey est attaché automatiquement — ne le passez pas vous-même), et enfin appelez aigc_provider_set_instructions pour enregistrer les instructions d’appel.",
				"row.auth": "Schéma d’authentification",
				"row.authBearer": "En-tête Bearer",
				"row.authHeader": "En-tête personnalisé",
				"row.authQuery": "Paramètre de requête URL",
				"row.authDesc": "Comment aigc_http_request attache le apiKey. Défaut : Authorization: Bearer <key>. Pour un en-tête personnalisé ou un paramètre d’URL, remplissez le nom",
				"badge.builtin": "intégré",
				"badge.stub": "mode stub",
				"badge.real": "API réelle",
				"badge.default": "défaut"
			},
			pt: {
				tabTitle: "Tela AIGC",
				title: "Tela AIGC",
				empty: "A tela está vazia. O agente chama as APIs do provedor via aigc_http_request para gerar os recursos e coloca os arquivos gerados em qualquer posição da tela com aigc_canvas_place.",
				emptyHint: "Configure um provedor na aba de configurações à direita e peça ao agente para gerar algo.",
				prompt: "Prompt",
				image: "Imagem",
				video: "Vídeo",
				audio: "Áudio",
				meta: "Metadados",
				generatedBy: "Método de geração",
				edgeCount: "arestas",
				elementCount: "elementos",
				loadError: "Falha ao carregar a tela",
				disconnected: "Desconectado, reconectando…",
				reconnecting: "Reconectando…",
				refresh: "Atualizar",
				resetView: "Redefinir visualização",
				zoom: "Zoom",
				zoomIn: "Ampliar",
				zoomOut: "Reduzir",
				detailClose: "Fechar",
				detailPrompt: "Prompt",
				detailParams: "Parâmetros de geração",
				detailPosition: "Posição",
				detailPath: "Caminho do arquivo",
				delete: "Excluir",
				deleteElement: "Excluir elemento",
				dropHint: "Solte arquivos na tela",
				uploading: "Enviando…",
				settingsNav: "Tela AIGC",
				settingsTitle: "Provedores AIGC",
				settingsIntro: "Configure um ou mais provedores AIGC. Cada provedor tem configurações independentes de nome, endereço da API, chave, método de autenticação e instruções de chamada. O agente lê a lista de provedores via aigc_get_provider_info, chama a API via aigc_http_request (endpoint e apiKey anexados automaticamente) e coloca os arquivos gerados na tela com aigc_canvas_place.",
				settingsEmpty: "Nenhum provedor configurado. Adicione um abaixo.",
				settingsAdd: "+ Adicionar provedor",
				settingsLoading: "Carregando…",
				settingsError: "Erro",
				"row.id": "ID",
				"row.name": "Nome",
				"row.endpoint": "Endereço da API",
				"row.apiKey": "Chave da API",
				"row.instructions": "Instruções de chamada",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Nome de exibição (ex.: 火山引擎)",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "O agente escreve as instruções ao inicializar o provedor (clique em \"Inicializar\" no cartão)...",
				"row.idHint": "Letras minúsculas, dígitos, hífens; deve começar com uma letra. Usado como parâmetro provider_id de aigc_http_request",
				"row.endpointDesc": "Endereço da API do provedor. Use stub://aigc-backend para o stub integrado (mídia de teste sintética, sem chamadas reais de API)",
				"row.apiKeyDesc": "Chave da API do provedor. Não é necessária para o backend stub. O agente nunca a vê — aigc_http_request a anexa automaticamente",
				"row.instructionsDesc": "O agente lê este campo via a ferramenta aigc_get_provider_info para decidir como chamar a API do provedor",
				"row.instructionsHint": "💡 Clique em \"Inicializar\" no cartão: o agente testa a API com aigc_http_request e escreve as instruções ele mesmo",
				"row.save": "Salvar",
				"row.delete": "Excluir",
				"row.deleteConfirm": "Excluir este provedor?",
				"row.expand": "Expandir",
				"row.collapse": "Recolher",
				"row.create": "Criar",
				"row.cancel": "Cancelar",
				"row.init": "Inicializar",
				"row.initPrompt": "Inicialize o provedor AIGC \"{name}\" (id: {id}): primeiro chame aigc_get_provider_info para ver a configuração dele, depois teste a API com aigc_http_request (o apiKey é anexado automaticamente — não o passe você mesmo) e finalmente chame aigc_provider_set_instructions para salvar as instruções de chamada.",
				"row.auth": "Método de autenticação",
				"row.authBearer": "Cabeçalho Bearer",
				"row.authHeader": "Cabeçalho personalizado",
				"row.authQuery": "Parâmetro de consulta de URL",
				"row.authDesc": "Como aigc_http_request anexa o apiKey. Padrão: Authorization: Bearer <key>. Para cabeçalho personalizado ou parâmetro de URL, preencha o nome",
				"badge.builtin": "integrado",
				"badge.stub": "modo stub",
				"badge.real": "API real",
				"badge.default": "padrão"
			},
			ko: {
				tabTitle: "AIGC 캔버스",
				title: "AIGC 캔버스",
				empty: "캔버스가 비어 있습니다. 에이전트가 aigc_http_request로 공급자 API를 호출해 자산을 생성한 후, aigc_canvas_place로 생성된 파일을 캔버스의 원하는 위치에 배치합니다.",
				emptyHint: "오른쪽 설정 탭에서 공급자를 구성한 다음 에이전트에게 생성을 요청하세요.",
				prompt: "프롬프트",
				image: "이미지",
				video: "동영상",
				audio: "오디오",
				meta: "메타데이터",
				generatedBy: "생성 방식",
				edgeCount: "개 연결",
				elementCount: "개 요소",
				loadError: "캔버스를 불러오지 못했습니다",
				disconnected: "연결이 끊겼습니다. 다시 연결하는 중…",
				reconnecting: "다시 연결하는 중…",
				refresh: "새로고침",
				resetView: "보기 초기화",
				zoom: "확대/축소",
				zoomIn: "확대",
				zoomOut: "축소",
				detailClose: "닫기",
				detailPrompt: "프롬프트",
				detailParams: "생성 매개변수",
				detailPosition: "위치",
				detailPath: "파일 경로",
				delete: "삭제",
				deleteElement: "요소 삭제",
				dropHint: "캔버스에 파일을 끌어다 놓기",
				uploading: "업로드 중…",
				settingsNav: "AIGC 캔버스",
				settingsTitle: "AIGC 공급자",
				settingsIntro: "하나 이상의 AIGC 공급자를 구성합니다. 각 공급자에 이름, API 주소, 키, 인증 방식, 호출 지침을 개별적으로 설정할 수 있습니다. 에이전트는 aigc_get_provider_info로 공급자 목록을 읽고, aigc_http_request로 API를 호출하며(endpoint와 apiKey 자동 첨부), 생성된 파일은 aigc_canvas_place로 캔버스에 배치합니다.",
				settingsEmpty: "구성된 공급자가 없습니다. 아래에서 추가하세요.",
				settingsAdd: "+ 공급자 추가",
				settingsLoading: "불러오는 중…",
				settingsError: "오류",
				"row.id": "ID",
				"row.name": "이름",
				"row.endpoint": "API 주소",
				"row.apiKey": "API 키",
				"row.instructions": "호출 지침",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "표시 이름(예: \"Volcano Engine\")",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "공급자 초기화 시 에이전트가 자동으로 작성합니다(카드의 \"초기화\" 버튼 클릭)...",
				"row.idHint": "소문자, 숫자, 하이픈; 반드시 문자로 시작해야 합니다. aigc_http_request의 provider_id 매개변수로 사용됩니다",
				"row.endpointDesc": "공급자 API 주소. stub://aigc-backend는 내장 stub(합성 테스트 미디어, 실제 API 호출 없음)을 사용합니다",
				"row.apiKeyDesc": "공급자 API 키. stub 백엔드에는 필요하지 않습니다. 에이전트는 키를 볼 수 없으며 aigc_http_request가 자동으로 첨부합니다",
				"row.instructionsDesc": "에이전트는 aigc_get_provider_info 도구로 이 필드를 읽어 공급자 API를 호출하는 방법을 결정합니다",
				"row.instructionsHint": "💡 카드의 \"초기화\" 버튼을 클릭하면 에이전트가 aigc_http_request로 API를 탐색하고 지침을 직접 작성합니다",
				"row.save": "저장",
				"row.delete": "삭제",
				"row.deleteConfirm": "이 공급자를 삭제할까요?",
				"row.expand": "펼치기",
				"row.collapse": "접기",
				"row.create": "만들기",
				"row.cancel": "취소",
				"row.init": "초기화",
				"row.initPrompt": "AIGC 공급자 \"{name}\"(id: {id})를 초기화해 주세요: 먼저 aigc_get_provider_info로 설정을 확인하고, aigc_http_request로 API를 탐색하세요(apiKey는 자동 첨부되므로 직접 전달하지 마세요). 마지막으로 aigc_provider_set_instructions로 호출 지침을 저장해 두면 나중에 바로 사용할 수 있습니다.",
				"row.auth": "인증 방식",
				"row.authBearer": "Bearer 헤더",
				"row.authHeader": "사용자 지정 헤더",
				"row.authQuery": "URL 매개변수",
				"row.authDesc": "aigc_http_request가 apiKey를 첨부하는 방식. 기본값: Authorization: Bearer <key>. 사용자 지정 헤더 또는 URL 매개변수를 선택한 경우 이름을 입력하세요",
				"badge.builtin": "내장",
				"badge.stub": "stub 모드",
				"badge.real": "실제 API",
				"badge.default": "기본값"
			},
			ar: {
				tabTitle: "لوحة AIGC",
				title: "لوحة AIGC",
				empty: "اللوحة فارغة. يستدعي الوكيل واجهات برمجة تطبيقات المزوّد عبر aigc_http_request لتوليد الموارد، ثم يضع الملفات المولَّدة في أي موضع على اللوحة باستخدام aigc_canvas_place.",
				emptyHint: "قم بتكوين مزوّد في تبويب الإعدادات على اليمين، ثم اطلب من الوكيل توليد شيء.",
				prompt: "الموجّه",
				image: "صورة",
				video: "فيديو",
				audio: "صوت",
				meta: "بيانات وصفية",
				generatedBy: "طريقة التوليد",
				edgeCount: "حافة",
				elementCount: "عنصر",
				loadError: "فشل تحميل اللوحة",
				disconnected: "انقطع الاتصال، جارٍ إعادة الاتصال…",
				reconnecting: "جارٍ إعادة الاتصال…",
				refresh: "تحديث",
				resetView: "إعادة تعيين العرض",
				zoom: "تكبير/تصغير",
				zoomIn: "تكبير",
				zoomOut: "تصغير",
				detailClose: "إغلاق",
				detailPrompt: "الموجّه",
				detailParams: "معلمات التوليد",
				detailPosition: "الموضع",
				detailPath: "مسار الملف",
				delete: "حذف",
				deleteElement: "حذف العنصر",
				dropHint: "اسحب الملفات إلى اللوحة",
				uploading: "جارٍ الرفع…",
				settingsNav: "لوحة AIGC",
				settingsTitle: "مزوّدو AIGC",
				settingsIntro: "قم بتكوين مزوّد واحد أو أكثر من مزوّدي AIGC. يمكن ضبط اسم وعنوان API ومفتاح وطريقة مصادقة وتعليمات الاستدعاء لكل مزوّد بشكل مستقل. يقرأ الوكيل قائمة المزوّدين عبر aigc_get_provider_info، ويستدعي واجهة API عبر aigc_http_request (مع إرفاق endpoint وapiKey تلقائيًا)، ويضع الملفات المولَّدة على اللوحة باستخدام aigc_canvas_place.",
				settingsEmpty: "لا توجد مزوّدات مكوّنة. أضف واحدًا أدناه.",
				settingsAdd: "+ إضافة مزوّد",
				settingsLoading: "جارٍ التحميل…",
				settingsError: "خطأ",
				"row.id": "المعرّف",
				"row.name": "الاسم",
				"row.endpoint": "عنوان API",
				"row.apiKey": "مفتاح API",
				"row.instructions": "تعليمات الاستدعاء",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "الاسم المعروض (مثل «火山引擎»)",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "يكتب الوكيل هذه التعليمات تلقائيًا عند تهيئة المزوّد (انقر زر «تهيئة» على البطاقة)...",
				"row.idHint": "أحرف صغيرة وأرقام وواصلات؛ يجب أن يبدأ بحرف. يُستخدم كمعامل provider_id في aigc_http_request",
				"row.endpointDesc": "عنوان API الخاص بالمزوّد. استخدم stub://aigc-backend للـ stub المدمج (محتوى اختبار اصطناعي دون استدعاءات API حقيقية)",
				"row.apiKeyDesc": "مفتاح API الخاص بالمزوّد. غير مطلوب للخلفية stub. لا يرى الوكيل المفتاح أبدًا — يرفقه aigc_http_request تلقائيًا",
				"row.instructionsDesc": "يقرأ الوكيل هذا الحقل عبر أداة aigc_get_provider_info ليقرر كيفية استدعاء واجهة API الخاصة بالمزوّد",
				"row.instructionsHint": "💡 انقر «تهيئة» على البطاقة: يستقصي الوكيل واجهة API باستخدام aigc_http_request ويكتب التعليمات بنفسه",
				"row.save": "حفظ",
				"row.delete": "حذف",
				"row.deleteConfirm": "هل تريد حذف هذا المزوّد؟",
				"row.expand": "توسيع",
				"row.collapse": "طيّ",
				"row.create": "إنشاء",
				"row.cancel": "إلغاء",
				"row.init": "تهيئة",
				"row.initPrompt": "يرجى تهيئة مزوّد AIGC «{name}» (المعرّف: {id}): استدعِ أولاً aigc_get_provider_info لرؤية إعداده، ثم استقصِ واجهة API الخاصة به عبر aigc_http_request (يُرفق apiKey تلقائيًا — لا تمرّره بنفسك)، وأخيرًا استدعِ aigc_provider_set_instructions لحفظ تعليمات الاستدعاء.",
				"row.auth": "طريقة المصادقة",
				"row.authBearer": "ترويسة Bearer",
				"row.authHeader": "ترويسة مخصصة",
				"row.authQuery": "معامل URL",
				"row.authDesc": "كيفية إرفاق aigc_http_request للمفتاح apiKey. الافتراضي: Authorization: Bearer <key>. عند اختيار ترويسة مخصصة أو معامل URL، املأ الاسم",
				"badge.builtin": "مدمج",
				"badge.stub": "وضع stub",
				"badge.real": "API حقيقي",
				"badge.default": "افتراضي"
			},
			hi: {
				tabTitle: "AIGC कैनवास",
				title: "AIGC कैनवास",
				empty: "कैनवास खाली है। एजेंट aigc_http_request के माध्यम से प्रदाता API को कॉल करके एसेट जनरेट करता है, फिर aigc_canvas_place से जनरेट की गई फ़ाइलों को कैनवास पर किसी भी स्थान पर रखता है।",
				emptyHint: "दाईं ओर सेटिंग्स टैब में प्रदाता कॉन्फ़िगर करें, फिर एजेंट से कुछ जनरेट करने के लिए कहें।",
				prompt: "प्रॉम्प्ट",
				image: "छवि",
				video: "वीडियो",
				audio: "ऑडियो",
				meta: "मेटाडेटा",
				generatedBy: "जनरेशन विधि",
				edgeCount: "कनेक्शन",
				elementCount: "तत्व",
				loadError: "कैनवास लोड करने में विफल",
				disconnected: "डिस्कनेक्ट हुआ, पुनः कनेक्ट किया जा रहा…",
				reconnecting: "पुनः कनेक्ट किया जा रहा…",
				refresh: "रीफ़्रेश",
				resetView: "दृश्य रीसेट करें",
				zoom: "ज़ूम",
				zoomIn: "ज़ूम इन",
				zoomOut: "ज़ूम आउट",
				detailClose: "बंद करें",
				detailPrompt: "प्रॉम्प्ट",
				detailParams: "जनरेशन पैरामीटर",
				detailPosition: "स्थिति",
				detailPath: "फ़ाइल पथ",
				delete: "हटाएं",
				deleteElement: "तत्व हटाएं",
				dropHint: "फ़ाइलों को कैनवास पर छोड़ें",
				uploading: "अपलोड किया जा रहा…",
				settingsNav: "AIGC कैनवास",
				settingsTitle: "AIGC प्रदाता",
				settingsIntro: "एक या अधिक AIGC प्रदाता कॉन्फ़िगर करें। प्रत्येक प्रदाता के लिए नाम, API पता, कुंजी, प्रमाणीकरण विधि और कॉल निर्देश अलग से सेट किए जा सकते हैं। एजेंट aigc_get_provider_info से प्रदाता सूची पढ़ता है, aigc_http_request से API कॉल करता है (endpoint और apiKey स्वतः जुड़ जाते हैं), और जनरेट की गई फ़ाइलें aigc_canvas_place से कैनवास पर रखता है।",
				settingsEmpty: "कोई प्रदाता कॉन्फ़िगर नहीं है। नीचे जोड़ें।",
				settingsAdd: "+ प्रदाता जोड़ें",
				settingsLoading: "लोड हो रहा…",
				settingsError: "त्रुटि",
				"row.id": "आईडी",
				"row.name": "नाम",
				"row.endpoint": "API पता",
				"row.apiKey": "API कुंजी",
				"row.instructions": "कॉल निर्देश",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "प्रदर्शन नाम (जैसे \"Volcano Engine\")",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "प्रदाता आरंभ होने पर एजेंट इन्हें स्वतः लिखता है (कार्ड पर \"आरंभ करें\" क्लिक करें)...",
				"row.idHint": "छोटे अक्षर, अंक, हाइफ़न; अक्षर से शुरू होना चाहिए। aigc_http_request के provider_id पैरामीटर के रूप में उपयोग होता है",
				"row.endpointDesc": "प्रदाता API पता। stub://aigc-backend का उपयोग अंतर्निहित stub (सिंथेटिक टेस्ट मीडिया, बिना वास्तविक API कॉल) के लिए करें",
				"row.apiKeyDesc": "प्रदाता API कुंजी। stub बैकएंड के लिए आवश्यक नहीं। एजेंट कुंजी कभी नहीं देखता — aigc_http_request इसे स्वतः जोड़ देता है",
				"row.instructionsDesc": "एजेंट aigc_get_provider_info टूल के माध्यम से इस फ़ील्ड को पढ़ता है ताकि प्रदाता API को कैसे कॉल करना है यह तय कर सके",
				"row.instructionsHint": "💡 कार्ड पर \"आरंभ करें\" क्लिक करें: एजेंट aigc_http_request से API की जांच करता है और निर्देश स्वयं लिखता है",
				"row.save": "सहेजें",
				"row.delete": "हटाएं",
				"row.deleteConfirm": "क्या यह प्रदाता हटाया जाए?",
				"row.expand": "विस्तार करें",
				"row.collapse": "संक्षिप्त करें",
				"row.create": "बनाएं",
				"row.cancel": "रद्द करें",
				"row.init": "आरंभ करें",
				"row.initPrompt": "कृपया AIGC प्रदाता \"{name}\" (id: {id}) आरंभ करें: पहले aigc_get_provider_info से इसका कॉन्फ़िग देखें, फिर aigc_http_request से इसकी API की जांच करें (apiKey स्वतः जुड़ता है — इसे स्वयं न दें), और अंत में aigc_provider_set_instructions से कॉल निर्देश सहेज लें।",
				"row.auth": "प्रमाणीकरण विधि",
				"row.authBearer": "Bearer हेडर",
				"row.authHeader": "कस्टम हेडर",
				"row.authQuery": "URL पैरामीटर",
				"row.authDesc": "aigc_http_request apiKey को कैसे जोड़ता है। डिफ़ॉल्ट: Authorization: Bearer <key>। कस्टम हेडर या URL पैरामीटर चुनने पर नाम भरें",
				"badge.builtin": "अंतर्निहित",
				"badge.stub": "stub मोड",
				"badge.real": "वास्तविक API",
				"badge.default": "डिफ़ॉल्ट"
			},
			id: {
				tabTitle: "Kanvas AIGC",
				title: "Kanvas AIGC",
				empty: "Kanvas kosong. Agen memanggil API penyedia melalui aigc_http_request untuk menghasilkan aset, lalu menempatkan file yang dihasilkan ke posisi mana pun di kanvas dengan aigc_canvas_place.",
				emptyHint: "Konfigurasikan penyedia di tab pengaturan di kanan, lalu minta agen untuk menghasilkan sesuatu.",
				prompt: "Prompt",
				image: "Gambar",
				video: "Video",
				audio: "Audio",
				meta: "Metadata",
				generatedBy: "Metode pembuatan",
				edgeCount: "tepi",
				elementCount: "elemen",
				loadError: "Gagal memuat kanvas",
				disconnected: "Terputus, menyambung ulang…",
				reconnecting: "Menyambung ulang…",
				refresh: "Segarkan",
				resetView: "Atur ulang tampilan",
				zoom: "Zoom",
				zoomIn: "Perbesar",
				zoomOut: "Perkecil",
				detailClose: "Tutup",
				detailPrompt: "Prompt",
				detailParams: "Parameter pembuatan",
				detailPosition: "Posisi",
				detailPath: "Lintasan file",
				delete: "Hapus",
				deleteElement: "Hapus elemen",
				dropHint: "Letakkan file di kanvas",
				uploading: "Mengunggah…",
				settingsNav: "Kanvas AIGC",
				settingsTitle: "Penyedia AIGC",
				settingsIntro: "Konfigurasikan satu atau lebih penyedia AIGC. Setiap penyedia dapat mengatur nama, alamat API, kunci, metode autentikasi, dan instruksi pemanggilan secara terpisah. Agen membaca daftar penyedia melalui aigc_get_provider_info, memanggil API melalui aigc_http_request (endpoint dan apiKey dilampirkan otomatis), dan file yang dihasilkan diletakkan di kanvas dengan aigc_canvas_place.",
				settingsEmpty: "Belum ada penyedia yang dikonfigurasi. Tambahkan di bawah.",
				settingsAdd: "+ Tambah penyedia",
				settingsLoading: "Memuat…",
				settingsError: "Kesalahan",
				"row.id": "ID",
				"row.name": "Nama",
				"row.endpoint": "Alamat API",
				"row.apiKey": "Kunci API",
				"row.instructions": "Instruksi pemanggilan",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Nama tampilan (mis. \"Volcano Engine\")",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "Instruksi pemanggilan ditulis otomatis oleh agen saat Anda menginisialisasi penyedia (klik tombol \"Inisialisasi\" di kartu)...",
				"row.idHint": "Huruf kecil, angka, tanda hubung; harus diawali huruf. Digunakan sebagai parameter provider_id untuk aigc_http_request",
				"row.endpointDesc": "Alamat API penyedia. Gunakan stub://aigc-backend untuk stub bawaan (media uji sintetis, tanpa panggilan API sungguhan)",
				"row.apiKeyDesc": "Kunci API penyedia. Tidak diperlukan untuk backend stub. Agen tidak pernah melihat kuncinya — aigc_http_request melampirkannya otomatis",
				"row.instructionsDesc": "Agen membaca kolom ini melalui alat aigc_get_provider_info untuk memutuskan cara memanggil API penyedia",
				"row.instructionsHint": "💡 Klik \"Inisialisasi\" di kartu: agen menguji API dengan aigc_http_request dan menulis instruksinya sendiri",
				"row.save": "Simpan",
				"row.delete": "Hapus",
				"row.deleteConfirm": "Hapus penyedia ini?",
				"row.expand": "Perluas",
				"row.collapse": "Ciutkan",
				"row.create": "Buat",
				"row.cancel": "Batal",
				"row.init": "Inisialisasi",
				"row.initPrompt": "Silakan inisialisasi penyedia AIGC \"{name}\" (id: {id}): pertama panggil aigc_get_provider_info untuk melihat konfigurasinya, lalu uji API-nya dengan aigc_http_request (apiKey dilampirkan otomatis — jangan dioper sendiri), dan terakhir panggil aigc_provider_set_instructions untuk menyimpan instruksi pemanggilan.",
				"row.auth": "Metode autentikasi",
				"row.authBearer": "Header Bearer",
				"row.authHeader": "Header kustom",
				"row.authQuery": "Parameter URL",
				"row.authDesc": "Cara aigc_http_request melampirkan apiKey. Default: Authorization: Bearer <key>. Bila memilih header kustom atau parameter URL, isi namanya",
				"badge.builtin": "bawaan",
				"badge.stub": "mode stub",
				"badge.real": "API sungguhan",
				"badge.default": "default"
			},
			tr: {
				tabTitle: "AIGC Tuvali",
				title: "AIGC Tuvali",
				empty: "Tuval boş. Aracı, aigc_http_request ile sağlayıcı API’lerini çağırıp varlık üretir; ardından aigc_canvas_place ile dosyaları tuvale istediğiniz konuma yerleştirir.",
				emptyHint: "Sağdaki ayarlar sekmesinde bir sağlayıcı yapılandırın, sonra aracıdan bir şey üretmesini isteyin.",
				prompt: "İstek",
				image: "Görsel",
				video: "Video",
				audio: "Ses",
				meta: "Üst veri",
				generatedBy: "Üretim yöntemi",
				edgeCount: "bağlantı",
				elementCount: "öğe",
				loadError: "Tuval yüklenemedi",
				disconnected: "Bağlantı kesildi, yeniden bağlanılıyor…",
				reconnecting: "Yeniden bağlanılıyor…",
				refresh: "Yenile",
				resetView: "Görünümü sıfırla",
				zoom: "Yakınlaştırma",
				zoomIn: "Yakınlaştır",
				zoomOut: "Uzaklaştır",
				detailClose: "Kapat",
				detailPrompt: "İstek",
				detailParams: "Üretim parametreleri",
				detailPosition: "Konum",
				detailPath: "Dosya yolu",
				delete: "Sil",
				deleteElement: "Öğeyi sil",
				dropHint: "Dosyaları tuvale bırakın",
				uploading: "Yükleniyor…",
				settingsNav: "AIGC Tuvali",
				settingsTitle: "AIGC Sağlayıcıları",
				settingsIntro: "Bir veya daha fazla AIGC sağlayıcısı yapılandırın. Her sağlayıcı için ad, API adresi, anahtar, kimlik doğrulama biçimi ve çağrı talimatları bağımsız olarak ayarlanabilir. Aracı, sağlayıcı listesini aigc_get_provider_info ile okur, API’yi aigc_http_request ile çağırır (endpoint ve apiKey otomatik eklenir) ve üretilen dosyaları aigc_canvas_place ile tuvale yerleştirir.",
				settingsEmpty: "Yapılandırılmış sağlayıcı yok. Aşağıdan ekleyin.",
				settingsAdd: "+ Sağlayıcı ekle",
				settingsLoading: "Yükleniyor…",
				settingsError: "Hata",
				"row.id": "Kimlik",
				"row.name": "Ad",
				"row.endpoint": "API adresi",
				"row.apiKey": "API Anahtarı",
				"row.instructions": "Çağrı talimatları",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Görünen ad (ör. \"Volcano Engine\")",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "Sağlayıcıyı başlatırken aracı bunları otomatik yazar (karttaki \"Başlat\"a tıklayın)...",
				"row.idHint": "Küçük harfler, rakamlar, tireler; harfle başlamalıdır. aigc_http_request için provider_id parametresi olarak kullanılır",
				"row.endpointDesc": "Sağlayıcı API adresi. Yerleşik stub için stub://aigc-backend kullanın (sentetik test medyası, gerçek API çağrısı yok)",
				"row.apiKeyDesc": "Sağlayıcı API anahtarı. stub arka ucu için gerekmez. Aracı anahtarı asla görmez — aigc_http_request otomatik olarak ekler",
				"row.instructionsDesc": "Aracı, sağlayıcı API’sinin nasıl çağrılacağına karar vermek için bu alanı aigc_get_provider_info aracıyla okur",
				"row.instructionsHint": "💡 Karttaki \"Başlat\"a tıklayın: aracı API’yi aigc_http_request ile sınar ve talimatları kendisi yazar",
				"row.save": "Kaydet",
				"row.delete": "Sil",
				"row.deleteConfirm": "Bu sağlayıcı silinsin mi?",
				"row.expand": "Genişlet",
				"row.collapse": "Daralt",
				"row.create": "Oluştur",
				"row.cancel": "İptal",
				"row.init": "Başlat",
				"row.initPrompt": "Lütfen AIGC sağlayıcısı \"{name}\" (id: {id}) öğesini başlatın: önce aigc_get_provider_info ile yapılandırmasını görün, ardından aigc_http_request ile API’sini sınayın (apiKey otomatik eklenir — kendiniz iletmeyin) ve son olarak çağrı talimatlarını kaydetmek için aigc_provider_set_instructions çağırın.",
				"row.auth": "Kimlik doğrulama biçimi",
				"row.authBearer": "Bearer başlığı",
				"row.authHeader": "Özel başlık",
				"row.authQuery": "URL parametresi",
				"row.authDesc": "aigc_http_request’in apiKey’i ekleme biçimi. Varsayılan: Authorization: Bearer <key>. Özel başlık veya URL parametresi seçilirse adı doldurun",
				"badge.builtin": "yerleşik",
				"badge.stub": "stub modu",
				"badge.real": "gerçek API",
				"badge.default": "varsayılan"
			},
			vi: {
				tabTitle: "Canvas AIGC",
				title: "Canvas AIGC",
				empty: "Canvas đang trống. Agent gọi API của nhà cung cấp qua aigc_http_request để tạo tài nguyên, sau đó dùng aigc_canvas_place đặt tệp đã tạo vào bất kỳ vị trí nào trên canvas.",
				emptyHint: "Cấu hình một nhà cung cấp trong tab cài đặt bên phải, rồi yêu cầu agent tạo nội dung.",
				prompt: "Lời nhắc",
				image: "Hình ảnh",
				video: "Video",
				audio: "Âm thanh",
				meta: "Siêu dữ liệu",
				generatedBy: "Cách tạo",
				edgeCount: "cạnh",
				elementCount: "phần tử",
				loadError: "Không tải được canvas",
				disconnected: "Đã ngắt kết nối, đang kết nối lại…",
				reconnecting: "Đang kết nối lại…",
				refresh: "Làm mới",
				resetView: "Đặt lại chế độ xem",
				zoom: "Thu phóng",
				zoomIn: "Phóng to",
				zoomOut: "Thu nhỏ",
				detailClose: "Đóng",
				detailPrompt: "Lời nhắc",
				detailParams: "Tham số tạo",
				detailPosition: "Vị trí",
				detailPath: "Đường dẫn tệp",
				delete: "Xóa",
				deleteElement: "Xóa phần tử",
				dropHint: "Kéo thả tệp vào canvas",
				uploading: "Đang tải lên…",
				settingsNav: "Canvas AIGC",
				settingsTitle: "Nhà cung cấp AIGC",
				settingsIntro: "Cấu hình một hoặc nhiều nhà cung cấp AIGC. Mỗi nhà cung cấp có thể đặt riêng tên, địa chỉ API, khóa, phương thức xác thực và hướng dẫn gọi. Agent đọc danh sách nhà cung cấp qua aigc_get_provider_info, gọi API qua aigc_http_request (endpoint và apiKey tự động đính kèm) và đặt tệp đã tạo lên canvas bằng aigc_canvas_place.",
				settingsEmpty: "Chưa có nhà cung cấp nào được cấu hình. Thêm một nhà cung cấp bên dưới.",
				settingsAdd: "+ Thêm nhà cung cấp",
				settingsLoading: "Đang tải…",
				settingsError: "Lỗi",
				"row.id": "ID",
				"row.name": "Tên",
				"row.endpoint": "Địa chỉ API",
				"row.apiKey": "Khóa API",
				"row.instructions": "Hướng dẫn gọi",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Tên hiển thị (ví dụ: \"Volcano Engine\")",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "Agent tự viết hướng dẫn gọi khi bạn khởi tạo nhà cung cấp (bấm \"Khởi tạo\" trên thẻ)...",
				"row.idHint": "Chữ thường, chữ số, dấu gạch ngang; phải bắt đầu bằng chữ cái. Được dùng làm tham số provider_id cho aigc_http_request",
				"row.endpointDesc": "Địa chỉ API của nhà cung cấp. Dùng stub://aigc-backend cho stub tích hợp sẵn (phương tiện kiểm thử giả lập, không gọi API thật)",
				"row.apiKeyDesc": "Khóa API của nhà cung cấp. Không cần cho backend stub. Agent không bao giờ thấy khóa — aigc_http_request tự động đính kèm",
				"row.instructionsDesc": "Agent đọc trường này qua công cụ aigc_get_provider_info để quyết định cách gọi API của nhà cung cấp",
				"row.instructionsHint": "💡 Bấm \"Khởi tạo\" trên thẻ: agent dò API bằng aigc_http_request và tự viết hướng dẫn",
				"row.save": "Lưu",
				"row.delete": "Xóa",
				"row.deleteConfirm": "Xóa nhà cung cấp này?",
				"row.expand": "Mở rộng",
				"row.collapse": "Thu gọn",
				"row.create": "Tạo",
				"row.cancel": "Hủy",
				"row.init": "Khởi tạo",
				"row.initPrompt": "Vui lòng khởi tạo nhà cung cấp AIGC \"{name}\" (id: {id}): trước tiên gọi aigc_get_provider_info để xem cấu hình, sau đó dò API bằng aigc_http_request (apiKey tự động đính kèm — đừng tự truyền), cuối cùng gọi aigc_provider_set_instructions để lưu hướng dẫn gọi.",
				"row.auth": "Phương thức xác thực",
				"row.authBearer": "Header Bearer",
				"row.authHeader": "Header tùy chỉnh",
				"row.authQuery": "Tham số URL",
				"row.authDesc": "Cách aigc_http_request đính kèm apiKey. Mặc định: Authorization: Bearer <key>. Nếu chọn header tùy chỉnh hoặc tham số URL, hãy điền tên",
				"badge.builtin": "tích hợp",
				"badge.stub": "chế độ stub",
				"badge.real": "API thật",
				"badge.default": "mặc định"
			},
			th: {
				tabTitle: "แคนวาส AIGC",
				title: "แคนวาส AIGC",
				empty: "แคนวาสว่างเปล่า เอเจนต์เรียก API ของผู้ให้บริการผ่าน aigc_http_request เพื่อสร้างทรัพยากร แล้ววางไฟล์ที่สร้างแล้วบนตำแหน่งใดก็ได้บนแคนวาสด้วย aigc_canvas_place",
				emptyHint: "กำหนดค่าผู้ให้บริการในแท็บการตั้งค่าทางขวา แล้วขอให้เอเจนต์สร้างบางอย่าง",
				prompt: "พรอมต์",
				image: "รูปภาพ",
				video: "วิดีโอ",
				audio: "เสียง",
				meta: "ข้อมูลเมตา",
				generatedBy: "วิธีสร้าง",
				edgeCount: "ขอบ",
				elementCount: "องค์ประกอบ",
				loadError: "โหลดแคนวาสไม่สำเร็จ",
				disconnected: "ตัดการเชื่อมต่อ กำลังเชื่อมต่อใหม่…",
				reconnecting: "กำลังเชื่อมต่อใหม่…",
				refresh: "รีเฟรช",
				resetView: "รีเซ็ตมุมมอง",
				zoom: "ซูม",
				zoomIn: "ซูมเข้า",
				zoomOut: "ซูมออก",
				detailClose: "ปิด",
				detailPrompt: "พรอมต์",
				detailParams: "พารามิเตอร์การสร้าง",
				detailPosition: "ตำแหน่ง",
				detailPath: "เส้นทางไฟล์",
				delete: "ลบ",
				deleteElement: "ลบองค์ประกอบ",
				dropHint: "วางไฟล์ลงบนแคนวาส",
				uploading: "กำลังอัปโหลด…",
				settingsNav: "แคนวาส AIGC",
				settingsTitle: "ผู้ให้บริการ AIGC",
				settingsIntro: "กำหนดค่าผู้ให้บริการ AIGC หนึ่งรายขึ้นไป แต่ละรายสามารถตั้งชื่อ ที่อยู่ API คีย์ วิธีการยืนยันตัวตน และคำแนะนำการเรียกได้ด้วยตัวเอง เอเจนต์อ่านรายชื่อผู้ให้บริการผ่าน aigc_get_provider_info เรียก API ผ่าน aigc_http_request (แนบ endpoint และ apiKey อัตโนมัติ) และวางไฟล์ที่สร้างแล้วบนแคนวาสด้วย aigc_canvas_place",
				settingsEmpty: "ยังไม่ได้กำหนดค่าผู้ให้บริการ เพิ่มด้านล่าง",
				settingsAdd: "+ เพิ่มผู้ให้บริการ",
				settingsLoading: "กำลังโหลด…",
				settingsError: "ข้อผิดพลาด",
				"row.id": "ID",
				"row.name": "ชื่อ",
				"row.endpoint": "ที่อยู่ API",
				"row.apiKey": "คีย์ API",
				"row.instructions": "คำแนะนำการเรียก",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "ชื่อที่แสดง (เช่น \"Volcano Engine\")",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "เอเจนต์เขียนคำแนะนำเหล่านี้เมื่อคุณเริ่มต้นผู้ให้บริการ (คลิก \"เริ่มต้น\" บนการ์ด)...",
				"row.idHint": "ตัวพิมพ์เล็ก ตัวเลข ยัติภังค์ ต้องขึ้นต้นด้วยตัวอักษร ใช้เป็นพารามิเตอร์ provider_id สำหรับ aigc_http_request",
				"row.endpointDesc": "ที่อยู่ API ของผู้ให้บริการ ใช้ stub://aigc-backend สำหรับ stub ในตัว (สื่อทดสอบสังเคราะห์ ไม่เรียก API จริง)",
				"row.apiKeyDesc": "คีย์ API ของผู้ให้บริการ ไม่จำเป็นสำหรับแบ็กเอนด์ stub เอเจนต์ไม่เห็นคีย์ — aigc_http_request แนบให้อัตโนมัติ",
				"row.instructionsDesc": "เอเจนต์อ่านฟิลด์นี้ผ่านเครื่องมือ aigc_get_provider_info เพื่อตัดสินใจวิธีเรียก API ของผู้ให้บริการ",
				"row.instructionsHint": "💡 คลิก \"เริ่มต้น\" บนการ์ด: เอเจนต์สำรวจ API ด้วย aigc_http_request และเขียนคำแนะนำเอง",
				"row.save": "บันทึก",
				"row.delete": "ลบ",
				"row.deleteConfirm": "ลบผู้ให้บริการนี้หรือไม่",
				"row.expand": "ขยาย",
				"row.collapse": "ย่อ",
				"row.create": "สร้าง",
				"row.cancel": "ยกเลิก",
				"row.init": "เริ่มต้น",
				"row.initPrompt": "กรุณาเริ่มต้นผู้ให้บริการ AIGC \"{name}\" (id: {id}): ก่อนอื่นเรียก aigc_get_provider_info เพื่อดูการกำหนดค่า จากนั้นสำรวจ API ด้วย aigc_http_request (apiKey แนบอัตโนมัติ — อย่าส่งเอง) สุดท้ายเรียก aigc_provider_set_instructions เพื่อบันทึกคำแนะนำการเรียก",
				"row.auth": "วิธีการยืนยันตัวตน",
				"row.authBearer": "Bearer header",
				"row.authHeader": "Header ที่กำหนดเอง",
				"row.authQuery": "พารามิเตอร์ URL",
				"row.authDesc": "วิธีที่ aigc_http_request แนบ apiKey ค่าเริ่มต้น: Authorization: Bearer <key> หากเลือก header ที่กำหนดเองหรือพารามิเตอร์ URL ให้กรอกชื่อ",
				"badge.builtin": "ในตัว",
				"badge.stub": "โหมด stub",
				"badge.real": "API จริง",
				"badge.default": "ค่าเริ่มต้น"
			},
			ru: {
				tabTitle: "Холст AIGC",
				title: "Холст AIGC",
				empty: "Холст пуст. Агент вызывает API провайдера через aigc_http_request для генерации ресурсов, затем помещает сгенерированные файлы в любое место холста с помощью aigc_canvas_place.",
				emptyHint: "Настройте провайдера на вкладке настроек справа, затем попросите агента что-нибудь сгенерировать.",
				prompt: "Промпт",
				image: "Изображение",
				video: "Видео",
				audio: "Аудио",
				meta: "Метаданные",
				generatedBy: "Способ генерации",
				edgeCount: "ребер",
				elementCount: "элементов",
				loadError: "Не удалось загрузить холст",
				disconnected: "Отключено, переподключение…",
				reconnecting: "Переподключение…",
				refresh: "Обновить",
				resetView: "Сбросить вид",
				zoom: "Масштаб",
				zoomIn: "Увеличить",
				zoomOut: "Уменьшить",
				detailClose: "Закрыть",
				detailPrompt: "Промпт",
				detailParams: "Параметры генерации",
				detailPosition: "Положение",
				detailPath: "Путь к файлу",
				delete: "Удалить",
				deleteElement: "Удалить элемент",
				dropHint: "Перетащите файлы на холст",
				uploading: "Загрузка…",
				settingsNav: "Холст AIGC",
				settingsTitle: "Провайдеры AIGC",
				settingsIntro: "Настройте одного или нескольких провайдеров AIGC. Для каждого провайдера можно отдельно задать имя, адрес API, ключ, способ аутентификации и инструкции по вызову. Агент читает список провайдеров через aigc_get_provider_info, вызывает API через aigc_http_request (endpoint и apiKey прикрепляются автоматически) и помещает сгенерированные файлы на холст с помощью aigc_canvas_place.",
				settingsEmpty: "Провайдеры не настроены. Добавьте одного ниже.",
				settingsAdd: "+ Добавить провайдера",
				settingsLoading: "Загрузка…",
				settingsError: "Ошибка",
				"row.id": "ID",
				"row.name": "Название",
				"row.endpoint": "Адрес API",
				"row.apiKey": "Ключ API",
				"row.instructions": "Инструкции по вызову",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Отображаемое имя (например, 火山引擎)",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "Агент пишет их при инициализации провайдера (нажмите «Инициализировать» на карточке)...",
				"row.idHint": "Строчные буквы, цифры, дефисы; должно начинаться с буквы. Используется как параметр provider_id для aigc_http_request",
				"row.endpointDesc": "Адрес API провайдера. Используйте stub://aigc-backend для встроенного stуба (синтетические тестовые медиа, без реальных вызовов API)",
				"row.apiKeyDesc": "Ключ API провайдера. Не требуется для stub-бэкенда. Агент никогда не видит ключ — aigc_http_request добавляет его автоматически",
				"row.instructionsDesc": "Агент читает это поле через инструмент aigc_get_provider_info, чтобы решить, как вызывать API провайдера",
				"row.instructionsHint": "💡 Нажмите «Инициализировать» на карточке: агент прощупывает API через aigc_http_request и сам пишет инструкции",
				"row.save": "Сохранить",
				"row.delete": "Удалить",
				"row.deleteConfirm": "Удалить этого провайдера?",
				"row.expand": "Развернуть",
				"row.collapse": "Свернуть",
				"row.create": "Создать",
				"row.cancel": "Отмена",
				"row.init": "Инициализировать",
				"row.initPrompt": "Пожалуйста, инициализируйте провайдера AIGC «{name}» (id: {id}): сначала вызовите aigc_get_provider_info, чтобы увидеть его конфигурацию, затем прощупайте его API через aigc_http_request (apiKey добавляется автоматически — не передавайте его сами) и наконец вызовите aigc_provider_set_instructions, чтобы сохранить инструкции по использованию.",
				"row.auth": "Способ аутентификации",
				"row.authBearer": "Заголовок Bearer",
				"row.authHeader": "Произвольный заголовок",
				"row.authQuery": "Параметр URL",
				"row.authDesc": "Как aigc_http_request добавляет apiKey. По умолчанию: Authorization: Bearer <key>. При выборе произвольного заголовка или параметра URL укажите имя",
				"badge.builtin": "встроенный",
				"badge.stub": "режим stub",
				"badge.real": "реальный API",
				"badge.default": "по умолчанию"
			},
			it: {
				tabTitle: "Tela AIGC",
				title: "Tela AIGC",
				empty: "La tela è vuota. L’agente chiama le API del fornitore tramite aigc_http_request per generare le risorse, quindi posiziona i file generati in un punto qualsiasi della tela con aigc_canvas_place.",
				emptyHint: "Configura un fornitore nella scheda impostazioni a destra, poi chiedi all’agente di generare qualcosa.",
				prompt: "Prompt",
				image: "Immagine",
				video: "Video",
				audio: "Audio",
				meta: "Metadati",
				generatedBy: "Metodo di generazione",
				edgeCount: "archi",
				elementCount: "elementi",
				loadError: "Impossibile caricare la tela",
				disconnected: "Disconnesso, riconnessione…",
				reconnecting: "Riconnessione in corso…",
				refresh: "Aggiorna",
				resetView: "Reimposta vista",
				zoom: "Zoom",
				zoomIn: "Ingrandisci",
				zoomOut: "Riduci",
				detailClose: "Chiudi",
				detailPrompt: "Prompt",
				detailParams: "Parametri di generazione",
				detailPosition: "Posizione",
				detailPath: "Percorso file",
				delete: "Elimina",
				deleteElement: "Elimina elemento",
				dropHint: "Trascina i file sulla tela",
				uploading: "Caricamento…",
				settingsNav: "Tela AIGC",
				settingsTitle: "Fornitori AIGC",
				settingsIntro: "Configura uno o più fornitori AIGC. Ogni fornitore ha nome, endpoint API, chiave, schema di autenticazione e istruzioni di chiamata propri. L’agente legge l’elenco dei fornitori tramite aigc_get_provider_info, chiama l’API tramite aigc_http_request (endpoint e apiKey allegati automaticamente) e posiziona i file generati sulla tela con aigc_canvas_place.",
				settingsEmpty: "Nessun fornitore configurato. Aggiungine uno qui sotto.",
				settingsAdd: "+ Aggiungi fornitore",
				settingsLoading: "Caricamento…",
				settingsError: "Errore",
				"row.id": "ID",
				"row.name": "Nome",
				"row.endpoint": "Endpoint",
				"row.apiKey": "Chiave API",
				"row.instructions": "Istruzioni",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Nome visualizzato (es. \"Volcano Engine\")",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "L’agente le scrive quando inizializzi il fornitore (fai clic su \"Inizializza\" sulla scheda)...",
				"row.idHint": "Lettere minuscole, cifre, trattini; deve iniziare con una lettera. Usato come parametro provider_id per aigc_http_request",
				"row.endpointDesc": "Endpoint API del fornitore. Usa stub://aigc-backend per lo stub integrato (contenuti di test sintetici, nessuna vera chiamata API)",
				"row.apiKeyDesc": "Chiave API del fornitore. Non necessaria per il backend stub. L’agente non la vede mai — aigc_http_request la allega automaticamente",
				"row.instructionsDesc": "L’agente legge questo campo tramite lo strumento aigc_get_provider_info per decidere come chiamare l’API del fornitore",
				"row.instructionsHint": "💡 Fai clic su \"Inizializza\" sulla scheda: l’agente sonda l’API con aigc_http_request e scrive le istruzioni da solo",
				"row.save": "Salva",
				"row.delete": "Elimina",
				"row.deleteConfirm": "Eliminare questo fornitore?",
				"row.expand": "Espandi",
				"row.collapse": "Comprimi",
				"row.create": "Crea",
				"row.cancel": "Annulla",
				"row.init": "Inizializza",
				"row.initPrompt": "Inizializza il fornitore AIGC \"{name}\" (id: {id}): prima chiama aigc_get_provider_info per vederne la configurazione, poi sonda la sua API con aigc_http_request (il apiKey è allegato automaticamente — non passarlo tu), e infine chiama aigc_provider_set_instructions per salvare le istruzioni di chiamata.",
				"row.auth": "Schema di autenticazione",
				"row.authBearer": "Header Bearer",
				"row.authHeader": "Header personalizzato",
				"row.authQuery": "Parametro URL",
				"row.authDesc": "Come aigc_http_request allega l’apiKey. Default: Authorization: Bearer <key>. Per header personalizzato o parametro URL, compila il nome",
				"badge.builtin": "integrato",
				"badge.stub": "modalità stub",
				"badge.real": "API reale",
				"badge.default": "default"
			},
			nl: {
				tabTitle: "AIGC-canvas",
				title: "AIGC-canvas",
				empty: "Het canvas is leeg. De agent roept provider-API’s aan via aigc_http_request om assets te genereren en plaatst de gegenereerde bestanden met aigc_canvas_place op elke gewenste positie op het canvas.",
				emptyHint: "Configureer een provider op het tabblad Instellingen rechts en vraag de agent vervolgens iets te genereren.",
				prompt: "Prompt",
				image: "Afbeelding",
				video: "Video",
				audio: "Audio",
				meta: "Metadata",
				generatedBy: "Generatiemethode",
				edgeCount: "randen",
				elementCount: "elementen",
				loadError: "Canvas laden mislukt",
				disconnected: "Verbinding verbroken, opnieuw verbinden…",
				reconnecting: "Opnieuw verbinden…",
				refresh: "Vernieuwen",
				resetView: "Weergave resetten",
				zoom: "Zoom",
				zoomIn: "Inzoomen",
				zoomOut: "Uitzoomen",
				detailClose: "Sluiten",
				detailPrompt: "Prompt",
				detailParams: "Generatieparameters",
				detailPosition: "Positie",
				detailPath: "Bestandspad",
				delete: "Verwijderen",
				deleteElement: "Element verwijderen",
				dropHint: "Sleep bestanden naar het canvas",
				uploading: "Bezig met uploaden…",
				settingsNav: "AIGC-canvas",
				settingsTitle: "AIGC-providers",
				settingsIntro: "Configureer een of meer AIGC-providers. Elke provider kan afzonderlijk worden ingesteld op naam, API-adres, sleutel, authenticatiemethode en aanroepinstructies. De agent leest de providerlijst via aigc_get_provider_info, roept de API aan via aigc_http_request (endpoint en apiKey automatisch toegevoegd) en plaatst de gegenereerde bestanden met aigc_canvas_place op het canvas.",
				settingsEmpty: "Geen providers geconfigureerd. Voeg er hieronder een toe.",
				settingsAdd: "+ Provider toevoegen",
				settingsLoading: "Laden…",
				settingsError: "Fout",
				"row.id": "ID",
				"row.name": "Naam",
				"row.endpoint": "API-adres",
				"row.apiKey": "API-sleutel",
				"row.instructions": "Aanroepinstructies",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Weergavenaam (bijv. Volcano Engine)",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "De agent schrijft deze wanneer je de provider initialiseert (klik op \"Initialiseren\" op de kaart)...",
				"row.idHint": "Kleine letters, cijfers, koppeltekens; moet met een letter beginnen. Wordt gebruikt als provider_id-parameter voor aigc_http_request",
				"row.endpointDesc": "API-adres van de provider. Gebruik stub://aigc-backend voor de ingebouwde stub (synthetische testmedia, geen echte API-aanroepen)",
				"row.apiKeyDesc": "API-sleutel van de provider. Niet nodig voor de stub-backend. De agent ziet de sleutel nooit — aigc_http_request voegt hem automatisch toe",
				"row.instructionsDesc": "De agent leest dit veld via de tool aigc_get_provider_info om te bepalen hoe de API van de provider moet worden aangeroepen",
				"row.instructionsHint": "💡 Klik op \"Initialiseren\" op de kaart: de agent test de API met aigc_http_request en schrijft de instructies zelf",
				"row.save": "Opslaan",
				"row.delete": "Verwijderen",
				"row.deleteConfirm": "Deze provider verwijderen?",
				"row.expand": "Uitvouwen",
				"row.collapse": "Inklappen",
				"row.create": "Maken",
				"row.cancel": "Annuleren",
				"row.init": "Initialiseren",
				"row.initPrompt": "Initialiseer de AIGC-provider \"{name}\" (id: {id}): roep eerst aigc_get_provider_info aan om de configuratie te zien, test daarna de API met aigc_http_request (de apiKey wordt automatisch toegevoegd — geef hem zelf niet door) en roep ten slotte aigc_provider_set_instructions aan om de aanroepinstructies op te slaan.",
				"row.auth": "Authenticatieschema",
				"row.authBearer": "Bearer-header",
				"row.authHeader": "Eigen header",
				"row.authQuery": "URL-queryparameter",
				"row.authDesc": "Hoe aigc_http_request de apiKey toevoegt. Standaard: Authorization: Bearer <key>. Kies je een eigen header of URL-parameter, vul dan de naam in",
				"badge.builtin": "ingebouwd",
				"badge.stub": "stubmodus",
				"badge.real": "echte API",
				"badge.default": "standaard"
			},
			sv: {
				tabTitle: "AIGC-canvas",
				title: "AIGC-canvas",
				empty: "Canvasen är tom. Agenten anropar leverantörens API:er via aigc_http_request för att generera tillgångar och placerar sedan de genererade filerna var som helst på canvasen med aigc_canvas_place.",
				emptyHint: "Konfigurera en leverantör i inställningsfliken till höger och be sedan agenten att generera något.",
				prompt: "Prompt",
				image: "Bild",
				video: "Video",
				audio: "Ljud",
				meta: "Metadata",
				generatedBy: "Genereringsmetod",
				edgeCount: "kanter",
				elementCount: "element",
				loadError: "Det gick inte att läsa in canvasen",
				disconnected: "Frånkopplad, återansluter…",
				reconnecting: "Återansluter…",
				refresh: "Uppdatera",
				resetView: "Återställ vy",
				zoom: "Zooma",
				zoomIn: "Zooma in",
				zoomOut: "Zooma ut",
				detailClose: "Stäng",
				detailPrompt: "Prompt",
				detailParams: "Genereringsparametrar",
				detailPosition: "Position",
				detailPath: "Filsökväg",
				delete: "Ta bort",
				deleteElement: "Ta bort element",
				dropHint: "Släpp filer på canvasen",
				uploading: "Laddar upp…",
				settingsNav: "AIGC-canvas",
				settingsTitle: "AIGC-leverantörer",
				settingsIntro: "Konfigurera en eller flera AIGC-leverantörer. Varje leverantör kan ställas in med eget namn, API-adress, nyckel, autentiseringsmetod och anropssinstruktioner. Agenten läser leverantörslistan via aigc_get_provider_info, anropar API:et via aigc_http_request (endpoint och apiKey läggs till automatiskt) och placerar de genererade filerna på canvasen med aigc_canvas_place.",
				settingsEmpty: "Inga leverantörer konfigurerade. Lägg till en nedan.",
				settingsAdd: "+ Lägg till leverantör",
				settingsLoading: "Läser in…",
				settingsError: "Fel",
				"row.id": "ID",
				"row.name": "Namn",
				"row.endpoint": "API-adress",
				"row.apiKey": "API-nyckel",
				"row.instructions": "Anropssinstruktioner",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Visningsnamn (t.ex. Volcano Engine)",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "Agenten skriver dem när du initierar leverantören (klicka på \"Initiera\" på kortet)...",
				"row.idHint": "Gemener, siffror, bindestreck; måste börja med en bokstav. Används som provider_id-parameter till aigc_http_request",
				"row.endpointDesc": "Leverantörens API-adress. Använd stub://aigc-backend för den inbyggda stubben (syntetiska testmedier, inga riktiga API-anrop)",
				"row.apiKeyDesc": "Leverantörens API-nyckel. Behövs inte för stub-backend. Agenten ser aldrig nyckeln — aigc_http_request lägger till den automatiskt",
				"row.instructionsDesc": "Agenten läser detta fält via verktyget aigc_get_provider_info för att avgöra hur leverantörens API ska anropas",
				"row.instructionsHint": "💡 Klicka på \"Initiera\" på kortet: agenten sondar API:et med aigc_http_request och skriver instruktionerna själv",
				"row.save": "Spara",
				"row.delete": "Ta bort",
				"row.deleteConfirm": "Ta bort den här leverantören?",
				"row.expand": "Expandera",
				"row.collapse": "Fäll ihop",
				"row.create": "Skapa",
				"row.cancel": "Avbryt",
				"row.init": "Initiera",
				"row.initPrompt": "Initiera AIGC-leverantören \"{name}\" (id: {id}): anropa först aigc_get_provider_info för att se konfigurationen, sondera sedan API:et med aigc_http_request (apiKey läggs till automatiskt — skicka inte den själv) och anropa slutligen aigc_provider_set_instructions för att spara anropssinstruktionerna.",
				"row.auth": "Autentiseringsschema",
				"row.authBearer": "Bearer-header",
				"row.authHeader": "Egen header",
				"row.authQuery": "URL-frågeparameter",
				"row.authDesc": "Hur aigc_http_request lägger till apiKey. Standard: Authorization: Bearer <key>. För egen header eller URL-parameter fyller du i namnet",
				"badge.builtin": "inbyggd",
				"badge.stub": "stub-läge",
				"badge.real": "riktigt API",
				"badge.default": "standard"
			},
			pl: {
				tabTitle: "Płótno AIGC",
				title: "Płótno AIGC",
				empty: "Płótno jest puste. Agent wywołuje API dostawcy przez aigc_http_request, aby wygenerować zasoby, a następnie umieszcza wygenerowane pliki w dowolnym miejscu na płótnie za pomocą aigc_canvas_place.",
				emptyHint: "Skonfiguruj dostawcę w zakładce ustawień po prawej, a następnie poproś agenta o wygenerowanie czegoś.",
				prompt: "Komunikat",
				image: "Obraz",
				video: "Wideo",
				audio: "Audio",
				meta: "Metadane",
				generatedBy: "Metoda generowania",
				edgeCount: "krawędzie",
				elementCount: "elementy",
				loadError: "Nie udało się załadować płótna",
				disconnected: "Rozłączono, ponawianie połączenia…",
				reconnecting: "Ponawianie połączenia…",
				refresh: "Odśwież",
				resetView: "Resetuj widok",
				zoom: "Zoom",
				zoomIn: "Powiększ",
				zoomOut: "Pomniejsz",
				detailClose: "Zamknij",
				detailPrompt: "Komunikat",
				detailParams: "Parametry generowania",
				detailPosition: "Pozycja",
				detailPath: "Ścieżka pliku",
				delete: "Usuń",
				deleteElement: "Usuń element",
				dropHint: "Przeciągnij pliki na płótno",
				uploading: "Przesyłanie…",
				settingsNav: "Płótno AIGC",
				settingsTitle: "Dostawcy AIGC",
				settingsIntro: "Skonfiguruj jednego lub więcej dostawców AIGC. Dla każdego dostawcy można osobno ustawić nazwę, adres API, klucz, metodę uwierzytelniania i instrukcje wywołania. Agent odczytuje listę dostawców przez aigc_get_provider_info, wywołuje API przez aigc_http_request (endpoint i apiKey dołączane automatycznie) i umieszcza wygenerowane pliki na płótnie za pomocą aigc_canvas_place.",
				settingsEmpty: "Nie skonfigurowano żadnych dostawców. Dodaj jednego poniżej.",
				settingsAdd: "+ Dodaj dostawcę",
				settingsLoading: "Ładowanie…",
				settingsError: "Błąd",
				"row.id": "ID",
				"row.name": "Nazwa",
				"row.endpoint": "Adres API",
				"row.apiKey": "Klucz API",
				"row.instructions": "Instrukcje wywołania",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "Nazwa wyświetlana (np. Volcano Engine)",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "Agent pisze je, gdy inicjalizujesz dostawcę (kliknij „Inicjalizuj” na karcie)...",
				"row.idHint": "Małe litery, cyfry, łączniki; musi zaczynać się od litery. Używany jako parametr provider_id dla aigc_http_request",
				"row.endpointDesc": "Adres API dostawcy. Użyj stub://aigc-backend dla wbudowanego stuba (syntetyczne media testowe, bez prawdziwych wywołań API)",
				"row.apiKeyDesc": "Klucz API dostawcy. Niepotrzebny dla backendu stub. Agent nigdy go nie widzi — aigc_http_request dołącza go automatycznie",
				"row.instructionsDesc": "Agent odczytuje to pole przez narzędzie aigc_get_provider_info, aby zdecydować, jak wywołać API dostawcy",
				"row.instructionsHint": "💡 Kliknij „Inicjalizuj” na karcie: agent sonduje API przez aigc_http_request i sam pisze instrukcje",
				"row.save": "Zapisz",
				"row.delete": "Usuń",
				"row.deleteConfirm": "Usunąć tego dostawcę?",
				"row.expand": "Rozwiń",
				"row.collapse": "Zwiń",
				"row.create": "Utwórz",
				"row.cancel": "Anuluj",
				"row.init": "Inicjalizuj",
				"row.initPrompt": "Zainicjalizuj dostawcę AIGC „{name}” (id: {id}): najpierw wywołaj aigc_get_provider_info, aby zobaczyć jego konfigurację, następnie przesondaj jego API przez aigc_http_request (apiKey jest dołączany automatycznie — nie przekazuj go sam), a na koniec wywołaj aigc_provider_set_instructions, aby zapisać instrukcje wywołania.",
				"row.auth": "Schemat uwierzytelniania",
				"row.authBearer": "Nagłówek Bearer",
				"row.authHeader": "Własny nagłówek",
				"row.authQuery": "Parametr zapytania URL",
				"row.authDesc": "Jak aigc_http_request dołącza apiKey. Domyślnie: Authorization: Bearer <key>. W przypadku własnego nagłówka lub parametru URL podaj nazwę",
				"badge.builtin": "wbudowany",
				"badge.stub": "tryb stub",
				"badge.real": "prawdziwe API",
				"badge.default": "domyślny"
			},
			"zh-HK": {
				tabTitle: "AIGC 畫布",
				title: "AIGC 畫布",
				empty: "畫布是空的。模型透過 aigc_http_request 呼叫供應商 API 產生素材，再用 aigc_canvas_place 把檔案放到畫布的任意位置。",
				emptyHint: "可在右側設定頁配置供應商，然後讓模型開始產生。",
				prompt: "提示詞",
				image: "圖片",
				video: "影片",
				audio: "音頻",
				meta: "中繼資料",
				generatedBy: "產生方式",
				edgeCount: "條連線",
				elementCount: "個元素",
				loadError: "載入畫布失敗",
				disconnected: "已中斷連線，正在重連…",
				reconnecting: "正在重連…",
				refresh: "重新整理",
				resetView: "重設檢視",
				zoom: "縮放",
				zoomIn: "放大",
				zoomOut: "縮小",
				detailClose: "關閉",
				detailPrompt: "提示詞",
				detailParams: "產生參數",
				detailPosition: "位置",
				detailPath: "檔案路徑",
				delete: "刪除",
				deleteElement: "刪除元素",
				dropHint: "拖放檔案到畫布",
				uploading: "上載中…",
				settingsNav: "AIGC 畫布",
				settingsTitle: "AIGC 供應商",
				settingsIntro: "設定一個或多個 AIGC 供應商。每個供應商可獨立設定名稱、API 位址、金鑰、驗證方式和呼叫說明。模型透過 aigc_get_provider_info 讀取供應商列表，用 aigc_http_request 呼叫 API（自動攜帶 endpoint 和 apiKey），產生的檔案用 aigc_canvas_place 放到畫布上。",
				settingsEmpty: "尚無供應商，請在下方新增。",
				settingsAdd: "+ 新增供應商",
				settingsLoading: "載入中…",
				settingsError: "錯誤",
				"row.id": "ID",
				"row.name": "名稱",
				"row.endpoint": "API 位址",
				"row.apiKey": "API 金鑰",
				"row.instructions": "呼叫說明",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "顯示名稱（例如「火山引擎」）",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "呼叫說明由 Agent 初始化供應商時自動撰寫（點擊卡片上的「初始化」按鈕）...",
				"row.idHint": "小寫字母、數字、連字號；必須以字母開頭。作為 provider_id 傳給 aigc_http_request",
				"row.endpointDesc": "供應商 API 位址。填 stub://aigc-backend 使用內建 stub（合成測試媒體，不呼叫真實 API）",
				"row.apiKeyDesc": "供應商 API 金鑰。stub 後端不需要。模型看不到金鑰，由 aigc_http_request 自動附加",
				"row.instructionsDesc": "Agent 透過 aigc_get_provider_info 工具讀取此欄位，決定如何呼叫該供應商的 API",
				"row.instructionsHint": "💡 點擊卡片上的「初始化」按鈕，Agent 會用 aigc_http_request 探測 API 並自動撰寫呼叫說明",
				"row.save": "儲存",
				"row.delete": "刪除",
				"row.deleteConfirm": "確定刪除此供應商？",
				"row.expand": "展開",
				"row.collapse": "收起",
				"row.create": "建立",
				"row.cancel": "取消",
				"row.init": "初始化",
				"row.initPrompt": "請幫我初始化 AIGC 供應商「{name}」(id: {id})：先用 aigc_get_provider_info 查看設定，再用 aigc_http_request 探測它的 API（apiKey 會自動附加，無需手動傳入），最後呼叫 aigc_provider_set_instructions 把呼叫說明儲存下來，方便以後直接使用。",
				"row.auth": "驗證方式",
				"row.authBearer": "Bearer 標頭",
				"row.authHeader": "自訂標頭",
				"row.authQuery": "URL 參數",
				"row.authDesc": "aigc_http_request 自動附加 apiKey 的方式。預設 Authorization: Bearer <key>；選擇自訂標頭或 URL 參數時需填寫名稱",
				"badge.builtin": "內建",
				"badge.stub": "stub 模式",
				"badge.real": "真實 API",
				"badge.default": "預設"
			},
			"zh-TW": {
				tabTitle: "AIGC 畫布",
				title: "AIGC 畫布",
				empty: "畫布是空的。模型透過 aigc_http_request 呼叫供應商 API 產生素材，再用 aigc_canvas_place 把檔案放到畫布的任意位置。",
				emptyHint: "可在右側設定頁配置供應商，然後讓模型開始產生。",
				prompt: "提示詞",
				image: "圖片",
				video: "影片",
				audio: "音訊",
				meta: "中繼資訊",
				generatedBy: "產生方式",
				edgeCount: "條連線",
				elementCount: "個元素",
				loadError: "載入畫布失敗",
				disconnected: "已中斷連線，正在重連…",
				reconnecting: "正在重連…",
				refresh: "重新整理",
				resetView: "重設檢視",
				zoom: "縮放",
				zoomIn: "放大",
				zoomOut: "縮小",
				detailClose: "關閉",
				detailPrompt: "提示詞",
				detailParams: "產生參數",
				detailPosition: "位置",
				detailPath: "檔案路徑",
				delete: "刪除",
				deleteElement: "刪除元素",
				dropHint: "拖放檔案到畫布",
				uploading: "上傳中…",
				settingsNav: "AIGC 畫布",
				settingsTitle: "AIGC 供應商",
				settingsIntro: "設定一個或多個 AIGC 供應商。每個供應商可獨立設定名稱、API 位址、金鑰、驗證方式和呼叫說明。模型透過 aigc_get_provider_info 讀取供應商列表，用 aigc_http_request 呼叫 API（自動攜帶 endpoint 和 apiKey），產生的檔案用 aigc_canvas_place 放到畫布上。",
				settingsEmpty: "尚無供應商，請在下方新增。",
				settingsAdd: "+ 新增供應商",
				settingsLoading: "載入中…",
				settingsError: "錯誤",
				"row.id": "ID",
				"row.name": "名稱",
				"row.endpoint": "API 位址",
				"row.apiKey": "API 金鑰",
				"row.instructions": "呼叫說明",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "顯示名稱（如「火山引擎」）",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "呼叫說明由 Agent 初始化供應商時自動撰寫（點擊卡片上的「初始化」按鈕）...",
				"row.idHint": "小寫字母、數字、連字號；必須以字母開頭。作為 provider_id 傳給 aigc_http_request",
				"row.endpointDesc": "供應商 API 位址。填 stub://aigc-backend 使用內建 stub（合成測試媒體，不呼叫真實 API）",
				"row.apiKeyDesc": "供應商 API 金鑰。stub 後端不需要。模型看不到金鑰，由 aigc_http_request 自動附加",
				"row.instructionsDesc": "Agent 透過 aigc_get_provider_info 工具讀取此欄位，決定如何呼叫該供應商的 API",
				"row.instructionsHint": "💡 點擊卡片上的「初始化」按鈕，Agent 會用 aigc_http_request 探測 API 並自動撰寫呼叫說明",
				"row.save": "儲存",
				"row.delete": "刪除",
				"row.deleteConfirm": "確定刪除此供應商？",
				"row.expand": "展開",
				"row.collapse": "收合",
				"row.create": "建立",
				"row.cancel": "取消",
				"row.init": "初始化",
				"row.initPrompt": "請幫我初始化 AIGC 供應商「{name}」(id: {id})：先用 aigc_get_provider_info 查看設定，再用 aigc_http_request 探測它的 API（apiKey 會自動附加，無需手動傳入），最後呼叫 aigc_provider_set_instructions 把呼叫說明儲存下來，方便以後直接使用。",
				"row.auth": "驗證方式",
				"row.authBearer": "Bearer 標頭",
				"row.authHeader": "自訂標頭",
				"row.authQuery": "URL 參數",
				"row.authDesc": "aigc_http_request 自動附加 apiKey 的方式。預設 Authorization: Bearer <key>；選擇自訂標頭或 URL 參數時需填寫名稱",
				"badge.builtin": "內建",
				"badge.stub": "stub 模式",
				"badge.real": "真實 API",
				"badge.default": "預設"
			},
			"zh-MO": {
				tabTitle: "AIGC 畫布",
				title: "AIGC 畫布",
				empty: "畫布是空的。模型透過 aigc_http_request 呼叫供應商 API 產生素材，再用 aigc_canvas_place 把檔案放到畫布的任意位置。",
				emptyHint: "可在右側設定頁配置供應商，然後讓模型開始產生。",
				prompt: "提示詞",
				image: "圖片",
				video: "影片",
				audio: "音頻",
				meta: "中繼資料",
				generatedBy: "產生方式",
				edgeCount: "條連線",
				elementCount: "個元素",
				loadError: "載入畫布失敗",
				disconnected: "已中斷連線，正在重連…",
				reconnecting: "正在重連…",
				refresh: "重新整理",
				resetView: "重設檢視",
				zoom: "縮放",
				zoomIn: "放大",
				zoomOut: "縮小",
				detailClose: "關閉",
				detailPrompt: "提示詞",
				detailParams: "產生參數",
				detailPosition: "位置",
				detailPath: "檔案路徑",
				delete: "刪除",
				deleteElement: "刪除元素",
				dropHint: "拖放檔案到畫布",
				uploading: "上載中…",
				settingsNav: "AIGC 畫布",
				settingsTitle: "AIGC 供應商",
				settingsIntro: "設定一個或多個 AIGC 供應商。每個供應商可獨立設定名稱、API 位址、金鑰、驗證方式和呼叫說明。模型透過 aigc_get_provider_info 讀取供應商列表，用 aigc_http_request 呼叫 API（自動攜帶 endpoint 和 apiKey），產生的檔案用 aigc_canvas_place 放到畫布上。",
				settingsEmpty: "尚無供應商，請在下方新增。",
				settingsAdd: "+ 新增供應商",
				settingsLoading: "載入中…",
				settingsError: "錯誤",
				"row.id": "ID",
				"row.name": "名稱",
				"row.endpoint": "API 位址",
				"row.apiKey": "API 金鑰",
				"row.instructions": "呼叫說明",
				"row.idPlaceholder": "volcano / jimeng / minimax",
				"row.namePlaceholder": "顯示名稱（如「火山引擎」）",
				"row.endpointPlaceholder": "stub://aigc-backend",
				"row.apiKeyPlaceholder": "sk-...",
				"row.instructionsPlaceholder": "呼叫說明由 Agent 初始化供應商時自動撰寫（點擊卡片上的「初始化」按鈕）...",
				"row.idHint": "小寫字母、數字、連字號；必須以字母開頭。作為 provider_id 傳給 aigc_http_request",
				"row.endpointDesc": "供應商 API 位址。填 stub://aigc-backend 使用內建 stub（合成測試媒體，不呼叫真實 API）",
				"row.apiKeyDesc": "供應商 API 金鑰。stub 後端不需要。模型看不到金鑰，由 aigc_http_request 自動附加",
				"row.instructionsDesc": "Agent 透過 aigc_get_provider_info 工具讀取此欄位，決定如何呼叫該供應商的 API",
				"row.instructionsHint": "💡 點擊卡片上的「初始化」按鈕，Agent 會用 aigc_http_request 探測 API 並自動撰寫呼叫說明",
				"row.save": "儲存",
				"row.delete": "刪除",
				"row.deleteConfirm": "確定刪除此供應商？",
				"row.expand": "展開",
				"row.collapse": "收起",
				"row.create": "建立",
				"row.cancel": "取消",
				"row.init": "初始化",
				"row.initPrompt": "請幫我初始化 AIGC 供應商「{name}」(id: {id})：先用 aigc_get_provider_info 查看設定，再用 aigc_http_request 探測它的 API（apiKey 會自動附加，無需手動傳入），最後呼叫 aigc_provider_set_instructions 把呼叫說明儲存下來，方便以後直接使用。",
				"row.auth": "驗證方式",
				"row.authBearer": "Bearer 標頭",
				"row.authHeader": "自訂標頭",
				"row.authQuery": "URL 參數",
				"row.authDesc": "aigc_http_request 自動附加 apiKey 的方式。預設 Authorization: Bearer <key>；選擇自訂標頭或 URL 參數時需填寫名稱",
				"badge.builtin": "內建",
				"badge.stub": "stub 模式",
				"badge.real": "真實 API",
				"badge.default": "預設"
			}
		};
		//#endregion
		//#region src/client/index.tsx
		/** Services required before mounting. `betterSidebar` is intentionally NOT
		*  listed here — this plugin extends `dsh-better-sidebar` when present, but
		*  must remain loadable without it (defensive lookup via `ctx.get(...)`). */
		const inject = [
			"slots",
			"locale",
			"conversation"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-aigc-canvas: dictionaries");
			ctx.effect(() => {
				let dispose;
				const sync = () => {
					dispose?.();
					dispose = void 0;
					const store = ctx.get("betterLocale");
					if (store !== void 0) dispose = store.register(NS, dicts);
				};
				sync();
				const unsubscribe = ctx.locale.subscribe(sync);
				return () => {
					unsubscribe();
					dispose?.();
				};
			}, "dsh-aigc-canvas: better-locale override dicts");
			const t = ctx.locale.bind(NS);
			const betterSidebar = ctx.get("betterSidebar");
			if (betterSidebar !== void 0) ctx.effect(() => betterSidebar.registerTab({
				id: "aigc-canvas:main",
				title: () => t("tabTitle"),
				order: 50,
				dedupeKey: () => "aigc-canvas:main",
				component: ({ scope }) => {
					const storeRef = (0, react.useRef)(null);
					if (storeRef.current === null || storeRef.current.sessionId !== scope.sessionId) {
						storeRef.current?.dispose();
						storeRef.current = new CanvasStore({ sessionId: scope.sessionId });
					}
					(0, react.useEffect)(() => {
						return () => {
							storeRef.current?.dispose();
							storeRef.current = null;
						};
					}, []);
					return (0, react.createElement)(CanvasViewWithBoundary, {
						store: storeRef.current,
						t
					});
				}
			}));
			const settingsInjected = () => ({
				t,
				send: (text) => ctx.conversation.send(text)
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "aigc-canvas",
				order: 60,
				label: () => t("settingsNav"),
				locale: NS,
				inject: settingsInjected
			}, SettingsPage));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map