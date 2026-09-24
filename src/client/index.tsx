/**
 * Client half of @huanlin/dsh-plugin-aigc-canvas: registers
 *  (1) a better-sidebar tab (`aigc-canvas:main`) rendering the canvas view, and
 *  (2) a `plugins.row.config` entry — the provider configuration page opened
 *      from this bundle's row on the Plugins page (dsh 0.1.7-rc.1: the
 *      shared-settings tab was retired in favor of it).
 *
 * i18n: registers the `dsh-aigc-canvas` locale namespace (zh + en) and binds
 * a translate function passed to both the canvas view and the config page
 * via inject — so the UI respects the DSH locale toggle (no hardcoded text).
 *
 * The config page's "initialize" action sends a prepared prompt into the
 * current conversation via the `conversation` service (ui-conversation).
 *
 * Settings transport (dsh 0.1.7-rc.1 DSH-0.1.7-J1-27): the page binds the
 * entry's shared `ConfigForm` through `ctx.configForms.get('dsh-aigc-canvas')`
 * — reads ride the settings describe mirror, writes go through
 * `settings.mutate` — and is passed to the page reactively through the
 * registration's `hooks` compartment. The registration itself is gated on
 * `configForms.whileServed`, so disabling the row withdraws the configure
 * entry from the Plugins page.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's ConfigForms service merge
// (ctx.configForms) — the read/write channel this page binds.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the Plugins page's SlotMap merge (the 'plugins.row.config'
// keyed entry — this half's registration target).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the conversation service merge (ctx.conversation.send).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ui-slots LocaleNamespaceMap + ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from 'dsh-better-sidebar/client'
import { createElement, useEffect, useRef, type ReactNode } from 'react'
import { CanvasStore } from './store.js'
import { CanvasViewWithBoundary } from './CanvasView.js'
import { SettingsPage, type AigcSettingsInjected } from './SettingsPage.js'
import { type AigcFormValue } from './api.js'
import { en, zh, NS, type AigcKey } from './locales.js'
import { dicts } from './dictionaries.js'
import { ENTRY_ID, ROW_CONFIG_KEY } from '../entry-identity.js'

/** Locale namespace map declaration for the DSH locale system. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-aigc-canvas': AigcKey
  }
}

/** Services required before mounting. `betterSidebar` is intentionally NOT
 *  listed here — this plugin extends `dsh-better-sidebar` when present, but
 *  must remain loadable without it (defensive lookup via `ctx.get(...)`).
 *  `configForms` is provided by the ui-settings base plugin. */
export const inject = ['slots', 'locale', 'conversation', 'configForms']

export function apply(ctx: ClientContext): void {
  // ── Locale registration ────────────────────────────────────────────────
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-aigc-canvas: dictionaries')
  // better-locale override dicts (optional — only when dsh-plugin-better-locale
  // is loaded): register the 19-language dictionary while the DSH active locale
  // is 'en'. Structurally typed; no runtime dep on the plugin.
  // Activation-order-safe: re-check ctx.get('betterLocale') on every locale
  // revision bump (better-locale bumps on activation + override switch).
  type BetterLocaleRegistry = {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  }
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    const sync = (): void => {
      dispose?.()
      dispose = undefined
      const store = ctx.get('betterLocale') as BetterLocaleRegistry | undefined
      if (store !== undefined) {
        dispose = store.register(NS, dicts)
      }
    }
    sync()
    const unsubscribe = ctx.locale.subscribe(sync)
    return () => {
      unsubscribe()
      dispose?.()
    }
  }, 'dsh-aigc-canvas: better-locale override dicts')
  const t = ctx.locale.bind(NS) as (key: string) => string

  // ── better-sidebar tab (optional — only when dsh-better-sidebar is loaded) ──
  type BetterSidebarService = { registerTab(descriptor: unknown): () => void }
  const betterSidebar = ctx.get('betterSidebar') as BetterSidebarService | undefined
  if (betterSidebar !== undefined) {
    ctx.effect(() =>
      betterSidebar.registerTab({
        id: 'aigc-canvas:main',
        title: () => t('tabTitle'),
        order: 50,
        dedupeKey: () => 'aigc-canvas:main',
        component: ({ scope }: { scope: { sessionId: string } }): ReactNode => {
          const storeRef = useRef<CanvasStore | null>(null)
          if (storeRef.current === null || storeRef.current.sessionId !== scope.sessionId) {
            storeRef.current?.dispose()
            storeRef.current = new CanvasStore({ sessionId: scope.sessionId })
          }
          useEffect(() => {
            return () => {
              storeRef.current?.dispose()
              storeRef.current = null
            }
          }, [])
          return createElement(CanvasViewWithBoundary, { store: storeRef.current, t })
        },
      }),
    )
  }

  // ── Plugins page row configuration ─────────────────────────────────────
  // The provider list lives in the entry's profile-owned Config; the shared
  // config form (ui-settings base service) is the read/write channel. The
  // contribution is keyed `<package>#<row id>` (the row id is the patch
  // insert line's `id`, passed through verbatim) and gated on the Host
  // serving the entry's config — a disabled row withdraws the configure
  // control from the Plugins page.
  const form = ctx.configForms.get<AigcFormValue>(ENTRY_ID)
  const settingsInjected = (): AigcSettingsInjected => ({
    t,
    send: (text) => ctx.conversation.send(text),
    hooks: { aigcSettings: form },
    saveProviders: (providers) => form.set('providers', providers.map(p => ({ ...p, auth: { ...p.auth } }))),
  })
  ctx.effect(
    () => ctx.configForms.whileServed([ENTRY_ID], () =>
      ctx.slots.inject('plugins.row.config', function* () {
        yield ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_CONFIG_KEY,
          locale: NS,
          inject: settingsInjected,
        }, SettingsPage)
      }),
    ),
    'dsh-aigc-canvas: plugin row config page',
  )
}
