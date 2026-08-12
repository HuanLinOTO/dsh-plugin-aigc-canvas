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
  RUNTIME_CAPABILITIES,
  RUNTIME_HTTP_METHODS,
  RUNTIME_PARAM_TYPES,
  RUNTIME_QUALITY_HINTS,
  RUNTIME_RESPONSE_KINDS,
  type RuntimeCapability,
  type RuntimeEndpointSpec,
  type RuntimeHttpMethod,
  type RuntimeParamSpec,
  type RuntimeProvider,
  type RuntimeQualityHint,
  type RuntimeResponseKind,
} from './api.js'
import css from './SettingsPage.module.css'

/** Inject face: locale translate + conversation send (for the init + auto-detect actions). */
export interface AigcSettingsInjected {
  readonly t: (key: string) => string
  /** Send a prompt into the current conversation scope (queued turn). */
  readonly send: (text: string) => Promise<void>
}

/** Full props: settings.section runtime share + locale seat + inject. */
type SettingsPageProps = PropsRuntime<'settings.section'> & PropsLocale<'dsh-aigc-canvas'> & AigcSettingsInjected

/**
 * Default shape for a brand-new draft (before the user fills in id/name).
 * The structured-catalog fields default to sane values so the endpoints
 * editor starts empty (the agent's "Initialize" / "Auto-detect" buttons
 * populate it after probing the API).
 */
function emptyDraft(): RuntimeProvider {
  return {
    id: '',
    name: '',
    endpoint: 'stub://aigc-backend',
    apiKey: '',
    instructions: '',
    auth: { scheme: 'bearer', name: '' },
    builtin: false,
    endpoints: [],
    priority: 100,
    costPerCall: 0,
    costPerKiloToken: 0,
    costPerSecond: 0,
    avgLatencyMs: 0,
    qualityHint: 'balanced',
  }
}

/** Build a fresh blank endpoint (for the "+ Add endpoint" button). */
function emptyEndpoint(): RuntimeEndpointSpec {
  return {
    path: '',
    method: 'POST',
    capability: 't2i',
    params: [],
    response: { kind: 'json_text', path: '' },
    acceptsCanvasRef: false,
    notes: '',
  }
}

/** Build a fresh blank parameter (for the "+ Add parameter" button). */
function emptyParam(): RuntimeParamSpec {
  return { name: '', type: 'string', required: false, default: '', description: '' }
}

/** Coerce a possibly-undefined value to a number (default 0 when invalid). */
function toNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n) && v.trim() !== '') return n
  }
  return fallback
}

