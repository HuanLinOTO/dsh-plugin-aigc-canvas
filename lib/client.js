window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-aigc-canvas",
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
		const tagId$1 = "@dsh-external/dsh-aigc-canvas/canvas.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-aigc-canvas";
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
		const tagId = "@dsh-external/dsh-aigc-canvas/SettingsPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-aigc-canvas";
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
		* @module @dsh-external/dsh-aigc-canvas/client/SettingsPage
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
		* @module @dsh-external/dsh-aigc-canvas/client/locales
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
		//#region src/client/index.tsx
		/** Services required before mounting. */
		const inject = [
			"betterSidebar",
			"slots",
			"locale",
			"conversation"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-aigc-canvas: dictionaries");
			const t = ctx.locale.bind(NS);
			const betterSidebar = ctx.betterSidebar;
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