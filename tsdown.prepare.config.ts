/**
 * Consumer-side build (git install / `prepare` script): self-contained,
 * no sibling-checkout typecheck, no dts. The host half builds from src
 * directly; the client half is identical to the dev build (the same
 * module-table externals + css-modules inline plugin).
 */
import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))
const CLIENT_ID = '@huanlin/dsh-plugin-aigc-canvas'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-primitives/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-slots/client',
]

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

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

function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

const hostConfig: UserConfig = {
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
}

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

export default defineConfig([hostConfig, clientConfig])