/** Coerce a possibly-undefined value to a string (default ''). */
function toStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
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

  /**
   * Auto-detect (per docs/product/03-provider-catalog.md §5): send a
   * prepared message into the current conversation asking the agent to
   * call `aigc_probe_endpoint` for each endpoint whose response.kind is
   * not yet set, then save the detected shapes via
   * `aigc_provider_set_endpoints`. The agent handles the actual probing
   * + persistence; the client just sends the prompt (same pattern as
   * the "Initialize" action).
   */
  const autoDetect = useCallback(async (provider: RuntimeProvider) => {
    const label = provider.name === '' ? provider.id : provider.name
    const text = t('row.autoDetectPrompt').replace('{name}', label).replace('{id}', provider.id)
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
              onAutoDetect={() => void autoDetect(draft)}
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
  readonly onAutoDetect?: () => void
}

function ProviderCard({ draft, expanded, isNew, isDefault, t, onToggle, onPatch, onSave, onDelete, onCreate, onCancel, onInit, onAutoDetect }: ProviderCardProps) {
  const isStub = draft.endpoint === '' || draft.endpoint === 'stub://aigc-backend'
  const patchAuth = (patch: Partial<{ scheme: 'bearer' | 'header' | 'query'; name: string }>): void => {
    onPatch({ auth: { ...draft.auth, ...patch } })
  }
  /**
   * Patch one endpoint in the draft's endpoints array (by index).
   * Replaces the whole array so React sees a new reference and re-renders.
   */
  const patchEndpoint = (index: number, patch: Partial<RuntimeEndpointSpec>): void => {
    const next = [...(draft.endpoints ?? [])]
    const existing = next[index]
    if (existing === undefined) return
    next[index] = { ...existing, ...patch }
    onPatch({ endpoints: next })
  }
  /** Append a fresh blank endpoint to the endpoints array. */
  const addEndpoint = (): void => {
    const next = [...(draft.endpoints ?? []), emptyEndpoint()]
    onPatch({ endpoints: next })
  }
  /** Remove the endpoint at one index. */
  const removeEndpoint = (index: number): void => {
    const next = [...(draft.endpoints ?? [])]
    next.splice(index, 1)
    onPatch({ endpoints: next })
  }
  /**
   * Patch one parameter on one endpoint (by endpoint index + param index).
   */
  const patchParam = (epIndex: number, paramIndex: number, patch: Partial<RuntimeParamSpec>): void => {
    const ep = (draft.endpoints ?? [])[epIndex]
    if (ep === undefined) return
    const params = [...(ep.params ?? [])]
    const existing = params[paramIndex]
    if (existing === undefined) return
    params[paramIndex] = { ...existing, ...patch }
    patchEndpoint(epIndex, { params })
  }
  /** Append a fresh blank parameter to one endpoint. */
  const addParam = (epIndex: number): void => {
    const ep = (draft.endpoints ?? [])[epIndex]
    if (ep === undefined) return
    const params = [...(ep.params ?? []), emptyParam()]
    patchEndpoint(epIndex, { params })
  }
  /** Remove the parameter at one index on one endpoint. */
  const removeParam = (epIndex: number, paramIndex: number): void => {
    const ep = (draft.endpoints ?? [])[epIndex]
    if (ep === undefined) return
    const params = [...(ep.params ?? [])]
    params.splice(paramIndex, 1)
    patchEndpoint(epIndex, { params })
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
              {!isStub && onAutoDetect !== undefined && (
                <button type="button" className={css.secondaryButton} onClick={onAutoDetect} title={t('row.autoDetectTitle')}>
                  {t('row.autoDetect')}
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
          {/* ── Selection policy fields (per docs/product/03-provider-catalog.md §4) ─ */}
          <div className={css.fieldRow}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('row.priority')}</span>
              <input
                className={css.input}
                type="number"
                min={0}
                step={1}
                value={toNumber(draft.priority, 100)}
                onChange={e => onPatch({ priority: toNumber(e.target.value, 100) })}
              />
              <span className={css.desc}>{t('row.priorityDesc')}</span>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('row.qualityHint')}</span>
              <select
                className={css.select}
                value={draft.qualityHint ?? 'balanced'}
                onChange={e => onPatch({ qualityHint: e.target.value as RuntimeQualityHint })}
              >
                {RUNTIME_QUALITY_HINTS.map(q => (
                  <option key={q} value={q}>{q}</option>
                ))}
              </select>
              <span className={css.desc}>{t('row.qualityHintDesc')}</span>
            </label>
          </div>
          <div className={css.fieldRow}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('row.costPerCall')}</span>
              <input
                className={css.input}
                type="number"
                min={0}
                step={0.0001}
                value={toNumber(draft.costPerCall, 0)}
                onChange={e => onPatch({ costPerCall: toNumber(e.target.value, 0) })}
              />
              <span className={css.desc}>{t('row.costPerCallDesc')}</span>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('row.costPerKiloToken')}</span>
              <input
                className={css.input}
                type="number"
                min={0}
                step={0.0001}
                value={toNumber(draft.costPerKiloToken, 0)}
                onChange={e => onPatch({ costPerKiloToken: toNumber(e.target.value, 0) })}
              />
              <span className={css.desc}>{t('row.costPerKiloTokenDesc')}</span>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('row.costPerSecond')}</span>
              <input
                className={css.input}
                type="number"
                min={0}
                step={0.0001}
                value={toNumber(draft.costPerSecond, 0)}
                onChange={e => onPatch({ costPerSecond: toNumber(e.target.value, 0) })}
              />
              <span className={css.desc}>{t('row.costPerSecondDesc')}</span>
            </label>
          </div>
          {/* ── Endpoints catalog editor (per docs/product/03-provider-catalog.md §5) ─ */}
          <div className={css.field}>
            <div className={css.fieldLabelRow}>
              <span className={css.fieldLabel}>{t('row.endpoints')}</span>
              {!isStub && onAutoDetect !== undefined && (
                <button type="button" className={css.endpointsAutoDetectButton} onClick={onAutoDetect} title={t('row.autoDetectTitle')}>
                  {t('row.autoDetect')}
                </button>
              )}
            </div>
            <span className={css.desc}>{t('row.endpointsDesc')}</span>
            {(draft.endpoints ?? []).length === 0 ? (
              <div className={css.endpointsEmpty}>{t('row.endpointsEmpty')}</div>
            ) : (
              <div className={css.endpointsList}>
                {(draft.endpoints ?? []).map((ep, epIndex) => (
                  <EndpointCard
                    key={epIndex}
                    endpoint={ep}
                    t={t}
                    onPatch={(patch) => patchEndpoint(epIndex, patch)}
                    onRemove={() => removeEndpoint(epIndex)}
                    onAddParam={() => addParam(epIndex)}
                    onPatchParam={(paramIndex, patch) => patchParam(epIndex, paramIndex, patch)}
                    onRemoveParam={(paramIndex) => removeParam(epIndex, paramIndex)}
                  />
                ))}
              </div>
            )}
            <button type="button" className={css.addEndpointButton} onClick={addEndpoint}>
              {t('row.addEndpoint')}
            </button>
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

// ─── EndpointCard ─────────────────────────────────────────────────────────────

