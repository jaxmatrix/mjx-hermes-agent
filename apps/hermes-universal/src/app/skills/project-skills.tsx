import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { getProjectSkills, setProjectSkillsTrust } from '@/hermes'
import { useI18n } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $currentCwd } from '@/store/chat'
import { notifyError } from '@/store/notifications'

/** The project-local skill trust gate, rendered where the skills are.
 *
 *  A repo can vendor skills under `.hermes/skills` / `.agents/skills`; the
 *  agent loads them only from a repo the user has trusted, and a scanner
 *  quarantines the dangerous ones. Until this card the whole decision lived in
 *  `hermes skills trust` — invisible from the app, and unreachable on a phone.
 *
 *  Renders nothing at all unless the current chat's directory is inside a
 *  checkout that actually carries project skills, so it stays out of the way
 *  for the repos (and the users) it does not concern. */
export function ProjectSkillsGate({ profile }: { profile?: null | string }) {
  const { t } = useI18n()
  const p = t.skills.project
  const cwd = useStore($currentCwd)
  const [busy, setBusy] = useState(false)

  const { data, refetch } = useQuery({
    queryKey: ['project-skills', cwd, profile ?? ''],
    queryFn: () => getProjectSkills(cwd, profile),
    staleTime: 30_000
  })

  const root = data?.root

  if (!root || !data || data.skills.length === 0) {
    return null
  }

  const quarantined = data.skills.filter(skill => skill.quarantined).length
  const loaded = data.skills.length - quarantined

  const toggleTrust = async () => {
    setBusy(true)

    try {
      await setProjectSkillsTrust(root, !data.trusted, profile)
      await refetch()
      // Trusting changes which skills the backend serves, so the installed
      // list is stale the moment this lands.
      void queryClient.invalidateQueries({ queryKey: ['skills-list'] })
    } catch (err) {
      notifyError(err, p.title)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border p-2.5',
        data.trusted
          ? 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary)'
          : 'border-(--ui-yellow)/40 bg-(--ui-yellow)/10'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[0.7rem] font-medium text-(--ui-text-secondary)">
          {data.trusted ? p.trustedCount(loaded) : p.untrustedCount(data.skills.length)}
        </div>
        <div className="truncate font-mono text-[0.62rem] text-(--ui-text-quaternary)" title={root}>
          {root}
        </div>
        {quarantined > 0 && (
          <div className="mt-0.5 text-[0.65rem] text-(--ui-yellow)">{p.quarantinedCount(quarantined)}</div>
        )}
        {!data.discovery_enabled && <div className="mt-0.5 text-[0.65rem] text-(--ui-text-tertiary)">{p.disabled}</div>}
      </div>
      <Button disabled={busy} onClick={() => void toggleTrust()} size="xs" variant={data.trusted ? 'text' : 'default'}>
        {data.trusted ? p.untrust : p.trust}
      </Button>
    </div>
  )
}
