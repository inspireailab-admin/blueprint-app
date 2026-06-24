import type { Model, Requirements } from './types'
import { computeVram, smallestQuant } from './vram'
import { LICENSE_LABEL } from './rank'
import { isLocallyInstallable } from './catalog'

type Props = {
  selectedModel: Model | null
  requirements: Requirements
  /** Called when the user is ready to leave the Plan tab. The container
   *  decides what "Continue" means — usually a tab switch. */
  onContinue: () => void
}

export function DetailPane({ selectedModel, requirements, onContinue }: Props) {
  if (!selectedModel) return <EmptyState />

  const quant = requirements.weightQuant ?? smallestQuant(selectedModel)
  const v = computeVram({
    model: selectedModel,
    weightQuant: quant,
    contextLength: requirements.context,
    concurrency: requirements.concurrency,
    kvElement: requirements.kvElement ?? 'fp16',
  })

  return (
    <aside className="space-y-4 rounded-2xl border border-border bg-card p-5">
      <div>
        <p className="eyebrow">Selected</p>
        <p className="mt-2 text-base font-semibold tracking-tight">
          {selectedModel.displayName}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground">
          {selectedModel.family} · {LICENSE_LABEL[selectedModel.license] ?? selectedModel.license}
        </p>
        {isLocallyInstallable(selectedModel) && (
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-chart-4/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-chart-4">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-chart-4" />
            Local install ready
          </span>
        )}
      </div>

      <dl className="space-y-1.5 text-sm">
        <Row k="Params" v={`${selectedModel.params}B${selectedModel.isMoE ? ` active · ${selectedModel.totalParams}B total (MoE)` : ''}`} />
        <Row k="Context" v={formatTokens(selectedModel.maxContext)} />
        <Row k="Quants" v={selectedModel.quantOptions.map((q) => q.toUpperCase()).join(' · ')} />
        <Row k="Gated" v={selectedModel.gated ? 'yes (HF approval)' : 'no'} />
      </dl>

      <div>
        <p className="eyebrow">VRAM at your settings</p>
        <div className="mt-2 rounded-lg border border-border bg-background p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm">
              {quant.toUpperCase()} · {formatTokens(requirements.context)} · {requirements.concurrency}{' '}
              concurrent
            </span>
            <b className="font-mono text-sm">{v.totalGB} GB</b>
          </div>
          <div className="mt-2 flex h-3 overflow-hidden rounded border border-border">
            <span
              className="bg-chart-1"
              style={{ width: `${(v.weightsBytes / v.totalBytes) * 100}%` }}
            />
            <span
              className="bg-chart-2"
              style={{ width: `${(v.kvCacheBytes / v.totalBytes) * 100}%` }}
            />
            <span
              className="bg-chart-3"
              style={{ width: `${(v.overheadBytes / v.totalBytes) * 100}%` }}
            />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] text-muted-foreground">
            <span>{v.weightsGB} GB · weights</span>
            <span>{v.kvCacheGB} GB · KV</span>
            <span>{v.overheadGB} GB · overhead</span>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          KV scales with context × concurrency — adjust the sliders to see it move.
        </p>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
      >
        Continue → Hardware &amp; Cost
        <span aria-hidden>→</span>
      </button>
    </aside>
  )
}

function EmptyState() {
  return (
    <aside className="rounded-2xl border border-dashed border-border bg-muted/30 p-5">
      <p className="eyebrow">Selected</p>
      <p className="mt-3 text-sm text-muted-foreground">
        Pick a model from the list to see its full spec, VRAM breakdown, and the path forward.
      </p>
    </aside>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5 first:border-t-0 first:pt-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-mono text-[12px]">{v}</span>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_048_576)}M`
  if (n >= 1_000) return `${Math.round(n / 1024)}K`
  return `${n}`
}
