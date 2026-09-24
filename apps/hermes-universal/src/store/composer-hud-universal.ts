/** HUD window sizing reads attachment/model menu open state; desktop composer no longer exports these atoms. */
import { atom } from '@/store/atom'

export const $attachmentMenuDropdownOpen = atom(false)
