import type { MessagePrimitive } from '@assistant-ui/react'
import type { ComponentProps } from 'react'

import { MarkdownText } from '@/components/assistant-ui/markdown-text'

import { ReasoningPart } from './reasoning-part'
import { ToolPart } from './tool-part'

// The part-dispatch table (mirrors desktop's MESSAGE_PARTS_COMPONENTS). Text →
// markdown, Reasoning → disclosure, tool-calls → the fallback tool row.
export const MESSAGE_PARTS: ComponentProps<typeof MessagePrimitive.Parts>['components'] = {
  Text: MarkdownText,
  Reasoning: ReasoningPart,
  tools: { Fallback: ToolPart }
}
