/**
 * SettingsPage — the AIGC canvas settings section: provider list CRUD.
 *
 * Visual language: matches ModelsSection / GeneralSection / yet-another-subagent —
 * outlined rowCard per provider (border-l2, r12, p12/14), filled editor surface
 * (bg-module-platform, r12, p14/16), capsule controls (h36 r18 primary,
 * h28 r14 secondary), 32px fields with border-l2 / bg-layer-1, 12/18 caption
 * labels. Every color resolves through --dsw-alias-* tokens.
 *
 * Each provider card is collapsible (chevron in the row head); the editor
 * surface is hidden when collapsed. Builtin providers (cordis.yml seed) carry
 * a `builtin`/`内置` badge next to the title. The "+ Add provider" button at
 * the bottom reveals an inline draft card with all fields editable (including
 * id) and Create / Cancel actions.
 *
 * Real providers carry an "initialize" (初始化) action: it sends a prepared
 * message to the current conversation so the agent probes the API with
 * aigc_http_request and records the usage instructions via
 * aigc_provider_set_instructions. The editor also exposes the auth scheme
 * (bearer / custom header / query param) the aigc_http_request tool uses to
 * attach the apiKey.
 *
 * @module @dsh-external/dsh-aigc-canvas/client/SettingsPage
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  addProvider,
  fetchConfig,
  removeProvider,
  updateProvider,
  type RuntimeProvider,
} from './api.js'
import css from './SettingsPage.module.css'

/** Inject face: locale translate + conversation send (for the init action). */
export interface AigcSettingsInjected {
  readonly t: (key: string) => string
  /** Send a prompt into the current conversation scope (queued turn). */
  readonly send: (text: string) => Promise<void>
}

/** Full props: settings.section runtime share + locale seat + inject. */
type SettingsPageProps = PropsRuntime<'settings.section'> & PropsLocale<'dsh-aigc-canvas'> & AigcSettingsInjected

/** Default shape for a brand-new draft (before the user fills in id/name). */
function emptyDraft(): RuntimeProvider {
  return { id: '', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '', auth: { scheme: 'bearer', name: '' }, builtin: false }
}

/**
 * Render the AIGC provider settings page.
 * @param props - settings.section runtime share + locale + inject.
 * @returns the page element.
 */
