// Central icon module — mirrors the desktop `@/lib/icons` seam so ported
// components can `import { X } from '@/lib/icons'` unchanged. Backed by
// @tabler/icons-react (the desktop icon library). Icons are aliased to the
// desktop names and re-exported; grow this list as more get referenced.
export {
  IconX as X,
  IconCheck as Check,
  IconChevronRight as ChevronRight,
  IconChevronDown as ChevronDown,
  IconChevronLeft as ChevronLeft,
  IconChevronUp as ChevronUp,
  IconCircleFilled as Circle,
  // Navigation glyphs (Track F sidebar)
  IconMenu2 as Menu,
  IconSettings as Settings,
  IconMessageCircle as MessageCircle,
  IconSparkles as Sparkles,
  IconCpu as Cpu,
  IconClock as Clock,
  IconSend as Send,
  IconBox as Box,
  IconStars as Stars,
  IconLayoutGrid as LayoutGrid,
  IconUsers as Users,
  IconPlus as Plus,
  // Session actions (Track H)
  IconTrash as Trash,
  IconPencil as Pencil,
  IconArchive as Archive,
  IconSearch as Search,
  IconDotsVertical as MoreVertical,
  IconHistory as History,
  // Language switcher / theme picker (Track I)
  IconWorld as Globe,
  IconPalette as Palette
} from '@tabler/icons-react'
