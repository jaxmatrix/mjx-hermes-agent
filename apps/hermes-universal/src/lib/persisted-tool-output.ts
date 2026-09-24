const OPEN = '<persisted-output>'
const CLOSE = '</persisted-output>'

export interface PersistedToolOutputRef {
  path: string
  preview: string
  sizeLabel?: string
}

/** Parse a backend `<persisted-output>` substitution block (see `tools/tool_result_storage.py`). */
export function parsePersistedToolOutput(raw: string): PersistedToolOutputRef | null {
  const text = raw.trim()

  if (!text.includes(OPEN)) {
    return null
  }

  const pathMatch = text.match(/^Full output saved to: (.+)$/m)
  const path = pathMatch?.[1]?.trim()

  if (!path) {
    return null
  }

  const sizeMatch = text.match(/too large \([^,]+,\s*([^)]+)\)/)
  const sizeLabel = sizeMatch?.[1]?.trim()

  const previewHeader = text.match(/Preview \(first \d+ chars\):\n/)
  let preview = ''

  if (previewHeader && previewHeader.index !== undefined) {
    const start = previewHeader.index + previewHeader[0].length
    let end = text.indexOf(CLOSE, start)

    if (end === -1) {
      end = text.length
    }

    preview = text
      .slice(start, end)
      .replace(/\n\.\.\.\s*$/, '')
      .trimEnd()
  }

  return { path, preview, sizeLabel }
}
