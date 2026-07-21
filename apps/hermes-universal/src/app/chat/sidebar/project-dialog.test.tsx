// Load the connection/session graph before @/store/projects (→ @/store/gateway)
// so the gateway↔connection import cycle resolves connection-first (see the same
// note in sidebar-content.test.tsx).
import '@/store/session'

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PROJECT_IDEA_TEMPLATES } from '@/lib/project-idea-templates'
import { $projectDialog, closeProjectDialog } from '@/store/projects'

import { ProjectDialog } from './project-dialog'

afterEach(() => closeProjectDialog())

describe('ProjectDialog (create)', () => {
  it('fills the idea from a clicked template chip', () => {
    $projectDialog.set({ mode: 'create' })
    render(<ProjectDialog />)

    const idea = screen.getByPlaceholderText("What's this project about? (saved to IDEA.md)") as HTMLTextAreaElement
    expect(idea.value).toBe('')

    // Six random chips render; click whichever one matched a known template.
    const chip = screen
      .getAllByRole('button')
      .find(b => PROJECT_IDEA_TEMPLATES.some(t => b.textContent?.includes(t.label)))

    expect(chip).toBeTruthy()

    const template = PROJECT_IDEA_TEMPLATES.find(t => chip!.textContent?.includes(t.label))!
    fireEvent.click(chip!)

    expect(idea.value).toBe(template.idea)
  })

  it('shows the empty folders hint and disables Create until a folder is added', () => {
    $projectDialog.set({ mode: 'create' })
    render(<ProjectDialog />)

    expect(screen.getByText('No folders added yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('adds a folder via the manual path input and renders it', () => {
    $projectDialog.set({ mode: 'create' })
    render(<ProjectDialog />)

    fireEvent.change(screen.getByPlaceholderText('Paste a folder path'), { target: { value: '/work/proj' } })
    // In the test env IS_DESKTOP is false, so the native browse button is absent;
    // the only "Add folder" button is the manual one.
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))

    expect(screen.getByText('/work/proj')).toBeInTheDocument()
    expect(screen.getByText('primary')).toBeInTheDocument()
  })
})
