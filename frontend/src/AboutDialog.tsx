// About dialog. Opened from the title bar; shows the app version + the
// catalog "as of" date + links to the source repos and the marketing
// site. Closed via the [Ã—] or click-outside.

import { BrowserOpenURL } from '../wailsjs/runtime/runtime'
import type { main } from '../wailsjs/go/models'

type Props = {
  version: main.VersionInfo | null
  onClose: () => void
  /** Jump to the Maintain tab. Used by the "How to uninstall" row so
   *  users who go looking in About find the Reset action without
   *  having to read the README. */
  onGoToMaintain: () => void
}

export function AboutDialog({ version, onClose, onGoToMaintain }: Props) {
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
              v{version.app} Â· catalog {version.catalogAsOf} Â· {version.modelCount} models
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

        <div className="border-t border-border bg-muted/30 px-6 py-4 text-xs">
          <p className="font-semibold tracking-tight text-foreground">Uninstalling</p>
          <p className="mt-1 text-muted-foreground">
            <b>Data</b> (pulled models + runtime, possibly many GB) lives at
            {' '}<code className="font-mono">~/.blueprint/</code>. Clear it from{' '}
            <button
              type="button"
              onClick={() => {
                onClose()
                onGoToMaintain()
              }}
              className="text-foreground underline decoration-border underline-offset-2 transition hover:decoration-foreground"
            >
              Maintain â†’ Reset Blueprint data
            </button>
            .
          </p>
          <p className="mt-1.5 text-muted-foreground">
            <b>The app binary itself</b> uninstalls the OS-native way: Apps &amp; Features
            on Windows, drag to Trash on macOS, package manager on Linux.
          </p>
        </div>
        <div className="grid gap-2 border-t border-border px-6 py-4 sm:grid-cols-3">
          <LinkButton href="https://github.com/inspireailab-admin/blueprint-app">
            App source
          </LinkButton>
          <LinkButton href="https://github.com/inspireailab-admin/blueprint-cli">
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
