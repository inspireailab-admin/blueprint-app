// Optimize tab — pick the knobs that affect quality, speed, and memory
// for this model. Values flow into the Deploy tab as the params we
// pass to llama-server.
//
// The user can tweak after deploy too, but tweaking these requires a
// server restart, so we surface it explicitly here before the deploy
// step instead of burying it in a disclosure.

import { useMemo } from 'react'
import type { Model, Quant } from '../planner/types'

export type ServeConfig = {
  quant: Quant
  ctxSize: number
  nGpuLayers: number
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
      <GpuLayersCard value={config.nGpuLayers} onChange={(n) => onChange({ ...config, nGpuLayers: n })} />

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

function GpuLayersCard({
  value,
  onChange,
}: {
  value: number
  onChange: (n: number) => void
}) {
  return (
    <SectionCard
      title="GPU layer offload"
      description="How many transformer layers move to the GPU. 999 offloads everything; 0 runs the whole model on CPU; partial values split between GPU and CPU (useful when the model is just barely too big for VRAM)."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Layers · {value === 999 ? 'all (auto-clamped to model)' : value}
          </label>
          <input
            type="range"
            min={0}
            max={999}
            step={1}
            value={value}
            onChange={(e) => onChange(parseInt(e.target.value, 10))}
            className="mt-1 w-full accent-primary"
          />
        </div>
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
    </SectionCard>
  )
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
