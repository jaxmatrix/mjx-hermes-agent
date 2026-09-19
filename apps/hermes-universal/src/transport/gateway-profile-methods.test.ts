import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { PROFILE_METHODS, UNSCOPED_METHODS } from './gateway-profile-methods.generated'

// The generated lists against the wire contract they were read from
// (`apps/shared/src/gateway-contract.openrpc.json`, itself held to
// `tui_gateway/contracts` by `tests/tui_gateway/contracts/test_generated.py`).
// Derived here independently of the generator, so a contract change that is not
// regenerated fails: `node scripts/gen-gateway-profile-methods.mjs`.

interface OpenRpc {
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
  methods: { name: string; params: { schema: { $ref: string } }[] }[]
}

// `import.meta.url` is an http URL under Vite's transform; tests run from the app root.
const CONTRACT = path.resolve(process.cwd(), '../shared/src/gateway-contract.openrpc.json')

describe('the generated profile method lists', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8')) as OpenRpc

  const declares = (method: OpenRpc['methods'][number]) =>
    Object.hasOwn(
      contract.components.schemas[method.params[0].schema.$ref.split('/').pop()!].properties ?? {},
      'profile'
    )

  it('match the wire contract, method for method', () => {
    const names = (keep: boolean) => contract.methods.filter(method => declares(method) === keep).map(m => m.name)

    expect([...PROFILE_METHODS].sort()).toEqual(names(true).sort())
    expect([...UNSCOPED_METHODS].sort()).toEqual(names(false).sort())
  })

  it('read a contract that still says what the client relies on', () => {
    expect(PROFILE_METHODS.has('session.create')).toBe(true)
    expect(PROFILE_METHODS.has('prompt.submit')).toBe(true)
    expect(UNSCOPED_METHODS.has('ping')).toBe(true)
  })
})
