import type { VramBreakdown } from '../planner/vram'

type Props = {
  breakdown: VramBreakdown
  /** Headline above the bar; defaults to a sensible label. */
  title?: string
  /** Shown on the right end of the title row; useful for the "≈ X GB" total. */
  rightAdornment?: React.ReactNode
}

/**
 * The hero stacked VRAM bar — Weights / KV cache / Overhead. Used on the
 * Hardware page where it's the centerpiece visual. Inline legend below.
 */
export function VramBreakdownBar({ breakdown, title = 'Memory requirement', rightAdornment }: Props) {
  const total = breakdown.totalBytes
  const weightsPct = (breakdown.weightsBytes / total) * 100
  const kvPct = (breakdown.kvCacheBytes / total) * 100
  const overheadPct = (breakdown.overheadBytes / total) * 100

  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="eyebrow">{title}</p>
          <p className="mt-1 text-base font-semibold tracking-tight">Where the VRAM goes</p>
        </div>
        {rightAdornment}
      </div>

      <div
        className="mt-5 flex h-12 overflow-hidden rounded-md border border-border"
        role="img"
        aria-label={`Stacked VRAM breakdown — ${breakdown.weightsGB} GB weights, ${breakdown.kvCacheGB} GB KV cache, ${breakdown.overheadGB} GB overhead`}
      >
        {/* Segments are colored bars only — values live in the legend below
            so they can't get clipped when a segment is narrow. */}
        <Segment width={weightsPct} color="bg-chart-1" label="Weights" />
        <Segment width={kvPct} color="bg-chart-2" label="KV cache" />
        <Segment width={overheadPct} color="bg-chart-3" label="Overhead" />
      </div>

      <ul className="mt-4 grid gap-x-6 gap-y-3 text-xs text-muted-foreground sm:grid-cols-3">
        <LegendItem swatch="bg-chart-1" name="Weights" value={`${breakdown.weightsGB} GB`}>
          fixed by params × quant
        </LegendItem>
        <LegendItem swatch="bg-chart-2" name="KV cache" value={`${breakdown.kvCacheGB} GB`}>
          grows with context × concurrency
        </LegendItem>
        <LegendItem swatch="bg-chart-3" name="Overhead" value={`${breakdown.overheadGB} GB`}>
          activations + runtime
        </LegendItem>
      </ul>

      <KvCallout breakdown={breakdown} />
    </div>
  )
}

function Segment({ width, color, label }: { width: number; color: string; label: string }) {
  // Minimum visible width so segments don't disappear at extreme ratios.
  // Show the label inside the segment only when there's comfortable room;
  // the legend below carries the numerical value either way.
  const w = Math.max(width, 4)
  return (
    <div
      className={`flex items-center justify-center px-2 font-mono text-[11px] font-medium text-white ${color}`}
      style={{ width: `${w}%` }}
    >
      <span className="truncate">{width >= 14 ? label : ''}</span>
    </div>
  )
}

function LegendItem({
  swatch,
  name,
  value,
  children,
}: {
  swatch: string
  name: string
  value: string
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={`mt-1 inline-block h-2.5 w-2.5 flex-shrink-0 rounded ${swatch}`}
      />
      <div className="min-w-0">
        <p className="text-foreground">
          <b>{name}</b>
          <span className="ml-2 font-mono">{value}</span>
        </p>
        <p className="mt-0.5">{children}</p>
      </div>
    </li>
  )
}

function KvCallout({ breakdown }: { breakdown: VramBreakdown }) {
  const kvBiggerThanWeights = breakdown.kvCacheBytes > breakdown.weightsBytes
  if (!kvBiggerThanWeights) return null
  return (
    <div className="mt-5 rounded-md border border-chart-5/30 bg-chart-5/5 px-4 py-3 text-sm text-foreground/90">
      <p>
        <b className="font-mono text-xs uppercase tracking-[0.12em] text-chart-5">KV cache is the swing factor</b>
      </p>
      <p className="mt-1 text-muted-foreground">
        At your context × concurrency the KV cache is larger than the weights themselves. Levers to apply: <b className="text-foreground">grouped-query attention</b> (already in the model), <b className="text-foreground">KV-cache quantization</b> (FP8 / INT8, halves the cost), or capping context.
      </p>
    </div>
  )
}
