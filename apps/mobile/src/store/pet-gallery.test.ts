import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))

import { requestGateway } from '@/store/gateway'

import { $petGallery, $petGalleryStatus, adoptPet, loadPetGallery, setPetEnabled } from './pet-gallery'
import type { PetGallery } from './pet-gallery'

const rpc = vi.mocked(requestGateway)

const gallery = (over: Partial<PetGallery> = {}): PetGallery => ({
  enabled: false,
  active: '',
  pets: [
    { slug: 'cat', displayName: 'Cat', installed: true },
    { slug: 'dog', displayName: 'Dog', installed: false, generated: true }
  ],
  ...over
})

describe('pet-gallery store', () => {
  beforeEach(() => {
    rpc.mockReset()
    $petGallery.set(null)
    $petGalleryStatus.set('idle')
  })
  afterEach(() => $petGallery.set(null))

  it('loads local then the full gallery', async () => {
    rpc.mockImplementation(async (method: string) => {
      if (method === 'pet.gallery') return gallery() as never
      if (method === 'pet.info') return { enabled: false } as never
      return {} as never
    })
    await loadPetGallery()
    expect($petGalleryStatus.get()).toBe('ready')
    expect($petGallery.get()?.pets.map(p => p.slug)).toEqual(['cat', 'dog'])
  })

  it('marks the backend stale on a missing-method error', async () => {
    rpc.mockRejectedValue(new Error('method not found: pet.gallery'))
    await loadPetGallery()
    expect($petGalleryStatus.get()).toBe('stale')
  })

  it('adopts a pet: selects it + marks active/installed', async () => {
    $petGallery.set(gallery())
    rpc.mockResolvedValue({} as never)
    await adoptPet('dog')
    expect(rpc).toHaveBeenCalledWith('pet.select', { slug: 'dog' })
    const g = $petGallery.get()!
    expect(g.active).toBe('dog')
    expect(g.enabled).toBe(true)
    expect(g.pets.find(p => p.slug === 'dog')?.installed).toBe(true)
  })

  it('disables the pet via pet.disable', async () => {
    $petGallery.set(gallery({ enabled: true, active: 'cat' }))
    rpc.mockResolvedValue({} as never)
    await setPetEnabled(false)
    expect(rpc).toHaveBeenCalledWith('pet.disable')
    expect($petGallery.get()?.enabled).toBe(false)
  })
})
