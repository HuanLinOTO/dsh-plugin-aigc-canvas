/**
 * SettingsPage — the AIGC canvas row-configuration page: provider list CRUD.
 *
 * Mounts as the bundle row's `plugins.row.config` entry on the Plugins page
 * (dsh 0.1.7-rc.1): `view: 'summary'` renders the one-line description the
 * row page falls back to when the row declares none; `view: 'page'` renders
 * the editor under the page's own title/breadcrumb. The optional owner
 * `form` is the page-assembled ConfigPageForm; this editor keeps its own
 * reactive binding (below), and an undefined `form` means the entry's config
 * is not served (row freshly disabled) — the editor reports that instead.
 *
 * Transport (dsh 0.1.7-rc.1 DSH-0.1.7-J1-27): reads/writes ride the entry's
 * shared config form (`ctx.configForms.get('dsh-aigc-canvas')`, provided by
 * the ui-settings base and bound reactively into this component as the
 * `useAigcSettings` hook through the registration's `hooks` compartment).
 * Saves are whole-list writes through `form.set('providers', …)`; the host
 * persists them into the active profile's `cordis.patch.yml` under the
 * entry id.
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
 * @module @huanlin/dsh-plugin-aigc-canvas/client/SettingsPage
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the 'plugins.row.config' SlotMap row (the Plugins page
// owner props: view + optional page-assembled form).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { type AigcFormSnapshot, type RuntimeProvider } from './api.js'
import { validateProviderId } from '../provider-shape.js'
import css from './SettingsPage.module.css'

/** Reactive source shape the renderer binds as the useAigcSettings hook. */
export interface AigcSettingsSource {
  getSnapshot(): AigcFormSnapshot
  subscribe(listener: () => void): () => void
}

/** Inject face: locale translate + conversation send + the settings form. */
export interface AigcSettingsInjected {
  readonly t: (key: string) => string
  /** Send a prompt into the current conversation scope (queued turn). */
  readonly send: (text: string) => Promise<void>
  /** Reactive snapshot of the entry's config form (bound as useAigcSettings). */
  readonly hooks: { aigcSettings: AigcSettingsSource }
  /**
   * Commit a replacement provider list through the entry's config form;
   * resolves to whether the host accepted the write.
   */
  readonly saveProviders: (providers: readonly RuntimeProvider[]) => Promise<boolean>
}

/**
 * Full props: plugins.row.config runtime share (view + optional page-assembled
 * form) + locale seat + the inject face (the hooks compartment arrives bound
 * as the useAigcSettings selector hook).
 */
type SettingsPageProps = PropsRuntime<'plugins.row.config'>
  & PropsLocale<'dsh-aigc-canvas'>
  & InjectFace<AigcSettingsInjected>

/** Default shape for a brand-new draft (before the user fills in id/name). */
function emptyDraft(): RuntimeProvider {
  return { id: '', name: '', endpoint: 'stub://aigc-backend', apiKey: '', instructions: '', auth: { scheme: 'bearer', name: '' }, builtin: false }
}

/** Clone the committed list into editable drafts (auth object detached). */
function toDrafts(providers: readonly RuntimeProvider[]): RuntimeProvider[] {
  return providers.map(p => ({ ...p, auth: { ...p.auth } }))
}

/**
 * Render the AIGC provider configuration entry.
 *
 * `view: 'summary'` returns the one-line description; `view: 'page'` renders
 * the CRUD editor (with its own hook set, in {@link ProviderEditor} below).
 * Branching before any hook keeps both arms hook-stable.
 *
 * @param props - plugins.row.config runtime share + locale + inject + form hook.
 * @returns the summary one-liner or the page element.
 */
export function SettingsPage(props: SettingsPageProps) {
  // The row page draws its own title and description; `summary` only supplies
  // the fallback one-liner when the row declares no description metadata.
  if (props.view === 'summary') return <span>{props.t('rowSummary')}</span>
  return <ProviderEditor {...props} />
}

