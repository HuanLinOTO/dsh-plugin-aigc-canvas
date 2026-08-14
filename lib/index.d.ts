import type { Context } from './context-types.js';
import { Config, type AigcCanvasConfig, type AigcProvider, type ResolvedAigcConfig, type ResolvedAigcProvider } from './config.js';
export { Config };
export type { AigcCanvasConfig, AigcProvider, ResolvedAigcConfig, ResolvedAigcProvider };
export type { Context } from './context-types.js';
export type { AigcCanvasService, AigcElement, AigcEdge, AigcCanvasState, AigcElementKind, } from './canvas-registry.js';
/** Plugin identity for cordis.yml rows. */
export declare const name = "dsh-aigc-canvas";
/** Services required before mounting. */
export declare const inject: string[];
/** Plugin body. */
export declare function apply(ctx: Context, config?: AigcCanvasConfig): void;
