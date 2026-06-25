// Dashboard — the operational home after the Start overlay is dismissed,
// shown when the user already has at least one model on disk.
//
// Layout (top → bottom):
//
//   1. Server hero       — running model + uptime + smart CTA
//   2. System tiles      — CPU / RAM / VRAM with rolling sparklines
//   3. GPU breakdown     — per-GPU vram / util / temp
//   4. Chat + sampling   — only when running; runs queries, tunes params live
//   5. Server config     — startup params (model, quant, ctx, GPU layers)
//   6. Performance       — placeholder cards explaining what'll be measured
//   7. Models on disk    — list with serve / manage buttons
//   8. Maintenance       — runtime version, update check, blueprint data
//   9. Recommendations   — computed health insights
//
// Live snapshots come from the same monitor:snapshot stream Monitor uses;
// StartMonitoring is idempotent on the Go side, so Monitor + Dashboard
// can both be mounted without doubling the polling rate.

import { useEffect, useRef, useState } from 'react'
import {
  BlueprintDataSummary,
  InstalledModels,
  LatestRuntimeVersion,
  LlamaMetrics,
  RuntimeStatus,
  ServerStatus,
  Snapshot,
  StartMonitoring,
  StartServe,
  StopMonitoring,
  StopServe,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { main } from '../../wailsjs/go/models'
import { DashboardChat } from './DashboardChat'

const POLL_MS = 2000
const HISTORY_LEN = 60

type GoTo = (tab: 'plan' | 'hardware' | 'optimize' | 'deploy' | 'monitor' | 'maintain') => void

type ServeConfig = {
  quant: string
  ctxSize: number
  nGpuLayers: number
}

type Props = {
  onGoTo: GoTo
  serveConfig: ServeConfig
  /** Called when the Dashboard quick-starts a model so App can remember
   *  the selection (used by Optimize / Deploy if user clicks through). */
  onSelectModel: (modelId: string) => void
}

export function DashboardExplorer({ onGoTo, serveConfig, onSelectModel }: Props) {
  const [installed, setInstalled] = useState<main.InstalledModel[] | null>(null)
  const [runtime, setRuntime] = useState<main.RuntimeStatus | null>(null)
  const [runtimeUpdate, setRuntimeUpdate] = useState<main.RuntimeUpdate | null>(null)
  const [server, setServer] = useState<main.ServerStatus | null>(null)
  const [snap, setSnap] = useState<main.Snapshot | null>(null)
  const [dataSummary, setDataSummary] = useState<main.BlueprintDataSummary | null>(null)
  const [metrics, setMetrics] = useState<main.LlamaMetrics | null>(null)

  // Local "action in flight" flags. Set synchronously on click so the
  // button paints the spinner state immediately — without these the
  // UI would freeze for 4-5 s while StartServe is in flight, since
  // React can't repaint between the click and the await resolving.
  const [startInFlight, setStartInFlight] = useState(false)
  const [stopInFlight, setStopInFlight] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [ramHistory, setRamHistory] = useState<number[]>([])
  const [vramHistory, setVramHistory] = useState<number[]>([])

  // Uptime tracking — client-side, keyed on PID so a restart resets it.
  const uptimePidRef = useRef<number | null>(null)
  const [uptimeStartedAt, setUptimeStartedAt] = useState<number | null>(null)
  const [, setNow] = useState(0) // forces a re-render once a second

  useEffect(() => {
    void refreshAll()

    const offSnap = EventsOn('monitor:snapshot', (s: main.Snapshot) => {
      setSnap(s)
      setCpuHistory((prev) => trim([...prev, s.cpuUtilPct]))
      setRamHistory((prev) => trim([...prev, s.ramUsedPct]))
      const totalUsed = s.gpus.reduce((a, g) => a + g.vramUsedMB, 0)
      const totalAll = s.gpus.reduce((a, g) => a + g.vramTotalMB, 0)
      const pct = totalAll > 0 ? (totalUsed / totalAll) * 100 : 0
      setVramHistory((prev) => trim([...prev, pct]))
    })
    const offServe = EventsOn('deploy:serve-status', () => {
      void ServerStatus().then(setServer)
    })

    StartMonitoring(POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      offSnap()
      offServe()
      clearInterval(tick)
      StopMonitoring()
    }
  }, [])

  // Reset uptime clock whenever PID changes (start / restart).
  useEffect(() => {
    if (server?.state === 'running' && server.pid) {
      if (uptimePidRef.current !== server.pid) {
        uptimePidRef.current = server.pid
        setUptimeStartedAt(Date.now())
      }
    } else {
      uptimePidRef.current = null
      setUptimeStartedAt(null)
    }
  }, [server?.state, server?.pid])

  // Clear the in-flight flags as soon as the backend confirms the
  // requested state transition. Belt-and-braces — they also clear in
  // the catch handlers — but this is the success path.
  useEffect(() => {
    if (server?.state === 'running') {
      setStartInFlight(false)
    } else if (server?.state === 'stopped') {
      setStartInFlight(false)
      setStopInFlight(false)
    }
  }, [server?.state])

  // Poll llama-server's /metrics while it's running. 3 s cadence is
  // a sensible default — the counters tick over fast under load and
  // we don't want to be janky, but we also don't want a thundering
  // herd of HTTP calls when the server is idle.
  useEffect(() => {
    if (server?.state !== 'running') {
      setMetrics(null)
      return
    }
    let alive = true
    const tick = async () => {
      try {
        const m = await LlamaMetrics()
        if (alive) setMetrics(m)
      } catch {
        if (alive) setMetrics(null)
      }
    }
    void tick()
    const id = setInterval(tick, 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [server?.state])

  async function refreshAll() {
    const [im, rt, srv, sn, ds] = await Promise.all([
      InstalledModels(),
      RuntimeStatus(),
      ServerStatus(),
      Snapshot(),
      BlueprintDataSummary(),
    ])
    setInstalled(im ?? [])
    setRuntime(rt)
    setServer(srv)
    setSnap(sn)
    setDataSummary(ds)
    // Update check runs in the background — slow, network-bound, don't block.
    LatestRuntimeVersion()
      .then(setRuntimeUpdate)
      .catch(() => setRuntimeUpdate(null))
  }

  const running = server?.state === 'running'
  const hasModel = (installed?.length ?? 0) > 0
  const runtimeReady = !!runtime?.installed

  const quickStartModel =
    installed?.find((m) => m.quant === serveConfig.quant) ?? installed?.[0] ?? null

  function quickStart() {
    if (!quickStartModel) {
      onGoTo('plan')
      return
    }
    if (!runtimeReady) {
      onSelectModel(quickStartModel.id)
      onGoTo('deploy')
      return
    }
    onSelectModel(quickStartModel.id)
    // Flip the local flag BEFORE awaiting anything so the button paints
    // its loading state immediately. Don't await StartServe — the
    // deploy:serve-status subscription will drive us to 'starting' →
    // 'running'. A .catch handler clears the flag on failure.
    setStartInFlight(true)
    setActionError(null)
    StartServe(
      quickStartModel.id,
      quickStartModel.quant,
      serveConfig.ctxSize,
      serveConfig.nGpuLayers,
    ).catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : String(err))
      setStartInFlight(false)
    })
  }

  function stopServe() {
    setStopInFlight(true)
    setActionError(null)
    StopServe().catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : String(err))
      setStopInFlight(false)
    })
  }

  const uptime = uptimeStartedAt ? Date.now() - uptimeStartedAt : 0

  return (
    <div className="mt-8 space-y-6">
      <ServerHero
        server={server}
        runtime={runtime}
        hasModel={hasModel}
        quickStartModel={quickStartModel}
        uptimeMs={uptime}
        startInFlight={startInFlight}
        stopInFlight={stopInFlight}
        actionError={actionError}
        onQuickStart={quickStart}
        onOpenVerify={() => onGoTo('deploy')}
        onStop={stopServe}
      />

      <SystemTiles
        snap={snap}
        cpuHistory={cpuHistory}
        ramHistory={ramHistory}
        vramHistory={vramHistory}
      />

      {snap && snap.gpus.length > 0 && <GpuBreakdown snap={snap} />}

      {running && server && <DashboardChat server={server} />}

      {running && server && (
        <ServerConfigCard server={server} serveConfig={serveConfig} onChangeConfig={() => onGoTo('optimize')} />
      )}

      {running && <PerformanceCard metrics={metrics} />}

      <ModelsOnDiskCard
        installed={installed}
        currentServingId={server?.modelId}
        running={running}
        onPickAnother={() => onGoTo('plan')}
        onServe={(m) => {
          onSelectModel(m.id)
          onGoTo('deploy')
        }}
        onManage={() => onGoTo('maintain')}
      />

      <MaintenanceCard
        runtime={runtime}
        runtimeUpdate={runtimeUpdate}
        dataSummary={dataSummary}
        installed={installed}
        onMaintain={() => onGoTo('maintain')}
      />

      <RecommendationsCard
        snap={snap}
        runtimeUpdate={runtimeUpdate}
        running={running}
        hasModel={hasModel}
        runtimeReady={runtimeReady}
      />
    </div>
  )
}

