/**
 * tsdown build for @dsh-external/dsh-aigc-canvas: the host-half lib
 * (lib/index.js + lib/invariant.js, ESM node) plus one browser client
 * bundle (lib/client.js, CJS closure factory).
 *
 * The client bundle replicates the official DSH client-bundle preset
 * (mirror of dsh-better-sidebar's tsdown.config.ts and dsh-mineru's
 * css-modules.ts): externals resolve through the loader module table at
 * runtime (react + cordis + ui-primitives), everything else inlines.
 * Each artifact registers itself via window.__ModuleLoader__.load({id,
 * factory}) with the (require) => exports CJS closure shape.
 *
 * Types ship from tsc -p tsconfig.json (declaration: true), not from tsdown.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Bundle id (= package name; the client-modules compose keys on it). */
const CLIENT_ID = '@dsh-external/dsh-aigc-canvas'

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-primitives/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-slots/client',
]

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** The style-injection prologue shared by module css and plain css loads. */
function injectTag(pluginId: string, fileId: string, cssText: string): string {
  const tagId = `${pluginId}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/** Simple CSS Modules transform (mirror of dsh-mineru's css-modules.ts). */
function transformCssModules(filename: string, source: Buffer): { classMap: Record<string, string>; cssText: string } {
  const hash = Array.from(filename).reduce((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0).toString(36).replace('-', '')
  const cssText = source.toString('utf8')
  const classMap: Record<string, string> = {}
  const classPattern = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g
  let match: RegExpExecArray | null
  while ((match = classPattern.exec(cssText)) !== null) {
    const local = match[1]
    if (local !== undefined && classMap[local] === undefined) {
      classMap[local] = `${hash}_${local}`
    }
  }
  const transformedCss = cssText.replace(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g, (full, name: string) => {
    if (classMap[name] !== undefined) return `.${classMap[name]}`
    return full
  })
  return { classMap, cssText: transformedCss }
}

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/** The host-half build (lib/index.js + lib/invariant.js, ESM node).
 * Type declarations ship from a separate `tsc -p tsconfig.build.json` pass
 * (mirrors dsh-better-sidebar's build flow) so the dts chunking does not
 * produce hash-named cross-file imports that consumers cannot resolve.
 */
const hostConfig: UserConfig = {
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
}

/** The client bundle build (lib/client.js, CJS closure factory). */
const clientConfig: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [
    {
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
          throw new Error(
            `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — `
            + 'cross-plugin value imports are forbidden; collaborate through cordis services',
          )
        }
        return null
      },
    },
    {
      name: 'dsh-css-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css') && !source.endsWith('.css')) return null
        const abs = importer === undefined
          ? source
          : source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)
            ? resolvePath(dirname(importer), source)
            : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        if (fileId.endsWith('.module.css')) {
          const { classMap, cssText } = transformCssModules(fileId, source)
          return [
            injectTag(CLIENT_ID, fileId, cssText),
            `export default ${JSON.stringify(classMap)};`,
          ].join('\n')
        }
        return [
          injectTag(CLIENT_ID, fileId, source.toString('utf8')),
          'export default "";',
        ].join('\n')
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapPathTransform: browserSourcePath,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
    footer: `return module.exports; } });`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [hostConfig, clientConfig] satisfies UserConfig[]
