// Start tab — the persistent landing page. Unlike the WelcomeOverlay
// (one-time on first launch), this tab is always there as the user's
// home base: lifecycle overview at the top, live system status in the
// middle, and a context-aware primary CTA that points wherever the
// user should go next based on what they've done so far.

import { useEffect, useState } from 'react'
import {
  RuntimeStatus,
  ServerStatus,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { Model } from '../planner/types'

type ServerStatusValue = {
  state: 'stopped' | 'starting' | 'running'
  modelId?: string
  quant?: string
}

type RuntimeStatusValue = {
  installed: boolean
  version: string
  binPath: string
}

type Props = {
  selectedModel: Model | null
  onGoTo: (
    tab: 'plan' | 'hardware' | 'optimize' | 'deploy' | 'monitor' | 'maintain',
  ) => void
}

export function StartExplorer({ selectedModel, onGoTo }: Props) {
  const [runtime, setRuntime] = useState<RuntimeStatusValue | null>(null)
  const [server, setServer] = useState<ServerStatusValue>({ state: 'stopped' })

  useEffect(() => {
    RuntimeStatus().then((r) => setRuntime(r as RuntimeStatusValue))
    ServerStatus().then((s) => setServer(s as ServerStatusValue))
    const off = EventsOn('deploy:serve-status', (s: ServerStatusValue) => setServer(s))
    return () => {
      off()
    }
  }, [])

  return (
    <div className="mt-8 space-y-8">
      <Hero />
      <Lifecycle />
      <Status
        selectedModel={selectedModel}
        runtime={runtime}
        server={server}
        onGoTo={onGoTo}
      />
    </div>
  )
}

// ─── Hero ───────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="rounded-2xl border border-border bg-card p-8 shadow-sm">
      <p className="eyebrow">Welcome</p>
      <h2 className="mt-2 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
        Run open LLMs on your own hardware
      </h2>
      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        Blueprint walks you through picking a model, sizing the hardware, optimizing
        the runtime parameters, installing everything, serving the API, and monitoring
        it — all on this machine. Nothing leaves the box, no account, no telemetry.
      </p>
    </section>
  )
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

const STEPS = [
  { tab: 'plan', label: 'Plan', body: 'Pick a model from the open catalog.' },
  { tab: 'hardware', label: 'Hardware', body: 'See VRAM math and tier recommendations.' },
  { tab: 'optimize', label: 'Optimize', body: 'Choose quant, context, GPU layers.' },
  { tab: 'deploy', label: 'Deploy', body: 'Install runtime, pull weights, start serve.' },
  { tab: 'monitor', label: 'Monitor', body: 'Live GPU / VRAM / CPU / throughput.' },
  { tab: 'maintain', label: 'Maintain', body: 'Update, swap, clean up.' },
] as const

function Lifecycle() {
  return (
    <section>
      <p className="eyebrow">The lifecycle</p>
      <h3 className="mt-2 text-balance text-xl font-semibold tracking-tight">
        Six steps, in order, all in one app
      </h3>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((s, i) => (
          <li
            key={s.tab}
            className="rounded-2xl border border-border bg-card p-5 shadow-sm"
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Step {i + 1}
            </p>
            <p className="mt-1 text-sm font-semibold tracking-tight">{s.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── Status + next-step CTA ────────────────────────────────────────────

type CTA = { label: string; tab: Props['onGoTo'] extends (t: infer T) => void ? T : never; explainer: string }

function Status({
  selectedModel,
  runtime,
  server,
  onGoTo,
}: {
  selectedModel: Model | null
  runtime: RuntimeStatusValue | null
  server: ServerStatusValue
  onGoTo: Props['onGoTo']
}) {
  const cta = nextStep(selectedModel, runtime, server)
  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <p className="eyebrow">Where you are</p>
      <ul className="mt-3 space-y-2 text-sm">
        <StatusRow
          ok={!!selectedModel}
          okText={`Selected: ${selectedModel?.displayName ?? ''}`}
          notOkText="No model selected yet"
        />
        <StatusRow
          ok={!!runtime?.installed}
          okText={`Runtime: llama.cpp ${runtime?.version}`}
          notOkText="llama.cpp not installed"
        />
        <StatusRow
          ok={server.state === 'running'}
          okText={`Server running on 127.0.0.1:8080 (${server.modelId} ${server.quant?.toUpperCase() ?? ''})`}
          notOkText={server.state === 'starting' ? 'Server starting…' : 'No server running'}
        />
      </ul>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">{cta.explainer}</p>
        <button
          type="button"
          onClick={() => onGoTo(cta.tab)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          {cta.label}
          <span aria-hidden>→</span>
        </button>
      </div>
    </section>
  )
}

function StatusRow({
  ok,
  okText,
  notOkText,
}: {
  ok: boolean
  okText: string
  notOkText: string
}) {
  return (
    <li className="flex items-baseline gap-2">
      <span
        aria-hidden
        className={[
          'mt-1 inline-flex h-2 w-2 shrink-0 rounded-full',
          ok ? 'bg-chart-4' : 'bg-muted-foreground/40',
        ].join(' ')}
      />
      <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>
        {ok ? okText : notOkText}
      </span>
    </li>
  )
}

function nextStep(
  selectedModel: Model | null,
  runtime: RuntimeStatusValue | null,
  server: ServerStatusValue,
): CTA {
  if (server.state === 'running') {
    return {
      tab: 'deploy',
      label: 'Open the Verify chat',
      explainer: 'Your server is live. Talk to it from the Deploy tab.',
    }
  }
  if (!selectedModel) {
    return {
      tab: 'plan',
      label: 'Pick a model',
      explainer: 'Start by browsing the catalog and picking what fits your workload.',
    }
  }
  if (!runtime?.installed) {
    return {
      tab: 'deploy',
      label: 'Install the runtime',
      explainer: `Got ${selectedModel.displayName}. Install llama.cpp and pull the weights to run it.`,
    }
  }
  return {
    tab: 'deploy',
    label: 'Start the server',
    explainer: `Runtime is in place. Pull ${selectedModel.displayName} weights and serve.`,
  }
}
