// Dashboard — the operational home after the Start overlay is dismissed,
// shown when the user already has at least one model on disk. Compact
// status of what's running plus shortcuts into the deeper tabs.
//
// Live snapshots come from the same monitor:snapshot stream Monitor uses;
// StartMonitoring is idempotent on the Go side, so Monitor + Dashboard
// can both be mounted without doubling the polling rate.

import { useEffect, useState } from 'react'
import {
  InstalledModels,
  RuntimeStatus,
  ServerStatus,
  Snapshot,
  StartMonitoring,
  StopMonitoring,
  StopServe,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { main } from '../../wailsjs/go/models'

const POLL_MS = 2000

type GoTo = (tab: 'plan' | 'hardware' | 'optimize' | 'deploy' | 'monitor' | 'maintain') => void

type Props = {
  onGoTo: GoTo
}

export function DashboardExplorer({ onGoTo }: Props) {
  const [installed, setInstalled] = useState<main.InstalledModel[] | null>(null)
  const [runtime, setRuntime] = useState<main.RuntimeStatus | null>(null)
  const [server, setServer] = useState<main.ServerStatus | null>(null)
  const [snap, setSnap] = useState<main.Snapshot | null>(null)

  useEffect(() => {
    void refreshAll()

    const offSnap = EventsOn('monitor:snapshot', (s: main.Snapshot) => setSnap(s))
    const offServe = EventsOn('deploy:serve-status', () => {
      void ServerStatus().then(setServer)
    })

    StartMonitoring(POLL_MS)
    return () => {
      offSnap()
      offServe()
      StopMonitoring()
    }
  }, [])

  async function refreshAll() {
    const [im, rt, srv, sn] = await Promise.all([
      InstalledModels(),
      RuntimeStatus(),
      ServerStatus(),
      Snapshot(),
    ])
    setInstalled(im ?? [])
    setRuntime(rt)
    setServer(srv)
    setSnap(sn)
  }

  const serving = server?.state === 'running'

  return (
    <div className="mt-8 space-y-6">
      <ServerCard
        server={server}
        runtime={runtime}
        onOpenVerify={() => onGoTo('deploy')}
        onStop={async () => {
          await StopServe()
          setServer(await ServerStatus())
        }}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="CPU" value={snap ? `${snap.cpuUtilPct.toFixed(0)}%` : '—'} sub="utilization" />
        <Metric
          label="System RAM"
          value={snap ? `${snap.ramUsedPct.toFixed(0)}%` : '—'}
          sub={snap ? `${humanBytes(snap.ramUsedBytes)} / ${humanBytes(snap.ramTotalBytes)}` : ''}
        />
        <Metric
          label="VRAM"
          value={!snap || snap.gpus.length === 0 ? '—' : `${vramPct(snap).toFixed(0)}%`}
          sub={
            !snap || snap.gpus.length === 0
              ? 'no NVIDIA GPU detected'
              : `${snap.gpus.length} GPU${snap.gpus.length === 1 ? '' : 's'}`
          }
        />
      </div>

      <InstalledModelsCard
        installed={installed}
        serving={serving}
        currentServingId={server?.modelId}
        onPickAnother={() => onGoTo('plan')}
        onDeploy={() => onGoTo('deploy')}
        onMaintain={() => onGoTo('maintain')}
      />

      <ShortcutGrid onGoTo={onGoTo} />
    </div>
  )
}

// ─── Server card ────────────────────────────────────────────────────────

function ServerCard({
  server,
  runtime,
  onOpenVerify,
  onStop,
}: {
  server: main.ServerStatus | null
  runtime: main.RuntimeStatus | null
  onOpenVerify: () => void
  onStop: () => void
}) {
  const running = server?.state === 'running'
  return (
    <section
      className={[
        'overflow-hidden rounded-2xl border shadow-sm',
        running ? 'border-chart-4/40 bg-chart-4/5' : 'border-border bg-card',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-5">
        <div>
          <p className="eyebrow">Server</p>
          {running ? (
            <>
              <p className="mt-1 text-xl font-semibold tracking-tight">
                Serving <span className="font-mono">{server!.modelId}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Quant <b className="text-foreground">{server!.quant}</b>
                <span className="mx-2 opacity-40">·</span>
                Port <b className="text-foreground">{server!.port}</b>
                <span className="mx-2 opacity-40">·</span>
                PID <b className="text-foreground">{server!.pid}</b>
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-xl font-semibold tracking-tight">Not running</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {runtime?.installed
                  ? 'Runtime is installed. Start a model from the Deploy tab to serve it on localhost.'
                  : 'Runtime not installed yet — go to Deploy to install llama.cpp.'}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {running ? (
            <>
              <button
                type="button"
                onClick={onOpenVerify}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                Open Verify chat
              </button>
              <button
                type="button"
                onClick={onStop}
                className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted"
              >
                Stop
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onOpenVerify}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              Go to Deploy
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Metric tile ────────────────────────────────────────────────────────

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <section className="rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </section>
  )
}

// ─── Installed models ───────────────────────────────────────────────────

function InstalledModelsCard({
  installed,
  serving,
  currentServingId,
  onPickAnother,
  onDeploy,
  onMaintain,
}: {
  installed: main.InstalledModel[] | null
  serving: boolean
  currentServingId?: string
  onPickAnother: () => void
  onDeploy: () => void
  onMaintain: () => void
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Installed models</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            On-disk weight files that the runtime can load.
          </p>
        </div>
        <button
          type="button"
          onClick={onPickAnother}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
        >
          + Pick another
        </button>
      </header>

      {installed === null ? (
        <div className="px-6 py-8 text-sm text-muted-foreground">Loading…</div>
      ) : installed.length === 0 ? (
        <div className="px-6 py-8 text-sm text-muted-foreground">
          No models on disk yet. Pick one from the Plan tab.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {installed.map((m) => {
            const isServing = serving && currentServingId === m.id
            return (
              <li
                key={`${m.id}:${m.quant}`}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-6 py-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold tracking-tight">
                    {m.displayName}
                    {isServing && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-chart-4/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-chart-4">
                        <span className="h-1.5 w-1.5 rounded-full bg-chart-4" />
                        Serving
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {m.fileName}
                  </p>
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {m.quant}
                  <span className="mx-2 opacity-40">·</span>
                  {humanBytes(m.bytesSize)}
                </span>
                <button
                  type="button"
                  onClick={isServing ? onMaintain : onDeploy}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
                >
                  {isServing ? 'Manage' : 'Serve'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ─── Shortcuts ──────────────────────────────────────────────────────────

function ShortcutGrid({ onGoTo }: { onGoTo: GoTo }) {
  const cards: { id: 'plan' | 'hardware' | 'optimize' | 'monitor' | 'maintain'; label: string; body: string }[] = [
    { id: 'plan', label: 'Plan', body: 'Browse the model catalog.' },
    { id: 'hardware', label: 'Hardware', body: 'Re-size for a different workload.' },
    { id: 'optimize', label: 'Optimize', body: 'Tune quant, context, GPU layers.' },
    { id: 'monitor', label: 'Monitor', body: 'Detailed live system stats.' },
    { id: 'maintain', label: 'Maintain', body: 'Updates, swap, restart, logs.' },
  ]
  return (
    <section>
      <p className="eyebrow">Jump to</p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onGoTo(c.id)}
              className="block h-full w-full rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/50 hover:shadow-sm"
            >
              <p className="text-sm font-semibold tracking-tight">{c.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{c.body}</p>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── Utils ──────────────────────────────────────────────────────────────

function vramPct(snap: main.Snapshot): number {
  const used = snap.gpus.reduce((a, g) => a + g.vramUsedMB, 0)
  const total = snap.gpus.reduce((a, g) => a + g.vramTotalMB, 0)
  return total > 0 ? (used / total) * 100 : 0
}

function humanBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
