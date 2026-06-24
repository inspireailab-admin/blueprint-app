import type { Requirements } from '../planner/types'

type Props = {
  requirements: Requirements
  onUpdate: (patch: Partial<Requirements>) => void
}

const CONTEXT_PRESETS = [
  { label: '4K', value: 4_096 },
  { label: '8K', value: 8_192 },
  { label: '16K', value: 16_384 },
  { label: '32K', value: 32_768 },
  { label: '64K', value: 65_536 },
  { label: '128K', value: 131_072 },
]

export function WhatIfSliders({ requirements, onUpdate }: Props) {
  return (
    <div className="space-y-5 rounded-2xl border border-border bg-card p-5">
      <div>
        <p className="eyebrow">What-if</p>
        <p className="mt-1 text-base font-semibold tracking-tight">Move the sliders</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Concurrency and context recompute the VRAM, the tiers, and the cost above.
        </p>
      </div>

      <div>
        <label className="block">
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Concurrency: {requirements.concurrency} users
          </span>
          <input
            type="range"
            min={1}
            max={200}
            step={1}
            value={requirements.concurrency}
            onChange={(e) => onUpdate({ concurrency: parseInt(e.target.value, 10) })}
            className="mt-1.5 w-full accent-primary"
          />
        </label>
      </div>

      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Context: {formatTokens(requirements.context)} tokens
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {CONTEXT_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => onUpdate({ context: p.value })}
              className={[
                'rounded-md border px-2 py-0.5 font-mono text-[11px] transition',
                requirements.context === p.value
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground',
              ].join(' ')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block">
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            KV-cache precision
          </span>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(['fp16', 'fp8', 'int8'] as const).map((kv) => (
              <button
                key={kv}
                type="button"
                onClick={() => onUpdate({ kvElement: kv })}
                className={[
                  'rounded-md border px-2 py-0.5 font-mono text-[11px] uppercase transition',
                  (requirements.kvElement ?? 'fp16') === kv
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground',
                ].join(' ')}
              >
                {kv}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            FP8 / INT8 KV cache halves the KV memory at minimal quality cost — the lever to reach for first when KV is the swing factor.
          </p>
        </label>
      </div>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_048_576)}M`
  if (n >= 1_000) return `${Math.round(n / 1024)}K`
  return `${n}`
}
