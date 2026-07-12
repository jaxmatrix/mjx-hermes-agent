import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Ported verbatim from the desktop app (apps/desktop/src/lib/utils.ts): merge
// conditional class lists, with later Tailwind utilities winning conflicts.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
