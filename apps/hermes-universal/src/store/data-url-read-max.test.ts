import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  $dataUrlReadMaxMb,
  clampDataUrlReadMaxMb,
  DATA_URL_READ_DEFAULT_MAX_MB,
  DATA_URL_READ_MAX_MAX_MB,
  DATA_URL_READ_MIN_MAX_MB,
  dataUrlReadMaxBytes,
  initDataUrlReadMax,
  readCappedFileBase64,
  setDataUrlReadMaxMb
} from './data-url-read-max'

beforeEach(() => {
  invoke.mockReset()
  $dataUrlReadMaxMb.set(DATA_URL_READ_DEFAULT_MAX_MB)
})

// The four values are duplicated three ways on purpose — apps/shared (desktop's
// source), here, and src-tauri/src/data_url_read_max.rs. Universal imports
// nothing from apps/shared and Rust cannot import TypeScript, so a literal
// assertion on each side is what makes a one-sided edit fail instead of
// silently letting Rust enforce 16 while the UI promises 64. The Rust half is
// `data_url_read_max::tests::pins_the_shared_literals`.
describe('the cap constants', () => {
  it('pins the values apps/shared and Rust also declare', () => {
    expect(DATA_URL_READ_DEFAULT_MAX_MB).toBe(16)
    expect(DATA_URL_READ_MIN_MAX_MB).toBe(1)
    expect(DATA_URL_READ_MAX_MAX_MB).toBe(4096)
  })

  it('converts megabytes to bytes the way Rust does', () => {
    expect(dataUrlReadMaxBytes(16)).toBe(16 * 1024 * 1024)
    expect(dataUrlReadMaxBytes(2)).toBe(2 * 1024 * 1024)
  })
})

describe('clampDataUrlReadMaxMb', () => {
  it('falls back to the default for anything not a finite number', () => {
    // Not the floor and not the ceiling: a typo must not silently become 1 MB
    // (every attach refused) or 4 GB (the guard gone).
    expect(clampDataUrlReadMaxMb('sixteen')).toBe(16)
    expect(clampDataUrlReadMaxMb(Number.POSITIVE_INFINITY)).toBe(16)
    expect(clampDataUrlReadMaxMb(undefined)).toBe(16)
  })

  // `Number('')` and `Number(null)` are 0, which is FINITE — so the clamp reads
  // an emptied field as the 1 MB floor, not as "use the default". That is why
  // the Settings row substitutes the default before calling this, and desktop's
  // row does the same; asserting it here stops someone "simplifying" the row.
  it('reads an empty value as the floor, which is why the row special-cases it', () => {
    expect(clampDataUrlReadMaxMb('')).toBe(1)
    expect(clampDataUrlReadMaxMb(null)).toBe(1)
  })

  it('rounds and holds the bounds', () => {
    expect(clampDataUrlReadMaxMb(0)).toBe(1)
    expect(clampDataUrlReadMaxMb(-9)).toBe(1)
    expect(clampDataUrlReadMaxMb(9000)).toBe(4096)
    expect(clampDataUrlReadMaxMb(31.6)).toBe(32)
    expect(clampDataUrlReadMaxMb('24')).toBe(24)
  })
})

describe('setDataUrlReadMaxMb', () => {
  it('clamps optimistically and mirrors the value down to Rust', async () => {
    invoke.mockResolvedValue(4096)

    expect(setDataUrlReadMaxMb(99999)).toBe(4096)
    expect($dataUrlReadMaxMb.get()).toBe(4096)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_data_url_read_max', { maxMb: 4096 }))
  })

  // Rust re-clamps, so it is allowed to disagree. Whatever it answers is what
  // is actually enforced — the row must show that, not what was typed, or the
  // number in the refusal message and the number in Settings drift apart.
  it('takes the cap Rust reports back when it differs', async () => {
    invoke.mockResolvedValue(4096)

    setDataUrlReadMaxMb(32)
    await vi.waitFor(() => expect($dataUrlReadMaxMb.get()).toBe(4096))
  })

  it('keeps the value when there is no Tauri runtime to mirror it to', async () => {
    invoke.mockRejectedValue(new Error('no Tauri'))

    expect(setDataUrlReadMaxMb(24)).toBe(24)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    expect($dataUrlReadMaxMb.get()).toBe(24)
  })
})

// Rust's copy is a plain atomic that boots at the default, so a device
// configured down to 2 MB would enforce 16 for the whole session without this.
it('re-asserts the persisted cap at startup', async () => {
  invoke.mockResolvedValue(2)
  $dataUrlReadMaxMb.set(2)

  initDataUrlReadMax()

  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_data_url_read_max', { maxMb: 2 }))
})

describe('readCappedFileBase64', () => {
  it('passes the payload through untouched on success', async () => {
    invoke.mockResolvedValue('AQID')

    await expect(readCappedFileBase64('/work/notes.txt')).resolves.toBe('AQID')
    expect(invoke).toHaveBeenCalledWith('read_capped_file_base64', { path: '/work/notes.txt' })
  })

  // The whole point of the typed error: the user cannot retry their way out of
  // this one, they have to raise the cap, and nothing else in the UI tells them
  // the number. So the message names it — and names the CURRENT cap, not 16.
  it('turns a too-large refusal into a message naming the current limit', async () => {
    $dataUrlReadMaxMb.set(24)
    invoke.mockRejectedValue({ message: 'file is too large (99 bytes; limit 10 bytes)', tooLarge: true })

    await expect(readCappedFileBase64('/work/huge.png')).rejects.toThrow(/24 MB/)
  })

  // The disagreeing neighbour: an ordinary read failure must NOT be dressed up
  // as a size problem, or a permission error sends the user to change a setting
  // that was never the cause.
  it('keeps a non-size failure as its own message', async () => {
    invoke.mockRejectedValue({ message: 'permission denied', tooLarge: false })

    await expect(readCappedFileBase64('/work/secret.bin')).rejects.toThrow('permission denied')
  })
})
