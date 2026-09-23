import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DesktopFsModule from '@/lib/desktop-fs'
import type * as GatewayModule from '@/store/gateway-client'
import type * as NotificationsModule from '@/store/notifications'

const { notify, notifyError, readDesktopDir, readDesktopFileText, requestGateway, writeDesktopFileText } = vi.hoisted(
  () => ({
    notify: vi.fn(),
    notifyError: vi.fn(),
    readDesktopDir: vi.fn(),
    readDesktopFileText: vi.fn(),
    requestGateway: vi.fn(),
    writeDesktopFileText: vi.fn()
  })
)

// Partial mocks throughout: store/connection subscribes to `$gatewayState` at
// import time, and store/projects pulls several other helpers out of each of
// these modules — the real ones have to stay underneath.
vi.mock('@/store/gateway-client', async importOriginal => ({
  ...(await importOriginal<typeof GatewayModule>()),
  requestGateway
}))

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...(await importOriginal<typeof DesktopFsModule>()),
  readDesktopDir,
  readDesktopFileText,
  writeDesktopFileText
}))

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notify,
  notifyError
}))

import type { ProjectInfo } from '@/types/hermes'

import { $activeProjectId, $projects, $projectsRpcAvailable, $projectTree, createProject } from './projects'

const project = (patch: Partial<ProjectInfo> = {}): ProjectInfo => ({
  archived: false,
  board_slug: null,
  color: null,
  created_at: 0,
  description: null,
  folders: [],
  icon: null,
  id: 'p_idea',
  name: 'Idea',
  primary_path: '/www/idea',
  slug: 'idea',
  ...patch
})

// `projects.create` answers with the row; every other call in the flow is the
// background reconcile, which this shape satisfies harmlessly.
const createReturns = (created: ProjectInfo) => {
  requestGateway.mockImplementation(async (method: string) =>
    method === 'projects.create' ? { project: created } : {}
  )
}

// A directory entry as `/api/fs/read-dir` returns it.
const entry = (dir: string, name: string) => ({ isDirectory: false, name, path: `${dir}/${name}` })

beforeEach(() => {
  requestGateway.mockReset()
  writeDesktopFileText.mockReset()
  writeDesktopFileText.mockResolvedValue({ path: '' })
  // Default: the project folder holds no IDEA.md yet.
  readDesktopDir.mockReset()
  readDesktopDir.mockResolvedValue({ entries: [] })
  readDesktopFileText.mockReset()
  notify.mockReset()
  notifyError.mockReset()
  $projects.set([])
  $projectTree.set([])
  $activeProjectId.set(null)
  $projectsRpcAvailable.set(true)
})

