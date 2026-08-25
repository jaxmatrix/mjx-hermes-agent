import { describe, expect, it } from 'vitest'

import {
  directiveFrameHeight,
  frameSizeFromMessage,
  themePrelude,
  withInlineChrome,
  workspaceFilePath
} from './inline-preview-directive'

// The `file` attribute is written by the MODEL, so this is the security seam
// of the whole directive: everything it returns becomes a gateway file read.
describe('workspaceFilePath', () => {
  const cwd = '/home/dev/project'

  it('resolves a plain relative file against the session cwd', () => {
    expect(workspaceFilePath('index.html', cwd)).toBe('/home/dev/project/index.html')
    expect(workspaceFilePath('build/out/report.html', cwd)).toBe('/home/dev/project/build/out/report.html')
  })

  it('normalizes `./` and interior `..` that stay inside the workspace', () => {
    expect(workspaceFilePath('./index.html', cwd)).toBe('/home/dev/project/index.html')
    expect(workspaceFilePath('docs/../index.html', cwd)).toBe('/home/dev/project/index.html')
    expect(workspaceFilePath('a/b/../../c.html', cwd)).toBe('/home/dev/project/c.html')
  })

  it('trims a trailing separator off the cwd instead of doubling it', () => {
    expect(workspaceFilePath('index.html', '/home/dev/project/')).toBe('/home/dev/project/index.html')
  })

  it('REJECTS a climb above the workspace root', () => {
    expect(workspaceFilePath('../secrets.html', cwd)).toBeNull()
    expect(workspaceFilePath('../../../../etc/passwd', cwd)).toBeNull()
    expect(workspaceFilePath('a/../../outside.html', cwd)).toBeNull()
    expect(workspaceFilePath('./../outside.html', cwd)).toBeNull()
    // Backslashes are separators too, or `..\\..\\` would walk out unchecked
    // on a Windows-shaped path the gateway is happy to resolve.
    expect(workspaceFilePath('..\\..\\outside.html', cwd)).toBeNull()
  })

  it('REJECTS anything that names a location instead of a workspace-relative path', () => {
    expect(workspaceFilePath('/etc/passwd', cwd)).toBeNull()
    expect(workspaceFilePath('file:///etc/passwd', cwd)).toBeNull()
    expect(workspaceFilePath('https://evil.example/x.html', cwd)).toBeNull()
    expect(workspaceFilePath('C:\\Windows\\win.ini', cwd)).toBeNull()
    expect(workspaceFilePath('\\\\server\\share\\x.html', cwd)).toBeNull()
    expect(workspaceFilePath('~/.ssh/id_rsa', cwd)).toBeNull()
  })

  it('REJECTS empty, whitespace-only, NUL-bearing, and cwd-less input', () => {
    expect(workspaceFilePath('', cwd)).toBeNull()
    expect(workspaceFilePath('   ', cwd)).toBeNull()
    expect(workspaceFilePath('.', cwd)).toBeNull()
    expect(workspaceFilePath('index.html\0.png', cwd)).toBeNull()
    expect(workspaceFilePath('index.html', '')).toBeNull()
  })

  it('strips the backticks a model wraps a path in', () => {
    expect(workspaceFilePath('`index.html`', cwd)).toBe('/home/dev/project/index.html')
  })
})

describe('directiveFrameHeight', () => {
  it('returns null (auto-size) when absent or garbage', () => {
    expect(directiveFrameHeight(undefined)).toBeNull()
    expect(directiveFrameHeight('')).toBeNull()
    expect(directiveFrameHeight('tall')).toBeNull()
    expect(directiveFrameHeight('12.5')).toBeNull()
  })

  it('clamps an explicit height to the sane band', () => {
    expect(directiveFrameHeight('50')).toBe(120)
    expect(directiveFrameHeight('480')).toBe(480)
    expect(directiveFrameHeight('99999')).toBe(1200)
  })
})

