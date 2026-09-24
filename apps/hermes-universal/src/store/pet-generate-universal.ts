/**
 * Mobile / gateway-client pet generation API. Desktop AUTO `pet-generate.ts`
 * takes an explicit `GatewayRequest`; this module binds `requestGateway` and
 * keeps the sheet-first flow (`$petGenOpen`, no overlay). Listed in
 * `sync/protected.txt`.
 */
import { atom } from '@/store/atom'
import { requestGateway, subscribeGateway } from '@/store/gateway-client'
import { notifyError } from '@/store/notifications'
import { type PetInfo, setPetInfo } from '@/store/pet'
import { loadPetGallery } from '@/store/pet-gallery'
import { openAppRoute } from '@/store/windows'

const GENERATE_TIMEOUT_MS = 420_000
const HATCH_TIMEOUT_MS = 3_600_000

const NAME_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'cute',
  'for',
  'from',
  'in',
  'of',
  'on',
  'style',
  'the',
  'to',
  'with'
])

const capitalize = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w)

export function cleanPetName(prompt: string): string {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const meaningful = words.filter(w => !NAME_STOPWORDS.has(w.toLowerCase()))
  const picked = (meaningful.length ? meaningful : words).slice(0, 3)
  const name = picked.map(capitalize).join(' ').slice(0, 28).trim()

  return name || 'Pet'
}

export interface PetDraft {
  index: number
  dataUri: string
}

export type PetGenStatus = 'idle' | 'generating' | 'ready' | 'hatching' | 'preview' | 'adopting' | 'error' | 'stale'

export interface PetHatchStage {
  phase: 'row' | 'compose' | 'save'
  state?: string
  done?: number
  total?: number
}

export const $petGenStatus = atom<PetGenStatus>('idle')
export const $petGenStage = atom<PetHatchStage | null>(null)
export const $petGenError = atom<string | null>(null)
export const $petGenAvailable = atom<boolean | null>(null)
export const $petGenToken = atom<string | null>(null)
export const $petGenPrompt = atom('')
export const $petGenOpen = atom(false)
export const $petGenDrafts = atom<PetDraft[]>([])
export const $petGenSelected = atom<number | null>(null)
export const $petGenPreview = atom<PetInfo | null>(null)

const isMissingMethod = (err: unknown): boolean =>
  /method not found|-32601|unknown method|no such method/i.test(err instanceof Error ? err.message : String(err))

export function resetPetGen(): void {
  $petGenStatus.set('idle')
  $petGenStage.set(null)
  $petGenError.set(null)
  $petGenToken.set(null)
  $petGenPrompt.set('')
  $petGenDrafts.set([])
  $petGenSelected.set(null)
  $petGenPreview.set(null)
}

export function openPetGenerate(concept?: string): void {
  const seed = concept?.trim()

  if (seed) {
    $petGenPrompt.set(seed)
  }

  $petGenOpen.set(true)
  openAppRoute('/settings/appearance/pet')
}

export async function checkPetGenAvailable(): Promise<void> {
  try {
    const res = await requestGateway<{ available: boolean }>('pet.generate.status')
    $petGenAvailable.set(Boolean(res?.available))
  } catch {
    $petGenAvailable.set(true)
  }
}

let runId = 0
const bump = () => (runId += 1)

export async function generateDrafts(prompt: string): Promise<boolean> {
  const text = prompt.trim()

  if (!text) {
    return false
  }

  const myRun = bump()

  const preview = $petGenPreview.get()

  if (preview?.slug) {
    await requestGateway('pet.remove', { slug: preview.slug }).catch(() => {})
  }

  $petGenStatus.set('generating')
  $petGenError.set(null)
  $petGenPreview.set(null)
  $petGenDrafts.set([])
  $petGenSelected.set(null)

  const off = subscribeGateway<PetDraft & { token?: string }>('pet.generate.progress', draft => {
    if (myRun !== runId || $petGenStatus.get() !== 'generating') {
      return
    }

    if (draft?.token) {
      $petGenToken.set(draft.token)
    }

    if (!draft?.dataUri || typeof draft.index !== 'number') {
      return
    }

    const current = $petGenDrafts.get()

    if (current.some(d => d.index === draft.index)) {
      return
    }

    $petGenDrafts.set([...current, { index: draft.index, dataUri: draft.dataUri }].sort((a, b) => a.index - b.index))
  })

  try {
    const result = await requestGateway<{ ok: boolean; token: string; drafts: PetDraft[] }>(
      'pet.generate',
      { prompt: text, style: 'auto', count: 4 },
      GENERATE_TIMEOUT_MS
    )

    if (myRun !== runId) {
      return false
    }

    if (!result?.ok || !result.drafts?.length) {
      throw new Error('generation produced no drafts')
    }

    $petGenToken.set(result.token)
    $petGenPrompt.set(text)
    $petGenDrafts.set(result.drafts)
    $petGenSelected.set(result.drafts[0]?.index ?? 0)
    $petGenStatus.set('ready')

    return true
  } catch (e) {
    if (myRun !== runId) {
      return false
    }

    if (isMissingMethod(e)) {
      $petGenStatus.set('stale')
    } else {
      $petGenStatus.set('error')
      $petGenError.set(e instanceof Error ? e.message : 'Could not generate pet drafts.')
    }

    return false
  } finally {
    off()
  }
}

