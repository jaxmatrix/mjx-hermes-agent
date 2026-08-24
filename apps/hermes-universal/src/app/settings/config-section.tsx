import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useOnProfileSwitch } from '@/app/hooks/use-on-profile-switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { getHermesConfigSchema, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { reconcileApprovalModeForProfile } from '@/store/approval-mode'
import { useStore } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { repoDiscoveryPolicyFromConfig, repoDiscoveryPolicySignature, scanAndRecordRepos } from '@/store/projects'
import { $settingsScopeOverride } from '@/store/settings-scope'
import type { ConfigFieldSchema, HermesConfigRecord } from '@/types/hermes'

import { ComboboxInput } from './combobox-input'
import { CONTROL_TEXT, EMPTY_SELECT_VALUE, FIELD_DESCRIPTIONS, FIELD_LABELS, FREE_INPUT_KEYS } from './constants'
import { FallbackModelsField } from './fallback-models-field'
import { fieldCopyForSchemaKey } from './field-copy'
import { enumOptionsFor, getNested, prettyName, sectionFieldEntries, setNested } from './helpers'
import { EmptyState, ListRow, SettingsContent, SettingsSkeleton } from './primitives'
import { SettingsProfileScope } from './profile-scope'
import { SearchableSelect } from './searchable-select'
import { hermesConfigCacheWriter, useHermesConfigRecord } from './use-config-record'
import { useDeepLinkHighlight } from './use-deep-link-highlight'

// Shared by the row wrapper and the deep-link lookup so a palette jump can
// never drift from the id the row actually renders.
const fieldElementId = (key: string) => `setting-field-${key}`

/**
 * Approval mode has three writers in this app — Settings → Safety (this file,
 * `PUT /api/config`), the statusbar's Zap menu (`config.set`), and `/approvals`
 * (`slash.exec`) — and exactly one cached reader, `$approvalModes`, which the
 * menu fills once when it mounts and nothing else ever invalidates. So a mode
 * changed here left the bar reporting the old one for the rest of the session,
 * and the bar's next pick wrote that stale value straight back over this save.
 *
 * The record we just persisted IS the new truth, so reconcile from it rather
 * than spending a round trip. Only when it actually carries a value: a config
 * with the key unset must keep whatever default the gateway resolves (which is
 * NOT this cache's), or every save of an unrelated section would slam the bar to
 * the normalizer's fallback.
 */
function reconcileSavedApprovalMode(config: HermesConfigRecord, scopeProfile: null | string): void {
  const saved = getNested(config, 'approvals.mode')

  if (typeof saved === 'string' && saved.trim()) {
    // The bar reports the profile the APP is operating as; a save aimed at
    // another profile (the "Applies to" scope) must reconcile that one's cache
    // entry instead, or the bar would claim the other profile's mode.
    reconcileApprovalModeForProfile(scopeProfile ?? $activeGatewayProfile.get(), saved)
  }
}

