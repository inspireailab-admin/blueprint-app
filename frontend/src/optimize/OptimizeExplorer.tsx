// Optimize tab — pick the knobs that affect quality, speed, and memory
// for this model. Values flow into the Deploy tab as the params we
// pass to llama-server.
//
// The user can tweak after deploy too, but tweaking these requires a
// server restart, so we surface it explicitly here before the deploy
// step instead of burying it in a disclosure.

import { useEffect, useMemo, useState } from 'react'
import type { Model, Quant } from '../planner/types'
import { computeVram } from '../planner/vram'
import { planPlacement, type PlacementPlan } from '../planner/placement'
import { hardwareFromSnapshot, type HardwareProfile } from '../planner/hardware'
import { Snapshot } from '../../wailsjs/go/main/App'

export type ServeConfig = {
  quant: Quant
  ctxSize: number
  nGpuLayers: number
  // Multi-GPU placement (see docs/plan-target-aware-deploy.md §7). Left unset
  // for single-GPU deploys; the deploy step auto-fills these from the detected
  // hardware when the model needs splitting, and (later) an expert can override.
  splitMode?: 'layer' | 'row'
  tensorSplit?: number[]
  mainGpu?: number
}

type Props = {
  selectedModel: Model | null
  config: ServeConfig
  onChange: (next: ServeConfig) => void
  onBackToHardware: () => void
  onContinueToDeploy: () => void
}

export function OptimizeExplorer({
  selectedModel,
  config,
  onChange,
  onBackToHardware,
  onContinueToDeploy,
}: Props) {
  // Detected hardware feeds the GPU-placement control (auto plan + how many
  // GPUs to expose split controls for). null until the snapshot lands.
  const [hardware, setHardware] = useState<HardwareProfile | null>(null)
  useEffect(() => {
    Snapshot()
      .then((s) => setHardware(hardwareFromSnapshot(s)))
      .catch(() => {
        /* no snapshot → placement control shows the auto summary only */
      })
  }, [])

  if (!selectedModel) {
    return (
      <div className="mt-10 mx-auto max-w-md rounded-2xl border border-dashed border-border bg-muted/30 p-8 text-center">
        <p className="eyebrow">Pick a model first</p>
        <p className="mt-3 text-sm text-muted-foreground">
          Optimize knobs are model-specific — pick one in Plan and size the hardware
          before tuning.
        </p>
        <button
          type="button"
          onClick={onBackToHardware}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          ← Back to Hardware
        </button>
      </div>
    )
  }

  const maxCtx = selectedModel.maxContext

  return (
    <div className="mt-8 space-y-6">
      <QuantCard model={selectedModel} value={config.quant} onChange={(q) => onChange({ ...config, quant: q })} />
      <ContextCard maxCtx={maxCtx} value={config.ctxSize} onChange={(n) => onChange({ ...config, ctxSize: n })} />
      <GpuPlacementCard
        model={selectedModel}
        quant={config.quant}
        ctxSize={config.ctxSize}
        hardware={hardware}
        config={config}
        onChange={onChange}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
        <button
          type="button"
          onClick={onBackToHardware}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          ← Back to Hardware
        </button>
        <button
          type="button"
          onClick={onContinueToDeploy}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          Continue → Deploy
          <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  )
}

// ─── Cards ───────────────────────────────────────────────────────────────

function QuantCard({
  model,
  value,
  onChange,
}: {
  model: Model
  value: Quant
  onChange: (q: Quant) => void
}) {
  // Only show quants that have a GGUF file in the catalog — otherwise
  // the user picks a quant the pull step can't satisfy.
  const available = useMemo<Quant[]>(() => {
    if (!model.local?.ggufFiles) return model.quantOptions
    const have = new Set(Object.keys(model.local.ggufFiles))
    return model.quantOptions.filter((q) => have.has(q))
  }, [model])

  return (
    <SectionCard
      title="Weight quantization"
      description="Lower quants shrink the GGUF and lower VRAM, at some accuracy cost. Q4 is the default — it's the best size/quality tradeoff most workloads care about."
    >
      <div className="flex flex-wrap gap-2">
        {available.map((q) => {
          const active = q === value
          return (
            <button
              key={q}
              type="button"
              onClick={() => onChange(q)}
              className={[
                'rounded-md border px-3 py-1.5 text-sm font-medium transition',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-foreground hover:bg-muted',
              ].join(' ')}
            >
              <span className="font-mono">{q.toUpperCase()}</span>
              <span className="ml-2 text-[10px] opacity-70">{quantBlurb(q)}</span>
            </button>
          )
        })}
      </div>
    </SectionCard>
  )
}

