import type { FC } from 'react'

import type { ToolPart } from './fallback-model'

// FLAG(chat-port): universal already handles command approval through a separate
// gateway flow — `$approval` + `respondApproval` in `store/chat.ts`, rendered by
// a footer `ApprovalBar`. Desktop instead binds an inline approval strip under
// the pending tool row (positional binding to the single blocked terminal /
// execute_code call). We deliberately do NOT rewire universal's footer flow, so
// the inline strip is a no-op here: the footer bar owns approvals.
//
// This stub keeps `fallback.tsx`'s `<PendingToolApproval part={part} />` call
// site intact (the row still reserves the seam) without rendering a second,
// conflicting approval UI. Port the desktop inline strip here if universal ever
// moves approvals inline.
export const PendingToolApproval: FC<{ part: ToolPart }> = () => null
