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
  IconCircleFilled as Circle
} from '@tabler/icons-react'
