// About dialog. Opened from the title bar; shows the app version + the
// catalog "as of" date + links to the source repos and the marketing
// site. Closed via the [×] or click-outside.

import { BrowserOpenURL } from '../wailsjs/runtime/runtime'
import type { main } from '../wailsjs/go/models'

type Props = {
  version: main.VersionInfo | null
  onClose: () => void
}

export function AboutDialog({ version, onClose }: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <header className="border-b border-border px-6 py-5">
          <p className="eyebrow">About</p>
          <h2 id="about-title" className="mt-1 text-xl font-semibold tracking-tight">
            Blueprint
          </h2>
          {version && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              v{version.app} · catalog {version.catalogAsOf} · {version.modelCount} models
            </p>
          )}
        </header>
        <div className="space-y-3 px-6 py-5 text-sm">
          <p>
            Run open LLMs on your own hardware. Built and maintained by{' '}
            <ExternalLink href="https://inspireailab.com">Inspire AI Lab</ExternalLink>.
          </p>
          <p className="text-muted-foreground">
            Apache 2.0. Free, no telemetry, no account. The consulting practice funds it.
          </p>
        </div>
        <div className="grid gap-2 border-t border-border px-6 py-4 sm:grid-cols-3">
          <LinkButton href="https://github.com/inspireailab-admin/blueprint-app">
            App source
          </LinkButton>
          <LinkButton href="https://github.com/inspireailab-admin/blueprint">
            CLI / kernel
          </LinkButton>
          <LinkButton href="https://inspireailab.com">Marketing site</LinkButton>
        </div>
        <div className="flex justify-end border-t border-border px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => BrowserOpenURL(href)}
      className="text-primary underline decoration-border underline-offset-2 transition hover:decoration-primary"
    >
      {children}
    </button>
  )
}

function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => BrowserOpenURL(href)}
      className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
    >
      {children}
    </button>
  )
}
