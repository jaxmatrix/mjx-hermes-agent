/**
 * ROUTINES — cron, scoped to the selected bot.
 *
 * The pane exists only while the BOTS tab is on screen (`host.paneVisibility`),
 * so a user who never opens Bot Mode never gets a second rail they did not ask
 * for.
 *
 * The rows show the CAPTURED owner, not the current selection: a routine created
 * for `radar` stays radar's, and switching the roster selection must not pause
 * somebody else's job.
 */

import { Button, Codicon, confirmDelete, ErrorState, Input, relativeTime, useValue } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

import { $roster, $selectedBot } from '../store/atoms'
import { $routines, $routinesError, addRoutine, loadRoutines, updateRoutine } from '../store/routines'

export function RoutinesPane() {
  const roster = useValue($roster)
  const selected = useValue($selectedBot)
  const routines = useValue($routines)
  const error = useValue($routinesError)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState('')

  const row = roster.find(candidate => candidate.key === selected)

  const rowKey = row?.key

  useEffect(() => {
    // Keyed on the row's KEY: the row object is re-minted on every roster
    // merge, and re-listing cron on each of those is the 20 s poll this design
    // deleted, reintroduced by accident.
    const current = $roster.get().find(candidate => candidate.key === rowKey)

    if (current) {
      void loadRoutines(current)
    }
  }, [rowKey])

  if (!row) {
    return <p className="p-3 text-xs text-muted-foreground">Pick an agent to see its routines.</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-glass-raised="">
      <p className="px-1 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">Routines · {row.name}</p>

      {error && <ErrorState title="Could not load routines">{error}</ErrorState>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {routines.map(job => (
          <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm" key={job.id}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{job.name || job.prompt || job.id}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {job.schedule_display ?? ''}
                {job.next_run_at ? ` · next ${relativeTime(Date.parse(job.next_run_at))}` : ''}
              </span>
              {job.last_error && <span className="block truncate text-xs text-destructive">{job.last_error}</span>}
            </span>
            <Button
              aria-label={job.enabled ? 'Pause' : 'Resume'}
              onClick={() => void updateRoutine(row, job.id, job.enabled ? 'pause' : 'resume')}
              size="icon"
              variant="ghost"
            >
              <Codicon name={job.enabled ? 'debug-pause' : 'play'} />
            </Button>
            <Button
              aria-label="Delete"
              onClick={async () => {
                if (await confirmDelete(job.name || job.id)) {
                  await updateRoutine(row, job.id, 'remove')
                }
              }}
              size="icon"
              variant="ghost"
            >
              <Codicon name="trash" />
            </Button>
          </div>
        ))}

        {routines.length === 0 && !error && <p className="px-2 py-4 text-xs text-muted-foreground">No routines yet.</p>}
      </div>

      <div className="flex flex-col gap-1">
        <Input onChange={event => setName(event.target.value)} placeholder="Name" value={name} />
        <Input onChange={event => setPrompt(event.target.value)} placeholder="What should it do?" value={prompt} />
        <Input onChange={event => setSchedule(event.target.value)} placeholder="Schedule (e.g. every 30m)" value={schedule} />
        <Button
          disabled={!name.trim() || !prompt.trim() || !schedule.trim()}
          onClick={async () => {
            // The owner is captured HERE, from the row this pane rendered for.
            await addRoutine(row, { name: name.trim(), prompt: prompt.trim(), schedule: schedule.trim() })
            setName('')
            setPrompt('')
            setSchedule('')
          }}
          size="sm"
        >
          <Codicon name="add" /> Add routine
        </Button>
      </div>
    </div>
  )
}
