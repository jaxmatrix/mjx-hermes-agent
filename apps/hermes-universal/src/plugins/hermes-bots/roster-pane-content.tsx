import { Button, Codicon, DisclosureCaret, GlyphSpinner, PanelEmpty, RowButton } from '@hermes/plugin-sdk'
import { useEffect, useState, type ReactNode, type RefObject } from 'react'

import { useNearBottomLoad } from '@/app/chat/sidebar/use-near-bottom-load'

import type { useRoster } from './data'
import { $showHiddenBots } from './hidden-bots'
import type { useBots } from './i18n'
import type { deriveRosterPresentation, deriveRosterRows } from './roster-pane-derivation'
import type { rosterSectionRenderers } from './roster-pane-sections'
import type { rosterGatewayOptions } from './roster-sections'
import {
  nextRosterWindow,
  ROSTER_WINDOW_INITIAL,
  takeGatewaySections
} from './roster-window'
import type { RosterRow } from './types'

interface RosterContentProps {
  b: ReturnType<typeof useBots>
  staleNotice: string | number | null
  isLoading: boolean
  initialRosterLoading: boolean
  roster: RosterRow[]
  error: ReturnType<typeof useRoster>['error']
  gatewayUp: boolean
  refetch: ReturnType<typeof useRoster>['refetch']
  allBotsHidden: boolean
  hiddenExpanded: boolean
  rosterRows: ReturnType<typeof deriveRosterRows>['rosterRows']
  matchingHiddenBots: RosterRow[]
  query: string
  selectedGateway: ReturnType<typeof rosterGatewayOptions>[number] | undefined
  showGatewaySections: boolean
  sortedGroupRows: ReturnType<typeof deriveRosterRows>['sortedGroupRows']
  gatewaySections: ReturnType<typeof deriveRosterRows>['gatewaySections']
  showHiddenSection: boolean
  hiddenSectionRef: RefObject<HTMLDivElement | null>
  hasRosterConstraint: boolean
  hiddenBots: RosterRow[]
  showHiddenRows: boolean
  hiddenGatewaySections: ReturnType<typeof deriveRosterPresentation>['hiddenGatewaySections']
  renderBotRow: (bot: RosterRow, keyPrefix?: string) => ReactNode
  renderGroupChatSection: ReturnType<typeof rosterSectionRenderers>['renderGroupChatSection']
  renderGatewaySection: ReturnType<typeof rosterSectionRenderers>['renderGatewaySection']
  renderUserSections: ReturnType<typeof rosterSectionRenderers>['renderUserSections']
  renderHiddenGatewaySection: ReturnType<typeof rosterSectionRenderers>['renderHiddenGatewaySection']
}

function BotsRosterScrollPort({
  resetKey,
  rowCount,
  children
}: {
  resetKey: string
  rowCount: number
  children: (visibleCount: number) => ReactNode
}) {
  const [visibleCount, setVisibleCount] = useState(ROSTER_WINDOW_INITIAL)

  useEffect(() => {
    setVisibleCount(ROSTER_WINDOW_INITIAL)
  }, [resetKey])

  const onScroll = useNearBottomLoad({
    hasMore: visibleCount < rowCount,
    loadGeneration: visibleCount,
    loading: false,
    onLoadMore: () => setVisibleCount(prev => nextRosterWindow(prev, rowCount))
  })

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      data-slot="bots-roster"
      onScroll={onScroll}
    >
      <div className="grid w-full min-w-0 gap-0.5 px-1.5 pb-2">{children(visibleCount)}</div>
    </div>
  )
}

