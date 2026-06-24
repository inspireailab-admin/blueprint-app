// Welcome overlay — shown once, the first time a user launches the
// app on a given machine. Sets expectations about the lifecycle
// (Plan → Hardware → Deploy → Monitor → Maintain), reassures about
// privacy (everything local, no telemetry, no account), and gets out
// of the way on dismiss.

import { useEffect, useState } from 'react'
import { FirstRun, MarkFirstRunDone } from '../wailsjs/go/main/App'

export function WelcomeOverlay() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    FirstRun().then((isFirst) => {
      if (isFirst) setOpen(true)
    })
  }, [])

  if (!open) return null

  const dismiss = async () => {
    await MarkFirstRunDone()
    setOpen(false)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
    >
      <div className="mx-4 w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="border-b border-border px-8 py-6">
          <p className="eyebrow">Welcome</p>
          <h1 id="welcome-title" className="mt-2 text-2xl font-semibold tracking-tight">
            Run open LLMs on your own hardware
          </h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Blueprint walks you through picking a model, sizing the hardware,
            installing the runtime, pulling the weights, and serving the API —
            all on this machine. Nothing leaves it.
          </p>
        </header>

        <div className="grid gap-4 px-8 py-6 sm:grid-cols-5">
          <Step n={1} label="Plan" body="Pick a model from the open catalog that fits your workload." />
          <Step n={2} label="Hardware" body="See the VRAM math and three GPU recommendations." />
          <Step n={3} label="Deploy" body="Install llama.cpp, pull the GGUF, start serving on 127.0.0.1." />
          <Step n={4} label="Monitor" body="Live GPU, VRAM, CPU. Catch problems before they bite." />
          <Step n={5} label="Maintain" body="Update the runtime, swap models, clean up disk." />
        </div>

        <div className="border-t border-border bg-muted/30 px-8 py-4">
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            <Reassurance>Free, no account, no telemetry.</Reassurance>
            <Reassurance>
              Models and runtime install under <code>~/.blueprint/</code>. Override with
              the <code>BLUEPRINT_HOME</code> environment variable.
            </Reassurance>
            <Reassurance>
              The local server runs only while this app is open. Close the window and the
              server stops cleanly.
            </Reassurance>
          </ul>
        </div>

        <div className="flex justify-end gap-3 border-t border-border px-8 py-4">
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            Get started
            <span aria-hidden>→</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function Step({ n, label, body }: { n: number; label: string; body: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Step {n}
      </p>
      <p className="mt-1 text-sm font-semibold tracking-tight">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  )
}

function Reassurance({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden className="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-chart-4" />
      <span>{children}</span>
    </li>
  )
}