// The schema-driven config field: renders the right control for the schema type
// and calls onChange with the parsed value. Ported from desktop config-settings.tsx.
export function ConfigField({
  schemaKey,
  schema,
  value,
  enumOptions,
  optionLabels,
  onChange,
  descriptionExtra
}: {
  schemaKey: string
  schema: ConfigFieldSchema
  value: unknown
  enumOptions?: string[]
  optionLabels?: Record<string, string>
  onChange: (value: unknown) => void
  descriptionExtra?: ReactNode
}) {
  const { t } = useI18n()
  const c = t.settings.config

  const label =
    fieldCopyForSchemaKey(t.settings.fieldLabels, schemaKey) ??
    fieldCopyForSchemaKey(FIELD_LABELS, schemaKey) ??
    prettyName(schemaKey.split('.').pop() ?? schemaKey)

  const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '')

  const rawDescription = (
    fieldCopyForSchemaKey(t.settings.fieldDescriptions, schemaKey) ??
    fieldCopyForSchemaKey(FIELD_DESCRIPTIONS, schemaKey) ??
    schema.description ??
    ''
  ).trim()

  const normalizedDesc = normalize(rawDescription)

  const description =
    rawDescription && normalizedDesc !== normalize(label) && normalizedDesc !== normalize(schemaKey)
      ? rawDescription
      : undefined

  const descriptionNode: ReactNode = descriptionExtra ? (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {description}
      {descriptionExtra}
    </span>
  ) : (
    description
  )

  const row = (action: ReactNode, wide = false) => (
    // `data-tour="field-<schema key>"`: a tour (or the agent) can point at one
    // setting without hunting through the section for an nth-child path. The
    // schema key is the stable identity here — the LABEL is translated.
    <ListRow action={action} data-tour={`field-${schemaKey}`} description={descriptionNode} title={label} wide={wide} />
  )

  // Structured provider+model chain editor (replaces the generic comma-list input,
  // which stringified the {provider,model} objects). Mirrors desktop config-settings.
  if (schemaKey === 'fallback_providers') {
    return row(<FallbackModelsField onChange={onChange} value={value} />, true)
  }

  if (schema.type === 'boolean') {
    return row(
      <div className="flex items-center justify-end">
        <Switch checked={Boolean(value)} onCheckedChange={onChange} />
      </div>
    )
  }

  const selectOptions = enumOptions ?? (schema.type === 'select' ? (schema.options ?? []).map(String) : undefined)

  // Large closed-world lists (e.g. ~590 IANA timezones) get a searchable
  // Popover + cmdk combobox instead of a closed Select dropdown. The schema
  // opt-in via `searchable: true` keeps this deterministic — no field
  // accidentally triggers based on dynamic option count.
  if (selectOptions && schema.searchable) {
    return row(
      <SearchableSelect
        clearLabel={schema.clearable ? c.systemDefault : undefined}
        emptyMessage={c.noResults}
        onChange={next => onChange(next)}
        options={selectOptions.filter(o => o !== '')}
        placeholder={c.searchPlaceholder}
        value={String(value ?? '')}
      />
    )
  }

  // Voice/model name fields are open-world (custom voice IDs, cloned voices,
  // brand-new model names) — render a free-input combobox where the known
  // options are dropdown suggestions instead of a closed Select gate.
  if (selectOptions && FREE_INPUT_KEYS.has(schemaKey)) {
    return row(
      <ComboboxInput
        className={CONTROL_TEXT}
        onChange={onChange}
        optionLabels={optionLabels}
        options={selectOptions.filter(o => o !== '')}
        placeholder={c.notSet}
        value={String(value ?? '')}
      />
    )
  }

  if (selectOptions) {
    return row(
      <Select
        onValueChange={next => onChange(next === EMPTY_SELECT_VALUE ? '' : next)}
        value={String(value ?? '') || EMPTY_SELECT_VALUE}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {selectOptions.map(option => (
            <SelectItem key={option || EMPTY_SELECT_VALUE} value={option || EMPTY_SELECT_VALUE}>
              {option
                ? (optionLabels?.[option] ?? prettyName(option))
                : schemaKey === 'display.personality'
                  ? c.none
                  : // The empty `memory.provider` sentinel means built-in memory, not
                    // "memory off" — built-in is not a provider plugin (#49513), so
                    // "(none)" reads as a disabled subsystem it never was.
                    schemaKey === 'memory.provider'
                    ? c.builtinOnly
                    : c.noneParen}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  if (schema.type === 'number') {
    return row(
      <Input
        inputMode="numeric"
        onChange={e => {
          const raw = e.target.value
          const n = raw === '' ? 0 : Number(raw)

          if (!Number.isNaN(n)) {
            onChange(n)
          }
        }}
        placeholder={c.notSet}
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
      />
    )
  }

  if (schema.type === 'list') {
    return row(
      <Input
        onChange={e =>
          onChange(
            e.target.value
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
          )
        }
        placeholder={c.commaSeparated}
        value={Array.isArray(value) ? value.join(', ') : String(value ?? '')}
      />
    )
  }

  if (typeof value === 'object' && value !== null) {
    return row(
      <Textarea
        className={cn('min-h-28 resize-y font-mono')}
        onChange={e => {
          try {
            onChange(JSON.parse(e.target.value))
          } catch {
            /* keep last valid */
          }
        }}
        placeholder={c.notSet}
        value={JSON.stringify(value, null, 2)}
      />,
      true
    )
  }

  const isLong = schema.type === 'text' || String(value ?? '').length > 100

  return row(
    isLong ? (
      <Textarea
        className="min-h-24 resize-y"
        onChange={e => onChange(e.target.value)}
        placeholder={c.notSet}
        value={String(value ?? '')}
      />
    ) : (
      <Input onChange={e => onChange(e.target.value)} placeholder={c.notSet} value={String(value ?? '')} />
    ),
    isLong
  )
}

// Renders the schema fields for one config section, with a seed-once local draft
// and a debounced (550ms) autosave that mirrors into the shared cache. Adapted
// from desktop ConfigSettings (draft/seed/autosave replicated exactly so a save
// never drops fields — saveHermesConfig REPLACES the whole record).
export function ConfigSection(props: ConfigSectionProps) {
  // Shared "Applies to" scope (null → the app's active profile). Remount the
  // inner section per scope so every draft/seed/autosave ref resets wholesale
  // when the target profile changes — the same guarantee useOnProfileSwitch
  // gives for app-wide switches, without hand-clearing each piece.
  const scopeProfile = useStore($settingsScopeOverride)

  return <ScopedConfigSection {...props} key={scopeProfile ?? '__active__'} scopeProfile={scopeProfile} />
}

interface ConfigSectionProps {
  sectionId: string
  // Optional per-key visibility filter (voice hides inactive-provider fields).
  fieldFilter?: (key: string, config: HermesConfigRecord) => boolean
  // Optional block rendered UNDER a field's row (memory: ProviderConfigPanel).
  renderExtra?: (key: string, config: HermesConfigRecord) => ReactNode
  // Optional inline extra appended to a field's description (memory: MemoryConnect).
  renderDescriptionExtra?: (key: string, config: HermesConfigRecord) => ReactNode
  // Optional enum-options override (voice: dynamic ElevenLabs voice ids). Defaults
  // to enumOptionsFor.
  resolveEnumOptions?: (key: string, value: unknown, config: HermesConfigRecord) => string[] | undefined
  // Optional per-key option-label map (voice: ElevenLabs id → display name).
  resolveOptionLabels?: (key: string) => Record<string, string> | undefined
  // Optional custom block rendered above the schema fields (model picker).
  headerSlot?: ReactNode
}

function ScopedConfigSection({
  sectionId,
  fieldFilter,
  renderExtra,
  renderDescriptionExtra,
  resolveEnumOptions,
  resolveOptionLabels,
  headerSlot,
  scopeProfile
}: ConfigSectionProps & { scopeProfile: null | string }) {
  const { t } = useI18n()
  const c = t.settings.config

  const [config, setConfig] = useState<HermesConfigRecord | null>(null)
  const { data: loadedConfig, isError: configLoadFailed, refetch: refetchConfig } = useHermesConfigRecord(scopeProfile)
  // Writes land on the same cache key the query above reads (base key when
  // following the active profile, suffixed under a scope override).
  const writeConfigCache = useMemo(() => hermesConfigCacheWriter(scopeProfile), [scopeProfile])

  const {
    data: schemaResponse,
    isError: schemaFailed,
    refetch: refetchSchema
  } = useQuery({
    // Base key when following the active profile (matches every pre-existing
    // consumer); suffixed only for an explicit scope override.
    queryKey:
      scopeProfile == null ? ['hermes-config-schema'] : ['hermes-config-schema', normalizeProfileKey(scopeProfile)],
    queryFn: () => getHermesConfigSchema(scopeProfile ?? undefined),
    staleTime: 5 * 60 * 1000
  })

  const schema = schemaResponse?.fields ?? null
  const saveVersionRef = useRef(0)
  // Last-saved repository-discovery policy, so an edit to the scan roots can
  // re-crawl while unrelated config edits don't.
  const savedDiscoverySignatureRef = useRef<string | undefined>(undefined)
  const [saveVersion, setSaveVersion] = useState(0)
  const configSeeded = useRef(false)

  // Seed the local draft once, the first time the shared record lands.
  // Background refetches thereafter must not clobber in-progress edits.
  useEffect(() => {
    if (loadedConfig && !configSeeded.current) {
      configSeeded.current = true
      savedDiscoverySignatureRef.current = repoDiscoveryPolicySignature(repoDiscoveryPolicyFromConfig(loadedConfig))
      setConfig(loadedConfig)
    }
  }, [loadedConfig])

  // A profile switch invalidates (but doesn't clear) the shared config query and
  // leaves this panel mounted, so the local draft would otherwise keep profile
  // A's data and autosave it into B — and `saveHermesConfig` REPLACES the whole
  // record, so that is B's config overwritten wholesale, not a merge. Drop the
  // seed + draft (re-seeds from B's refetch) and zero saveVersion so the pending
  // debounced autosave is cancelled by its effect cleanup.
  useOnProfileSwitch(() => {
    configSeeded.current = false
    savedDiscoverySignatureRef.current = undefined
    setConfig(null)
    saveVersionRef.current = 0
    setSaveVersion(0)
  })

  // Debounced autosave. saveHermesConfig REPLACES the whole record, so the draft
  // (a full clone edited via setNested) is what we persist.
  useEffect(() => {
    if (!config || saveVersion === 0) {
      return
    }

    const v = saveVersion

    const timer = setTimeout(() => {
      void (async () => {
        try {
          await saveHermesConfig(config, scopeProfile ?? undefined)
          writeConfigCache(config)
          reconcileSavedApprovalMode(config, scopeProfile)

          if (saveVersionRef.current === v) {
            // The repo-discovery scan crawls THIS client's filesystem under the
            // ACTIVE profile's workspace policy; skip it when the page is
            // editing another profile's config.
            if (scopeProfile == null) {
              const discoverySignature = repoDiscoveryPolicySignature(repoDiscoveryPolicyFromConfig(config))

              if (savedDiscoverySignatureRef.current !== discoverySignature) {
                savedDiscoverySignatureRef.current = discoverySignature
                await scanAndRecordRepos(true)
              }
            }
          }
        } catch (err) {
          if (saveVersionRef.current === v) {
            notifyError(err, c.autosaveFailed)
          }
        }
      })()
    }, 550)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- copy is stable; avoid re-scheduling on locale change
  }, [config, saveVersion])

  const updateConfig = (next: HermesConfigRecord) => {
    saveVersionRef.current += 1
    setConfig(next)
    setSaveVersion(saveVersionRef.current)
  }

  const sectionFields = useMemo(() => {
    if (!schema || !config) {
      return [] as [string, ConfigFieldSchema][]
    }

    return sectionFieldEntries(schema, config).get(sectionId) ?? []
  }, [schema, config, sectionId])

  // Deep-link target from the command palette (?field=<key>).
  const fieldReady = useCallback((key: string) => sectionFields.some(([k]) => k === key), [sectionFields])

  useDeepLinkHighlight({ elementId: fieldElementId, param: 'field', ready: fieldReady })

  if (!config || !schema) {
    if ((configLoadFailed && !config) || (schemaFailed && !schema)) {
      return (
        <SettingsContent>
          <SettingsProfileScope className="mb-5" />
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{c.failedLoad}</span>
            <Button
              onClick={() => {
                void refetchConfig()
                void refetchSchema()
              }}
              size="sm"
            >
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      )
    }

    // The header slot (Settings -> Model) owns its own DOM-shaped skeleton, so
    // keep it mounted and let it load in parallel with the schema.
    return (
      <SettingsSkeleton sections={[{ rows: 6 }]}>
        {headerSlot && <div className="pt-1">{headerSlot}</div>}
      </SettingsSkeleton>
    )
  }

  const visibleFields = fieldFilter ? sectionFields.filter(([key]) => fieldFilter(key, config)) : sectionFields

  return (
    <SettingsContent>
      <SettingsProfileScope className="mb-5" />
      {headerSlot && <div className="pt-1">{headerSlot}</div>}
      {visibleFields.length === 0 ? (
        headerSlot ? null : (
          <EmptyState description={c.emptyDesc} title={c.emptyTitle} />
        )
      ) : (
        <div className="grid gap-1 pt-1">
          {visibleFields.map(([key, field]) => (
            <div className="scroll-mt-6 rounded-lg" id={fieldElementId(key)} key={key}>
              <ConfigField
                descriptionExtra={renderDescriptionExtra?.(key, config)}
                enumOptions={
                  resolveEnumOptions
                    ? resolveEnumOptions(key, getNested(config, key), config)
                    : enumOptionsFor(key, getNested(config, key), config)
                }
                onChange={value => updateConfig(setNested(config, key, value))}
                optionLabels={resolveOptionLabels?.(key)}
                schema={field}
                schemaKey={key}
                value={getNested(config, key)}
              />
              {renderExtra?.(key, config)}
            </div>
          ))}
        </div>
      )}
    </SettingsContent>
  )
}
