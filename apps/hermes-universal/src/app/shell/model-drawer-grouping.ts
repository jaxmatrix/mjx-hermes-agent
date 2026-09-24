import type { ModelOptionProvider } from '@hermes/shared'

import { catalogProviderMatches } from '@/lib/model-options'
import { displayModelName } from '@/lib/model-status-label'
import { foldIncludes, normalize } from '@/lib/text'
import {
  collapseModelFamilies,
  DEFAULT_VISIBLE_PER_PROVIDER,
  type ModelFamily,
  modelVisibilityKey
} from '@/store/model-visibility'

interface ProviderGroup {
  families: ModelFamily[]
  provider: ModelOptionProvider
}

/** Same grouping as `ModelCatalogMenu`'s internal `groupModels` — exported for the touch drawer only. */
export function groupModelsForDrawer(
  providers: ModelOptionProvider[],
  search: string,
  current: { model: string; provider: string },
  visible: Set<string> | null
): ProviderGroup[] {
  const q = normalize(search)
  const groups: ProviderGroup[] = []

  for (const provider of providers) {
    const allFamilies = collapseModelFamilies(provider.models ?? [])

    if (allFamilies.length === 0) {
      continue
    }

    const matches = (family: ModelFamily) =>
      foldIncludes(
        `${family.id} ${family.fastId ?? ''} ${provider.name} ${provider.slug} ${displayModelName(family.id)}`,
        q
      )

    let shown: Set<string>

    if (q) {
      shown = new Set(allFamilies.filter(matches).map(family => family.id))
    } else if (visible) {
      shown = new Set(
        allFamilies.filter(family => visible.has(modelVisibilityKey(provider.slug, family.id))).map(family => family.id)
      )
    } else {
      shown = new Set(allFamilies.slice(0, DEFAULT_VISIBLE_PER_PROVIDER).map(family => family.id))
    }

    const activeId =
      !q && catalogProviderMatches(provider, current.provider) && current.model
        ? allFamilies.find(family => family.id === current.model || family.fastId === current.model)?.id
        : undefined

    const families = allFamilies.filter(family => shown.has(family.id) || family.id === activeId)

    if (families.length > 0) {
      groups.push({ families, provider })
    }
  }

  groups.sort((a, b) => a.provider.name.localeCompare(b.provider.name))

  return groups
}
