
import { useEffect, useState } from 'react'
import type { ModelType, Requirements } from './types'

type Props = {
  open: boolean
  onClose: () => void
  onApply: (patch: Partial<Requirements>) => void
}

type WorkloadChoice =
  | { id: 'chat-rag'; label: 'Chat or RAG'; patch: Partial<Requirements> }
  | { id: 'reasoning'; label: 'Reasoning (math, analysis, planning)'; patch: Partial<Requirements> }
  | { id: 'code'; label: 'Code assistance'; patch: Partial<Requirements> }
  | { id: 'multilingual-docs'; label: 'Multilingual document processing'; patch: Partial<Requirements> }

const WORKLOADS: WorkloadChoice[] = [
  { id: 'chat-rag', label: 'Chat or RAG', patch: { types: ['text-generation'] } },
  { id: 'reasoning', label: 'Reasoning (math, analysis, planning)', patch: { types: ['reasoning', 'text-generation'] } },
  { id: 'code', label: 'Code assistance', patch: { types: ['code'] } },
  { id: 'multilingual-docs', label: 'Multilingual document processing', patch: { types: ['text-generation'], needMultilingual: true } },
]

const CONCURRENCY: { id: string; label: string; value: number }[] = [
  { id: 'few', label: 'Just me or a few testers', value: 3 },
  { id: 'team', label: 'A small team (5–25)', value: 25 },
  { id: 'app', label: 'An app (25–100)', value: 75 },
  { id: 'high', label: 'High volume (100+)', value: 150 },
]

const CONTEXT: { id: string; label: string; value: number }[] = [
  { id: 'short', label: 'Short — chat length', value: 4_096 },
  { id: 'medium', label: 'Medium — RAG, summaries', value: 32_768 },
  { id: 'long', label: 'Long — whole documents', value: 131_072 },
  { id: 'xlong', label: 'Very long — codebases or contracts', value: 262_144 },
]

const LICENSING: { id: string; label: string; patch: Partial<Requirements> }[] = [
  { id: 'internal', label: 'Internal / research only', patch: { commercialOk: false } },
  { id: 'product', label: 'Going into a commercial product', patch: { commercialOk: true, notGated: true } },
]

export function HelpMeChoose({ open, onClose, onApply }: Props) {
  const [workload, setWorkload] = useState<string>('chat-rag')
  const [concurrency, setConcurrency] = useState<string>('team')
  const [context, setContext] = useState<string>('medium')
  const [licensing, setLicensing] = useState<string>('product')

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Lock body scroll
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  const apply = () => {
    const w = WORKLOADS.find((w) => w.id === workload)!
    const c = CONCURRENCY.find((c) => c.id === concurrency)!
    const ctx = CONTEXT.find((c) => c.id === context)!
    const lic = LICENSING.find((l) => l.id === licensing)!

    // Merge type lists (workload + multilingual)
    const types: ModelType[] = w.patch.types ?? ['text-generation']

    onApply({
      ...w.patch,
      ...lic.patch,
      types,
      concurrency: c.value,
      context: ctx.value,
    })
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hmc-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-4 py-6 backdrop-blur-sm sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <p className="eyebrow">Help me choose</p>
            <h2 id="hmc-title" className="mt-1 text-lg font-semibold tracking-tight">
              Four quick questions, then we set the filters
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[70vh] space-y-6 overflow-y-auto p-5">
          <Question title="What are you building?">
            {WORKLOADS.map((w) => (
              <Option key={w.id} active={workload === w.id} onClick={() => setWorkload(w.id)}>
                {w.label}
              </Option>
            ))}
          </Question>

          <Question title="How many simultaneous users at peak?">
            {CONCURRENCY.map((c) => (
              <Option key={c.id} active={concurrency === c.id} onClick={() => setConcurrency(c.id)}>
                {c.label} <span className="text-muted-foreground">· {c.value}</span>
              </Option>
            ))}
          </Question>

          <Question title="How long are your typical prompts?">
            {CONTEXT.map((c) => (
              <Option key={c.id} active={context === c.id} onClick={() => setContext(c.id)}>
                {c.label} <span className="text-muted-foreground">· {formatTokens(c.value)}</span>
              </Option>
            ))}
          </Question>

          <Question title="What's the deployment context?">
            {LICENSING.map((l) => (
              <Option key={l.id} active={licensing === l.id} onClick={() => setLicensing(l.id)}>
                {l.label}
              </Option>
            ))}
          </Question>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-5 py-3">
          <p className="text-xs text-muted-foreground">
            Adjusts the filters — you can still tweak anything after.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm transition hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-sm font-semibold tracking-tight">{title}</p>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </div>
  )
}

function Option({
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
      aria-pressed={active}
      className={[
        'rounded-md border px-3 py-2 text-left text-sm transition',
        active
          ? 'border-primary bg-primary/5 text-foreground shadow-[inset_0_0_0_1px_var(--color-primary)]'
          : 'border-border bg-card text-foreground/85 hover:border-foreground/30',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_048_576)}M`
  if (n >= 1_000) return `${Math.round(n / 1024)}K`
  return `${n}`
}