describe('withInlineChrome', () => {
  const prelude = themePrelude({ '--foreground': '#eee' }, 'Inter')

  it('puts the theme prelude before the page styles so the page overrides it', () => {
    const doc = '<html><head><style>body{color:red}</style></head><body><h1>hi</h1></body></html>'
    const framed = withInlineChrome(doc, 'tok', prelude)

    expect(framed.startsWith(prelude)).toBe(true)
    expect(framed.indexOf(prelude)).toBeLessThan(framed.indexOf('color:red'))
  })

  it('keeps the doctype FIRST — a prelude in front of it means quirks mode', () => {
    const framed = withInlineChrome('<!doctype html><html><body>x</body></html>', 'tok', prelude)

    expect(framed.startsWith('<!doctype html>')).toBe(true)
    // …and the prelude still lands ahead of the document's own markup.
    expect(framed.indexOf(prelude)).toBeLessThan(framed.indexOf('<body>'))
  })

  it('injects the measuring script before </body>', () => {
    const doc = '<html><body><h1>hi</h1></body></html>'
    const framed = withInlineChrome(doc, 'tok', prelude)

    expect(framed.indexOf('postMessage')).toBeGreaterThan(framed.indexOf('<h1>'))
    expect(framed.indexOf('postMessage')).toBeLessThan(framed.indexOf('</body>'))
    expect(framed).toContain('"tok"')
  })

  it('appends the script when there is no body close tag', () => {
    const framed = withInlineChrome('<h1>fragment</h1>', 'tok', prelude)

    expect(framed).toContain('<h1>fragment</h1>')
    expect(framed).toContain('postMessage')
  })
})

describe('themePrelude', () => {
  it('carries resolved tokens, transparent background, and the app font', () => {
    const prelude = themePrelude({ '--foreground': 'oklch(0.9 0 0)', '--accent': '#7aa2f7' }, 'Inter, sans-serif')

    expect(prelude).toContain('--foreground:oklch(0.9 0 0)')
    expect(prelude).toContain('--accent:#7aa2f7')
    expect(prelude).toContain('background:transparent')
    expect(prelude).toContain('font-family:Inter, sans-serif')
  })

  it('omits the font rule when no font resolved', () => {
    expect(themePrelude({}, '')).not.toContain('font-family')
  })
})

describe('frameSizeFromMessage', () => {
  const msg = (over: Record<string, unknown> = {}) => ({
    type: 'hermes-inline-preview-size',
    token: 'tok',
    height: 500,
    width: 300,
    ...over
  })

  it('accepts our message with our token, height clamped', () => {
    expect(frameSizeFromMessage(msg(), 'tok')).toEqual({ height: 500, width: 300 })
    expect(frameSizeFromMessage(msg({ height: 12 }), 'tok')?.height).toBe(120)
    expect(frameSizeFromMessage(msg({ height: 5000 }), 'tok')?.height).toBe(1200)
    expect(frameSizeFromMessage(msg({ height: 500.7 }), 'tok')?.height).toBe(501)
  })

  it('sanitizes width to 0 when missing or hostile', () => {
    expect(frameSizeFromMessage(msg({ width: undefined }), 'tok')?.width).toBe(0)
    expect(frameSizeFromMessage(msg({ width: 'wide' }), 'tok')?.width).toBe(0)
    expect(frameSizeFromMessage(msg({ width: Infinity }), 'tok')?.width).toBe(0)
    expect(frameSizeFromMessage(msg({ width: -10 }), 'tok')?.width).toBe(0)
  })

  it('rejects wrong type, wrong token, and hostile shapes', () => {
    expect(frameSizeFromMessage(msg({ type: 'other' }), 'tok')).toBeNull()
    expect(frameSizeFromMessage(msg({ token: 'stolen' }), 'tok')).toBeNull()
    expect(frameSizeFromMessage(msg({ height: 'tall' }), 'tok')).toBeNull()
    expect(frameSizeFromMessage(msg({ height: Infinity }), 'tok')).toBeNull()
    expect(frameSizeFromMessage(msg({ height: -5 }), 'tok')).toBeNull()
    expect(frameSizeFromMessage(null, 'tok')).toBeNull()
    expect(frameSizeFromMessage('str', 'tok')).toBeNull()
  })
})
