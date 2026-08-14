/**
 * Wire helpers for the /aigc-canvas JSON API: bounded body reading, response
 * writing, and the shared error envelope. Every API method returns
 * `{ ok: true, value }` on success and `{ ok: false, error: { code, message } }`
 * (HTTP 4xx/5xx matching the code) on failure — mirrors better-sidebar's
 * `/sidebar/api/*` envelope so the client-side fetch helper is identical.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Machine-readable error codes of the canvas API. */
export type AigcErrorCode = 'bad-request' | 'not-found' | 'forbidden' | 'method-error' | 'fs-error' | 'backend-error' | 'internal';
/** One API failure with its wire code and HTTP status. */
export declare class AigcError extends Error {
    readonly code: AigcErrorCode;
    readonly status: number;
    constructor(code: AigcErrorCode, message: string, status?: number);
}
/** Success envelope of one API method. */
export interface AigcOk<T> {
    ok: true;
    value: T;
}
/** Failure envelope of one API method. */
export interface AigcErr {
    ok: false;
    error: {
        code: AigcErrorCode;
        message: string;
    };
}
/** Read and parse the JSON request body (bounded; malformed → bad-request). */
export declare function readJsonBody(req: IncomingMessage): Promise<unknown>;
/** Write a JSON response with the given status. */
export declare function writeJson(res: ServerResponse, status: number, body: unknown): void;
/** Write the success envelope. */
export declare function writeOk(res: ServerResponse, value: unknown): void;
/** Write the failure envelope for any thrown value (unknown → internal 500). */
export declare function writeError(res: ServerResponse, error: unknown): void;
/** Narrow an unknown payload value to a string, else throw bad-request. */
export declare function requireString(payload: unknown, key: string): string;
/** Narrow an unknown payload value to an array of strings (default [] when absent). */
export declare function optionalStringArray(payload: unknown, key: string): string[];
