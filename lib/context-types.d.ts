/**
 * Structural types for the cordis services this plugin consumes, plus the
 * Context augmentation both halves share. A third-party plugin resolves
 * outside the DSH monorepo's single cordis instance, so the upstream
 * `declare module 'cordis'` augmentations do not reach this Context — and
 * the npm cordis package does not declare the DSH-vendored runtime members
 * (`ctx.effect`, the webServer/sessions/loader faces). The members below
 * mirror the actual runtime shapes this plugin touches:
 *
 * - webServer: @deepseek-ai/dsh-host-webserver
 * - sessions:   @deepseek-ai/dsh-session (host side)
 * - loader:     @cordisjs/plugin-loader (entry options)
 * - invariants: @deepseek-ai/dsh-invariants
 * - effect:     the DSH-vendored cordis lifecycle helper
 *
 * Drift from upstream is contained to this file.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Context } from 'cordis';
import type { AigcCanvasService } from './canvas-registry.js';
/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface AigcWebRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** One exact-path HTTP upgrade registration (mirror of WebUpgradeRoute). */
export interface AigcWebUpgradeRoute {
    path: string;
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
/** The webServer service face this plugin uses. */
export interface AigcWebServer {
    register(route: AigcWebRoute): () => void;
    registerUpgrade(route: AigcWebUpgradeRoute): () => void;
}
/** A published session's header slice (authoritative cwd). */
export interface AigcSessionHeader {
    cwd?: string;
}
/** The host session store face (`ctx.sessions.get(id)` returns the live session). */
export interface AigcSessionStore {
    get(id: string): {
        header: AigcSessionHeader;
    } | undefined;
}
/**
 * The minimal Agent face this plugin uses for context injection.
 * Mirrors `@deepseek-ai/dsh-agent`'s `Agent.inject()` — see the DSH
 * agent loop's inbox/splice path. The plugin calls `inject()` to push
 * a notice into the agent's next-step context (non-waking).
 */
export interface AigcAgent {
    readonly id: string;
    inject(message: AigcUserMessage): void;
}
/** A minimal user-role message for agent.inject (mirrors dsh-llm's UserMessage). */
export interface AigcUserMessage {
    readonly id: string;
    readonly role: 'user';
    readonly content: ReadonlyArray<{
        type: 'text';
        text: string;
    }>;
    readonly source: {
        readonly kind: 'plugin';
        readonly plugin: string;
        readonly form?: 'notice';
        readonly summary?: string;
    };
}
/** The agents registry face (`ctx.agents.get(sessionId)` returns the live agent). */
export interface AigcAgentRegistry {
    get(id: string): AigcAgent | undefined;
}
/** One loader entry's options slice (the connection row's resolved config). */
export interface AigcLoaderEntry {
    options: {
        name: string;
        config?: unknown;
    };
}
/** The loader face used to read the connection row's trustedHosts config. */
export interface AigcLoader {
    entries(): Iterable<AigcLoaderEntry>;
}
/** The invariants service face (mirror of @deepseek-ai/dsh-invariants). */
export interface AigcInvariantsService {
    register(packageName: string, installer: (ctx: Context, fail: (message: string) => never) => void | Promise<void>): () => void;
}
/**
 * The invariant service face restated (mirror of @deepseek-ai/dsh-invariants).
 * Mirrored here exactly like better-sidebar does — the dual-cordis-instance
 * resolution otherwise hides the upstream augmentation. The `tools` service
 * face is declared in `./types.d.ts` (the ambient cordis module augmentation)
 * and not restated here to avoid a "subsequent property declarations must
 * have the same type" error.
 */
export interface AigcToolsService {
    register(tool: unknown): () => void;
}
declare module 'cordis' {
    interface Context {
        webServer: AigcWebServer;
        sessions: AigcSessionStore;
        agents: AigcAgentRegistry;
        loader: AigcLoader;
        invariants: AigcInvariantsService;
        /**
         * The host-side AIGC canvas registry: holds the per-session element
         * table (prompts + generated assets) and edges. Provided by the host
         * half (see {@link ./canvas-registry.ts}); undefined on the client.
         */
        aigcCanvas: AigcCanvasService;
        /** Register a lifecycle callback (DSH-vendored cordis). */
        effect(fn: () => void | (() => void), label?: string): void;
    }
}
export type { Context };
