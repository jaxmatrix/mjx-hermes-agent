import { type ApprovalChoice, type ApprovalRequest, respondApproval } from '@/store/chat'

const CHOICES: { choice: ApprovalChoice; label: string; kind: string }[] = [
  { choice: 'once', label: 'Allow once', kind: 'primary' },
  { choice: 'session', label: 'Allow session', kind: 'soft' },
  { choice: 'always', label: 'Always', kind: 'soft' },
  { choice: 'deny', label: 'Deny', kind: 'danger' }
]

export function ApprovalBar({ request }: { request: ApprovalRequest }) {
  return (
    <div className="approval">
      <div className="approval-head">Approval needed</div>
      <div className="approval-desc">{request.command || request.description}</div>
      <div className="approval-actions">
        {CHOICES.filter(c => c.choice !== 'always' || request.allowPermanent).map(c => (
          <button
            key={c.choice}
            className={`btn btn-sm btn-${c.kind}`}
            onClick={() => {
              void respondApproval(c.choice)
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}
