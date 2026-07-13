import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

// Adapted from apps/desktop/src/components/error-boundary.tsx: the class is
// verbatim; the fallback is a simple inline one (no ErrorState/useI18n/logs
// deps). FIXME(I1): i18n the fallback strings.

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
  return (
    <div className="fixed inset-0 z-[1500] grid place-items-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
        <p className="text-sm break-words text-muted-foreground">{error.message || 'An unexpected error occurred.'}</p>
        <div className="flex flex-col gap-2">
          <Button className="font-semibold" onClick={reset} size="lg">
            Retry
          </Button>
          <Button onClick={() => window.location.reload()} variant="text">
            Reload
          </Button>
        </div>
      </div>
    </div>
  )
}
