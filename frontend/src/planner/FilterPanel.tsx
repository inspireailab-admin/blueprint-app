import type { ModelType, Requirements, SizeRange } from './types'

type Props = {
  requirements: Requirements
  /** Family names — passed in so this component stays catalog-agnostic. */
  families: string[]
  onUpdate: (patch: Partial<Requirements>) => void
  onOpenHelp: () => void
  onReset: () => void
}

const CONTEXT_PRESETS: { label: string; value: number }[] = [
  { label: '4K', value: 4_096 },
  { label: '32K', value: 32_768 },
  { label: '128K', value: 131_072 },
  { label: '256K', value: 262_144 },
  { label: '1M', value: 1_048_576 },
]

// Speech-to-text and text-to-speech filter options are intentionally
// omitted for Phase 1 — Blueprint's llama-server runtime doesn't drive
// those models, so listing them with zero matches would be a dead end.
// They come back when the catalog has runnable entries.
const TYPE_OPTIONS: { value: ModelType; label: string; group: string }[] = [
  { value: 'text-generation', label: 'Text generation (instruct / chat)', group: 'Text' },
  { value: 'reasoning', label: 'Reasoning-specialized', group: 'Text' },
  { value: 'code', label: 'Code-specialized', group: 'Text' },
  { value: 'vision-language', label: 'Vision–language', group: 'Multimodal' },
  { value: 'embedding', label: 'Embeddings', group: 'Retrieval' },
  { value: 'reranker', label: 'Reranking', group: 'Retrieval' },
]

const SIZE_OPTIONS: { value: SizeRange; label: string }[] = [
  { value: 'lt-4b', label: '< 4B' },
  { value: '4b-14b', label: '4–14B' },
  { value: '14b-32b', label: '14–32B' },
  { value: '32b-70b', label: '32–70B' },
  { value: 'gt-70b', label: '70B+' },
]

export function FilterPanel({ requirements, families, onUpdate, onOpenHelp, onReset }: Props) {
  // Toggling allows the list to go empty — that's interpreted as "no type
  // filter applied, show all model types." The previous behavior silently
  // re-checked the last-removed type, which made the checkbox feel broken.
  const toggleType = (t: ModelType) => {
    const has = requirements.types.includes(t)
    const next = has
      ? requirements.types.filter((x) => x !== t)
      : [...requirements.types, t]
    onUpdate({ types: next })
  }

  const toggleSize = (s: SizeRange) => {
    const current = requirements.sizeRanges ?? []
    const has = current.includes(s)
    onUpdate({
      sizeRanges: has ? current.filter((x) => x !== s) : [...current, s],
    })
  }

  return (
    <aside className="border border-border bg-card lg:rounded-2xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="eyebrow">Filters</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenHelp}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-primary/15"
          >
            ✦ Help me choose
          </button>
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-muted-foreground transition hover:text-foreground"
          >
            Reset
          </button>
        </div>
      </div>

      <Group title="Model type">
        {(['Text', 'Multimodal', 'Retrieval'] as const).map((g) => (
          <div key={g} className="mb-3 last:mb-0">
            <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {g}
            </p>
            {TYPE_OPTIONS.filter((o) => o.group === g).map((o) => (
              <Check
                key={o.value}
                checked={requirements.types.includes(o.value)}
                onChange={() => toggleType(o.value)}
                label={o.label}
              />
            ))}
          </div>
        ))}
      </Group>

      <Group title="Capabilities">
        <Check
          checked={!!requirements.needStructuredOutput}
          onChange={() => onUpdate({ needStructuredOutput: !requirements.needStructuredOutput })}
          label="Structured output (JSON / tool calls)"
        />
        <Check
          checked={!!requirements.needMultilingual}
          onChange={() => onUpdate({ needMultilingual: !requirements.needMultilingual })}
          label="Multilingual"
        />
      </Group>

      <Group title="Performance & SLA">
        <Range
          label={`Concurrency: ${requirements.concurrency}`}
          min={1}
          max={200}
          step={1}
          value={requirements.concurrency}
          onChange={(v) => onUpdate({ concurrency: v })}
        />
        <Range
          label={`TTFT target: < ${requirements.ttftMs} ms`}
          min={50}
          max={1500}
          step={10}
          value={requirements.ttftMs}
          onChange={(v) => onUpdate({ ttftMs: v })}
        />
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Context
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {CONTEXT_PRESETS.map((p) => (
            <Pill
              key={p.value}
              active={requirements.context === p.value}
              onClick={() => onUpdate({ context: p.value })}
            >
              {p.label}
            </Pill>
          ))}
        </div>
      </Group>

      <Group title="Constraints">
        <Check
          checked={!!requirements.commercialOk}
          onChange={() => onUpdate({ commercialOk: !requirements.commercialOk })}
          label="Commercial license OK"
        />
        <Check
          checked={!!requirements.notGated}
          onChange={() => onUpdate({ notGated: !requirements.notGated })}
          label="Instant download (not gated)"
        />
      </Group>

      <Group title="Model preferences">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Size
        </p>
        <div className="mb-3 flex flex-wrap gap-1">
          {SIZE_OPTIONS.map((s) => (
            <Pill
              key={s.value}
              active={(requirements.sizeRanges ?? []).includes(s.value)}
              onClick={() => toggleSize(s.value)}
            >
              {s.label}
            </Pill>
          ))}
        </div>
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Family preference
        </p>
        <select
          value={requirements.preferFamily ?? ''}
          onChange={(e) => onUpdate({ preferFamily: e.target.value || undefined })}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any family</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Group>
    </aside>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border px-4 py-4 last:border-b-0">
      <p className="mb-2 text-sm font-semibold tracking-tight">{title}</p>
      {children}
    </div>
  )
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-sm text-foreground/90 last:mb-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 rounded border-border accent-primary"
      />
      <span>{label}</span>
    </label>
  )
}

function Range({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="mb-3 block last:mb-0">
      <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="mt-1 w-full accent-primary"
      />
    </label>
  )
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-md border px-2 py-0.5 font-mono text-[11px] transition',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
