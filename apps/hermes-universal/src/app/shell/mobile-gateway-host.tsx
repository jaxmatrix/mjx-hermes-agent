import { type ReactNode } from 'react'

import { ContribWiring } from '@/app/contrib/wiring'

interface MobileGatewayHostProps {
  children: ReactNode
}

/** Phone root hosts ContribWiring so chatRoutes / useRouteResume share one gateway. */
export function MobileGatewayHost({ children }: MobileGatewayHostProps) {
  return <ContribWiring>{children}</ContribWiring>
}
