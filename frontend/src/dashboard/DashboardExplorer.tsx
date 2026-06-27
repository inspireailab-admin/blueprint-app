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

import { useCallback, useEffect, useState } from 'react'
import {
  CurrentServeConfig,
  InstalledModels,
  LatestRuntimeVersion,
  LlamaMetrics,
  RuntimeStatus,
  ServiceInfo,
  Snapshot,
  StartMonitoring,
  StopMonitoring,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { main, svcconfig } from '../../wailsjs/go/models'
import { DashboardChat } from './DashboardChat'
import { PromptCacheCard } from './PromptCacheCard'
import { PythonRuntimeCard } from './PythonRuntimeCard'
import { RemoteServersCard } from './RemoteServersCard'
import { RouterCard } from './RouterCard'
import { ServiceCard } from './ServiceCard'
import { TrainCard } from './TrainCard'
import { CalibrateExplorer } from '../calibrate/CalibrateExplorer'
import { MaintainExplorer } from '../maintain/MaintainExplorer'
import { HostsExplorer } from '../hosts/HostsExplorer'
import {
  RemoteChatStream,
  RemoteHostInfo,
  RemoteHostModels,
  RemoteHostPull,
  RemoteHostPullStatus,
  RemoteHostServe,
  RemoteHostSnapshot,
  RemoteHostStop,
} from '../../wailsjs/go/main/App'
import { loadCatalog } from '../planner/catalog'
import type { Model, Quant } from '../planner/types'
import { HelpButton } from '../help/HelpButton'
import type { ActiveHost } from '../App'

const POLL_MS = 2000
const HISTORY_LEN = 60

export type DashboardSection =
  | 'overview'
  | 'inference'
  | 'models'
  | 'hosts'
  | 'calibrate'
  | 'maintain'

type ServeConfig = {
  quant: string
  ctxSize: number
  nGpuLayers: number
}

type Props = {
  /** Which sub-tab is active inside the dashboard. */
  section: DashboardSection
  /** null = local machine, otherwise the connected remote host. */
  activeHost: ActiveHost
  serveConfig: ServeConfig
  /** Called by Models cards' Serve buttons to pre-select a model
   *  before routing the user to the Add-LLM wizard. */
  onSelectModel: (modelId: string) => void
  /** Open the Add-LLM wizard from any "+ Add" CTA inside the dashboard. */
  onAddLLM: () => void
}

export function DashboardExplorer({
  section,
  activeHost,
  serveConfig,
  onSelectModel,
  onAddLLM,
}: Props) {
  const [installed, setInstalled] = useState<main.InstalledModel[] | null>(null)
  const [runtime, setRuntime] = useState<main.RuntimeStatus | null>(null)
  const [runtimeUpdate, setRuntimeUpdate] = useState<main.RuntimeUpdate | null>(null)
  const [svcInfo, setSvcInfo] = useState<main.ServiceInfo | null>(null)
  const [svcConfig, setSvcConfig] = useState<svcconfig.Config | null>(null)
  const [snap, setSnap] = useState<main.Snapshot | null>(null)
  const [metrics, setMetrics] = useState<main.LlamaMetrics | null>(null)

  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [ramHistory, setRamHistory] = useState<number[]>([])
  const [vramHistory, setVramHistory] = useState<number[]>([])

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

    StartMonitoring(POLL_MS)
    return () => {
      offSnap()
      StopMonitoring()
    }
  }, [])

  // Poll the service every 2 s — it's a cheap local SCM call. Drives
  // the gating for the chat + metrics + performance cards below.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const [i, c] = await Promise.all([ServiceInfo(), CurrentServeConfig()])
        if (!alive) return
        setSvcInfo(i)
        setSvcConfig(c)
      } catch {
        // Non-fatal — keep last known state.
      }
    }
    void tick()
    const id = setInterval(tick, 2000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const serving = svcInfo?.scmState === 'running' && svcInfo?.phase === 'running'

  // Poll llama-server's /metrics only when the service supervisor
  // reports an active child. 3 s cadence — fast enough to look live,
  // slow enough not to spam the local HTTP loop.
  useEffect(() => {
    if (!serving) {
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
  }, [serving])

  async function refreshAll() {
    const [im, rt, sn] = await Promise.all([
      InstalledModels(),
      RuntimeStatus(),
      Snapshot(),
    ])
    setInstalled(im ?? [])
    setRuntime(rt)
    setSnap(sn)
    LatestRuntimeVersion()
      .then(setRuntimeUpdate)
      .catch(() => setRuntimeUpdate(null))
  }

  const hasModel = (installed?.length ?? 0) > 0
  const runtimeReady = !!runtime?.installed
  const currentServingId = serving ? svcInfo?.modelId : undefined
  const currentServingQuant = serving ? svcInfo?.quant : undefined

  // Hosts is the registry — same on every active host, so it stays
  // available even when a remote is selected.
  if (section === 'hosts') {
    return <HostsExplorer />
  }

  // Remote-host-aware routing: each ported section gets its own
  // remote view. Tabs we haven't ported yet (Calibrate, Maintain)
  // get a clear "switch back to local" stub so the user isn't
  // staring at stale local state thinking it's the remote.
  if (activeHost) {
    if (section === 'overview') {
      return <RemoteOverview host={activeHost} />
    }
    if (section === 'models') {
      return <RemoteModelsCard host={activeHost} />
    }
    if (section === 'inference') {
      return <RemoteChatCard host={activeHost} />
    }
    return <RemoteNotSupportedYet section={section} host={activeHost} />
  }

  // Calibrate + Maintain are sub-tabs with their own full UIs — render
  // them and bail, no system tiles or chat overlays.
  if (section === 'calibrate') {
    return <CalibrateExplorer />
  }
  if (section === 'maintain') {
    return <MaintainExplorer />
  }

  // Overview: at-a-glance — server state + system + GPU + insights.
  // Designed to fit on one screen at 1080p; no inference/chat noise.
  if (section === 'overview') {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          <ServiceCard
            installed={installed}
            defaults={{
              quant: serveConfig.quant,
              ctxSize: serveConfig.ctxSize,
              nGpuLayers: serveConfig.nGpuLayers,
            }}
            onPickModel={onAddLLM}
          />
          <RecommendationsCard
            snap={snap}
            runtimeUpdate={runtimeUpdate}
            running={serving}
            hasModel={hasModel}
            runtimeReady={runtimeReady}
          />
        </div>

        <SystemTiles
          snap={snap}
          cpuHistory={cpuHistory}
          ramHistory={ramHistory}
          vramHistory={vramHistory}
        />

        {snap && snap.gpus.length > 0 && <GpuBreakdown snap={snap} />}
      </div>
    )
  }

  // Inference: only useful when a server is running — chat + perf +
  // optimizations (cache + router).
  if (section === 'inference') {
    if (!serving) {
      return (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <p className="text-sm font-semibold tracking-tight">
            No model serving yet
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Start a server from the Overview tab, then come back here to
            chat with the model, watch live performance, and tune the
            prompt cache + router.
          </p>
        </div>
      )
    }
    return (
      <div className="space-y-4">
        {svcConfig && (
          <DashboardChat port={svcConfig.port} apiKey={svcConfig.apiKey} />
        )}
        <PerformanceCard metrics={metrics} />
        <div className="grid gap-4 lg:grid-cols-2">
          <PromptCacheCard />
          <RouterCard />
        </div>
      </div>
    )
  }

  // Models: everything about what's on disk + remote servers + Python.
  return (
    <div className="space-y-4">
      <ModelsOnDiskCard
        installed={installed}
        currentServingId={currentServingId}
        currentServingQuant={currentServingQuant}
        running={serving}
        onPickAnother={onAddLLM}
        onServe={(m) => {
          onSelectModel(m.id)
          onAddLLM()
        }}
        onManage={onAddLLM}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <RemoteServersCard />
        <PythonRuntimeCard />
      </div>
      <TrainCard />
    </div>
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
  currentServingQuant,
  running,
  onPickAnother,
  onServe,
  onManage,
}: {
  installed: main.InstalledModel[] | null
  currentServingId?: string
  currentServingQuant?: string
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
            // SERVING only matches the exact (model, quant) pair the
            // service is running — two quants of the same model would
            // otherwise both light up. Quant comparison is loose so
            // "q4" matches "Q4_K_M" if the svc reports either format.
            const isServing =
              running &&
              currentServingId === m.id &&
              (currentServingQuant === undefined ||
                quantsMatch(currentServingQuant, m.quant))
            return (
              <li
                key={`${m.id}:${m.quant}`}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-6 py-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold tracking-tight">
                    {m.displayName}
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-foreground/70">
                      {m.quant}
                    </span>
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

// ─── Remote views (host-aware) ──────────────────────────────────────────

type RemoteInfo = {
  appVersion?: string
  apiVersion?: string
  host?: string
  os?: string
  arch?: string
  status?: {
    phase?: string
    modelId?: string
    quant?: string
    port?: number
    bindHost?: string
    pid?: number
    startedAtMs?: number
    restartCount?: number
    lastError?: string
  }
}

type StartFormState = {
  open: boolean
  modelPath: string
  quant: string
  ctxSize: number
  nGpuLayers: number
  busy: boolean
  error: string | null
}

const EMPTY_START: StartFormState = {
  open: false,
  modelPath: '',
  quant: '',
  ctxSize: 4096,
  nGpuLayers: 999,
  busy: false,
  error: null,
}

function RemoteOverview({
  host,
}: {
  host: { id: string; label: string }
}) {
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [models, setModels] = useState<RemoteModel[] | null>(null)
  const [start, setStart] = useState<StartFormState>(EMPTY_START)

  // Poll /v1/info every 3 s so phase + restart count stay live.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await RemoteHostInfo(host.id)
        if (alive) {
          setInfo(r as RemoteInfo)
          setInfoError(null)
        }
      } catch (err) {
        if (alive) {
          setInfoError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [host.id])

  // Fetch the remote model list once so the Start form has something
  // to pick from. Refreshed when the user opens the form.
  const fetchModels = useCallback(async () => {
    try {
      const r = await RemoteHostModels(host.id)
      const m = (r as { models?: RemoteModel[] }).models ?? []
      setModels(m)
    } catch {
      setModels([])
    }
  }, [host.id])

  useEffect(() => {
    void fetchModels()
  }, [fetchModels])

  async function submitStart() {
    if (!start.modelPath) {
      setStart((s) => ({ ...s, error: 'Pick a model first.' }))
      return
    }
    setStart((s) => ({ ...s, busy: true, error: null }))
    try {
      await RemoteHostServe(host.id, {
        modelPath: start.modelPath,
        quant: start.quant,
        ctxSize: start.ctxSize,
        nGpuLayers: start.nGpuLayers,
      })
      setStart(EMPTY_START)
    } catch (err) {
      setStart((s) => ({
        ...s,
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  async function submitStop() {
    if (!confirm(`Stop the running model on ${host.label}?`)) return
    try {
      await RemoteHostStop(host.id)
    } catch (err) {
      console.error('RemoteHostStop failed:', err)
    }
  }

  const phase = info?.status?.phase ?? 'unknown'
  const isRunning = phase === 'running'
  const isIdle = phase === 'idle' || phase === 'stopped' || phase === 'unknown'

  return (
    <div className="space-y-4">
      {/* Server card */}
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">
              Server on{' '}
              <span className="text-primary">{host.label}</span>
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Live from <code className="font-mono">/v1/info</code>, polled
              every 3 s. Start / Stop write a new svcconfig on the remote
              and the supervisor picks it up within ~5 s.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isRunning ? (
              <button
                type="button"
                onClick={() => void submitStop()}
                className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/10"
              >
                Stop server
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void fetchModels()
                  setStart((s) => ({ ...s, open: !s.open }))
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
              >
                {start.open ? '✕ Cancel' : '+ Start a model'}
              </button>
            )}
          </div>
        </header>

        <div className="grid gap-4 px-6 py-4 sm:grid-cols-2">
          <KV2 k="Phase" v={<PhasePill phase={phase} />} />
          <KV2
            k="App version"
            v={info?.appVersion ?? '—'}
            mono
          />
          <KV2
            k="OS / arch"
            v={info ? `${info.os ?? '?'} / ${info.arch ?? '?'}` : '—'}
            mono
          />
          <KV2 k="Hostname" v={info?.host ?? '—'} mono />
          {isRunning && (
            <>
              <KV2 k="Model" v={info?.status?.modelId ?? '—'} mono />
              <KV2 k="Quant" v={info?.status?.quant ?? '—'} mono />
              <KV2
                k="Bound at"
                v={
                  info?.status?.bindHost && info?.status?.port
                    ? `${info.status.bindHost}:${info.status.port}`
                    : '—'
                }
                mono
              />
              <KV2 k="PID" v={String(info?.status?.pid ?? '—')} mono />
            </>
          )}
          {info?.status?.lastError && (
            <KV2
              k="Last error"
              v={info.status.lastError}
              mono
              accent="warn"
            />
          )}
        </div>

        {infoError && (
          <div className="border-t border-border bg-destructive/5 px-6 py-3 text-xs">
            <p className="font-mono text-destructive/80">
              poll error: {infoError}
            </p>
          </div>
        )}

        {start.open && isIdle && (
          <div className="border-t border-border bg-muted/30 px-6 py-4">
            <p className="text-xs font-semibold tracking-tight">
              Start a model on {host.label}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              POSTs to <code className="font-mono">/v1/serve</code>. The
              remote supervisor reads the new config and respawns llama-
              server against it. Only models already on the remote&apos;s
              disk show up here.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr]">
              <label className="block">
                <span className="text-xs font-medium">Model</span>
                <select
                  value={start.modelPath}
                  onChange={(e) => {
                    const path = e.target.value
                    const m = models?.find((m) => m.fileName === path)
                    setStart((s) => ({
                      ...s,
                      modelPath: path,
                      quant: m?.quant ?? s.quant,
                    }))
                  }}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
                >
                  <option value="">
                    {models && models.length === 0
                      ? '— no models on remote yet —'
                      : '— select —'}
                  </option>
                  {models?.map((m) => (
                    <option key={m.fileName} value={m.fileName}>
                      {m.displayName} · {m.quant} · {humanBytes(m.bytesSize)}
                    </option>
                  ))}
                </select>
              </label>
              <NumField
                label="Ctx size"
                value={start.ctxSize}
                onChange={(v) => setStart((s) => ({ ...s, ctxSize: v }))}
              />
              <NumField
                label="GPU layers"
                value={start.nGpuLayers}
                onChange={(v) => setStart((s) => ({ ...s, nGpuLayers: v }))}
                hint="999 = all"
              />
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => void submitStart()}
                  disabled={start.busy || !start.modelPath}
                  className="w-full rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
                >
                  {start.busy ? 'Starting…' : 'Start'}
                </button>
              </div>
            </div>
            {start.error && (
              <p className="mt-2 text-xs text-destructive">{start.error}</p>
            )}
          </div>
        )}
      </section>

      <RemoteSystemTiles host={host} />
    </div>
  )
}

// Polls /v1/snapshot every 3 s for CPU% / RAM% / GPU details on the
// remote host. Tries once on mount and then keeps an interval going.
function RemoteSystemTiles({ host }: { host: { id: string; label: string } }) {
  const [snap, setSnap] = useState<RemoteSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await RemoteHostSnapshot(host.id)
        if (alive) {
          setSnap(r as RemoteSnapshot)
          setError(null)
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [host.id])

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <p className="font-mono text-destructive/80">
          snapshot poll error: {error}
        </p>
      </div>
    )
  }

  return (
    <section className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <PercentTile
          label="CPU"
          pct={snap?.cpuUtilPct ?? 0}
          hint={snap ? `${snap.numCPU ?? 0} cores` : ''}
        />
        <PercentTile
          label="RAM"
          pct={snap?.ramUsedPct ?? 0}
          hint={
            snap?.ramTotalMB && snap?.ramUsedMB
              ? `${(snap.ramUsedMB / 1024).toFixed(1)} / ${(snap.ramTotalMB / 1024).toFixed(1)} GB`
              : ''
          }
        />
      </div>

      {snap && snap.gpus && snap.gpus.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <header className="border-b border-border px-6 py-3">
            <h3 className="text-sm font-semibold tracking-tight">GPUs</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Live from <code className="font-mono">nvidia-smi</code> on the
              remote.
            </p>
          </header>
          <ul className="divide-y divide-border">
            {snap.gpus.map((g) => (
              <li
                key={g.index}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-6 py-3 text-sm"
              >
                <span className="font-mono text-[10px] text-muted-foreground">
                  GPU{g.index}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-semibold tracking-tight">
                    {g.name}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {g.utilPct.toFixed(0)}% util · {(g.vramUsedMB / 1024).toFixed(1)}{' '}
                    / {(g.vramTotalMB / 1024).toFixed(1)} GB VRAM
                  </p>
                </div>
                <PercentTile
                  label=""
                  pct={
                    g.vramTotalMB > 0
                      ? (g.vramUsedMB / g.vramTotalMB) * 100
                      : 0
                  }
                  compact
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}

type RemoteSnapshot = {
  host: string
  os: string
  arch: string
  numCPU: number
  cpuUtilPct: number
  ramUsedPct: number
  ramUsedMB: number
  ramTotalMB: number
  gpus: Array<{
    index: number
    name: string
    utilPct: number
    vramUsedMB: number
    vramTotalMB: number
  }>
}

function PercentTile({
  label,
  pct,
  hint,
  compact,
}: {
  label: string
  pct: number
  hint?: string
  compact?: boolean
}) {
  const clamped = Math.max(0, Math.min(100, pct))
  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${clamped}%` }}
          />
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {clamped.toFixed(0)}%
        </span>
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold">{label}</p>
        <p className="font-mono text-lg font-semibold tracking-tight">
          {clamped.toFixed(0)}
          <span className="text-sm font-normal text-muted-foreground">%</span>
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {hint && (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

function PhasePill({ phase }: { phase: string }) {
  const tone =
    phase === 'running'
      ? 'bg-chart-4/15 text-chart-4'
      : phase === 'crashed'
        ? 'bg-destructive/15 text-destructive'
        : 'bg-muted text-muted-foreground'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${tone}`}
    >
      {phase === 'running' && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-chart-4" />
      )}
      {phase}
    </span>
  )
}

function KV2({
  k,
  v,
  mono,
  accent,
}: {
  k: string
  v: React.ReactNode
  mono?: boolean
  accent?: 'warn'
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span
        className={[
          'min-w-0 truncate text-right text-sm',
          mono ? 'font-mono text-xs' : '',
          accent === 'warn' ? 'font-semibold text-chart-5' : '',
        ].join(' ')}
        title={typeof v === 'string' ? v : undefined}
      >
        {v}
      </span>
    </div>
  )
}

function NumField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  hint?: string
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10)
          onChange(Number.isFinite(n) ? n : 0)
        }}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      {hint && (
        <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      )}
    </label>
  )
}


