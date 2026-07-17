// STUB — FIXME(chat-port): the desktop CodingStatusRow (branch / worktree
// status + branch-off / convert / switch actions) needs branch RPCs the
// universal gateway does not expose yet (no branch/worktree RPC). Rendered as
// nothing until that backend lands; kept as a file so the composer's import site
// mirrors desktop's structure. FLAG.
//
// Accepts (and ignores) the desktop ChatBar's handler props so index.tsx wires
// up verbatim; every prop is optional so the null render never touches them.
interface CodingStatusRowProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ignored handlers; `any` accepts desktop's typed callbacks
  onBranchOff?: (...args: any[]) => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onConvertBranch?: (...args: any[]) => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onListBranches?: (...args: any[]) => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onOpen?: (...args: any[]) => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onOpenWorktree?: (...args: any[]) => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSwitchBranch?: (...args: any[]) => any
}

export function CodingStatusRow(_props: CodingStatusRowProps = {}) {
  return null
}
