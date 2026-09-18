import { useEffect } from 'react'
import { useNavigate } from 'react-router'

import { bindNavigate } from './route-nav'

export function RouterNavBridge() {
  const navigate = useNavigate()
  useEffect(() => {
    bindNavigate(navigate)
  }, [navigate])

  return null
}
