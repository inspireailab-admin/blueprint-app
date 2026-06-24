'use client'

import { useMemo, useState } from 'react'
import { selfHostVsApiBreakEven } from '../planner/cost'
import type { Tier } from '../planner/types'

type Props = {
  recommendedTier: Tier
}

export function BreakEvenCard({ recommendedTier }: Props) {
  const [requestsPerDay, setRequestsPerDay] = useState<number>(5_000)

  const result = useMemo(
    () =>
      selfHostVsApiBreakEven({
        recommendedTier,
        requestsPerDay,
      }),
    [recommendedTier, requestsPerDay],
  )

  const selfHostWins = result.apiMonthly >= result.selfHostMonthly

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="eyebrow">Self-host vs frontier API</p>
      <p className="mt-1 text-base font-semibold tracking-tight">Where it pays to own the stack</p>

      <label className="mt-4 block">
        <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Requests / day at peak
        </span>
        <input
          type="range"
          min={100}
          max={500_000}
          step={100}
          value={requestsPerDay}
          onChange={(e) => setRequestsPerDay(parseInt(e.target.value, 10))}
          className="mt-1.5 w-full accent-primary"
        />
        <span className="mt-1 block font-mono text-[12px] text-foreground">
          {requestsPerDay.toLocaleString()} req/day · ~{(requestsPerDay * 1500).toLocaleString()} tokens/day
        </span>
      </label>

      <div className="mt-5 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
        <Cost
          label="Frontier API"
          value={fmtUSD(result.apiMonthly) + '/mo'}
          highlight={!selfHostWins}
          foot={selfHostWins ? 'Self-host is cheaper at this volume' : 'Cheaper than self-host today'}
        />
        <Cost
          label="Self-host (cloud reserved)"
          value={fmtUSD(result.selfHostMonthly) + '/mo'}
          highlight={selfHostWins}
          foot={
            selfHostWins
              ? 'Cheaper than the API at this volume'
              : 'Becomes cheaper above ~' + result.breakEvenRequestsPerDay.toLocaleString() + ' req/day'
          }
        />
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{result.reason}</p>
    </div>
  )
}

function Cost({
  label,
  value,
  foot,
  highlight,
}: {
  label: string
  value: string
  foot: string
  highlight?: boolean
}) {
  return (
    <div className={`bg-card p-4 ${highlight ? 'text-primary' : ''}`}>
      <p
        className={`font-mono text-[10px] uppercase tracking-[0.12em] ${highlight ? 'text-primary/80' : 'text-muted-foreground'}`}
      >
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tracking-tight">{value}</p>
      <p className={`mt-1 text-[11px] ${highlight ? 'text-primary/70' : 'text-muted-foreground'}`}>{foot}</p>
    </div>
  )
}

function fmtUSD(n: number): string {
  return '$' + Math.round(n).toLocaleString()
}
