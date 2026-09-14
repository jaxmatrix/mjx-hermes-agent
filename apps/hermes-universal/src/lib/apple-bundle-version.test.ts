import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// gen/apple is tracked and hand-maintained, not regenerated per build. Tauri rewrites
// CFBundleShortVersionString from tauri.conf.json at build time but leaves
// CFBundleVersion to the project template, so a stale value there silently ships:
// a new release carrying the previous build's CFBundleVersion, which App Store Connect
// refuses to accept twice. Bump every key below together with the app version.
const tauriDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src-tauri')
const read = (file: string) => readFileSync(path.join(tauriDir, file), 'utf8')

const appVersion = (JSON.parse(read('tauri.conf.json')) as { version: string }).version

function yamlValue(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\s]+)"?\\s*$`, 'm'))

  return match?.[1]
}

function plistValue(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))

  return match?.[1]
}

describe('the tracked Apple project carries the app version', () => {
  it('reads a real semver out of tauri.conf.json', () => {
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    it(`gen/apple/project.yml ${key} matches tauri.conf.json`, () => {
      expect(yamlValue(read('gen/apple/project.yml'), key)).toBe(appVersion)
    })

    it(`the iOS Info.plist ${key} matches tauri.conf.json`, () => {
      expect(plistValue(read('gen/apple/hermes-universal_iOS/Info.plist'), key)).toBe(appVersion)
    })
  }
})
