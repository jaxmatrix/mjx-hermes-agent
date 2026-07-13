import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { openExternalLink } from '@/lib/external-link'
import { useStore } from '@/store/atom'
import {
  backToPicker,
  chooseLater,
  confirmModel,
  $onboarding,
  saveApiKey,
  selectApiKeyProvider
} from '@/store/onboarding'

import { type ApiKeyOption, LOCAL_ENV_KEY, useApiKeyCatalog } from './api-key-options'

export function OnboardingScreen() {
  const { t } = useI18n()
  const state = useStore($onboarding)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-[max(2rem,env(safe-area-inset-top))]">
        <h1 className="text-xl font-semibold text-foreground">{t.onboarding.headerTitle}</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">{t.onboarding.headerDesc}</p>

        {state.step === 'picker' ? <Picker /> : state.step === 'apikey' ? <ApiKeyForm option={state.option} /> : <ConfirmModel />}
      </div>
    </div>
  )
}

function Picker() {
  const { t } = useI18n()
  const options = useApiKeyCatalog()
  const copy = t.onboarding.apiKeyOptions as Record<string, { short: string; description: string }>

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-col gap-2">
        {options.map(option => (
          <button
            key={option.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary"
            onClick={() => selectApiKeyProvider(option)}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{option.name}</span>
                {option.id === 'openrouter' && (
                  <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-primary">
                    {t.onboarding.recommended}
                  </span>
                )}
              </span>
              {copy[option.id]?.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{copy[option.id].description}</span>
              )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>

      <Button className="mt-6 w-full" onClick={() => chooseLater()} variant="ghost">
        {t.onboarding.chooseLater}
      </Button>
    </div>
  )
}

function ApiKeyForm({ option }: { option: ApiKeyOption | null }) {
  const { t } = useI18n()
  const state = useStore($onboarding)
  const [value, setValue] = useState('')
  const [localApiKey, setLocalApiKey] = useState('')

  if (!option) {
    return null
  }
  const isLocal = option.envKey === LOCAL_ENV_KEY

  const submit = () => void saveApiKey(option, value, isLocal ? localApiKey : undefined)

  return (
    <div className="flex flex-1 flex-col">
      <button className="-ml-1 mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground" onClick={() => backToPicker()} type="button">
        <ChevronLeft className="size-4" />
        {t.onboarding.backToSignIn}
      </button>

      <div className="text-base font-medium text-foreground">{option.name}</div>

      <label className="mt-4 block">
        <Input
          autoFocus
          onChange={e => setValue(e.target.value)}
          placeholder={isLocal ? option.placeholder : t.onboarding.pasteApiKey}
          type={isLocal ? 'text' : 'password'}
          value={value}
        />
      </label>

      {isLocal && (
        <label className="mt-2 block">
          <Input
            onChange={e => setLocalApiKey(e.target.value)}
            placeholder={t.onboarding.localApiKeyPlaceholder}
            type="password"
            value={localApiKey}
          />
        </label>
      )}

      {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}

      {option.docsUrl && (
        <Button className="mt-3 w-fit" onClick={() => void openExternalLink(option.docsUrl!)} size="sm" variant="ghost">
          {t.onboarding.getKey}
        </Button>
      )}

      <Button className="mt-auto w-full" disabled={state.busy || !value.trim()} onClick={submit}>
        {state.busy ? t.onboarding.connecting : t.common.continue}
      </Button>
    </div>
  )
}

function ConfirmModel() {
  const { t } = useI18n()
  const state = useStore($onboarding)

  return (
    <div className="flex flex-1 flex-col">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t.onboarding.defaultModel}</div>
      <div className="mt-1 rounded-lg border border-border bg-card p-3">
        <div className="text-sm font-medium text-foreground">{state.recommended?.model ?? t.onboarding.recommended}</div>
        {state.recommended?.provider && <div className="text-xs text-muted-foreground">{state.recommended.provider}</div>}
      </div>

      {state.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}

      <Button className="mt-auto w-full" disabled={state.busy} onClick={() => void confirmModel()}>
        {state.busy ? t.onboarding.connecting : t.onboarding.startChatting}
      </Button>
    </div>
  )
}
