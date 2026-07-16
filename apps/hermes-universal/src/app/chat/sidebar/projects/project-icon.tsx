import { Codicon } from '@/components/ui/codicon'

import { SIDEBAR_LEAD_ICON_SIZE } from '../chrome'
import type { SidebarProjectTree } from './model'

// A project's lead glyph: a tinted dot for a color-only project, else its
// codicon (defaulting to a folder, or a slash for the "No project" bucket).
export function ProjectIcon({ project }: { project: SidebarProjectTree }) {
  if (project.color && !project.icon) {
    return <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
  }

  return (
    <Codicon
      className="text-(--ui-text-tertiary)"
      name={project.icon || (project.isNoProject ? 'circle-slash' : 'folder-library')}
      size={SIDEBAR_LEAD_ICON_SIZE}
    />
  )
}
