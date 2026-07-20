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
  // Tool / clarify glyphs (chat-port phase 5)
  IconMessageQuestion as MessageQuestion,
  IconCircleLetterA as CircleLetterA,
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
  IconArchiveOff as ArchiveOff,
  IconSearch as Search,
  IconDotsVertical as MoreVertical,
  IconHistory as History,
  // Language switcher / theme picker (Track I). Globe = IconGlobe to match the
  // desktop `@/lib/icons` alias exactly (the meridian globe, not IconWorld).
  IconGlobe as Globe,
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
  IconFolderOpen as FolderOpen,
  IconFile as File,
  IconGitBranch as GitBranch,
  IconPaw as Paw,
  // Status bar (Track F — bottom statusbar port)
  IconCommand as Command,
  IconActivity as Activity,
  IconHash as Hash,
  IconLoader2 as Loader2,
  // Chat message action bar / user bubble (Phase 4 chat-UI port) — aliased to
  // the exact names desktop's assistant-message / user-message import.
  IconLoader2 as Loader2Icon,
  IconX as XIcon,
  IconVolume as Volume2Icon,
  IconVolumeOff as VolumeXIcon,
  IconGitBranch as GitBranchIcon,
  IconPlayerStopFilled as StopFilled,
  IconRefresh as RefreshCw,
  IconLayoutDashboard as LayoutDashboard,
  IconBolt as Zap,
  IconBoltFilled as ZapFilled,
  IconTerminal2 as Terminal,
  // Memory provider panels (config sections port)
  IconExternalLink as ExternalLink,
  IconDeviceFloppy as Save,
  // Notifications completion-sound preview
  IconPlayerPlay as Play,
  // Gateway settings (mode-card hint + sign-in buttons)
  IconHelpCircle as HelpCircle,
  IconLogin as LogIn,
  // Chat rendering pipeline (chat-session UI port)
  IconCopy as Copy,
  IconArrowUpRight as ArrowUpRight,
  // Zoomable viewer (embeds phase — mermaid/svg pan-zoom toolbar)
  IconMaximize as Maximize,
  IconZoomIn as ZoomIn,
  IconZoomOut as ZoomOut,
  // Composer (Phase 7 chat-UI port) — aliased to the exact names the desktop
  // composer imports so the ported files resolve unchanged.
  IconArrowUp as ArrowUp,
  IconWaveSine as AudioLines,
  IconLayersIntersect2 as Layers3,
  IconSquare as Square,
  IconSquareFilled as SquareFilled,
  IconSteeringWheel as SteeringWheel,
  IconFileText as FileText,
  IconPhoto as ImageIcon,
  IconPhoto as FileImage,
  IconClipboard as Clipboard,
  IconLink as Link,
  IconLink as Link2,
  IconMessage2 as MessageSquareText,
  IconTrash as Trash2,
  IconVolume2 as Volume2,
  IconVolumeOff as VolumeX
} from '@tabler/icons-react'

// Shared icon-size utility (mirrors desktop `@/lib/icons` iconSize) so ported
// components can size glyphs with `className={iconSize.sm}`.
export const iconSize = {
  xs: 'size-3', // 12px
  sm: 'size-3.5', // 14px
  md: 'size-4', // 16px
  lg: 'size-5', // 20px
  xl: 'size-6' // 24px
} as const

export type IconSize = keyof typeof iconSize