/**
 * Render the provider CRUD editor (the `view: 'page'` arm).
 *
 * Reads the committed provider list through the entry's config form
 * (dsh 0.1.7-rc.1 DSH-0.1.7-J1-27: `ctx.configForms.get('dsh-aigc-canvas')`,
 * bound reactively as `useAigcSettings`) and writes whole-list replacements
 * through `saveProviders`. Local drafts re-seed from the committed list on
 * every revision bump — own saves land there, and so do external writers
 * (e.g. the model's aigc_provider_set_instructions tool).
 *
 * @param props - plugins.row.config runtime share + locale + inject + form hook.
 * @returns the editor element.
 */
function ProviderEditor({ form, t, send, useAigcSettings, saveProviders }: SettingsPageProps) {
  const snapshot = useAigcSettings(s => s)

  const providers = snapshot.status === 'ready' && snapshot.value !== undefined ? snapshot.value.providers : []
  const [drafts, setDrafts] = useState<readonly RuntimeProvider[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [addingNew, setAddingNew] = useState(false)
  const [newDraft, setNewDraft] = useState<RuntimeProvider>(emptyDraft())
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)

  // Seed local drafts from the committed list: on first readiness and after
  // every committed revision bump. A bump means OUR entry's document moved —
  // an own save, another tab, or the model's instruction write — so the
  // drafts always follow the latest committed state (same behaviour as the
  // previous RPC page, which re-seeded from every mutation result).
  const { status, revision, value } = snapshot
  useEffect(() => {
    if (status !== 'ready' || value === undefined) return
    setDrafts(toDrafts(value.providers))
    // `revision` gates the re-seed; the value is read synchronously inside.
  }, [status, revision])

  const commit = useCallback(async (next: readonly RuntimeProvider[]): Promise<boolean> => {
    setError(undefined)
    try {
      const accepted = await saveProviders(next)
      if (!accepted) {
        setError(t('settingsSaveFailed'))
        return false
      }
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [saveProviders, t])

  const add = useCallback(async () => {
    if (newDraft.id === '') return
    const idError = validateProviderId(newDraft.id)
    if (idError !== undefined) {
      setError(idError)
      return
    }
    if (providers.some(p => p.id === newDraft.id)) {
      setError(`provider id already exists: ${newDraft.id}`)
      return
    }
    // Mutations added at runtime are never builtin (mirrors the host store).
    const stored = { ...newDraft, builtin: false }
    const ok = await commit([...providers, stored])
    if (ok) {
      setExpanded(new Set([...expanded, newDraft.id]))
      setAddingNew(false)
      setNewDraft(emptyDraft())
    }
  }, [commit, expanded, newDraft, providers])

  const update = useCallback(async (draft: RuntimeProvider) => {
    // Build the next list from the COMMITTED value with only this card's
    // draft applied — sibling cards keep their edits private until saved.
    await commit(providers.map(p => (p.id === draft.id ? draft : p)))
  }, [commit, providers])

  const remove = useCallback(async (id: string) => {
    const ok = await commit(providers.filter(p => p.id !== id))
    if (ok) {
      const next = new Set(expanded)
      next.delete(id)
      setExpanded(next)
    }
  }, [commit, expanded, providers])

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

  // The page assembles the owner `form` from the served configurations; an
  // undefined form means the entry's config left the served set (row freshly
  // disabled) and the editor has nothing to bind — report instead of editing.
  if (form === undefined) {
    return (
      <section className={css.section}>
        <p className={css.empty}>{t('settingsUnavailable')}</p>
      </section>
    )
  }

  return (
    <section className={css.section}>
      <p className={css.intro}>{t('settingsIntro')}</p>
      {error !== undefined && (
        <div className={css.error}>
          {error}
          <button type="button" className={css.errorDismiss} onClick={() => setError(undefined)}>×</button>
        </div>
      )}
      {status === 'ready' && !snapshot.writable && (
        <p className={css.intro}>{t('settingsReadOnly')}</p>
      )}
      {status === 'loading' ? (
        <div className={css.loading}>{t('settingsLoading')}</div>
      ) : status === 'unavailable' ? (
        <p className={css.empty}>{t('settingsUnavailable')}</p>
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
      {status === 'ready' && !addingNew && (
        <button type="button" className={css.addBlockButton} onClick={() => setAddingNew(true)}>
          {t('settingsAdd')}
        </button>
      )}
      <Modal
        open={confirmDelete !== undefined}
        onClose={() => { setConfirmDelete(undefined) }}
        title={t('row.deleteConfirm')}
        closeLabel={t('row.close')}
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
