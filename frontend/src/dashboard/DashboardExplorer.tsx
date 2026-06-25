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

import { useEffect, useState } from 'react'
import {
  BlueprintDataSummary,
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
import { RouterCard } from './RouterCard'
import { ServiceCard } from './ServiceCard'
import { TrainCard } from './TrainCard'

const POLL_MS = 2000
const HISTORY_LEN = 60

type GoTo = (tab: 'plan' | 'hardware' | 'deploy' | 'calibrate' | 'maintain') => void

type ServeConfig = {
  quant: string
  ctxSize: number
  nGpuLayers: number
}

type Props = {
  onGoTo: GoTo
  serveConfig: ServeConfig
  /** Called by ModelsOnDiskCard's Serve buttons to pre-select a model
   *  before routing the user to Plan / Deploy. */
  onSelectModel: (modelId: string) => void
}

export function DashboardExplorer({ onGoTo, serveConfig, onSelectModel }: Props) {
  const [installed, setInstalled] = useState<main.InstalledModel[] | null>(null)
  const [runtime, setRuntime] = useState<main.RuntimeStatus | null>(null)
  const [runtimeUpdate, setRuntimeUpdate] = useState<main.RuntimeUpdate | null>(null)
  const [svcInfo, setSvcInfo] = useState<main.ServiceInfo | null>(null)
  const [svcConfig, setSvcConfig] = useState<svcconfig.Config | null>(null)
  const [snap, setSnap] = useState<main.Snapshot | null>(null)
  const [dataSummary, setDataSummary] = useState<main.BlueprintDataSummary | null>(null)
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
    const [im, rt, sn, ds] = await Promise.all([
      InstalledModels(),
      RuntimeStatus(),
      Snapshot(),
      BlueprintDataSummary(),
    ])
    setInstalled(im ?? [])
    setRuntime(rt)
    setSnap(sn)
    setDataSummary(ds)
    LatestRuntimeVersion()
      .then(setRuntimeUpdate)
      .catch(() => setRuntimeUpdate(null))
  }

  const hasModel = (installed?.length ?? 0) > 0
  const runtimeReady = !!runtime?.installed
  const currentServingId = serving ? svcInfo?.modelId : undefined

  return (
    <div className="mt-8 space-y-6">
      <ServiceCard
        installed={installed}
        defaults={{
          quant: serveConfig.quant,
          ctxSize: serveConfig.ctxSize,
          nGpuLayers: serveConfig.nGpuLayers,
        }}
        onPickModel={() => onGoTo('plan')}
      />

      <SystemTiles
        snap={snap}
        cpuHistory={cpuHistory}
        ramHistory={ramHistory}
        vramHistory={vramHistory}
      />

      {snap && snap.gpus.length > 0 && <GpuBreakdown snap={snap} />}

      {serving && svcConfig && (
        <DashboardChat
          port={svcConfig.port}
          apiKey={svcConfig.apiKey}
        />
      )}

      {serving && <PerformanceCard metrics={metrics} />}

      {serving && <PromptCacheCard />}

      {serving && <RouterCard />}

      <PythonRuntimeCard />

      <TrainCard />

      <ModelsOnDiskCard
        installed={installed}
        currentServingId={currentServingId}
        running={serving}
        onPickAnother={() => onGoTo('plan')}
        onServe={(m) => {
          onSelectModel(m.id)
          onGoTo('deploy')
        }}
        onManage={() => onGoTo('maintain')}
      />

      {hasModel && <CalibrateCard onGoTo={() => onGoTo('calibrate')} />}

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
        running={serving}
        hasModel={hasModel}
        runtimeReady={runtimeReady}
      />
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

// ─── Calibrate CTA ──────────────────────────────────────────────────────

function CalibrateCard({ onGoTo }: { onGoTo: () => void }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/5 to-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-5">
        <div className="min-w-0">
          <p className="eyebrow">Custom calibration</p>
          <p className="mt-1 text-base font-semibold tracking-tight">
            Quantize this model for the client&apos;s workload
          </p>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            Pre-quantized GGUFs from HuggingFace are calibrated on a generic corpus. Run
            <code className="mx-1 font-mono">llama-imatrix</code>
            against the client&apos;s representative prompts and produce custom GGUFs that
            measurably beat the stock variant on their eval set — the artefact + the report
            are what the engagement delivers.
          </p>
        </div>
        <button
          type="button"
          onClick={onGoTo}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          Open Calibrate →
        </button>
      </div>
    </section>
  )
}

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

