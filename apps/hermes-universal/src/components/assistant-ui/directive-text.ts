// Composer chip helpers, ported from the composer-facing half of
// apps/desktop/src/components/assistant-ui/directive-text.tsx. The desktop file
// also exports a React <DirectiveText> message renderer (chips in sent user
// messages) — that half is deferred to a later chat-render phase; here we keep
// only what the contentEditable composer needs to build `@type:value` and
// `/command` chips inline.

const HERMES_REF_TYPES = ['file', 'folder', 'url', 'image', 'tool', 'line', 'terminal', 'session'] as const
type HermesRefType = (typeof HERMES_REF_TYPES)[number]

/** Single source of truth for chip icon glyphs (Tabler outline @ 24×24). Used
 *  by both the raw SVG markup (`directiveIconSvg`) and the DOM builder
 *  (`directiveIconElement`) the composer embeds. */
const ICON_PATHS: Record<HermesRefType, string[]> = {
  file: [
    'M14 3v4a1 1 0 0 0 1 1h4',
    'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2',
    'M9 9l1 0',
    'M9 13l6 0',
    'M9 17l6 0'
  ],
  folder: [
    'M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2'
  ],
  url: [
    'M9 15l6 -6',
    'M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464',
    'M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463'
  ],
  image: [
    'M15 8h.01',
    'M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12',
    'M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5',
    'M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3'
  ],
  tool: ['M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5'],
  line: ['M5 9l14 0', 'M5 15l14 0', 'M11 4l-4 16', 'M17 4l-4 16'],
  terminal: ['M5 7l5 5l-5 5', 'M12 19l7 0'],
  session: [
    'M8 9h8',
    'M8 13h6',
    'M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3z'
  ]
}

const ICON_FALLBACK = ['M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M16 12v1.5a2.5 2.5 0 0 0 5 0v-1.5a9 9 0 1 0 -5.5 8.28']

const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'

const iconPathsFor = (type: string) => ICON_PATHS[type as HermesRefType] ?? ICON_FALLBACK

/** SVG markup string for embedding directly in HTML (composer contenteditable). */
export function directiveIconSvg(type: string) {
  const inner = iconPathsFor(type)
    .map(d => `<path d="${d}"/>`)
    .join('')

  return `<svg ${SVG_ATTRS} class="size-3 shrink-0 opacity-80">${inner}</svg>`
}

function iconElementFromPaths(paths: string[]) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'size-3 shrink-0 opacity-80')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }

  return svg
}

export function directiveIconElement(type: string) {
  return iconElementFromPaths(iconPathsFor(type))
}

/** Per-type slash-command pill styling. The composer inserts these chips when a
 *  command is picked; the kind drives a theme-aware accent so commands, skills,
 *  and themes read distinctly. */
export type SlashChipKind = 'command' | 'skill' | 'theme'

const SLASH_ICON_PATHS: Record<SlashChipKind, string[]> = {
  command: ['M5 7l5 5l-5 5', 'M12 19l7 0'],
  skill: ['M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11'],
  theme: [
    'M3 21v-4a4 4 0 1 1 4 4h-4',
    'M21 3a16 16 0 0 0 -12.8 10.2',
    'M21 3a16 16 0 0 1 -10.2 12.8',
    'M10.6 9a9 9 0 0 1 4.4 4.4'
  ]
}

const SLASH_CHIP_VARIANT: Record<SlashChipKind, string> = {
  command:
    'bg-[color-mix(in_srgb,var(--ui-accent)_14%,transparent)] text-[color-mix(in_srgb,var(--ui-accent)_82%,var(--foreground))]',
  skill:
    'bg-[color-mix(in_srgb,var(--ui-warm)_18%,transparent)] text-[color-mix(in_srgb,var(--ui-warm)_82%,var(--foreground))]',
  theme:
    'bg-[color-mix(in_srgb,var(--ui-accent-secondary)_16%,transparent)] text-[color-mix(in_srgb,var(--ui-accent-secondary)_82%,var(--foreground))]'
}

export const SLASH_CHIP_BASE_CLASS =
  'mx-0.5 inline-flex max-w-64 items-center gap-1 rounded px-1.5 py-0.5 align-middle text-[0.86em] font-medium leading-none'

export function slashChipClass(kind: SlashChipKind): string {
  return `${SLASH_CHIP_BASE_CLASS} ${SLASH_CHIP_VARIANT[kind]}`
}

export function slashIconElement(kind: SlashChipKind) {
  return iconElementFromPaths(SLASH_ICON_PATHS[kind])
}

/** Shared chip styling — used by the raw HTML composer chips in
 *  `rich-editor.ts`. Neutral subtle wash + muted-foreground text so chips read
 *  as quiet tags on the composer surface. */
export const DIRECTIVE_CHIP_CLASS =
  'mx-0.5 inline-flex max-w-56 items-center gap-1 rounded px-1.5 py-0.5 align-middle text-[0.86em] font-normal leading-none bg-[color-mix(in_srgb,currentColor_8%,transparent)] text-muted-foreground'

function needsQuoting(value: string): boolean {
  return /[\s()[\]{}<>"'`]/.test(value)
}

export function formatRefValue(value: string): string {
  if (!needsQuoting(value)) {
    return value
  }

  if (!value.includes('`')) {
    return `\`${value}\``
  }

  if (!value.includes('"')) {
    return `"${value}"`
  }

  if (!value.includes("'")) {
    return `'${value}'`
  }

  return value
}
