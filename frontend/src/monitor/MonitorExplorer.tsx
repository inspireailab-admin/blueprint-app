// Monitor tab — live system state. Subscribes to monitor:snapshot on
// mount and tells the Go side to start polling; unsubscribes + tells
// Go to stop on unmount so we don't burn cycles when the tab isn't
// visible.
//
// The polling cadence is fixed at 2 s server-side (configurable later);
// the UI keeps a rolling history of ~60 samples (~2 min) for the
// sparkline charts.

import { useEffect, useState } from 'react'
import { Snapshot, StartMonitoring, StopMonitoring } from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'

type Gpu = {
  index: number
  name: string
  vramTotalMB: number
  vramUsedMB: number
  vramFreeMB: number
  utilPct: number
  tempC: number
}

type Snap = {
  timestamp: number
  hasGpuDriver: boolean
  gpuVendor?: string
  gpus: Gpu[]
  cpuUtilPct: number
  ramTotalBytes: number
  ramUsedBytes: number
  ramUsedPct: number
}

const POLL_MS = 2000
const HISTORY_LEN = 60

export function MonitorExplorer() {
  const [snap, setSnap] = useState<Snap | null>(null)
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [vramHistory, setVramHistory] = useState<number[]>([])
  const [ramHistory, setRamHistory] = useState<number[]>([])

  useEffect(() => {
    // Prime the UI with one synchronous sample so we have something
    // to show before the first ticker fire.
    Snapshot().then((s) => setSnap(s as Snap))

    const off = EventsOn('monitor:snapshot', (s: Snap) => {
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
      off()
      StopMonitoring()
    }
  }, [])

  if (!snap) {
    return (
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-32 rounded-2xl border border-border bg-muted/30" />
        ))}
      </div>
    )
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <BigMetricCard
          label="CPU"
          value={`${snap.cpuUtilPct.toFixed(0)}%`}
          sub="utilization across all cores"
          history={cpuHistory}
        />
        <BigMetricCard
          label="System RAM"
          value={`${snap.ramUsedPct.toFixed(0)}%`}
          sub={`${humanBytes(snap.ramUsedBytes)} of ${humanBytes(snap.ramTotalBytes)}`}
          history={ramHistory}
        />
        <BigMetricCard
          label="VRAM"
          value={
            snap.gpus.length === 0
              ? '—'
              : `${aggregateVramPct(snap.gpus).toFixed(0)}%`
          }
          sub={
            snap.gpus.length === 0
              ? 'no NVIDIA GPU detected'
              : `${snap.gpus.reduce((a, g) => a + g.vramUsedMB, 0).toLocaleString()} MB / ${snap.gpus.reduce((a, g) => a + g.vramTotalMB, 0).toLocaleString()} MB across ${snap.gpus.length} GPU${snap.gpus.length === 1 ? '' : 's'}`
          }
          history={vramHistory}
        />
      </div>

      <GpuBreakdown snap={snap} />

      <p className="text-center text-xs text-muted-foreground">
        Polling every {POLL_MS / 1000} s · history retained for ~{(HISTORY_LEN * POLL_MS) / 60000} min
      </p>
    </div>
  )
}

// ─── Pieces ─────────────────────────────────────────────────────────────

function BigMetricCard({
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

function GpuBreakdown({ snap }: { snap: Snap }) {
  if (!snap.hasGpuDriver || snap.gpus.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-sm">
        <p className="eyebrow">GPU breakdown</p>
        <p className="mt-2 text-foreground">
          No NVIDIA driver detected on this machine.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Blueprint runs CPU-only models too — see the catalog for ones
          under ~4B parameters. AMD (ROCm) and Apple Silicon support
          land in a later release.
        </p>
      </section>
    )
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold tracking-tight">GPU breakdown</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          One row per GPU. VRAM usage is the headline for fitting larger models.
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

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) {
    return <div className="h-full w-full" />
  }
  const w = 200
  const h = 48
  const max = 100 // utilization metrics top at 100
  const step = w / Math.max(1, HISTORY_LEN - 1)
  // Right-align the latest point so older samples scroll off the left.
  const offset = w - step * (points.length - 1)
  const d = points
    .map((p, i) => {
      const x = offset + i * step
      const y = h - (Math.min(p, max) / max) * h
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
  // Fill area beneath for the visual.
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

function aggregateVramPct(gpus: Gpu[]): number {
  const used = gpus.reduce((a, g) => a + g.vramUsedMB, 0)
  const total = gpus.reduce((a, g) => a + g.vramTotalMB, 0)
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
