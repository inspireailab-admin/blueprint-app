import type { Tier } from '../planner/types'

export type TierCost = {
  /** Headline cost figure — e.g. "$2,800/mo" or "$18,000 one-time". */
  primary: string
  /** Optional second cost line. Used for on-prem to show one-time +
   *  monthly together ("$3,200 hardware" + "$130/mo power"); cloud
   *  leaves it blank. */
  secondary?: string
  /** Sub-line — e.g. "AWS reserved, 24×7" or "1.4 kW @ $0.15/kWh". */
  sub: string
}

type Props = {
  tiers: Tier[]
  /** SLA target the tiers are being compared against (used for the meets/misses note). */
  ttftTargetMs: number
  concurrencyTarget: number
  /**
   * Cost figures contextualized to a hosting choice — same length and order as `tiers`.
   * Omit to render the cards without a cost block (e.g. before hosting is chosen).
   */
  costs?: (TierCost | null)[]
  /** Label above the cost block ("On-prem cost", "Cloud cost"). */
  costLabel?: string
}

const TIER_LABEL: Record<Tier['label'], string> = {
  minimum: 'Minimum',
  recommended: 'Recommended',
  'high-end': 'High-end',
}

const TIER_TAG: Record<Tier['label'], string> = {
  minimum: 'It runs · tight',
  recommended: 'Meets your SLA · headroom',
  'high-end': 'Peak + growth · HA',
}

export function TierCards({
  tiers,
  ttftTargetMs,
  concurrencyTarget,
  costs,
  costLabel,
}: Props) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {tiers.map((tier, i) => (
        <TierCard
          key={tier.label}
          tier={tier}
          ttftTargetMs={ttftTargetMs}
          concurrencyTarget={concurrencyTarget}
          cost={costs?.[i] ?? null}
          costLabel={costLabel}
        />
      ))}
    </div>
  )
}

function TierCard({
  tier,
  ttftTargetMs,
  concurrencyTarget,
  cost,
  costLabel,
}: {
  tier: Tier
  ttftTargetMs: number
  concurrencyTarget: number
  cost: TierCost | null
  costLabel?: string
}) {
  const isRecommended = tier.label === 'recommended'
  const meetsSla = tier.expectedTtftMs <= ttftTargetMs && tier.supportedConcurrency >= concurrencyTarget

  return (
    <article
      className={[
        'relative rounded-2xl border p-5',
        isRecommended ? 'border-primary bg-card shadow-[0_8px_28px_rgba(58,91,208,0.10)]' : 'border-border bg-card',
      ].join(' ')}
    >
      {isRecommended && (
        <span className="absolute -top-2.5 left-4 rounded-md bg-primary px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-primary-foreground">
          Recommended
        </span>
      )}
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {TIER_TAG[tier.label]}
      </p>
      <p className="mt-2 text-lg font-semibold tracking-tight">{TIER_LABEL[tier.label]}</p>

      {cost && (
        <div className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
          {costLabel && (
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {costLabel}
            </p>
          )}
          <p
            className={[
              'mt-0.5 font-mono text-base font-semibold tracking-tight',
              isRecommended ? 'text-primary' : 'text-foreground',
            ].join(' ')}
          >
            {cost.primary}
          </p>
          {cost.secondary && (
            <p
              className={[
                'font-mono text-sm font-medium tracking-tight',
                isRecommended ? 'text-primary/85' : 'text-foreground/85',
              ].join(' ')}
            >
              {cost.secondary}
            </p>
          )}
          <p className="font-mono text-[10px] text-muted-foreground">{cost.sub}</p>
        </div>
      )}

      <dl className="mt-4 space-y-1.5 text-sm">
        {tier.config.gpu.vendor === 'CPU' ? (
          <>
            <Row k="GPU" v="None — runs on CPU" />
            <Row k="System RAM" v={`${tier.systemRamGB} GB (model lives here)`} />
            <Row k="CPU" v={`${tier.cpuCores}+ cores, AVX2/AVX-512`} />
            <Row k="Disk" v={`${tier.diskGB} GB NVMe`} />
            <Row k="Expected TTFT" v={`~ ${(tier.expectedTtftMs / 1000).toFixed(1)} s`} />
            <Row k="Concurrency" v={`${tier.supportedConcurrency} @ your settings`} />
          </>
        ) : (
          <>
            <Row k="GPU" v={`${tier.config.count}× ${tier.config.gpu.name}`} />
            <Row k="VRAM" v={`${tier.config.totalVramGB} GB total · ${tier.config.headroomGB} GB free`} />
            <Row k="System RAM" v={`${tier.systemRamGB} GB`} />
            <Row k="CPU" v={`${tier.cpuCores} cores`} />
            <Row k="Disk" v={`${tier.diskGB} GB NVMe`} />
            <Row k="Expected TTFT" v={`~ ${tier.expectedTtftMs} ms`} />
            <Row k="Concurrency" v={`${tier.supportedConcurrency} @ your settings`} />
          </>
        )}
      </dl>

      <div
        className={[
          'mt-4 rounded-md border px-3 py-2 text-xs',
          meetsSla
            ? 'border-chart-4/30 bg-chart-4/5 text-foreground/85'
            : tier.label === 'minimum'
              ? 'border-chart-5/30 bg-chart-5/5 text-foreground/85'
              : 'border-border bg-muted/30 text-muted-foreground',
        ].join(' ')}
      >
        {tier.note}
      </div>
    </article>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-t border-border/60 pt-1.5 first:border-t-0 first:pt-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-mono text-[12px]">{v}</span>
    </div>
  )
}