// ─── Remote chat (Inference tab) ────────────────────────────────────────

type ChatMsg = { role: 'user' | 'assistant'; content: string }

type SamplingParams = {
  temperature: number
  maxTokens: number
  topK: number
  topP: number
  minP: number
  repeatPenalty: number
  presencePenalty: number
  frequencyPenalty: number
  seed: number
  stopSequences: string
  systemPrompt: string
}

const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 0.7,
  maxTokens: 512,
  topK: 40,
  topP: 0.95,
  minP: 0.05,
  repeatPenalty: 1.1,
  presencePenalty: 0,
  frequencyPenalty: 0,
  seed: -1,
  stopSequences: '',
  systemPrompt: '',
}

function RemoteChatCard({ host }: { host: { id: string; label: string } }) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [params, setParams] = useState<SamplingParams>(DEFAULT_SAMPLING)

  // Subscribe to streamed chunks: append delta to the last assistant
  // message in place. The event payload always carries the host id so
  // we filter on that and ignore other hosts' streams if multiple are
  // active.
  useEffect(() => {
    const off = EventsOn(
      'host:chat:chunk',
      (evt: { id: string; stream: 'delta' | 'done' | 'error'; text: string }) => {
        if (evt.id !== host.id) return
        if (evt.stream === 'delta') {
          setMessages((prev) => {
            if (prev.length === 0 || prev[prev.length - 1].role !== 'assistant') {
              return prev
            }
            const next = prev.slice()
            next[next.length - 1] = {
              role: 'assistant',
              content: next[next.length - 1].content + evt.text,
            }
            return next
          })
        }
      },
    )
    return () => off()
  }, [host.id])

  async function send() {
    const text = input.trim()
    if (!text || sending) return

    // Build the wire payload BEFORE adding the placeholder assistant
    // message so the model doesn't see an empty assistant turn.
    const systemBlock = params.systemPrompt.trim()
      ? [{ role: 'system' as const, content: params.systemPrompt.trim() }]
      : []
    const userTurn: ChatMsg = { role: 'user', content: text }
    const next: ChatMsg[] = [...messages, userTurn]
    setMessages([...next, { role: 'assistant', content: '' }]) // placeholder
    setInput('')
    setSending(true)
    setError(null)

    const stops = params.stopSequences
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const extra: Record<string, unknown> = {
      top_k: params.topK,
      top_p: params.topP,
      min_p: params.minP,
      repeat_penalty: params.repeatPenalty,
      presence_penalty: params.presencePenalty,
      frequency_penalty: params.frequencyPenalty,
    }
    if (params.seed >= 0) extra.seed = params.seed
    if (stops.length > 0) extra.stop = stops

    try {
      // Type-cast to any to avoid the convertValues wrangle. The Go
      // side reads JSON tags, not the TS class shape.
      const result = await RemoteChatStream(
        host.id,
        {
          model: 'local',
          messages: [...systemBlock, ...next],
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          extra,
        } as unknown as Parameters<typeof RemoteChatStream>[1],
      )
      if (!result.ok) {
        setError(result.error ?? 'unknown error')
        // Remove the empty placeholder if the stream errored before
        // any delta arrived.
        setMessages((prev) => {
          if (
            prev.length > 0 &&
            prev[prev.length - 1].role === 'assistant' &&
            prev[prev.length - 1].content === ''
          ) {
            return prev.slice(0, -1)
          }
          return prev
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <header className="border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">
            Chat — remote on{' '}
            <span className="text-primary">{host.label}</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Streamed tokens from the supervised llama-server. Travels
            GUI → SSH tunnel → svc /llama proxy → llama-server, with
            SSE chunks flowing back the same path.
          </p>
        </header>

        <div className="max-h-[420px] min-h-[200px] overflow-y-auto border-b border-border bg-background px-6 py-4">
          {messages.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              Send a message to start chatting with the remote model.
            </p>
          ) : (
            <ul className="space-y-3">
              {messages.map((m, i) => (
                <li
                  key={i}
                  className={
                    m.role === 'user'
                      ? 'rounded-md bg-muted/50 px-3 py-2 text-sm'
                      : 'rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm'
                  }
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {m.role}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">
                    {m.content || (sending && i === messages.length - 1 ? '…' : '')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <div className="border-b border-border bg-destructive/5 px-6 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <SamplingPanel params={params} onChange={setParams} />

        <div className="grid gap-3 px-6 py-4 sm:grid-cols-[1fr_auto]">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Type a message and hit Enter (Shift+Enter for newline)"
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setMessages([])}
              disabled={sending || messages.length === 0}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || !input.trim()}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? 'Streaming…' : 'Send'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function SamplingPanel({
  params,
  onChange,
}: {
  params: SamplingParams
  onChange: (p: SamplingParams) => void
}) {
  return (
    <div className="border-b border-border bg-muted/20 px-6 py-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Per-request sampling — applied to the next message
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <NumField
          label="Temp ×100"
          value={Math.round(params.temperature * 100)}
          onChange={(v) => onChange({ ...params, temperature: v / 100 })}
          hint="0–200; lower = focused"
        />
        <NumField
          label="Max tokens"
          value={params.maxTokens}
          onChange={(v) => onChange({ ...params, maxTokens: v })}
          hint="cap on length"
        />
        <NumField
          label="Top-k"
          value={params.topK}
          onChange={(v) => onChange({ ...params, topK: v })}
          hint="0 = disabled"
        />
        <NumField
          label="Top-p ×100"
          value={Math.round(params.topP * 100)}
          onChange={(v) => onChange({ ...params, topP: v / 100 })}
          hint="nucleus cutoff"
        />
        <NumField
          label="Min-p ×100"
          value={Math.round(params.minP * 100)}
          onChange={(v) => onChange({ ...params, minP: v / 100 })}
          hint="relative cutoff"
        />
        <NumField
          label="Repeat penalty ×100"
          value={Math.round(params.repeatPenalty * 100)}
          onChange={(v) => onChange({ ...params, repeatPenalty: v / 100 })}
        />
        <NumField
          label="Presence ×100"
          value={Math.round(params.presencePenalty * 100)}
          onChange={(v) => onChange({ ...params, presencePenalty: v / 100 })}
          hint="-200 to 200"
        />
        <NumField
          label="Frequency ×100"
          value={Math.round(params.frequencyPenalty * 100)}
          onChange={(v) => onChange({ ...params, frequencyPenalty: v / 100 })}
          hint="-200 to 200"
        />
        <NumField
          label="Seed"
          value={params.seed}
          onChange={(v) => onChange({ ...params, seed: v })}
          hint="-1 = random"
        />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium">Stop sequences</span>
          <input
            type="text"
            value={params.stopSequences}
            onChange={(e) =>
              onChange({ ...params, stopSequences: e.target.value })
            }
            placeholder="</answer>, ###"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm shadow-sm transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Comma-separated. Streaming halts when any matches.
          </p>
        </label>
        <label className="block">
          <span className="text-xs font-medium">System prompt</span>
          <textarea
            value={params.systemPrompt}
            onChange={(e) =>
              onChange({ ...params, systemPrompt: e.target.value })
            }
            placeholder="You are a concise technical assistant."
            rows={2}
            className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-1.5 text-sm shadow-sm transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
      </div>
    </div>
  )
}

type PullState = {
  modelId: string
  quant: string
  stage: 'pulling' | 'done' | 'error'
  bytesDownloaded: number
  bytesTotal: number
  bytesPerSecond: number
  error?: string
  path?: string
}

function RemoteModelsCard({ host }: { host: { id: string; label: string } }) {
  const [data, setData] = useState<{ models: RemoteModel[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Pull-to-host state.
  const [pullOpen, setPullOpen] = useState(false)
  const [catalog, setCatalog] = useState<Model[] | null>(null)
  const [pickModelId, setPickModelId] = useState<string>('')
  const [pickQuant, setPickQuant] = useState<Quant | ''>('')
  const [active, setActive] = useState<PullState | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)

  const fetchModels = useCallback(async () => {
    try {
      const r = await RemoteHostModels(host.id)
      setData(r as { models: RemoteModel[] })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [host.id])

  useEffect(() => {
    setLoading(true)
    setData(null)
    setError(null)
    void fetchModels()
  }, [host.id, fetchModels])

  // Lazy-load the catalog the first time the user opens the picker.
  useEffect(() => {
    if (!pullOpen || catalog) return
    let alive = true
    void (async () => {
      try {
        const cat = await loadCatalog()
        if (!alive) return
        // Restrict to models the kernel can actually pull (have ggufFiles).
        const installable = (cat.models ?? []).filter((m) => m.local?.available)
        setCatalog(installable)
      } catch {
        if (alive) setCatalog([])
      }
    })()
    return () => {
      alive = false
    }
  }, [pullOpen, catalog])

  // Poll the active pull's status every second until it leaves the
  // "pulling" stage. On completion, refresh the disk list and keep
  // the final state on screen for ~3s so the user sees the outcome.
  useEffect(() => {
    if (!active || active.stage !== 'pulling') return
    let alive = true
    const id = setInterval(async () => {
      try {
        const s = (await RemoteHostPullStatus(host.id, active.modelId, active.quant)) as PullState
        if (!alive) return
        setActive(s)
        if (s.stage === 'done') {
          void fetchModels()
          setTimeout(() => alive && setActive(null), 3000)
        } else if (s.stage === 'error') {
          setTimeout(() => alive && setActive(null), 5000)
        }
      } catch {
        // Transient — keep polling.
      }
    }, 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [active, host.id, fetchModels])

  const startPull = useCallback(async () => {
    if (!pickModelId || !pickQuant) return
    setPullError(null)
    try {
      const s = (await RemoteHostPull(host.id, pickModelId, pickQuant)) as PullState
      setActive(s)
      setPullOpen(false)
    } catch (err) {
      setPullError(err instanceof Error ? err.message : String(err))
    }
  }, [host.id, pickModelId, pickQuant])

  const picked = catalog?.find((m) => m.id === pickModelId)
  const availableQuants: Quant[] = picked
    ? (Object.keys(picked.local?.ggufFiles ?? {}) as Quant[])
    : []
  const totalBytes = data?.models?.reduce((a, m) => a + m.bytesSize, 0) ?? 0

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Models on disk</h2>
            <HelpButton slug="models-on-disk" label="Models on disk" />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What&apos;s installed on{' '}
            <b className="text-foreground">{host.label}</b>
            {data && (
              <>
                {' · '}
                {data.models?.length ?? 0} model
                {(data.models?.length ?? 0) === 1 ? '' : 's'} ·{' '}
                {humanBytes(totalBytes)}
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPullOpen((v) => !v)}
          className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          {pullOpen ? 'Cancel' : 'Pull to host'}
        </button>
      </header>

      {pullOpen && (
        <div className="border-b border-border bg-muted/30 px-6 py-4">
          <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
            <label className="block">
              <span className="text-xs font-medium">Model</span>
              <select
                value={pickModelId}
                onChange={(e) => {
                  setPickModelId(e.target.value)
                  setPickQuant('')
                }}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">{catalog ? 'Pick a model…' : 'Loading catalog…'}</option>
                {(catalog ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium">Quant</span>
              <select
                value={pickQuant}
                onChange={(e) => setPickQuant(e.target.value as Quant)}
                disabled={!picked}
                className="mt-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-40"
              >
                <option value="">…</option>
                {availableQuants.map((q) => (
                  <option key={q} value={q}>
                    {q.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={startPull}
              disabled={!pickModelId || !pickQuant}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              Pull
            </button>
          </div>
          {pullError && (
            <p className="mt-2 font-mono text-[11px] text-destructive">{pullError}</p>
          )}
        </div>
      )}

      {active && <PullProgressRow s={active} />}

      {loading ? (
        <div className="px-6 py-8 text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="font-semibold text-destructive">Couldn&apos;t fetch remote models</p>
          <p className="mt-1 font-mono text-[11px] text-destructive/80">{error}</p>
        </div>
      ) : !data?.models || data.models.length === 0 ? (
        <div className="px-6 py-8 text-sm text-muted-foreground">
          No models on this host yet. Use <b>Pull to host</b> above to
          download one from the catalog directly onto the remote disk.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {data.models.map((m) => (
            <li
              key={m.fileName}
              className="grid grid-cols-[1fr_auto] items-center gap-4 px-6 py-4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-tight">
                  {m.displayName}
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-foreground/70">
                    {m.quant}
                  </span>
                </p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {m.fileName}
                </p>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">
                {humanBytes(m.bytesSize)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PullProgressRow({ s }: { s: PullState }) {
  const pct =
    s.bytesTotal > 0
      ? Math.min(100, Math.round((s.bytesDownloaded / s.bytesTotal) * 100))
      : 0
  const isDone = s.stage === 'done'
  const isError = s.stage === 'error'
  return (
    <div
      className={`border-b border-border px-6 py-3 text-xs ${
        isError ? 'bg-destructive/5' : isDone ? 'bg-emerald-500/5' : 'bg-muted/30'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">
          {isError ? 'Pull failed' : isDone ? 'Pull complete' : 'Pulling'}
          {' · '}
          <span className="font-mono">
            {s.modelId} ({s.quant.toUpperCase()})
          </span>
        </span>
        {!isError && !isDone && s.bytesTotal > 0 && (
          <span className="font-mono text-muted-foreground">
            {humanBytes(s.bytesDownloaded)} / {humanBytes(s.bytesTotal)}
            {s.bytesPerSecond > 0 && (
              <> · {humanBytes(s.bytesPerSecond)}/s</>
            )}
          </span>
        )}
      </div>
      {!isError && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className={`h-full ${isDone ? 'bg-emerald-500' : 'bg-primary'}`}
            style={{ width: `${isDone ? 100 : pct}%` }}
          />
        </div>
      )}
      {isError && s.error && (
        <p className="mt-1 font-mono text-[11px] text-destructive">{s.error}</p>
      )}
    </div>
  )
}

type RemoteModel = {
  id: string
  displayName: string
  quant: string
  fileName: string
  bytesSize: number
}

function RemoteNotSupportedYet({
  section,
  host,
}: {
  section: DashboardSection
  host: { id: string; label: string }
}) {
  const label =
    section === 'overview'
      ? 'Overview'
      : section === 'inference'
        ? 'Inference'
        : section === 'calibrate'
          ? 'Calibrate'
          : section === 'maintain'
            ? 'Maintain'
            : section
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center">
      <p className="text-sm font-semibold tracking-tight">
        {label} on remote hosts is coming next
      </p>
      <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">
        Right now this tab only renders local state. To see remote{' '}
        <b className="text-foreground">{host.label}</b>&apos;s {label.toLowerCase()},
        switch the host selector at the top back to{' '}
        <b className="text-foreground">⌂ Local</b>, or use the Models tab
        for what&apos;s on its disk. Phase B.5b makes Overview + Inference
        host-aware.
      </p>
    </div>
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

/** Loose match for quant strings the svc and the installer use
 *  inconsistently. "q4" matches "Q4_K_M", "q3" matches "Q3_K_L", etc.
 *  We compare on the leading "q" + digit prefix. */
function quantsMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  const prefix = (s: string) => {
    const m = s.toLowerCase().match(/^q(\d+)/)
    return m ? `q${m[1]}` : s.toLowerCase()
  }
  return prefix(a) === prefix(b)
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

