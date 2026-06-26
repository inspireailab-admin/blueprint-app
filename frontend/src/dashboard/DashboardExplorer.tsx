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

const POLL_MS = 2000
const HISTORY_LEN = 60

export type DashboardSection =
  | 'overview'
  | 'inference'
  | 'models'
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
  serveConfig: ServeConfig
  /** Called by Models cards' Serve buttons to pre-select a model
   *  before routing the user to the Add-LLM wizard. */
  onSelectModel: (modelId: string) => void
  /** Open the Add-LLM wizard from any "+ Add" CTA inside the dashboard. */
  onAddLLM: () => void
}

export function DashboardExplorer({
  section,
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