describe('createProject → IDEA.md', () => {
  it('writes the idea into the primary folder with a single trailing newline', async () => {
    createReturns(project())

    await createProject({ folders: ['/www/idea'], idea: '  A tool for tools  ', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledTimes(1)
    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/IDEA.md', 'A tool for tools\n')
  })

  it('does not double the newline on an idea that already ends in one', async () => {
    createReturns(project())

    await createProject({ folders: ['/www/idea'], idea: 'Ends in a newline\n', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/IDEA.md', 'Ends in a newline\n')
  })

  it('writes nothing when there is no idea, or only whitespace', async () => {
    createReturns(project())

    await createProject({ folders: ['/www/idea'], name: 'Idea' })
    await createProject({ folders: ['/www/idea'], idea: '   ', name: 'Idea' })

    expect(writeDesktopFileText).not.toHaveBeenCalled()
  })

  it('falls back to the first folder, then to the requested primary path', async () => {
    createReturns(
      project({ folders: [{ added_at: 0, is_primary: true, label: null, path: '/www/first' }], primary_path: null })
    )
    await createProject({ folders: ['/www/first'], idea: 'From folders', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/first/IDEA.md', 'From folders\n')

    createReturns(project({ primary_path: null }))
    await createProject({ idea: 'From input', name: 'Idea', primaryPath: '/www/input' })

    expect(writeDesktopFileText).toHaveBeenLastCalledWith('/www/input/IDEA.md', 'From input\n')
  })

  it('does not double the separator on a folder with a trailing slash', async () => {
    createReturns(project({ primary_path: '/www/idea/' }))

    await createProject({ folders: ['/www/idea/'], idea: 'Trailing slash', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/IDEA.md', 'Trailing slash\n')
  })

  it('writes nothing when the backend reports no folder at all', async () => {
    createReturns(project({ primary_path: null }))

    await createProject({ idea: 'Nowhere to put it', name: 'Idea' })

    expect(writeDesktopFileText).not.toHaveBeenCalled()
  })

  it('appends to an IDEA.md that is already there instead of overwriting it', async () => {
    createReturns(project())
    readDesktopDir.mockResolvedValue({ entries: [entry('/www/idea', 'IDEA.md')] })
    readDesktopFileText.mockResolvedValue({ path: '/www/idea/IDEA.md', text: 'The original brief.\n\n' })

    await createProject({ folders: ['/www/idea'], idea: 'A second thought', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith(
      '/www/idea/IDEA.md',
      'The original brief.\n\n---\n\nA second thought\n'
    )
    expect(notify).toHaveBeenCalledWith({
      kind: 'info',
      message: 'IDEA.md already existed — your idea was appended to it'
    })
  })

  it('appends to a differently-cased idea file rather than shadowing it', async () => {
    createReturns(project())
    readDesktopDir.mockResolvedValue({ entries: [entry('/www/idea', 'Idea.md')] })
    readDesktopFileText.mockResolvedValue({ path: '/www/idea/Idea.md', text: 'Kept' })

    await createProject({ folders: ['/www/idea'], idea: 'Added', name: 'Idea' })

    expect(readDesktopFileText).toHaveBeenCalledWith('/www/idea/Idea.md')
    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/Idea.md', 'Kept\n\n---\n\nAdded\n')
  })

  it('overwrites an existing IDEA.md that holds nothing but whitespace', async () => {
    createReturns(project())
    readDesktopDir.mockResolvedValue({ entries: [entry('/www/idea', 'IDEA.md')] })
    readDesktopFileText.mockResolvedValue({ path: '/www/idea/IDEA.md', text: '  \n\n' })

    await createProject({ folders: ['/www/idea'], idea: 'Fresh start', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/IDEA.md', 'Fresh start\n')
    expect(notify).not.toHaveBeenCalled()
  })

  it('leaves an IDEA.md alone when the read came back truncated or binary', async () => {
    createReturns(project())
    readDesktopDir.mockResolvedValue({ entries: [entry('/www/idea', 'IDEA.md')] })
    readDesktopFileText.mockResolvedValue({ path: '/www/idea/IDEA.md', text: 'head of a huge file', truncated: true })

    await createProject({ folders: ['/www/idea'], idea: 'Not worth the tail', name: 'Idea' })

    expect(writeDesktopFileText).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith({
      kind: 'warning',
      message: 'IDEA.md was left untouched — it is too large or not text'
    })

    notify.mockClear()
    readDesktopFileText.mockResolvedValue({ binary: true, path: '/www/idea/IDEA.md', text: '\u0000' })

    await createProject({ folders: ['/www/idea'], idea: 'Still not', name: 'Idea' })

    expect(writeDesktopFileText).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('writes a fresh file when the folder cannot be listed at all', async () => {
    createReturns(project())
    readDesktopDir.mockRejectedValue(new Error('gateway down'))

    await createProject({ folders: ['/www/idea'], idea: 'Optimistic', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/IDEA.md', 'Optimistic\n')
  })

  it('reports a failed read of the existing file instead of clobbering it', async () => {
    createReturns(project())
    readDesktopDir.mockResolvedValue({ entries: [entry('/www/idea', 'IDEA.md')] })
    const err = new Error('GET /api/fs/read-text → HTTP 403: not readable')
    readDesktopFileText.mockRejectedValue(err)

    await createProject({ folders: ['/www/idea'], idea: 'Denied', name: 'Idea' })

    expect(writeDesktopFileText).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith(err, 'Project created, but IDEA.md could not be saved')
  })

  it('still creates the project when the write fails, and says so', async () => {
    createReturns(project())
    const err = new Error('read-only file system')
    writeDesktopFileText.mockRejectedValue(err)

    await expect(createProject({ folders: ['/www/idea'], idea: 'Doomed', name: 'Idea' })).resolves.toMatchObject({
      id: 'p_idea'
    })

    expect(notifyError).toHaveBeenCalledWith(err, 'Project created, but IDEA.md could not be saved')
  })
})