function ContextCard({
  maxCtx,
  value,
  onChange,
}: {
  maxCtx: number
  value: number
  onChange: (n: number) => void
}) {
  const presets = useMemo(
    () => [4096, 8192, 16384, 32768, 65536, 131072, 262144].filter((n) => n <= maxCtx),
    [maxCtx],
  )
  return (
    <SectionCard
      title="Context window"
      description={`Maximum tokens per request. Higher means more text in/out per call, but VRAM scales with context × concurrency. Model max is ${formatTokens(maxCtx)}.`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {presets.map((n) => {
            const active = n === value
            return (
              <button
                key={n}
                type="button"
                onClick={() => onChange(n)}
                className={[
                  'rounded-md border px-2.5 py-1 font-mono text-xs transition',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground',
                ].join(' ')}
              >
                {formatTokens(n)}
              </button>
            )
          })}
        </div>
        <div>
          <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Custom · {formatTokens(value)} tokens
          </label>
          <input
            type="range"
            min={512}
            max={maxCtx}
            step={512}
            value={value}
            onChange={(e) => onChange(parseInt(e.target.value, 10))}
            className="mt-1 w-full accent-primary"
          />
        </div>
      </div>
    </SectionCard>
  )
}

/**
 * The single place any GPU decision is made. Blueprint picks the placement
 * automatically (shown read-only up top); an Advanced disclosure lets an
 * expert override — GPU-layer offload, and, on multi-GPU hosts, the split
 * mode. See docs/plan-target-aware-deploy.md §7.
 */
function GpuPlacementCard({
  model,
  quant,
  ctxSize,
  hardware,
  config,
  onChange,
}: {
  model: Model
  quant: Quant
  ctxSize: number
  hardware: HardwareProfile | null
  config: ServeConfig
  onChange: (next: ServeConfig) => void
}) {
  const plan = useMemo<PlacementPlan | null>(() => {
    if (!hardware) return null
    const v = computeVram({
      model,
      weightQuant: quant,
      contextLength: ctxSize || 4096,
      concurrency: 1,
      kvElement: 'fp16',
    })
    return planPlacement(v, hardware)
  }, [model, quant, ctxSize, hardware])

  const gpuCount = hardware?.gpus.length ?? 0
  const customSplit = !!config.tensorSplit?.length
  const resetAuto = () =>
    onChange({
      ...config,
      splitMode: undefined,
      tensorSplit: undefined,
      mainGpu: undefined,
      nGpuLayers: 999,
    })

  return (
    <SectionCard
      title="GPU placement"
      description="How this model is distributed across your GPU(s). Blueprint picks this automatically; advanced users can override below."
    >
      <PlacementSummary plan={plan} hardware={hardware} />

      <details className="mt-4 overflow-hidden rounded-xl border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>Advanced</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {customSplit ? 'custom split' : 'auto'}
          </span>
        </summary>
        <div className="space-y-6 border-t border-border p-4">
          <OffloadControl
            value={config.nGpuLayers}
            onChange={(n) => onChange({ ...config, nGpuLayers: n })}
          />
          {gpuCount > 1 && hardware && (
            <SplitControl plan={plan} hardware={hardware} config={config} onChange={onChange} />
          )}
          <button
            type="button"
            onClick={resetAuto}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
          >
            Reset to auto
          </button>
        </div>
      </details>
    </SectionCard>
  )
}

function PlacementSummary({
  plan,
  hardware,
}: {
  plan: PlacementPlan | null
  hardware: HardwareProfile | null
}) {
  if (!hardware) {
    return <p className="text-sm text-muted-foreground">Detecting hardware…</p>
  }
  if (hardware.gpus.length === 0) {
    return <SummaryLine tone="muted" text="No GPU detected — this model would run on CPU (slow)." />
  }
  if (!plan) return null
  switch (plan.mode) {
    case 'single-gpu':
      return (
        <SummaryLine
          tone="green"
          text={`Runs on 1 GPU — ${plan.usedGB} GB used, ${plan.headroomGB ?? 0} GB free.`}
        />
      )
    case 'multi-gpu':
      return (
        <SummaryLine
          tone="blue"
          text={`Runs across ${plan.gpuIndices.length} GPUs — split ${(plan.tensorSplit ?? [])
            .map((r) => `${Math.round(r * 100)}%`)
            .join(' / ')}.`}
        />
      )
    case 'partial-offload':
      return <SummaryLine tone="amber" text="Weights on the GPU; long-context KV cache offloads to system RAM." />
    case 'cpu-only':
      return <SummaryLine tone="muted" text="Weights don't fit VRAM — runs mostly on CPU (slow)." />
    case 'no-fit':
      return <SummaryLine tone="red" text="Doesn't fit this hardware — lower the quant or context to make room." />
  }
}

function SummaryLine({ tone, text }: { tone: 'green' | 'amber' | 'blue' | 'red' | 'muted'; text: string }) {
  const dot =
    tone === 'green'
      ? 'bg-chart-4'
      : tone === 'amber'
        ? 'bg-amber-500'
        : tone === 'blue'
          ? 'bg-primary'
          : tone === 'red'
            ? 'bg-destructive'
            : 'bg-muted-foreground/50'
  return (
    <p className="flex items-center gap-2 text-sm text-foreground">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      {text}
    </p>
  )
}

function OffloadControl({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        GPU layer offload · {value >= 999 ? 'all (auto-clamped to model)' : value}
      </label>
      <div className="mt-1 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
        <input
          type="range"
          min={0}
          max={999}
          step={1}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className="w-full accent-primary"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange(0)}
            className="rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs text-muted-foreground transition hover:bg-muted"
          >
            CPU only
          </button>
          <button
            type="button"
            onClick={() => onChange(999)}
            className="rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs text-muted-foreground transition hover:bg-muted"
          >
            All GPU
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        How many transformer layers move to the GPU. Lower values keep some on CPU —
        useful when a model is just barely too big for VRAM.
      </p>
    </div>
  )
}