interface EndpointCardProps {
  readonly endpoint: RuntimeEndpointSpec
  readonly t: (key: string) => string
  readonly onPatch: (patch: Partial<RuntimeEndpointSpec>) => void
  readonly onRemove: () => void
  readonly onAddParam: () => void
  readonly onPatchParam: (paramIndex: number, patch: Partial<RuntimeParamSpec>) => void
  readonly onRemoveParam: (paramIndex: number) => void
}

/**
 * One endpoint in the catalog editor: path / method / capability /
 * response.kind / response.path + acceptsCanvasRef + notes + parameter
 * list. Per docs/product/03-provider-catalog.md §5.
 *
 * No collapsible state — the card is always expanded so the user can
 * see all fields. The parameter list is a simple grid (name / type /
 * required / default) with add/remove buttons.
 */
function EndpointCard({ endpoint, t, onPatch, onRemove, onAddParam, onPatchParam, onRemoveParam }: EndpointCardProps) {
  const response = endpoint.response ?? { kind: 'json_text' as RuntimeResponseKind, path: '' }
  return (
    <div className={css.endpointCard}>
      <div className={css.endpointHead}>
        <span className={css.endpointHeadLabel}>
          {endpoint.method} {endpoint.path === '' ? '<path>' : endpoint.path}
          {endpoint.capability !== undefined && (
            <Pill className={css.endpointCapabilityBadge}>{endpoint.capability}</Pill>
          )}
        </span>
        <button type="button" className={css.endpointRemoveButton} onClick={onRemove} aria-label={t('row.removeEndpoint')}>
          ×
        </button>
      </div>
      <div className={css.fieldRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('row.endpointPath')}</span>
          <input
            className={css.input}
            value={endpoint.path}
            placeholder="/v1/images/generations"
            onChange={e => onPatch({ path: e.target.value })}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('row.endpointMethod')}</span>
          <select
            className={css.select}
            value={endpoint.method}
            onChange={e => onPatch({ method: e.target.value as RuntimeHttpMethod })}
          >
            {RUNTIME_HTTP_METHODS.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('row.endpointCapability')}</span>
          <select
            className={css.select}
            value={endpoint.capability}
            onChange={e => onPatch({ capability: e.target.value as RuntimeCapability })}
          >
            {RUNTIME_CAPABILITIES.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className={css.fieldRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('row.endpointResponseKind')}</span>
          <select
            className={css.select}
            value={response.kind}
            onChange={e => onPatch({ response: { kind: e.target.value as RuntimeResponseKind, path: response.path } })}
          >
            {RUNTIME_RESPONSE_KINDS.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('row.endpointResponsePath')}</span>
          <input
            className={css.input}
            value={toStr(response.path)}
            placeholder="data[0].b64_json"
            onChange={e => onPatch({ response: { kind: response.kind, path: e.target.value } })}
          />
        </label>
      </div>
      <label className={css.fieldRow}>
        <input
          type="checkbox"
          checked={endpoint.acceptsCanvasRef === true}
          onChange={e => onPatch({ acceptsCanvasRef: e.target.checked })}
        />
        <span className={css.desc}>{t('row.endpointAcceptsCanvasRef')}</span>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('row.endpointNotes')}</span>
        <input
          className={css.input}
          value={toStr(endpoint.notes)}
          placeholder="size must be 1024x1024 or 1792x1024"
          onChange={e => onPatch({ notes: e.target.value })}
        />
      </label>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('row.endpointParams')}</span>
        {(endpoint.params ?? []).length === 0 ? (
          <div className={css.endpointsEmpty}>{t('row.endpointParamsEmpty')}</div>
        ) : (
          <div className={css.paramsTable}>
            {(endpoint.params ?? []).map((param, paramIndex) => (
              <div key={paramIndex} className={css.paramRow}>
                <input
                  className={css.input}
                  value={param.name}
                  placeholder={t('row.endpointParamName')}
                  onChange={e => onPatchParam(paramIndex, { name: e.target.value })}
                />
                <select
                  className={css.select}
                  value={param.type}
                  onChange={e => onPatchParam(paramIndex, { type: e.target.value as RuntimeParamSpec['type'] })}
                >
                  {RUNTIME_PARAM_TYPES.map(tp => (
                    <option key={tp} value={tp}>{tp}</option>
                  ))}
                </select>
                <label className={css.paramRequired}>
                  <input
                    type="checkbox"
                    checked={param.required}
                    onChange={e => onPatchParam(paramIndex, { required: e.target.checked })}
                  />
                  <span>{t('row.endpointParamRequired')}</span>
                </label>
                <input
                  className={css.input}
                  value={toStr(param.default)}
                  placeholder={t('row.endpointParamDefault')}
                  onChange={e => onPatchParam(paramIndex, { default: e.target.value })}
                />
                <button type="button" className={css.paramRemoveButton} onClick={() => onRemoveParam(paramIndex)} aria-label={t('row.endpointRemoveParam')}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <button type="button" className={css.addEndpointButton} onClick={onAddParam}>
          {t('row.endpointAddParam')}
        </button>
      </div>
    </div>
  )
}
