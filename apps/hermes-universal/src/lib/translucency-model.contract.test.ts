/**
 * The drift pin for the vendored translucency model.
 *
 * `lib/translucency-model.ts` is a COPY of `apps/shared/src/translucency.ts`
 * (universal imports nothing from `apps/shared`). Byte identity could never
 * hold — this workspace's eslint sorts members and prettier reformats — so the
 * pin is semantic: every exported name, every numeric constant, and the
 * defaults table have to agree.
 *
 * It FAILS rather than skips when the shared file is missing or has changed
 * shape. A guard that quietly opts itself out is a guard that is not there.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import * as vendored from './translucency-model'

const SHARED = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../shared/src/translucency.ts')

/**
 * Not vendored on purpose (see the module header): on Electron these are static
 * platform facts, on universal they are a runtime question Rust answers through
 * `appearance_capabilities`. Anything else that stops being vendored has to be
 * argued for here.
 */
const NOT_VENDORED = new Set(['glassSupportedOn', 'translucencySupportedOn'])

function sharedSource(): ts.SourceFile {
  const text = readFileSync(SHARED, 'utf8')

  return ts.createSourceFile(SHARED, text, ts.ScriptTarget.ESNext, true)
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
}

/** Every name the shared module exports, from the AST rather than a grep. */
function exportedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()

  for (const statement of source.statements) {
    if (!isExported(statement)) {
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text)
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text)
    }
  }

  return names
}

/** The initializer of a top-level `const`, exported or not. */
function declaration(source: ts.SourceFile, name: string): ts.Expression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }

    for (const declared of statement.declarationList.declarations) {
      if (ts.isIdentifier(declared.name) && declared.name.text === name && declared.initializer) {
        return declared.initializer
      }
    }
  }

  throw new Error(`${name} is gone from ${SHARED} — the vendored model has lost its source of truth`)
}

/** Evaluate the literal-only expressions this file's constants are made of. */
function literalValue(node: ts.Expression): unknown {
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return literalValue(node.expression)
  }

  if (ts.isNumericLiteral(node)) {
    return Number(node.text)
  }

  if (ts.isStringLiteral(node)) {
    return node.text
  }

  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    return -(literalValue(node.operand) as number)
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(element => literalValue(element))
  }

  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {}

    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`unsupported object member in ${SHARED}`)
      }

      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null

      if (key === null) {
        throw new Error(`unsupported key in ${SHARED}`)
      }

      out[key] = literalValue(property.initializer)
    }

    return out
  }

  throw new Error(`unsupported literal kind ${ts.SyntaxKind[node.kind]} in ${SHARED}`)
}

describe('translucency-model is pinned to apps/shared', () => {
  it('reads the shared file (a missing source is a failure, never a skip)', () => {
    expect(() => sharedSource()).not.toThrow()
    expect(readFileSync(SHARED, 'utf8').length).toBeGreaterThan(0)
  })

  it('exports every name the shared module does, minus the two documented omissions', () => {
    const shared = exportedNames(sharedSource())

    expect(shared.size).toBeGreaterThan(20)

    for (const name of NOT_VENDORED) {
      expect([...shared]).toContain(name)
    }

    const expected = [...shared].filter(name => !NOT_VENDORED.has(name)).sort()
    // Type-only exports vanish at runtime, so runtime keys are the value half;
    // the type half is pinned by the typecheck (this file imports the module).
    const runtime = new Set(Object.keys(vendored))
    const missing = expected.filter(name => !runtime.has(name) && !isTypeOnly(name))

    expect(missing).toEqual([])
    expect([...runtime].filter(name => !shared.has(name))).toEqual([])
  })

  it('carries every numeric constant unchanged', () => {
    const source = sharedSource()

    const numeric = [
      'TRANSLUCENCY_MIN',
      'TRANSLUCENCY_MAX',
      'TRANSLUCENCY_STEP',
      'TRANSLUCENCY_OPACITY_FLOOR',
      'TRANSLUCENCY_CURVE',
      'WINDOWS_GLASS_MIN_BUILD'
    ] as const

    for (const name of numeric) {
      expect([name, literalValue(declaration(source, name))]).toEqual([name, vendored[name]])
    }
  })

  it('carries the ladders and the frost → backdrop mapping unchanged', () => {
    const source = sharedSource()

    expect(literalValue(declaration(source, 'GLASS_MATERIALS'))).toEqual([...vendored.GLASS_MATERIALS])
    expect(literalValue(declaration(source, 'GLASS_SCOPES'))).toEqual([...vendored.GLASS_SCOPES])
    expect(literalValue(declaration(source, 'WINDOWS_BACKGROUND_MATERIALS'))).toEqual([
      ...vendored.WINDOWS_BACKGROUND_MATERIALS
    ])
    expect(literalValue(declaration(source, 'DEFAULT_GLASS_MATERIAL'))).toBe(vendored.DEFAULT_GLASS_MATERIAL)
    expect(literalValue(declaration(source, 'DEFAULT_GLASS_SCOPE'))).toBe(vendored.DEFAULT_GLASS_SCOPE)

    const mapping = literalValue(declaration(source, 'WINDOWS_MATERIAL_BY_FROST')) as Record<string, string>

    for (const rung of vendored.GLASS_MATERIALS) {
      expect([rung, mapping[rung]]).toEqual([
        rung,
        vendored.backgroundMaterialFor({
          fade: 0,
          intensity: 1,
          material: rung,
          mode: 'glass',
          scope: 'window'
        })
      ])
    }
  })

  it('carries the per-appearance defaults table unchanged', () => {
    const defaults = literalValue(declaration(sharedSource(), 'DEFAULT_VALUES')) as Record<
      'mac' | 'windows',
      Record<'dark' | 'light', unknown>
    >

    expect(defaults.mac.light).toEqual(vendored.defaultTranslucencyValues('light', false))
    expect(defaults.mac.dark).toEqual(vendored.defaultTranslucencyValues('dark', false))
    expect(defaults.windows.light).toEqual(vendored.defaultTranslucencyValues('light', true))
    expect(defaults.windows.dark).toEqual(vendored.defaultTranslucencyValues('dark', true))
  })
})

/** Names the shared module exports as types only — nothing to compare at runtime. */
function isTypeOnly(name: string): boolean {
  return [
    'Appearance',
    'GlassMaterial',
    'GlassScope',
    'TranslucencyBook',
    'TranslucencyMode',
    'TranslucencyState',
    'TranslucencyValues',
    'WindowsBackgroundMaterial'
  ].includes(name)
}