export function cancelGenerate(): void {
  const token = $petGenToken.get()

  if (token) {
    void requestGateway('pet.cancel', { token }).catch(() => {})
  }

  bump()
  $petGenStatus.set('idle')
  $petGenStage.set(null)
  $petGenError.set(null)
  $petGenDrafts.set([])
  $petGenSelected.set(null)
  $petGenToken.set(null)
}

export async function hatchSelected(name: string): Promise<boolean> {
  const token = $petGenToken.get()
  const index = $petGenSelected.get()
  const finalName = name.trim()
  const concept = ($petGenPrompt.get() || finalName).trim()

  if (token === null || index === null || !finalName) {
    return false
  }

  const cancelToken = crypto.randomUUID()
  const myRun = bump()

  $petGenStatus.set('hatching')
  $petGenStage.set(null)
  $petGenError.set(null)

  const off = subscribeGateway<{ event: string; state?: string; done?: string; total?: string }>(
    'pet.hatch.progress',
    p => {
      if (!p || myRun !== runId || $petGenStatus.get() !== 'hatching') {
        return
      }

      if (p.event === 'row' && p.state) {
        $petGenStage.set({
          phase: 'row',
          state: p.state,
          done: Number(p.done) || undefined,
          total: Number(p.total) || undefined
        })
      } else if (p.event === 'compose') {
        $petGenStage.set({ phase: 'compose' })
      } else if (p.event === 'save') {
        $petGenStage.set({ phase: 'save' })
      }
    }
  )

  try {
    const result = await requestGateway<{ ok: boolean; slug: string; displayName: string; pet?: PetInfo }>(
      'pet.hatch',
      { token, cancelToken, index, name: finalName, description: '', prompt: concept, style: 'auto' },
      HATCH_TIMEOUT_MS
    )

    if (myRun !== runId) {
      if (result?.slug) {
        void requestGateway('pet.remove', { slug: result.slug }).catch(() => {})
      }

      return false
    }

    if (!result?.ok || !result.pet?.spritesheetBase64) {
      throw new Error('hatch produced no preview')
    }

    $petGenPreview.set({ ...result.pet, enabled: true })
    $petGenStatus.set('preview')

    return true
  } catch (e) {
    if (myRun !== runId) {
      return false
    }

    $petGenStatus.set('error')
    $petGenError.set(e instanceof Error ? e.message : 'Could not hatch the pet.')

    return false
  } finally {
    off()

    if (myRun === runId) {
      $petGenStage.set(null)
    }
  }
}

export function cancelHatch(): void {
  bump()
  $petGenStage.set(null)
  $petGenError.set(null)
  $petGenStatus.set($petGenDrafts.get().length > 0 ? 'ready' : 'idle')
}

export async function adoptHatched(name?: string): Promise<boolean> {
  const preview = $petGenPreview.get()

  if (!preview?.slug) {
    return false
  }

  $petGenStatus.set('adopting')
  $petGenError.set(null)

  try {
    const finalName = name?.trim()
    let adoptSlug = preview.slug

    if (finalName && finalName !== preview.displayName) {
      const renamed = await requestGateway<{ ok: boolean; slug: string }>('pet.rename', {
        slug: preview.slug,
        name: finalName
      }).catch(() => null)

      if (renamed?.slug) {
        adoptSlug = renamed.slug
      }
    }

    const result = await requestGateway<{ ok: boolean; slug: string; displayName: string }>('pet.select', {
      slug: adoptSlug
    })

    if (!result?.ok) {
      throw new Error('adopt failed')
    }

    setPetInfo({ ...preview, slug: result.slug, displayName: result.displayName || finalName || preview.displayName })
    resetPetGen()
    void loadPetGallery(requestGateway, { force: true })

    return true
  } catch (e) {
    $petGenStatus.set('preview')
    $petGenError.set(e instanceof Error ? e.message : 'Could not adopt the pet.')
    notifyError(e, 'Could not adopt the pet.')

    return false
  }
}

export async function discardHatched(): Promise<void> {
  const preview = $petGenPreview.get()

  if (preview?.slug) {
    await requestGateway('pet.remove', { slug: preview.slug }).catch(() => {})
  }

  $petGenPreview.set(null)
  $petGenError.set(null)
  $petGenStatus.set($petGenDrafts.get().length > 0 ? 'ready' : 'idle')
}
