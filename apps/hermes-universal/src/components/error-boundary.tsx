import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

// Adapted from apps/desktop/src/components/error-boundary.tsx: the class is
// verbatim; the fallback is a simple inline one (no ErrorState/logs deps). The
// fallback strings are i18n'd via t.errors.*; note the boundary is mounted above
// I18nProvider, so useI18n resolves to the default (English) catalog on a crash.

export interface ErrorBoundaryFallbackProps {
  error: Error
  reset: () => void
}

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode
  label?: string
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const tag = this.props.label ? `[error-boundary:${this.props.label}]` : '[error-boundary]'
    console.error(tag, error, info.componentStack)
    this.props.onError?.(error, info)
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state

    if (!error) {
      return this.props.children
    }

    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset })
    }

    return <RootErrorFallback error={error} reset={this.reset} />
  }
}

function RootErrorFallback({ error, reset }: ErrorBoundaryFallbackProps) {
  const { t } = useI18n()
  return (
    <div className="fixed inset-0 z-[1500] grid place-items-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-semibold text-foreground">{t.errors.boundaryTitle}</h1>
        <p className="text-sm break-words text-muted-foreground">{error.message || t.errors.boundaryDesc}</p>
        <div className="flex flex-col gap-2">
          <Button className="font-semibold" onClick={reset} size="lg">
            {t.common.retry}
          </Button>
          <Button onClick={() => window.location.reload()} variant="text">
            {t.errors.reloadWindow}
          </Button>
        </div>
      </div>
    </div>
  )
}
