import type { RankedModel, Requirements } from './types'
import { computeVram, smallestQuant } from './vram'
import { LICENSE_LABEL } from './rank'
import { DEFAULT_REQUIREMENTS } from './state'

type Props = {
  ranked: RankedModel[]
  selectedId: string | null
  requirements: Requirements
  /**
   * Total VRAM on this machine (in GB) for the fit-vs-this-GPU badge.
   * null = unknown (no GPU detected, or snapshot not yet loaded) — in
   * that case the badge stays hidden so we don't show meaningless data.
   */
  userVramGB: number | null
  onSelect: (id: string) => void
}

export function ResultsList({
  ranked,
  selectedId,
  requirements,
  userVramGB,
  onSelect,
}: Props) {
  const included = ranked.filter((r) => !r.verdict.excludedBy)
  const excluded = ranked.filter((r) => r.verdict.excludedBy)
  const topIncludedId = included[0]?.model.id

  return (
    <div>
      <div className="mb-4 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm">
            <span className="font-mono text-2xl font-semibold tracking-tight text-foreground">
              {included.length}
            </span>
            <span className="ml-2 text-muted-foreground">
              {included.length === 1 ? 'model matches' : 'models match'} your filters
              {excluded.length > 0 && (
                <span className="ml-1.5 text-muted-foreground/80">
                  · {excluded.length} excluded
                </span>
              )}
            </span>
          </p>
        </div>
        <ActiveFilterSummary requirements={requirements} />
      </div>

      {userVramGB && (
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Sizing fit against your GPU: <span className="text-foreground">{userVramGB} GB VRAM detected</span>
        </p>
      )}

      <ul className="space-y-2">
        {included.map((r) => (
          <li key={r.model.id}>
            <Row
              ranked={r}
              requirements={requirements}
              userVramGB={userVramGB}
              selected={selectedId === r.model.id}
              isBestFit={r.model.id === topIncludedId}
              onSelect={() => onSelect(r.model.id)}
            />
          </li>
        ))}
      </ul>

      {excluded.length > 0 && (
        <>
          <p className="mt-8 mb-2 px-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Excluded by your filters
          </p>
          <ul className="space-y-2">
            {excluded.map((r) => (
              <li key={r.model.id}>
                <ExcludedRow ranked={r} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Row({
  ranked,
  requirements,
  userVramGB,
  selected,
  isBestFit,
  onSelect,
}: {
  ranked: RankedModel
  requirements: Requirements
  userVramGB: number | null
  selected: boolean
  isBestFit: boolean
  onSelect: () => void
}) {
  const { model, verdict } = ranked
  const quant = requirements.weightQuant ?? smallestQuant(model)
  const v = computeVram({
    model,
    weightQuant: quant,
    contextLength: requirements.context,
    concurrency: requirements.concurrency,
    kvElement: requirements.kvElement ?? 'fp16',
  })

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        'block w-full rounded-xl border bg-card p-4 text-left transition',
        selected
          ? 'border-primary shadow-[0_2px_16px_rgba(58,91,208,0.12)]'
          : 'border-border hover:border-foreground/30',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <b className="text-base tracking-tight">{model.displayName}</b>
        {isBestFit && (
          <span className="rounded-full bg-chart-4/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-chart-4">
            ● best fit
          </span>
        )}
        <FitBadge totalGB={v.totalGB} userVramGB={userVramGB} />
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {verdict.score}/100
        </span>
      </div>

      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        {model.params}B{model.isMoE && ` · MoE ${model.totalParams}B`} · {formatTokens(model.maxContext)} ctx
        {' · '}
        {LICENSE_LABEL[model.license] ?? model.license}
        {' · '}
        {quant.toUpperCase()} ~{v.weightsGB} GB weights
      </p>

      <p className="mt-2 text-sm text-foreground/85">{verdict.reason}</p>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>
          <span className="text-foreground">{v.totalGB} GB</span> total
        </span>
        <span>
          KV: <span className="text-foreground">{v.kvCacheGB} GB</span>
        </span>
        <span>
          weights + KV + overhead
        </span>
      </div>
    </button>
  )
}

/**
 * Renders a colored pill indicating how the model's total VRAM
 * requirement compares to the user's detected GPU memory:
 *   green  ·  fits with comfortable headroom (<70% of available VRAM)
 *   amber  ·  tight fit (70–100% of VRAM — works but no room for
 *             KV-cache spikes or other apps)
 *   red    ·  exceeds available VRAM at this quant
 * Hidden when userVramGB is null (no GPU detected or snapshot still
 * loading); a CPU-only host shouldn't see misleading "won't fit"
 * badges on every card.
 */
function FitBadge({
  totalGB,
  userVramGB,
}: {
  totalGB: number
  userVramGB: number | null
}) {
  if (!userVramGB) return null
  const ratio = totalGB / userVramGB
  if (ratio > 1) {
    return (
      <span className="rounded-full border border-destructive/30 bg-destructive/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-destructive">
        ● needs more VRAM
      </span>
    )
  }
  if (ratio > 0.7) {
    return (
      <span className="rounded-full border border-amber-500/30 bg-amber-500/[0.08] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
        ● tight fit
      </span>
    )
  }
  return (
    <span className="rounded-full border border-chart-4/30 bg-chart-4/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-chart-4">
      ● runs on this machine
    </span>
  )
}

function ExcludedRow({ ranked }: { ranked: RankedModel }) {
  const { model, verdict } = ranked
  return (
    <div className="block w-full rounded-xl border border-border/60 bg-muted/30 p-4 opacity-70">
      <div className="flex flex-wrap items-baseline gap-2">
        <b className="text-sm tracking-tight">{model.displayName}</b>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{verdict.reason}</p>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_048_576)}M`
  if (n >= 1_000) return `${Math.round(n / 1024)}K`
  return `${n}`
}

const TYPE_LABEL: Record<string, string> = {
  'text-generation': 'Text generation',
  reasoning: 'Reasoning',
  code: 'Code',
  'vision-language': 'Vision–language',
  'speech-to-text': 'Speech-to-text',
  'text-to-speech': 'Text-to-speech',
  embedding: 'Embeddings',
  reranker: 'Reranking',
}

/**
 * Tiny status line showing which filter changes a user has applied
 * relative to defaults. Helps with the "did clicking that checkbox
 * actually do anything?" perception problem — when an active filter
 * matches no extra models, the count stays the same but this line
 * confirms the click registered.
 */
function ActiveFilterSummary({ requirements }: { requirements: Requirements }) {
  const def = DEFAULT_REQUIREMENTS
  const labels: string[] = []

  if (requirements.types.length === 0) {
    labels.push('any type')
  } else if (
    requirements.types.length !== def.types.length ||
    requirements.types.some((t) => !def.types.includes(t))
  ) {
    labels.push(
      requirements.types.length === 1
        ? TYPE_LABEL[requirements.types[0]] ?? requirements.types[0]
        : `${requirements.types.length} types`,
    )
  }
  if (requirements.needStructuredOutput) labels.push('structured output')
  if (requirements.needMultilingual) labels.push('multilingual')
  if (requirements.notGated) labels.push('not gated')
  if (requirements.commercialOk !== def.commercialOk) {
    labels.push(requirements.commercialOk ? 'commercial OK' : 'non-commercial OK')
  }
  if (requirements.sizeRanges && requirements.sizeRanges.length > 0) {
    labels.push(`size: ${requirements.sizeRanges.join(', ')}`)
  }
  if (requirements.preferFamily) {
    labels.push(`family: ${requirements.preferFamily}`)
  }

  if (labels.length === 0) {
    return (
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
        no extra filters
      </p>
    )
  }
  return (
    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
      filters · {labels.join(' · ')}
    </p>
  )
}
