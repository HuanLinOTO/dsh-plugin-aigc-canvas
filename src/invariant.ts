/**
 * Package-owned invariant companion for `@huanlin/dsh-plugin-aigc-canvas`.
 * @module @huanlin/dsh-plugin-aigc-canvas/invariant
 */

/* jscpd:ignore-start */
import type { Context } from './context-types.js'

const PACKAGE_NAME = '@huanlin/dsh-plugin-aigc-canvas'

/** Cordis companion plugin name. */
export const name = 'dsh-aigc-canvas-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the canvas owns no service state or event protocol
 * of its own beyond the registry's own assertions (uuid existence, kind
 * checks) — every route is mounted under the host's webServer fence, the
 * element table is exercised by the smoke spec, and the client view is a
 * pure projection of the host state.
 */
const install: () => void = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