export function renderRosterContent({
  b,
  staleNotice,
  isLoading,
  initialRosterLoading,
  roster,
  error,
  gatewayUp,
  refetch,
  allBotsHidden,
  hiddenExpanded,
  rosterRows,
  matchingHiddenBots,
  query,
  selectedGateway,
  showGatewaySections,
  sortedGroupRows,
  gatewaySections,
  showHiddenSection,
  hiddenSectionRef,
  hasRosterConstraint,
  hiddenBots,
  showHiddenRows,
  hiddenGatewaySections,
  renderBotRow,
  renderGroupChatSection,
  renderGatewaySection,
  renderUserSections,
  renderHiddenGatewaySection
}: RosterContentProps) {
  const gatewayBotCount = gatewaySections.sections.reduce((n, section) => n + section.rows.length, 0)
  const hiddenCount = showHiddenRows ? matchingHiddenBots.length : 0
  const rowCount = showGatewaySections
    ? sortedGroupRows.length + gatewayBotCount + hiddenCount
    : rosterRows.length + hiddenCount
  const resetKey = [
    query,
    selectedGateway?.connectionId ?? '',
    showGatewaySections ? 'gw' : 'flat',
    String(rowCount)
  ].join('|')

  return (
    <>
      {staleNotice ? (
        <div className="mx-2.5 mb-1 rounded-md bg-(--chrome-action-hover) px-2 py-1.5 text-[0.6875rem] text-(--ui-text-tertiary)">
          {staleNotice}
        </div>
      ) : null}
      {(isLoading || initialRosterLoading) && !roster.length ? (
        <div className="flex flex-1 items-center justify-center">
          <GlyphSpinner className="text-(--ui-text-tertiary)" spinner="breathe" />
        </div>
      ) : error && !roster.length ? (
        <div className="grid gap-2 px-3 py-4 text-xs text-(--ui-text-tertiary)">
          <div>
            {gatewayUp
              ? b.roster.rosterUnavailable(error instanceof Error ? error.message : 'gateway error')
              : b.roster.waitingForGateway}
          </div>
          <Button className="justify-self-start" onClick={() => void refetch()} size="sm" variant="secondary">
            {b.roster.retryNow}
          </Button>
        </div>
      ) : roster.length === 0 ? (
        <PanelEmpty description={b.roster.emptyDesc} icon="hubot" title={b.roster.emptyTitle} />
      ) : allBotsHidden && !hiddenExpanded ? (
        <div className="grid content-start gap-2 px-3 py-4 text-xs text-(--ui-text-tertiary)">
          <div className="flex items-center gap-1.5 font-medium text-(--ui-text-secondary)">
            <Codicon className="text-(--ui-text-quaternary)" name="eye-closed" />
            {b.roster.allHidden}
          </div>
          <p className="leading-relaxed">{b.roster.allHiddenDesc}</p>
          <Button
            className="justify-self-start"
            onClick={() => $showHiddenBots.set(true)}
            size="sm"
            variant="secondary"
          >
            {b.roster.showHidden}
          </Button>
        </div>
      ) : rosterRows.length === 0 && matchingHiddenBots.length === 0 ? (
        <div aria-live="polite" className="flex min-h-0 flex-1 flex-col" role="status">
          <PanelEmpty
            description={
              query.trim()
                ? selectedGateway
                  ? b.roster.noMatchQueryOn(query.trim(), String(selectedGateway.label))
                  : b.roster.noMatchQuery(query.trim())
                : selectedGateway
                  ? b.roster.noMatchFiltersOn(String(selectedGateway.label))
                  : b.roster.noMatchFilters
            }
            icon="search"
          />
        </div>
      ) : (
        <BotsRosterScrollPort resetKey={resetKey} rowCount={rowCount}>
          {visibleCount => {
            const groupBudget = showGatewaySections ? Math.min(sortedGroupRows.length, visibleCount) : 0
            const afterGroups = Math.max(0, visibleCount - groupBudget)

            if (showGatewaySections) {
              const { remaining, sections: visibleGateway } = takeGatewaySections(
                gatewaySections.sections,
                afterGroups
              )
              const hiddenBudget = showHiddenRows ? remaining : 0
              const visibleHidden = matchingHiddenBots.slice(0, hiddenBudget)
              const { sections: visibleHiddenGateway } = takeGatewaySections(
                hiddenGatewaySections.sections,
                hiddenBudget
              )

              return (
                <>
                  {groupBudget > 0
                    ? renderGroupChatSection(sortedGroupRows.slice(0, groupBudget))
                    : null}
                  {visibleGateway.map(renderGatewaySection)}
                  {showHiddenSection ? (
                    <div
                      className="mt-1 border-t border-(--ui-stroke-tertiary) pt-1"
                      key="hidden-section"
                      ref={hiddenSectionRef}
                    >
                      {hasRosterConstraint ? (
                        <div className="flex w-full items-center gap-1 px-2 py-1.5 text-[0.6875rem] font-medium text-(--ui-text-tertiary)">
                          <Codicon name="eye-closed" />
                          <span>Hidden</span>
                          <span className="text-(--ui-text-quaternary)">{matchingHiddenBots.length}</span>
                        </div>
                      ) : (
                        <RowButton
                          aria-expanded={hiddenExpanded}
                          className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-start text-[0.6875rem] font-medium text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground"
                          onClick={() => $showHiddenBots.set(!hiddenExpanded)}
                        >
                          <DisclosureCaret open={hiddenExpanded} />
                          <span>Hidden</span>
                          <span className="text-(--ui-text-quaternary)">{hiddenBots.length}</span>
                        </RowButton>
                      )}
                      {showHiddenRows ? (
                        matchingHiddenBots.length ? (
                          hiddenGatewaySections.sectioned ? (
                            visibleHiddenGateway.map(renderHiddenGatewaySection)
                          ) : (
                            visibleHidden.map((bot: RosterRow) => renderBotRow(bot, 'hidden:'))
                          )
                        ) : (
                          <div className="px-2 py-2 text-xs text-(--ui-text-quaternary)">{b.roster.noHiddenMatch}</div>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </>
              )
            }

            const visibleRows = rosterRows.slice(0, visibleCount)
            const hiddenBudget = Math.max(0, visibleCount - visibleRows.length)
            const visibleHidden = matchingHiddenBots.slice(0, hiddenBudget)

            return (
              <>
                {renderUserSections(visibleRows)}
                {showHiddenSection ? (
                  <div
                    className="mt-1 border-t border-(--ui-stroke-tertiary) pt-1"
                    key="hidden-section"
                    ref={hiddenSectionRef}
                  >
                    {hasRosterConstraint ? (
                      <div className="flex w-full items-center gap-1 px-2 py-1.5 text-[0.6875rem] font-medium text-(--ui-text-tertiary)">
                        <Codicon name="eye-closed" />
                        <span>Hidden</span>
                        <span className="text-(--ui-text-quaternary)">{matchingHiddenBots.length}</span>
                      </div>
                    ) : (
                      <RowButton
                        aria-expanded={hiddenExpanded}
                        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-start text-[0.6875rem] font-medium text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground"
                        onClick={() => $showHiddenBots.set(!hiddenExpanded)}
                      >
                        <DisclosureCaret open={hiddenExpanded} />
                        <span>Hidden</span>
                        <span className="text-(--ui-text-quaternary)">{hiddenBots.length}</span>
                      </RowButton>
                    )}
                    {showHiddenRows ? (
                      matchingHiddenBots.length ? (
                        visibleHidden.map((bot: RosterRow) => renderBotRow(bot, 'hidden:'))
                      ) : (
                        <div className="px-2 py-2 text-xs text-(--ui-text-quaternary)">{b.roster.noHiddenMatch}</div>
                      )
                    ) : null}
                  </div>
                ) : null}
              </>
            )
          }}
        </BotsRosterScrollPort>
      )}
    </>
  )
}