function SplitControl({
  plan,
  hardware,
  config,
  onChange,
}: {
  plan: PlacementPlan | null
  hardware: HardwareProfile
  config: ServeConfig
  onChange: (next: ServeConfig) => void
}) {
  const autoSplit = plan?.mode === 'multi-gpu' ? plan.tensorSplit : undefined
  const effective = config.tensorSplit ?? autoSplit ?? evenSplit(hardware.gpus.length)
  const mode = config.splitMode // undefined = auto

  const setMode = (m?: 'layer' | 'row') => {
    if (!m) {
      onChange({ ...config, splitMode: undefined, tensorSplit: undefined, mainGpu: undefined })
      return
    }
    onChange({
      ...config,
      splitMode: m,
      tensorSplit: effective,
      mainGpu: config.mainGpu ?? hardware.gpus[argmaxIndex(effective)]?.index ?? 0,
    })
  }

  return (
    <div>
      <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        Multi-GPU split
      </label>
      <div className="mt-1 flex gap-2">
        {([undefined, 'layer', 'row'] as const).map((m) => {
          const active = mode === m
          return (
            <button
              key={m ?? 'auto'}
              type="button"
              onClick={() => setMode(m)}
              className={[
                'rounded-md border px-3 py-1.5 text-xs font-medium transition',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-foreground hover:bg-muted',
              ].join(' ')}
            >
              {m === undefined ? 'Auto' : m === 'layer' ? 'Layer' : 'Row'}
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
        {hardware.gpus.map((g, i) => (
          <span key={g.index}>
            GPU{g.index}: <span className="text-foreground">{Math.round((effective[i] ?? 0) * 100)}%</span>
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        <b>Layer</b> splits whole layers across GPUs — the default, tolerant of slow PCIe.
        <b> Row</b> is tensor-parallel: faster only with a fast interconnect (NVLink), and
        can be slower otherwise. Ratios are set automatically ∝ each GPU&apos;s VRAM.
      </p>
    </div>
  )
}

function evenSplit(n: number): number[] {
  return Array.from({ length: n }, () => Math.round((1 / n) * 100) / 100)
}

function argmaxIndex(a: number[]): number {
  return a.reduce((m, v, i) => (v > a[m] ? i : m), 0)
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-4">
        <h2 className="text-balance text-base font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{description}</p>
      </header>
      <div className="p-6">{children}</div>
    </section>
  )
}

function quantBlurb(q: Quant): string {
  switch (q) {
    case 'q3':
      return 'smallest · lossy'
    case 'q4':
      return 'recommended'
    case 'q8':
      return 'higher quality'
    case 'fp8':
      return 'fp8 · datacenter'
    case 'bf16':
    case 'fp16':
      return 'full precision'
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_048_576)}M`
  if (n >= 1_000) return `${Math.round(n / 1024)}K`
  return `${n}`
}
