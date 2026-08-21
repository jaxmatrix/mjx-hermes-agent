/**
 * The live half of the settings catalog: `settings-search.ts` is pure, this
 * feeds it the schema, the config record and the env-var map.
 *
 * Everything is read under the shared "Applies to" scope (MJXHRM-450), so the
 * rows the palette offers are the rows the page will actually render for the
 * profile the user is editing — a Voice field that only exists on the research
 * profile must not be offered while the scope names the default one.
 *
 * Ported from apps/desktop/src/app/settings/use-settings-search.ts.
 */

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { getEnvVars, getHermesConfigSchema } from '@/hermes'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $settingsScopeOverride } from '@/store/settings-scope'

import type { SettingsSearchEntry } from './settings-search'
import { buildClientPrefSearchEntries, buildConfigSearchEntries, buildCredentialSearchEntries } from './settings-search'
import { useHermesConfigRecord } from './use-config-record'

const STALE_MS = 5 * 60 * 1000

export interface SettingsSearchCatalog {
  clientPrefEntries: SettingsSearchEntry[]
  configEntries: SettingsSearchEntry[]
  credentialEntries: SettingsSearchEntry[]
}

export function useSettingsSearchCatalog(enabled: boolean): SettingsSearchCatalog {
  const { t } = useI18n()
  const scopeProfile = useStore($settingsScopeOverride)

  const configQuery = useHermesConfigRecord(scopeProfile)

  const schemaQuery = useQuery({
    enabled,
    queryFn: () => getHermesConfigSchema(scopeProfile),
    queryKey: ['settings-search', 'schema', scopeProfile],
    staleTime: STALE_MS
  })

  const envQuery = useQuery({
    enabled,
    queryFn: () => getEnvVars(scopeProfile),
    queryKey: ['settings-search', 'env-vars', scopeProfile],
    staleTime: STALE_MS
  })

  const sectionLabels = t.settings.sections as Record<string, string>

  const configEntries = useMemo(() => {
    // A catalog mid-refresh still holds the PREVIOUS profile's fields, and every
    // one of those is a deep link that would land on a row this profile doesn't
    // have. Offer nothing rather than something wrong.
    if (configQuery.isFetching || configQuery.isError || schemaQuery.isFetching || schemaQuery.isError) {
      return []
    }

    return buildConfigSearchEntries(schemaQuery.data?.fields, configQuery.data, {
      fieldDescriptions: t.settings.fieldDescriptions,
      fieldLabels: t.settings.fieldLabels,
      sections: sectionLabels
    })
  }, [
    configQuery.data,
    configQuery.isError,
    configQuery.isFetching,
    schemaQuery.data,
    schemaQuery.isError,
    schemaQuery.isFetching,
    sectionLabels,
    t.settings.fieldDescriptions,
    t.settings.fieldLabels
  ])

  const credentialEntries = useMemo(
    () =>
      envQuery.isFetching || envQuery.isError
        ? []
        : buildCredentialSearchEntries(envQuery.data, {
            settings: t.settings.nav.keysSettings,
            tools: t.settings.nav.keysTools
          }),
    [envQuery.data, envQuery.isError, envQuery.isFetching, t.settings.nav.keysSettings, t.settings.nav.keysTools]
  )

  // Device-local rows: no gateway round trip, so they are the one part of the
  // catalog that is complete the instant the palette opens.
  const clientPrefEntries = useMemo(() => buildClientPrefSearchEntries(t, sectionLabels), [sectionLabels, t])

  return { clientPrefEntries, configEntries, credentialEntries }
}
