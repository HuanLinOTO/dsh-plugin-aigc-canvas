/**
 * entry-identity.ts — the identity triple that binds this plugin's three
 * naming surfaces together. Keeping them in one dependency-free module lets
 * a unit test pin them against `cordis.patch.yml` and `package.json`
 * (a mismatched `plugins.row.config` key fails silently: the row's configure
 * entry simply never appears).
 *
 *  - ENTRY_ID: the profile entry id — the `id` of the insert row in
 *    `cordis.patch.yml`. The Host serves the entry's volatile config under
 *    it, so it keys `ctx.configForms.get` and `settings.update`.
 *  - PACKAGE_NAME: the bundle's npm package name — the row's `name` field.
 *  - ROW_CONFIG_KEY: the Plugins page `plugins.row.config` slot key,
 *    `<package name>#<row id>` with the row id passed through verbatim.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/entry-identity
 */

/** Profile entry id (= the `cordis.patch.yml` insert row id / settings namespace). */
export const ENTRY_ID = 'dsh-aigc-canvas'

/** Bundle package name (the Loader resolves the row's module through it). */
export const PACKAGE_NAME = '@huanlin/dsh-plugin-aigc-canvas'

/** `plugins.row.config` key: the bundle's package name `#` the patch row id. */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}`
