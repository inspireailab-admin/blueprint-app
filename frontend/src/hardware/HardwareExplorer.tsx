// Hardware tab — VRAM sizing + three tier recommendations + an adjust
// disclosure. Mirrors the simplified /hardware page on the marketing
// site: no pricing, no provider comparison, no "pick your GPU" picker.
// Blueprint is a self-serve sizing tool, not a hardware-procurement
// service.

import { useMemo } from 'react'
import type { Model, Requirements } from '../planner/types'
import { computeVram, smallestQuant } from '../planner/vram'
import { pickTiers } from '../planner/sizing'
import { VramBreakdownBar } from './VramBreakdownBar'
import { TierCards } from './TierCards'
import { WhatIfSliders } from './WhatIfSliders'
import { BreakEvenCard } from './BreakEvenCard'
import { EstimatesDisclaimer } from './EstimatesDisclaimer'

type Props = {
  selectedModel: Model | null
  requirements: Requirements
  catalogAsOf: string
  onUpdate: (patch: Partial<Requirements>) => void
  onBackToPlan: () => void
  onContinueToDeploy: () => void
}

export function HardwareExplorer({
  selectedModel,
  requirements,
  catalogAsOf,
  onUpdate,
  onBackToPlan,
  onContinueToDeploy,
}: Props) {
  const quant = selectedModel
    ? requirements.weightQuant ?? smallestQuant(selectedModel)
    : 'q4'

  const breakdown = useMemo(
    () =>
      selectedModel
        ? computeVram({
            model: selectedModel,
            weightQuant: quant,
            kvElement: requirements.kvElement ?? 'fp16',
            contextLength: requirements.context,
            concurrency: requirements.concurrency,
          })
        : null,
    [selectedModel, quant, requirements.context, requirements.concurrency, requirements.kvElement],
  )

  const sizing = useMemo(
    () =>
      selectedModel
        ? pickTiers({
            model: selectedModel,
            weightQuant: quant,
            contextLength: requirements.context,
            concurrency: requirements.concurrency,
            ttftMs: requirements.ttftMs,
            kvElement: requirements.kvElement ?? 'fp16',
          })
        : null,
    [selectedModel, quant, requirements.context, requirements.concurrency, requirements.ttftMs, requirements.kvElement],
  )

  if (!selectedModel || !breakdown || !sizing) {
    return (
      <div className="mt-10 mx-auto max-w-md rounded-2xl border border-dashed border-border bg-muted/30 p-8 text-center">
        <p className="eyebrow">Pick a model first</p>
        <h2 className="mt-3 text-balance text-xl font-semibold tracking-tight">
          Nothing to size until you&apos;ve picked a model
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          The Plan tab is where you filter the open catalog and pick a model that
          fits your workload. From there we can size the hardware.
        </p>
        <button
          type="button"
          onClick={onBackToPlan}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          ← Back to Plan
        </button>
      </div>
    )
  }

  const recommended = sizing.tiers[1]

  return (
    <div className="mt-8 space-y-10">
      <Sizing breakdown={breakdown} catalogAsOf={catalogAsOf} />

      <HardwareRecommendations
        sizing={sizing}
        ttftMs={requirements.ttftMs}
        concurrency={requirements.concurrency}
      />

      <AdjustDisclosure>
        <WhatIfSliders requirements={requirements} onUpdate={onUpdate} />
        <BreakEvenCard recommendedTier={recommended} />
      </AdjustDisclosure>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
        <button
          type="button"
          onClick={onBackToPlan}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          ← Back to Plan
        </button>
        <button
          type="button"
          onClick={onContinueToDeploy}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          Continue → Optimize
          <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  )
}

// ─── Sections ───────────────────────────────────────────────────────────────

function SectionCard({
  title,
  description,
  children,
  contentClassName = '',
}: {
  title: string
  description: string
  children: React.ReactNode
  contentClassName?: string
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-5">
        <h2 className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
      </header>
      <div className={`p-6 ${contentClassName}`}>{children}</div>
    </section>
  )
}

function Sizing({
  breakdown,
  catalogAsOf,
}: {
  breakdown: NonNullable<ReturnType<typeof computeVram>>
  catalogAsOf: string
}) {
  return (
    <SectionCard
      title="VRAM Utilization"
      description="Total GPU memory needed for this model at your context length × concurrency."
      contentClassName="space-y-4"
    >
      <VramBreakdownBar
        breakdown={breakdown}
        rightAdornment={
          <span className="font-mono text-sm text-muted-foreground">
            ≈ <b className="text-foreground">{breakdown.totalGB} GB</b> total
          </span>
        }
      />
      <EstimatesDisclaimer catalogAsOf={catalogAsOf} />
    </SectionCard>
  )
}

function HardwareRecommendations({
  sizing,
  ttftMs,
  concurrency,
}: {
  sizing: NonNullable<ReturnType<typeof pickTiers>>
  ttftMs: number
  concurrency: number
}) {
  return (
    <SectionCard
      title="Hardware Recommendations"
      description="Three configurations sized for this model — minimum, recommended, high-end. Each tier is a complete spec to match against your own hardware or a cloud instance."
    >
      <TierCards
        tiers={sizing.tiers}
        ttftTargetMs={ttftMs}
        concurrencyTarget={concurrency}
      />
    </SectionCard>
  )
}

function AdjustDisclosure({ children }: { children: React.ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <summary className="flex cursor-pointer select-none items-start justify-between gap-3 list-none border-b border-transparent px-6 py-5 transition group-open:border-border">
        <div>
          <h2 className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
            Adjust Workload Assumptions
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Tweak context, concurrency, TTFT target, or weight quantization. The
            VRAM sizing and the hardware recommendations above recompute. Includes
            the self-host-vs-API break-even.
          </p>
        </div>
        <span
          aria-hidden
          className="mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-base text-muted-foreground transition group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="grid gap-6 p-6 lg:grid-cols-2">{children}</div>
    </details>
  )
}
