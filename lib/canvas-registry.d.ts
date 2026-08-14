/** Discriminated union of element kinds the canvas stores. */
export type AigcElementKind = 'prompt' | 'image' | 'video' | 'audio';
/** File extension for each media kind (no leading dot). */
export declare function extensionFor(kind: AigcElementKind): string;
/** MIME type for each media kind (for the file route). */
export declare function mimeTypeFor(kind: AigcElementKind): string;
/** One node on the canvas. */
export interface AigcElement {
    /** Stable opaque handle (internal; used for edges). */
    uuid: string;
    /** Owning conversation id. */
    sessionId: string;
    /** Discriminator. */
    kind: AigcElementKind;
    /** Display title (short human-readable label). */
    title: string;
    /** Canvas position, world coordinates (infinite free canvas). */
    x: number;
    /** Canvas position, world coordinates (infinite free canvas). */
    y: number;
    /** Creation time (ms since epoch). */
    createdAt: number;
    /** Tool that produced this element. */
    producedBy: string;
    /**
     * Absolute path to the element file on disk. For prompt elements: the
     * `.txt` file containing the prompt text. For media elements: the media
     * file. This is the **primary external identifier** — tools return and
     * accept this path.
     */
    filePath: string;
    /** For prompt elements: the prompt text (mirrored in the .txt file). */
    promptText?: string;
    /** For media elements: byte size of the media file. */
    mediaSize?: number;
    /** Freeform metadata bag (dimensions, duration, model, seed, ...). */
    meta?: Record<string, unknown>;
    /**
     * Ultra-short model-supplied description of the element (a noun, an
     * adjective, or a short phrase — e.g. "orange cat", "sunset beach",
     * "fast cut"). Bounded to ~40 chars; shown on the node card under the
     * title and injected into context when the element is referenced.
     */
    description?: string;
}
/** One edge: source element → target element (multi-to-one fan-in). */
export interface AigcEdge {
    /** Source element uuid (an input — prompt or reference). */
    source: string;
    /** Target element uuid (the produced output). */
    target: string;
}
/** The serializable canvas state for one session. */
export interface AigcCanvasState {
    sessionId: string;
    elements: AigcElement[];
    edges: AigcEdge[];
}
/** Listener callback receives the session id that changed. */
export type AigcCanvasListener = (sessionId: string) => void;
/** The registry service published as `ctx.aigcCanvas`. */
export interface AigcCanvasService {
    /** Add a prompt element (writes a .txt file). Returns the new element. */
    addPrompt(sessionId: string, params: {
        title: string;
        promptText: string;
        producedBy: string;
        x?: number;
        y?: number;
        meta?: Record<string, unknown>;
        description?: string;
    }, cwd: string): Promise<AigcElement>;
    /** Add a media element (image/video/audio) with the given bytes on disk. */
    addMedia(sessionId: string, params: {
        kind: 'image' | 'video' | 'audio';
        title: string;
        producedBy: string;
        mediaBytes: Buffer;
        x?: number;
        y?: number;
        meta?: Record<string, unknown>;
        description?: string;
    }, cwd: string): Promise<AigcElement>;
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
        kind: 'image' | 'video' | 'audio' | 'prompt';
        filePath: string;
        title: string;
        producedBy: string;
        x?: number;
        y?: number;
        promptText?: string;
        meta?: Record<string, unknown>;
        description?: string;
        /** Uuids of reference elements — when x/y are omitted, the new element is placed to the right of them. */
        referenceUuids?: readonly string[];
    }, cwd: string): Promise<AigcElement>;
    /** Move an element to a new canvas position (persisted + pushed). */
    updatePosition(sessionId: string, uuid: string, x: number, y: number): Promise<AigcElement>;
    /**
     * Delete one element and any edges referencing it. The media file on
     * disk is NOT removed (the model may still reference its filePath);
     * only the canvas registration is dropped.
     */
    deleteElement(sessionId: string, uuid: string): Promise<void>;
    /** Wire edges from each input uuid to the target uuid (multi-to-one). */
    wireEdges(sessionId: string, inputUuids: readonly string[], targetUuid: string): Promise<void>;
    /** Remove one edge (source → target). Idempotent. */
    unlink(sessionId: string, sourceUuid: string, targetUuid: string): Promise<void>;
    /** Load the persisted state for one session (idempotent; used before sync reads). */
    ensureHydrated(sessionId: string): Promise<void>;
    /** Look up one element by uuid (throws if not found or wrong session). */
    getElement(sessionId: string, uuid: string): AigcElement;
    /** Look up one element by its filePath (throws if not found). */
    getElementByPath(sessionId: string, filePath: string): AigcElement;
    /** Snapshot of one session's full canvas state (elements + edges). */
    snapshot(sessionId: string): AigcCanvasState;
    /** Subscribe to canvas mutations for any session. Returns disposer. */
    subscribe(listener: AigcCanvasListener): () => void;
    /** Subscribe to canvas mutations for one specific session. */
    subscribeSession(sessionId: string, listener: AigcCanvasListener): () => void;
}
/** Resolve the per-session canvas directory under the session cwd. */
export declare function canvasDirFor(cwd: string, sessionId: string): string;
/** Resolve the per-session canvas JSON path. */
export declare function canvasJsonPath(cwd: string, sessionId: string): string;
/** Resolve the per-session file path for one element (by uuid + kind). */
export declare function elementFilePath(cwd: string, sessionId: string, uuid: string, kind: AigcElementKind): string;
/**
 * Build the service. The `resolveCwd` callback threads the live session cwd;
 * `mediaSizeLimit` bounds how large a placed file may be.
 */
export declare function createAigcCanvasService(resolveCwd: (sessionId: string) => string, mediaSizeLimit?: () => number): AigcCanvasService;
