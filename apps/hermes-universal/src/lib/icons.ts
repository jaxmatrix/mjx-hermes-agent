// Central icon module — mirrors the desktop `@/lib/icons` seam so ported
// components can `import { X } from '@/lib/icons'` unchanged. Backed by
// @tabler/icons-react (the desktop icon library). Icons are aliased to the
// desktop names and re-exported; grow this list as more get referenced.
import type { ComponentType } from 'react'

// Structural icon type (matches the desktop `IconComponent`) so ported nav /
// settings components type their icon props identically.
export type IconComponent = ComponentType<{ className?: string }>

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
  IconPalette as Palette,
  // Notification toasts (Track I)
  IconAlertCircle as AlertCircle,
  IconAlertTriangle as AlertTriangle,
  IconCircleCheck as CheckCircle2,
  IconInfoCircle as Info,
  // Settings section icons (Track J)
  IconBrain as Brain,
  IconLock as Lock,
  IconMicrophone as Mic,
  IconDeviceDesktop as Monitor,
  IconSun as Sun,
  IconMoon as Moon,
  IconCloud as Cloud,
  IconTool as Wrench,
  IconBell as Bell,
  IconKey as Key,
  IconRefresh as Refresh,
  IconDownload as Download,
  IconUpload as Upload,
  IconEye as Eye,
  IconEyeOff as EyeOff,
  IconKeyboard as Keyboard,
  IconFolder as Folder,
  IconFile as File,
  IconGitBranch as GitBranch,
  IconPaw as Paw,
  // Status bar (Track F — bottom statusbar port)
  IconCommand as Command,
  IconActivity as Activity,
  IconHash as Hash,
  IconLoader2 as Loader2,
  IconRefresh as RefreshCw,
  IconLayoutDashboard as LayoutDashboard,
  IconBolt as Zap,
  IconBoltFilled as ZapFilled,
  IconTerminal2 as Terminal,
  // Memory provider panels (config sections port)
  IconExternalLink as ExternalLink,
  IconDeviceFloppy as Save,
  // Notifications completion-sound preview
  IconPlayerPlay as Play
} from '@tabler/icons-react'
