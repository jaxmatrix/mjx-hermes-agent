/**
 * Mobile shell route table — chat catch-all plus contributed workspace pages.
 */

import { Navigate, Route, Routes } from 'react-router'

import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'

import { ChatScreen } from '../chat/chat-screen'
import { contributedRoutes, NEW_CHAT_ROUTE, ROUTES_AREA } from '../routes'

import { LegacySessionRedirect } from './surfaces'

export function WorkspaceRoutes() {
  const routeContributions = contributedRoutes(useContributions(ROUTES_AREA))

  return (
    <Routes>
      <Route element={<ChatScreen />} index />
      <Route element={<ChatScreen />} path=":sessionId" />
      {routeContributions.map(route => (
        <Route
          element={
            <ContribBoundary id={route.key}>
              <ContribRender render={route.render} />
            </ContribBoundary>
          }
          key={route.key}
          path={route.path.slice(1)}
        />
      ))}
      <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="new" />
      <Route element={<LegacySessionRedirect />} path="sessions/:sessionId" />
      <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="*" />
    </Routes>
  )
}
