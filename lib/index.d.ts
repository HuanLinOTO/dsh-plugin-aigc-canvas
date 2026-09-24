import type { Context } from './context-types.js';
import { Config, type AigcEntryConfig, type AigcProvider, type ResolvedAigcConfig, type ResolvedAigcProvider } from './config.js';
import { SETTINGS_NAMESPACE } from './settings.js';
export { Config, SETTINGS_NAMESPACE };
export type { AigcCanvasConfig } from './config.js';
export type { AigcEntryConfig, AigcProvider, ResolvedAigcConfig, ResolvedAigcProvider };
export type { Context } from './context-types.js';
export type { AigcCanvasService, AigcElement, AigcEdge, AigcCanvasState, AigcElementKind, } from './canvas-registry.js';
/** Plugin identity for cordis.yml rows. */
export declare const name = "dsh-aigc-canvas";
/** Services required before mounting. */
export declare const inject: string[];
/** Plugin body. */
export declare function apply(ctx: Context, config?: AigcEntryConfig): void;