export function SettingsPage({ t, send }: SettingsPageProps) {
  const [providers, setProviders] = useState<readonly RuntimeProvider[]>([])
  const [drafts, setDrafts] = useState<readonly RuntimeProvider[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [addingNew, setAddingNew] = useState(false)
  const [newDraft, setNewDraft] = useState<RuntimeProvider>(emptyDraft())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await fetchConfig()
      setProviders(result.providers)
      setDrafts(result.providers.map(p => ({ ...p, auth: { ...p.auth } })))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const add = useCallback(async () => {
    if (newDraft.id === '') return
    try {
      const result = await addProvider(newDraft)
      setProviders(result.providers)
      setDrafts(result.providers.map(p => ({ ...p, auth: { ...p.auth } })))
      setExpanded(new Set([...expanded, newDraft.id]))
      setAddingNew(false)
      setNewDraft(emptyDraft())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [expanded, newDraft])

  const update = useCallback(async (draft: RuntimeProvider) => {
    try {
      const result = await updateProvider(draft)
      setProviders(result.providers)
      setDrafts(result.providers.map(p => ({ ...p, auth: { ...p.auth } })))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const remove = useCallback(async (id: string) => {
    try {
      const result = await removeProvider(id)
      setProviders(result.providers)
      setDrafts(result.providers.map(p => ({ ...p, auth: { ...p.auth } })))
      const next = new Set(expanded)
      next.delete(id)
      setExpanded(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [expanded])

  const init = useCallback(async (provider: RuntimeProvider) => {
    const label = provider.name === '' ? provider.id : provider.name
    const text = t('row.initPrompt').replace('{name}', label).replace('{id}', provider.id)
    try {
      await send(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [send, t])

  const patchDraft = (id: string, patch: Partial<RuntimeProvider>): void => {
    setDrafts(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)))
  }

  const toggleExpand = (id: string): void => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  const cancelNew = (): void => {
    setAddingNew(false)
    setNewDraft(emptyDraft())
  }

  const defaultId = providers.length > 0 ? providers[0]?.id : undefined

  return (
    <section className={css.section}>
      <h2 className={css.title}>{t('settingsTitle')}</h2>
      <p className={css.intro}>{t('settingsIntro')}</p>
      {error !== undefined && (
        <div className={css.error}>
          {error}
          <button type="button" className={css.errorDismiss} onClick={() => setError(undefined)}>×</button>
        </div>
      )}
      {loading ? (
        <div className={css.loading}>{t('settingsLoading')}</div>
      ) : providers.length === 0 && !addingNew ? (
        <p className={css.empty}>{t('settingsEmpty')}</p>
      ) : (
        <ul className={css.rows}>
          {drafts.map(draft => (
            <ProviderCard
              key={draft.id}
              draft={draft}
              expanded={expanded.has(draft.id)}
              isDefault={draft.id === defaultId}
              t={t}
              onToggle={() => toggleExpand(draft.id)}
              onPatch={patch => patchDraft(draft.id, patch)}
              onSave={() => void update(draft)}
              onDelete={() => setConfirmDelete(draft.id)}
              onInit={() => void init(draft)}
            />
          ))}
          {addingNew && (
            <ProviderCard
              key="__new__"
              draft={newDraft}
              expanded={true}
              isNew={true}
              isDefault={false}
              t={t}
              onPatch={patch => setNewDraft(prev => ({ ...prev, ...patch }))}
              onCreate={() => void add()}
              onCancel={cancelNew}
            />
          )}
        </ul>
      )}
      {!loading && !addingNew && (
        <button type="button" className={css.addBlockButton} onClick={() => setAddingNew(true)}>
          {t('settingsAdd')}
        </button>
      )}
      <Modal
        open={confirmDelete !== undefined}
        onClose={() => { setConfirmDelete(undefined) }}
        title={t('row.deleteConfirm')}
        footer={(
          <>
            <button type="button" className={css.secondaryButton} onClick={() => { setConfirmDelete(undefined) }}>
              {t('row.cancel')}
            </button>
            <button
              type="button"
              className={css.dangerButton}
              onClick={() => {
                if (confirmDelete !== undefined) void remove(confirmDelete)
                setConfirmDelete(undefined)
              }}
            >
              {t('row.delete')}
            </button>
          </>
        )}
      >
        <p className={css.confirmText}>{t('row.deleteConfirm')}</p>
      </Modal>
    </section>
  )
}

// ─── ProviderCard ─────────────────────────────────────────────────────────────

interface ProviderCardProps {
  readonly draft: RuntimeProvider
  readonly expanded: boolean
  readonly isNew?: boolean
  readonly isDefault: boolean
  readonly t: (key: string) => string
  readonly onToggle?: () => void
  readonly onPatch: (patch: Partial<RuntimeProvider>) => void
  readonly onSave?: () => void
  readonly onDelete?: () => void
  readonly onCreate?: () => void
  readonly onCancel?: () => void
  readonly onInit?: () => void
}

function ProviderCard({ draft, expanded, isNew, isDefault, t, onToggle, onPatch, onSave, onDelete, onCreate, onCancel, onInit }: ProviderCardProps) {
  const isStub = draft.endpoint === '' || draft.endpoint === 'stub://aigc-backend'
  const patchAuth = (patch: Partial<{ scheme: 'bearer' | 'header' | 'query'; name: string }>): void => {
    onPatch({ auth: { ...draft.auth, ...patch } })
  }
  return (
    <li className={css.rowCard}>
      <div className={css.rowHead}>
        {!isNew && onToggle !== undefined && (
          <button type="button" className={css.chevronButton} onClick={onToggle} aria-label={expanded ? t('row.collapse') : t('row.expand')}>
            <span className={expanded ? `${css.chevron} ${css.chevronExpanded}` : css.chevron} aria-hidden="true" />
          </button>
        )}
        {isNew && <span className={css.chevronSpacer} aria-hidden="true" />}
        <div className={css.rowIdentity}>
          {isNew ? (
            <span className={css.rowNamePlaceholder}>{t('settingsAdd')}</span>
          ) : (
            <span className={css.rowName}>{draft.name === '' ? draft.id : draft.name}</span>
          )}
          {draft.builtin && <Pill className={css.builtinBadge}>{t('badge.builtin')}</Pill>}
          {isDefault && !isNew && <Pill className={css.defaultBadge}>{t('badge.default')}</Pill>}
          <Pill className={isStub ? css.stubBadge : css.realBadge}>
            {isStub ? t('badge.stub') : t('badge.real')}
          </Pill>
          {!isNew && <code className={css.rowId}>{draft.id}</code>}
        </div>
        <div className={css.rowActions}>
          {isNew ? (
            <>
              <button type="button" className={css.primaryButton} onClick={onCreate} disabled={draft.id === ''}>
                {t('row.create')}
              </button>
              <button type="button" className={css.secondaryButton} onClick={onCancel}>
                {t('row.cancel')}
              </button>
            </>
          ) : (
            <>
              {!isStub && onInit !== undefined && (
                <button type="button" className={css.secondaryButton} onClick={onInit}>
                  {t('row.init')}
                </button>
              )}
              <button type="button" className={css.secondaryButton} onClick={onSave}>
                {t('row.save')}
              </button>
              <button type="button" className={css.dangerButton} onClick={onDelete}>
                {t('row.delete')}
              </button>
            </>
          )}
        </div>
      </div>
      {expanded && (
        <div className={css.editor}>
          {isNew && (
            <>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('row.id')}</span>
                <input
                  className={css.input}
                  value={draft.id}
                  placeholder={t('row.idPlaceholder')}
                  onChange={e => onPatch({ id: e.target.value })}
                />
                <span className={css.hint}>{t('row.idHint')}</span>
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('row.name')}</span>
                <input
                  className={css.input}
                  value={draft.name}
                  placeholder={t('row.namePlaceholder')}
                  onChange={e => onPatch({ name: e.target.value })}
                />
              </label>
            </>
          )}
          {!isNew && (
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('row.name')}</span>
              <input
                className={css.input}
                value={draft.name}
                placeholder={t('row.namePlaceholder')}
                onChange={e => onPatch({ name: e.target.value })}
              />
            </label>
          )}
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('row.endpoint')}</span>
            <input
              className={css.input}
              value={draft.endpoint}
              placeholder={t('row.endpointPlaceholder')}
              onChange={e => onPatch({ endpoint: e.target.value })}
            />
            <span className={css.desc}>{t('row.endpointDesc')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('row.apiKey')}</span>
            <input
              className={css.input}
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              placeholder={t('row.apiKeyPlaceholder')}
              onChange={e => onPatch({ apiKey: e.target.value })}
            />
            <span className={css.desc}>{t('row.apiKeyDesc')}</span>
          </label>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('row.auth')}</span>
            <div className={css.authRow}>
              <select
                className={css.select}
                value={draft.auth.scheme}
                onChange={e => patchAuth({ scheme: e.target.value as 'bearer' | 'header' | 'query' })}
              >
                <option value="bearer">{t('row.authBearer')}</option>
                <option value="header">{t('row.authHeader')}</option>
                <option value="query">{t('row.authQuery')}</option>
              </select>
              {draft.auth.scheme !== 'bearer' && (
                <input
                  className={css.input}
                  value={draft.auth.name}
                  placeholder={draft.auth.scheme === 'header' ? 'x-api-key' : 'api_key'}
                  onChange={e => patchAuth({ name: e.target.value })}
                />
              )}
            </div>
            <span className={css.desc}>{t('row.authDesc')}</span>
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('row.instructions')}</span>
            <textarea
              className={css.textarea}
              value={draft.instructions}
              placeholder={t('row.instructionsPlaceholder')}
              rows={8}
              onChange={e => onPatch({ instructions: e.target.value })}
            />
            <span className={css.desc}>{t('row.instructionsDesc')}</span>
            <span className={css.hint}>{t('row.instructionsHint')}</span>
          </label>
        </div>
      )}
    </li>
  )
}
