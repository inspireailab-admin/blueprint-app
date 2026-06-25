// Startup overlay. Shows on every app launch as a full-screen welcome
// covering the whole window. Single dismiss button — once clicked
// there's no way to get back to it from the menu (it isn't a tab),
// the user is routed straight to the Dashboard (if any model is on
// disk) or to Plan (if not).

type Props = {
  onDismiss: () => void
}

export function StartOverlay({ onDismiss }: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="start-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
    >
      <div className="mx-auto w-full max-w-3xl px-6">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <header className="border-b border-border px-8 py-7">
            <p className="eyebrow">Welcome</p>
            <h1 id="start-title" className="mt-2 text-balance text-3xl font-semibold tracking-tight">
              Run open LLMs on your own hardware
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Blueprint walks you through picking a model, sizing the hardware, optimizing
              the runtime parameters, installing everything, serving the API, and monitoring
              it — all on this machine. Nothing leaves the box, no account, no telemetry.
            </p>
          </header>

          <ul className="grid gap-3 px-8 py-7 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <li
                key={s.label}
                className="rounded-xl border border-border bg-background p-4"
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Step {i + 1}
                </p>
                <p className="mt-1 text-sm font-semibold tracking-tight">{s.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ul>

          <div className="flex justify-end border-t border-border bg-muted/30 px-8 py-5">
            <button
              type="button"
              autoFocus
              onClick={onDismiss}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              OK, get started
              <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const STEPS = [
  { label: 'Plan', body: 'Pick a model from the open catalog.' },
  { label: 'Hardware', body: 'See VRAM math and tier recommendations.' },
  { label: 'Optimize', body: 'Choose quant, context window, GPU layers.' },
  { label: 'Deploy', body: 'Install runtime, pull weights, start serving.' },
  { label: 'Monitor', body: 'Live GPU / VRAM / CPU / throughput.' },
  { label: 'Maintain', body: 'Update, swap, clean up.' },
]
