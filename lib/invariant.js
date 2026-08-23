//#region src/invariant.ts
const PACKAGE_NAME = "@huanlin/dsh-plugin-aigc-canvas";
/** Cordis companion plugin name. */
const name = "dsh-aigc-canvas-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the canvas owns no service state or event protocol
* of its own beyond the registry's own assertions (uuid existence, kind
* checks) — every route is mounted under the host's webServer fence, the
* element table is exercised by the smoke spec, and the client view is a
* pure projection of the host state.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
