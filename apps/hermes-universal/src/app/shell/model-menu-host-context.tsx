import { createContext, useContext, type ReactNode } from 'react'

import type { ModelMenuHostProps } from './use-model-menu-controller'

/**
 * Host props for the composer model / reasoning menus. On mobile the pills
 * read this to open `ModelDrawer` / a reasoning sheet instead of floating
 * DropdownMenus — same controller, different surface.
 */
const ModelMenuHostContext = createContext<ModelMenuHostProps | null>(null)

export function ModelMenuHostProvider({
  children,
  value
}: {
  children: ReactNode
  value: ModelMenuHostProps | null
}) {
  return <ModelMenuHostContext.Provider value={value}>{children}</ModelMenuHostContext.Provider>
}

export function useModelMenuHost(): ModelMenuHostProps | null {
  return useContext(ModelMenuHostContext)
}
