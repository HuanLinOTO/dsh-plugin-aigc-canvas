/** The operations the tool supports. */
export type MediaEditOperation = 'concat' | 'clip' | 'extract_audio' | 'extract_frame' | 'speed' | 'resize' | 'reverse' | 'add_audio' | 'images_to_video';
/** All operations as a readonly array (for schema enum + validation). */
export declare const MEDIA_EDIT_OPERATIONS: readonly MediaEditOperation[];
/** One operation request (already validated by the tool layer). */
export interface MediaEditRequest {
    operation: MediaEditOperation;
    inputs: string[];
    outputExt: string;
    start?: number;
    end?: number;
    duration?: number;
    speed?: number;
    width?: number;
    height?: number;
    fps?: number;
    timestamp?: number;
}
/** Result of a successful media edit. */
export interface MediaEditResult {
    outputPath: string;
    operation: MediaEditOperation;
    durationMs: number;
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
export declare function executeMediaEdit(request: MediaEditRequest, cwd: string, sessionId: string, opts: {
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<MediaEditResult>;