// ─── Server hero ────────────────────────────────────────────────────────

function ServerHero({
  server,
  runtime,
  hasModel,
  quickStartModel,
  uptimeMs,
  startInFlight,
  stopInFlight,
  actionError,
  onQuickStart,
  onOpenVerify,
  onStop,
}: {
  server: main.ServerStatus | null
  runtime: main.RuntimeStatus | null
  hasModel: boolean
  quickStartModel: main.InstalledModel | null
  uptimeMs: number
  startInFlight: boolean
  stopInFlight: boolean
  actionError: string | null
  onQuickStart: () => void
  onOpenVerify: () => void
  onStop: () => void
}) {
  // Combine local in-flight flag with backend 'starting' state — either
  // means "we're in the middle of bringing the server up."
  const starting = startInFlight || server?.state === 'starting'
  const running = server?.state === 'running'
  const runtimeReady = !!runtime?.installed

  // CTA when stopped — the obvious next action given what the user has.
  const cta = (() => {
    if (running || starting) return null
    if (!hasModel) return { label: 'Pick a model' }
    if (!runtimeReady) return { label: 'Install runtime' }
    return { label: `Start server — ${quickStartModel?.displayName ?? 'model'}` }
  })()

  return (
    <section
      className={[
        'overflow-hidden rounded-2xl border shadow-sm',
        running ? 'border-chart-4/40 bg-chart-4/5' : starting ? 'border-chart-5/40 bg-chart-5/5' : 'border-border bg-card',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-5">
        <div className="min-w-0">
          <p className="eyebrow">Server</p>
          {starting ? (
            <>
              <p className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
                <Spinner /> Starting llama-server…
              </p>
              <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                Loading <b>{quickStartModel?.displayName ?? server?.modelId ?? 'model'}</b>{' '}
                <span className="font-mono">{(quickStartModel?.quant ?? server?.quant ?? '').toUpperCase()}</span>
                {' '}— mmaping weights and warming the KV cache. First boot of a big model can take a few seconds.
              </p>
            </>
          ) : running ? (
            <>
              <p className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
                <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-chart-4" />
                Serving <span className="font-mono">{server!.modelId}</span>
              </p>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {server!.quant?.toUpperCase()}
                <span className="mx-2 opacity-40">·</span>
                port {server!.port}
                <span className="mx-2 opacity-40">·</span>
                pid {server!.pid}
                <span className="mx-2 opacity-40">·</span>
                up {formatDuration(uptimeMs)}
                <span className="mx-2 opacity-40">·</span>
                <span>http://127.0.0.1:{server!.port}/v1</span>
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-xl font-semibold tracking-tight">Not running</p>
              <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                {!hasModel
                  ? 'No model on disk yet — pick one from the catalog first.'
                  : !runtimeReady
                    ? 'llama.cpp runtime isn’t installed yet. The Deploy tab handles the one-time install.'
                    : `Ready to serve ${quickStartModel?.displayName ?? 'a model'} — click below to start the local OpenAI-compatible API.`}
              </p>
              {actionError && (
                <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 font-mono text-[11px] text-destructive">
                  {actionError}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {starting ? (
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-2 rounded-md bg-primary/70 px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm"
            >
              <Spinner /> Starting…
            </button>
          ) : running ? (
            <>
              <button
                type="button"
                onClick={onOpenVerify}
                className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted"
              >
                Open in Deploy
              </button>
              <button
                type="button"
                onClick={onStop}
                disabled={stopInFlight}
                className="inline-flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-4 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/5 disabled:opacity-60"
              >
                {stopInFlight && <Spinner />}
                {stopInFlight ? 'Stopping…' : 'Stop server'}
              </button>
            </>
          ) : (
            cta && (
              <button
                type="button"
                onClick={onQuickStart}
                className="rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
              >
                {cta.label} →
              </button>
            )
          )}
        </div>
      </div>
    </section>
  )
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  )
}

// ─── System tiles ───────────────────────────────────────────────────────

function SystemTiles({
  snap,
  cpuHistory,
  ramHistory,
  vramHistory,
}: {
  snap: main.Snapshot | null
  cpuHistory: number[]
  ramHistory: number[]
  vramHistory: number[]
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <MetricTile
        label="CPU"
        value={snap ? `${snap.cpuUtilPct.toFixed(0)}%` : '—'}
        sub="utilization, all cores"
        history={cpuHistory}
      />
      <MetricTile
        label="System RAM"
        value={snap ? `${snap.ramUsedPct.toFixed(0)}%` : '—'}
        sub={snap ? `${humanBytes(snap.ramUsedBytes)} / ${humanBytes(snap.ramTotalBytes)}` : ''}
        history={ramHistory}
      />
      <MetricTile
        label="VRAM"
        value={!snap || snap.gpus.length === 0 ? '—' : `${vramPct(snap).toFixed(0)}%`}
        sub={
          !snap || snap.gpus.length === 0
            ? 'no NVIDIA GPU detected'
            : `${snap.gpus.length} GPU${snap.gpus.length === 1 ? '' : 's'}`
        }
        history={vramHistory}
      />
    </div>
  )
}

function MetricTile({
  label,
  value,
  sub,
  history,
}: {
  label: string
  value: string
  sub: string
  history: number[]
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="px-5 pt-4">
        <p className="eyebrow">{label}</p>
        <p className="mt-1 font-mono text-3xl font-semibold tracking-tight">{value}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      </div>
      <div className="h-12">
        <Sparkline points={history} />
      </div>
    </section>
  )
}

// ─── GPU breakdown ──────────────────────────────────────────────────────

function GpuBreakdown({ snap }: { snap: main.Snapshot }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold tracking-tight">GPU breakdown</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Per-GPU VRAM, utilization, and temperature.
        </p>
      </header>
      <ul className="divide-y divide-border">
        {snap.gpus.map((g) => (
          <li key={g.index} className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-6 py-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                GPU {g.index}
              </p>
              <p className="text-sm font-semibold tracking-tight">{g.name}</p>
            </div>
            <div className="min-w-0">
              <p className="font-mono text-[11px] text-muted-foreground">
                VRAM <b className="text-foreground">{g.vramUsedMB.toLocaleString()}</b>
                {' / '}
                {g.vramTotalMB.toLocaleString()} MB
              </p>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full border border-border bg-muted">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${(g.vramUsedMB / Math.max(g.vramTotalMB, 1)) * 100}%` }}
                />
              </div>
            </div>
            <dl className="text-right font-mono text-[11px]">
              <div>
                <dt className="inline text-muted-foreground">Util </dt>
                <dd className="inline font-semibold text-foreground">{g.utilPct}%</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Temp </dt>
                <dd className="inline font-semibold text-foreground">{g.tempC}°C</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── Server config ──────────────────────────────────────────────────────

function ServerConfigCard({
  server,
  serveConfig,
  onChangeConfig,
}: {
  server: main.ServerStatus
  serveConfig: ServeConfig
  onChangeConfig: () => void
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Server config</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Startup parameters — changing these requires a restart.
          </p>
        </div>
        <button
          type="button"
          onClick={onChangeConfig}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
        >
          Edit in Optimize →
        </button>
      </header>
      <dl className="grid gap-x-6 gap-y-2 px-6 py-4 text-sm sm:grid-cols-2">
        <KV k="Model" v={server.modelId ?? '—'} mono />
        <KV k="Quantization" v={(server.quant ?? serveConfig.quant).toUpperCase()} mono />
        <KV k="Context window" v={`${serveConfig.ctxSize.toLocaleString()} tokens`} mono />
        <KV
          k="GPU layers"
          v={serveConfig.nGpuLayers >= 999 ? 'All available' : String(serveConfig.nGpuLayers)}
          mono
        />
      </dl>
    </section>
  )
}

// ─── Performance placeholder ────────────────────────────────────────────

function PerformanceCard({ metrics }: { metrics: main.LlamaMetrics | null }) {
  const live = metrics?.available
  const tiles = [
    {
      label: 'Throughput',
      value: live ? metrics!.tokensPerSecond.toFixed(1) : '—',
      unit: 'tokens / sec, generation',
    },
    {
      label: 'Prompt speed',
      value: live ? metrics!.promptTokensPerSecond.toFixed(0) : '—',
      unit: 'tokens / sec, prefill',
    },
    {
      label: 'Active requests',
      value: live ? metrics!.requestsProcessing.toFixed(0) : '—',
      unit: live && metrics!.requestsDeferred > 0
        ? `${metrics!.requestsDeferred.toFixed(0)} queued`
        : 'concurrent',
    },
    {
      label: 'Tokens generated',
      value: live ? formatCompactNumber(metrics!.tokensPredictedTotal) : '—',
      unit: 'since server start',
    },
  ]

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Performance</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Scraped from llama-server&apos;s <code className="font-mono">/metrics</code> endpoint every 3 s.
            Counters tick once you send requests.
          </p>
        </div>
        {!live && (
          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Awaiting first request
          </span>
        )}
      </header>
      <ul className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <li key={t.label} className="bg-card px-5 py-4">
            <p className="eyebrow">{t.label}</p>
            <p
              className={[
                'mt-1 font-mono text-2xl font-semibold tracking-tight',
                live ? 'text-foreground' : 'text-muted-foreground/60',
              ].join(' ')}
            >
              {t.value}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t.unit}</p>
          </li>
        ))}
      </ul>
      {live && metrics!.kvCacheTokens > 0 && (
        <div className="border-t border-border px-6 py-3 text-xs text-muted-foreground">
          <span className="font-mono">KV cache</span>
          {' '}
          {(metrics!.kvCacheUsageRatio * 100).toFixed(0)}%
          <span className="mx-2 opacity-40">·</span>
          {metrics!.kvCacheTokens.toLocaleString()} tokens in cache
          <span className="mx-2 opacity-40">·</span>
          {formatCompactNumber(metrics!.promptTokensTotal)} prompt tokens processed lifetime
        </div>
      )}
    </section>
  )
}

function formatCompactNumber(n: number): string {
  if (n < 1000) return n.toFixed(0)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

// ─── Models on disk ─────────────────────────────────────────────────────

function ModelsOnDiskCard({
  installed,
  currentServingId,
  running,
  onPickAnother,
  onServe,
  onManage,
}: {
  installed: main.InstalledModel[] | null
  currentServingId?: string
  running: boolean
  onPickAnother: () => void
  onServe: (m: main.InstalledModel) => void
  onManage: () => void
}) {
  const totalBytes = (installed ?? []).reduce((a, m) => a + m.bytesSize, 0)
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Models on disk</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {installed === null
              ? 'Loading…'
              : `${installed.length} model${installed.length === 1 ? '' : 's'} · ${humanBytes(totalBytes)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onPickAnother}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
        >
          + Add another
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
            const isServing = running && currentServingId === m.id
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
                  onClick={() => (isServing ? onManage() : onServe(m))}
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

// ─── Maintenance ────────────────────────────────────────────────────────

function MaintenanceCard({
  runtime,
  runtimeUpdate,
  dataSummary,
  installed,
  onMaintain,
}: {
  runtime: main.RuntimeStatus | null
  runtimeUpdate: main.RuntimeUpdate | null
  dataSummary: main.BlueprintDataSummary | null
  installed: main.InstalledModel[] | null
  onMaintain: () => void
}) {
  const modelBytes = (installed ?? []).reduce((a, m) => a + m.bytesSize, 0)
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Maintenance</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Runtime version and disk footprint.</p>
        </div>
        <button
          type="button"
          onClick={onMaintain}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
        >
          Open Maintain →
        </button>
      </header>
      <dl className="grid gap-x-6 gap-y-2 px-6 py-4 text-sm sm:grid-cols-2">
        <KV
          k="Runtime"
          v={
            runtime?.installed
              ? `${runtime.version}${runtimeUpdate?.hasUpdate ? ` → ${runtimeUpdate.latest} available` : ''}`
              : 'Not installed'
          }
          mono
          accent={runtimeUpdate?.hasUpdate ? 'warn' : undefined}
        />
        <KV
          k="Models on disk"
          v={installed ? `${installed.length} · ${humanBytes(modelBytes)}` : '—'}
        />
        <KV k="Blueprint data" v={dataSummary ? humanBytes(dataSummary.bytesTotal) : '—'} />
        <KV
          k="Data path"
          v={dataSummary?.path ?? '—'}
          mono
          small
        />
      </dl>
    </section>
  )
}

// ─── Recommendations ────────────────────────────────────────────────────

type Recommendation = {
  kind: 'warn' | 'info'
  title: string
  body: string
}

function buildRecommendations({
  snap,
  runtimeUpdate,
  running,
  hasModel,
  runtimeReady,
}: {
  snap: main.Snapshot | null
  runtimeUpdate: main.RuntimeUpdate | null
  running: boolean
  hasModel: boolean
  runtimeReady: boolean
}): Recommendation[] {
  const recs: Recommendation[] = []

  if (!hasModel) {
    recs.push({
      kind: 'info',
      title: 'No model on disk',
      body: 'Pick one from the Plan tab to start. The catalog is filtered by what fits this hardware.',
    })
  }
  if (hasModel && !runtimeReady) {
    recs.push({
      kind: 'info',
      title: 'Runtime not installed',
      body: 'llama.cpp is a one-time install (~80 MB). Deploy tab handles it.',
    })
  }
  if (runtimeUpdate?.hasUpdate) {
    recs.push({
      kind: 'info',
      title: `llama.cpp ${runtimeUpdate.latest} is available`,
      body: `You're on ${runtimeUpdate.installed}. New releases bring perf and stability fixes.`,
    })
  }
  if (snap && snap.ramUsedPct > 90) {
    recs.push({
      kind: 'warn',
      title: 'System RAM under pressure',
      body: `Used ${snap.ramUsedPct.toFixed(0)}%. Close other apps before serving, or pick a smaller quant.`,
    })
  }
  if (snap) {
    const hotGpu = snap.gpus.find((g) => g.tempC >= 85)
    if (hotGpu) {
      recs.push({
        kind: 'warn',
        title: `GPU ${hotGpu.index} is hot (${hotGpu.tempC}°C)`,
        body: 'Sustained temps over 85°C risk thermal throttling. Improve airflow or cap power.',
      })
    }
  }
  if (snap && snap.gpus.length > 0) {
    const vp = vramPct(snap)
    if (running && vp > 95) {
      recs.push({
        kind: 'warn',
        title: 'VRAM saturated',
        body: `${vp.toFixed(0)}% used. Long-context requests may OOM. Reduce ctx size or quant.`,
      })
    }
  }

  if (recs.length === 0) {
    recs.push({
      kind: 'info',
      title: 'Everything looks healthy',
      body: 'No warnings to act on right now.',
    })
  }
  return recs
}

function RecommendationsCard(props: {
  snap: main.Snapshot | null
  runtimeUpdate: main.RuntimeUpdate | null
  running: boolean
  hasModel: boolean
  runtimeReady: boolean
}) {
  const recs = buildRecommendations(props)
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold tracking-tight">Recommendations</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Computed from your current system + runtime state.
        </p>
      </header>
      <ul className="divide-y divide-border">
        {recs.map((r, i) => (
          <li key={i} className="flex items-start gap-3 px-6 py-3 text-sm">
            <span
              className={[
                'mt-1 inline-flex h-2 w-2 shrink-0 rounded-full',
                r.kind === 'warn' ? 'bg-chart-5' : 'bg-chart-4',
              ].join(' ')}
              aria-hidden
            />
            <div>
              <p className="font-semibold tracking-tight">{r.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{r.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── Bits ───────────────────────────────────────────────────────────────

function KV({
  k,
  v,
  mono,
  small,
  accent,
}: {
  k: string
  v: string
  mono?: boolean
  small?: boolean
  accent?: 'warn'
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-2 last:border-b-0 last:pb-0 sm:border-b-0 sm:pb-0">
      <span className="text-muted-foreground">{k}</span>
      <span
        className={[
          'min-w-0 truncate text-right',
          mono ? 'font-mono' : '',
          small ? 'text-[11px]' : '',
          accent === 'warn' ? 'font-semibold text-chart-5' : '',
        ].join(' ')}
        title={v}
      >
        {v}
      </span>
    </div>
  )
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="h-full w-full" />
  const w = 200
  const h = 48
  const max = 100
  const step = w / Math.max(1, HISTORY_LEN - 1)
  const offset = w - step * (points.length - 1)
  const d = points
    .map((p, i) => {
      const x = offset + i * step
      const y = h - (Math.min(p, max) / max) * h
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
  const fillD = `${d} L ${w} ${h} L ${offset} ${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full">
      <path d={fillD} fill="oklch(0.45 0.17 262 / 0.12)" />
      <path d={d} fill="none" stroke="oklch(0.45 0.17 262)" strokeWidth="1.5" />
    </svg>
  )
}

function trim(arr: number[]): number[] {
  return arr.length > HISTORY_LEN ? arr.slice(arr.length - HISTORY_LEN) : arr
}

function vramPct(snap: main.Snapshot): number {
  const used = snap.gpus.reduce((a, g) => a + g.vramUsedMB, 0)
  const total = snap.gpus.reduce((a, g) => a + g.vramTotalMB, 0)
  return total > 0 ? (used / total) * 100 : 0
}

function humanBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}
