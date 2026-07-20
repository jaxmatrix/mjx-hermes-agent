import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button, type buttonVariants } from '@/components/ui/button'
import { type ApprovalChoice, type ApprovalRequest, respondApproval } from '@/store/chat'

type Variant = NonNullable<Parameters<typeof buttonVariants>[0]>['variant']

const CHOICES: { choice: ApprovalChoice; label: string; variant: Variant }[] = [
  { choice: 'once', label: 'Allow once', variant: 'default' },
  { choice: 'session', label: 'Allow session', variant: 'secondary' },
  { choice: 'always', label: 'Always', variant: 'secondary' },
  { choice: 'deny', label: 'Deny', variant: 'destructive' }
]

export function ApprovalBar({ request }: { request: ApprovalRequest }) {
  return (
    <RequestBar title="Approval needed">
      <RequestBarDescription mono>{request.command || request.description}</RequestBarDescription>
      <RequestBarActions>
        {CHOICES.filter(c => c.choice !== 'always' || request.allowPermanent).map(c => (
          <Button
            key={c.choice}
            onClick={() => {
              void respondApproval(c.choice)
            }}
            size="sm"
            variant={c.variant}
          >
            {c.label}
          </Button>
        ))}
      </RequestBarActions>
    </RequestBar>
  )
}
