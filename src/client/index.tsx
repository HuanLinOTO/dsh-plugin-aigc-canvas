/**
 * Client half of @huanlin/dsh-plugin-aigc-canvas: registers
 *  (1) a better-sidebar tab (`aigc-canvas:main`) rendering the canvas view, and
 *  (2) a settings.section slot for the provider config page.
 *
 * i18n: registers the `dsh-aigc-canvas` locale namespace (zh + en) and binds
 * a translate function passed to both the canvas view and the settings page
 * via inject — so the UI respects the DSH locale toggle (no hardcoded text).
 *
 * The settings page's "initialize" action sends a prepared prompt into the
 * current conversation via the `conversation` service (ui-conversation).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (settings.section).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the conversation service merge (ctx.conversation.send).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-slots LocaleNamespaceMap + ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from 'dsh-better-sidebar/client'
import { createElement, useEffect, useRef, type ReactNode } from 'react'
import { CanvasStore } from './store.js'
import { CanvasViewWithBoundary } from './CanvasView.js'
import { SettingsPage, type AigcSettingsInjected } from './SettingsPage.js'
import { en, zh, NS, type AigcKey } from './locales.js'

/** Locale namespace map declaration for the DSH locale system. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-aigc-canvas': AigcKey
  }
}

/** Services required before mounting. */
export const inject = ['betterSidebar', 'slots', 'locale', 'conversation']

export function apply(ctx: ClientContext): void {
  // ── Locale registration ────────────────────────────────────────────────
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-aigc-canvas: dictionaries')
  const t = ctx.locale.bind(NS) as (key: string) => string

  // ── better-sidebar tab ──────────────────────────────────────────────────
  const betterSidebar = (ctx as unknown as {
    betterSidebar?: { registerTab(descriptor: unknown): () => void }
  }).betterSidebar
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

  // ── Settings section ────────────────────────────────────────────────────
  const settingsInjected = (): AigcSettingsInjected => ({
    t,
    send: (text) => ctx.conversation.send(text),
  })
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'aigc-canvas',
      order: 60,
      label: () => t('settingsNav'),
      locale: NS,
      inject: settingsInjected,
    }, SettingsPage),
  )
}
