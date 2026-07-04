import type { RankedModel, Requirements } from './types'
import { computeVram, smallestQuant } from './vram'
import { LICENSE_LABEL } from './rank'
import { DEFAULT_REQUIREMENTS } from './state'
import type { HardwareProfile } from './hardware'
import { totalVramGB } from './hardware'
import { planPlacement, type PlacementPlan } from './placement'

type Props = {
  ranked: RankedModel[]
  selectedId: string | null
  requirements: Requirements
  /**
   * Detected hardware for the fit badge — per-GPU VRAM + system RAM. Drives
   * the single-GPU / multi-GPU / offload / CPU / won't-fit placement badge.
   * null = unknown (snapshot not yet loaded) → badges stay hidden.
   */
  hardware: HardwareProfile | null
  onSelect: (id: string) => void
}

export function ResultsList({
  ranked,
  selectedId,
  requirements,
  hardware,
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

      {hardware && hardware.gpus.length > 0 && (
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Sizing fit against your hardware:{' '}
          <span className="text-foreground">
            {hardware.gpus.length === 1
              ? '1 GPU'
              : `${hardware.gpus.length} GPUs`}{' '}
            · {round1(totalVramGB(hardware))} GB VRAM detected
          </span>
        </p>
      )}

      <ul className="space-y-2">
        {included.map((r) => (
          <li key={r.model.id}>
            <Row
              ranked={r}
              requirements={requirements}
              hardware={hardware}
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
  hardware,
  selected,
  isBestFit,
  onSelect,
}: {
  ranked: RankedModel
  requirements: Requirements
  hardware: HardwareProfile | null
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
  const plan = planPlacement(v, hardware)

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
        <FitBadge plan={plan} />
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

const BADGE_BASE =
  'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]'
const BADGE_RED = 'border-destructive/30 bg-destructive/5 text-destructive'
const BADGE_AMBER =
  'border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400'
const BADGE_GREEN = 'border-chart-4/30 bg-chart-4/10 text-chart-4'
const BADGE_BLUE = 'border-primary/30 bg-primary/10 text-primary'
const BADGE_MUTED = 'border-border bg-muted text-muted-foreground'

/**
 * Renders a colored pill from the placement plan (planner/placement.ts),
 * indicating how — and whether — the model fits the detected hardware:
 *
 *   green  · single-gpu  · fits one GPU with headroom (<70%)
 *   amber  · single-gpu  · tight fit on one GPU (70–100%)
 *   blue   · multi-gpu   · weights split across N GPUs (GPU-resident)
 *   amber  · offload     · weights on GPU, full-context total needs trimming
 *   muted  · cpu-only    · weights fit only in RAM — runs mostly on CPU, slow
 *   red    · no-fit      · weights don't fit GPU(s)+RAM — won't run here
 *
 * Hidden when the plan is null (no hardware detected / snapshot still
 * loading) so a CPU-only host doesn't get misleading badges on every card.
 */
function FitBadge({ plan }: { plan: PlacementPlan | null }) {
  if (!plan) return null
  switch (plan.mode) {
    case 'single-gpu':
      return (plan.fillRatio ?? 0) > 0.7 ? (
        <span className={`${BADGE_BASE} ${BADGE_AMBER}`}>● tight fit</span>
      ) : (
        <span className={`${BADGE_BASE} ${BADGE_GREEN}`}>● runs on this machine</span>
      )
    case 'multi-gpu':
      return (
        <span className={`${BADGE_BASE} ${BADGE_BLUE}`}>
          ● runs across {plan.gpuIndices.length} GPUs
        </span>
      )
    case 'partial-offload':
      return (
        <span className={`${BADGE_BASE} ${BADGE_AMBER}`}>● tight — trim context</span>
      )
    case 'cpu-only':
      return <span className={`${BADGE_BASE} ${BADGE_MUTED}`}>● mostly CPU — slow</span>
    case 'no-fit':
      return <span className={`${BADGE_BASE} ${BADGE_RED}`}>● needs more VRAM</span>
  }
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

function round1(n: number): number {
  return Math.round(n * 10) / 10
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
