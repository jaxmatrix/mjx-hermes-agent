import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getGlobalModelInfo, getGlobalModelOptions, setGlobalModel } from '@/hermes'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'
import { openOnboarding } from '@/store/onboarding'

import { ConfigSection } from './config-section'
import { ListRow } from './primitives'
import { invalidateHermesConfig } from './use-config-record'

// Separator for the "provider///model" select value. Model ids use single "/"
// (e.g. "anthropic/claude-sonnet"), so a triple slash is collision-safe.
const SEP = '///'

// Lean default-model picker: pick the main model per provider. The desktop MoA /
// auxiliary-model / local-endpoint-onboarding surfaces are deferred. FIXME(J7).
function ModelPicker() {
  const { t } = useI18n()
  const m = t.settings.model
  const [saving, setSaving] = useState(false)

  const info = useQuery({ queryKey: ['model-info'], queryFn: getGlobalModelInfo, staleTime: 30_000 })
  const options = useQuery({ queryKey: ['model-options'], queryFn: () => getGlobalModelOptions(), staleTime: 60_000 })

  const providers = (options.data?.providers ?? []).filter(p => p.authenticated !== false && (p.models?.length ?? 0) > 0)
  const current = info.data ? `${info.data.provider}${SEP}${info.data.model}` : ''

  const onSelect = async (value: string) => {
    const idx = value.indexOf(SEP)
    if (idx < 0) {
      return
    }
    const provider = value.slice(0, idx)
    const model = value.slice(idx + SEP.length)
    setSaving(true)
    try {
      await setGlobalModel(provider, model)
      await info.refetch()
      void invalidateHermesConfig()
    } catch (err) {
      notifyError(err, m.defaultsFailed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <ListRow
      action={
        <Select disabled={saving || options.isLoading} onValueChange={value => void onSelect(value)} value={current}>
          <SelectTrigger>
            <SelectValue placeholder={saving ? m.applying : m.loading} />
          </SelectTrigger>
          <SelectContent>
            {providers.map(provider =>
              (provider.models ?? []).map(model => (
                <SelectItem key={`${provider.slug}${SEP}${model}`} value={`${provider.slug}${SEP}${model}`}>
                  {provider.name} / {model}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      }
      description={m.appliesDesc}
      title={m.model}
      wide
    />
  )
}

function ModelHeader() {
  const { t } = useI18n()
  return (
    <>
      <ModelPicker />
      {/* Re-open the onboarding wizard to add another provider (K11.c). */}
      <Button className="mt-2 w-full" onClick={() => openOnboarding()} variant="outline">
        {t.onboarding.setUpProvider}
      </Button>
    </>
  )
}

export function ModelSection() {
  // The picker + "set up a provider" render above the schema fields (context
  // length, fallback providers) inside the section's single scroll container.
  return <ConfigSection headerSlot={<ModelHeader />} sectionId="model" />
}
