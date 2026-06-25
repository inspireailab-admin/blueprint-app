// Calibrate tab — runs the imatrix-calibration + quantize workflow.
//
// Each "run" is a Blueprint consulting engagement: client uploads a
// representative prompt corpus, Blueprint runs llama-imatrix against
// the base GGUF to produce a calibration matrix, then llama-quantize
// uses that matrix to produce custom GGUFs that are better-quantized
// for the client's specific workload than bartowski's general-purpose
// pre-quants. The whole run directory is the deliverable.
//
// Layout: a left rail of runs (newest first) + a right pane that
// walks the active run through its phases.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CalibrationTools,
  CreateCalibrationRun,
  DeleteCalibrationRun,
  GetCalibrationRun,
  InstalledModels,
  ListCalibrationRuns,
  RunCalibratedQuantization,
  RunImatrixCalibration,
  SaveCalibrationPrompts,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { calibration as cal, main } from '../../wailsjs/go/models'
import { EvaluateStep } from './EvaluateStep'

// Targets we offer for calibrated quantization. Ordered by VRAM
// footprint, smallest first. The user multi-selects.
const QUANT_TARGETS = [
  { value: 'IQ3_XS', label: 'IQ3_XS', note: '~3.3 bpw — tight, mobile-friendly' },
  { value: 'Q3_K_S', label: 'Q3_K_S', note: '~3.5 bpw' },
  { value: 'IQ4_XS', label: 'IQ4_XS', note: '~4.25 bpw — fast modern format' },
  { value: 'Q4_K_M', label: 'Q4_K_M', note: '~4.85 bpw — common default' },
  { value: 'Q5_K_M', label: 'Q5_K_M', note: '~5.7 bpw — high quality' },
  { value: 'Q6_K', label: 'Q6_K', note: '~6.6 bpw — near-FP16 quality' },
] as const

export function CalibrateExplorer() {
  const [tools, setTools] = useState<main.CalibrationTools | null>(null)
  const [runs, setRuns] = useState<cal.Run[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<cal.Run | null>(null)
  const [installed, setInstalled] = useState<main.InstalledModel[] | null>(null)

  const refreshList = useCallback(async () => {
    try {
      const list = await ListCalibrationRuns()
      setRuns(list ?? [])
    } catch (e) {
      console.warn('list runs', e)
    }
  }, [])

  const refreshActive = useCallback(async () => {
    if (!activeId) {
      setActive(null)
      return
    }
    try {
      const r = await GetCalibrationRun(activeId)
      setActive(r)
    } catch (e) {
      console.warn('get run', e)
    }
  }, [activeId])

  useEffect(() => {
    void CalibrationTools().then(setTools)
    void InstalledModels().then((m) => setInstalled(m ?? []))
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    void refreshActive()
  }, [refreshActive])

  // Subscribe to backend events. Every run-updated bumps both the list
  // and the active run; stage events flip the section into "live."
  useEffect(() => {
    const off1 = EventsOn('calibrate:run-updated', () => {
      void refreshList()
      void refreshActive()
    })
    const off2 = EventsOn('calibrate:imatrix-stage', () => {
      void refreshActive()
    })
    const off3 = EventsOn('calibrate:quantize-stage', () => {
      void refreshActive()
    })
    return () => {
      off1()
      off2()
      off3()
    }
  }, [refreshList, refreshActive])

  // ─── Binary check ──────────────────────────────────────────────
  if (tools && (!tools.imatrixPresent || !tools.quantizePresent)) {
    return (
      <div className="mt-10 rounded-2xl border border-chart-5/40 bg-chart-5/5 p-8">
        <p className="eyebrow">Calibration tools missing</p>
        <p className="mt-1 text-base font-semibold tracking-tight">
          {!tools.imatrixPresent && <code className="font-mono">llama-imatrix.exe</code>}
          {!tools.imatrixPresent && !tools.quantizePresent && ' and '}
          {!tools.quantizePresent && <code className="font-mono">llama-quantize.exe</code>}{' '}
          weren’t found alongside llama-server.
        </p>
        <p className="mt-2 max-w-prose text-xs text-muted-foreground">
          Both ship in the llama.cpp release tarball. Reinstall the runtime from the Deploy tab
          (or re-run <code className="font-mono">.\build.ps1</code>) and they’ll be picked up
          automatically.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[260px_1fr]">
      <RunList
        runs={runs}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={async (label) => {
          const r = await CreateCalibrationRun(label)
          await refreshList()
          setActiveId(r.id)
        }}
        onDelete={async (id) => {
          if (!confirm('Delete this calibration run and all artifacts? This cannot be undone.')) return
          await DeleteCalibrationRun(id)
          if (activeId === id) setActiveId(null)
          await refreshList()
        }}
      />

      {active ? (
        <RunDetail
          run={active}
          installed={installed}
          onPromptsSaved={refreshActive}
        />
      ) : (
        <EmptyPane onCreate={async (label) => {
          const r = await CreateCalibrationRun(label)
          await refreshList()
          setActiveId(r.id)
        }} />
      )}
    </div>
  )
}

// ─── Run list ──────────────────────────────────────────────────────────

function RunList({
  runs,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: {
  runs: cal.Run[] | null
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (label: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')

  return (
    <aside className="space-y-3">
      <button
        type="button"
        onClick={() => {
          setCreating(true)
          setLabel('')
        }}
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
      >
        + New calibration run
      </button>

      {creating && (
        <div className="rounded-md border border-border bg-card p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Client label
          </p>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Acme Legal — Q3 2026"
            autoFocus
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={async () => {
                await onCreate(label.trim() || 'Untitled run')
                setCreating(false)
              }}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-md border border-border px-3 py-1 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul className="space-y-1.5">
        {runs === null && <li className="text-sm text-muted-foreground">Loading…</li>}
        {runs !== null && runs.length === 0 && (
          <li className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            No runs yet. Each calibration is one client engagement; the deliverable is the run
            directory at <code className="font-mono">~/.blueprint/calibration/&lt;run-id&gt;</code>.
          </li>
        )}
        {runs?.map((r) => {
          const isActive = r.id === activeId
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                className={[
                  'group flex w-full flex-col rounded-md border px-3 py-2 text-left transition',
                  isActive
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card hover:bg-muted',
                ].join(' ')}
              >
                <span className="truncate text-sm font-semibold tracking-tight">
                  {r.clientLabel || r.id}
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                  <span>{phaseLabel(r.phase)}</span>
                  <span>{new Date(r.createdAt).toLocaleDateString()}{/* createdAt is unix ms */}</span>
                </span>
              </button>
              {isActive && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void onDelete(r.id)
                  }}
                  className="mt-1 ml-auto block text-[10px] text-muted-foreground transition hover:text-destructive"
                >
                  delete run
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'draft':
      return 'Draft'
    case 'prompts':
      return 'Prompts ready'
    case 'imatrix':
      return 'Calibrating…'
    case 'imatrix-ok':
      return 'Calibrated'
    case 'quantize':
      return 'Quantizing…'
    case 'quantize-ok':
      return 'GGUFs ready'
    case 'eval':
      return 'Evaluating…'
    case 'eval-ok':
      return 'Eval complete'
    case 'error':
      return 'Error'
    default:
      return phase
  }
}

// ─── Empty pane ────────────────────────────────────────────────────────

function EmptyPane({ onCreate }: { onCreate: (label: string) => Promise<void> }) {
  return (
    <section className="rounded-2xl border border-dashed border-border bg-card p-10">
      <p className="eyebrow">No run selected</p>
      <p className="mt-1 text-lg font-semibold tracking-tight">
        Each calibration run is one consulting engagement.
      </p>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        Workflow per run: upload the client’s representative prompts → calibrate (
        <code className="font-mono">llama-imatrix</code>) → quantize at target levels (
        <code className="font-mono">llama-quantize --imatrix</code>) → evaluate on the client’s
        eval set → export the report.
      </p>
      <button
        type="button"
        onClick={() => onCreate('Untitled run')}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
      >
        + Start a run
      </button>
    </section>
  )
}

// ─── Run detail ────────────────────────────────────────────────────────

function RunDetail({
  run,
  installed,
  onPromptsSaved,
}: {
  run: cal.Run
  installed: main.InstalledModel[] | null
  onPromptsSaved: () => Promise<void>
}) {
  return (
    <section className="space-y-4">
      <header className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <p className="eyebrow">Run</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">
          {run.clientLabel || run.id}
        </h2>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {run.id}
          <span className="mx-2 opacity-40">·</span>
          Phase <b className="text-foreground">{phaseLabel(run.phase)}</b>
          {run.baseModelId && (
            <>
              <span className="mx-2 opacity-40">·</span>
              Base <b className="text-foreground">{run.baseModelId} {run.baseQuant?.toUpperCase()}</b>
            </>
          )}
        </p>
        {run.lastError && (
          <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 font-mono text-[11px] text-destructive">
            {run.lastError}
          </p>
        )}
      </header>

      <PromptsStep run={run} onSaved={onPromptsSaved} />
      <ImatrixStep run={run} installed={installed} />
      <QuantizeStep run={run} />
      <EvaluateStep run={run} onChanged={onPromptsSaved} />
    </section>
  )
}

// ─── Step 1: prompts ───────────────────────────────────────────────────

function PromptsStep({ run, onSaved }: { run: cal.Run; onSaved: () => Promise<void> }) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = run.promptCount > 0

  return (
    <article className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <StepHeader n={1} title="Calibration prompts" done={done} />
      <p className="mt-1 text-xs text-muted-foreground">
        Paste 100–1,000 prompts representative of the client’s workload — one per line.
        <code className="ml-1 font-mono">llama-imatrix</code> uses these to build a per-tensor
        importance matrix that steers the quantization rounding toward the values your client
        actually sees.
      </p>

      {done ? (
        <div className="mt-3 rounded-md border border-chart-4/30 bg-chart-4/5 px-3 py-2 text-xs">
          <b>{run.promptCount.toLocaleString()}</b> prompts saved.
          You can replace them below if needed.
        </div>
      ) : null}

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={8}
        placeholder="Paste prompts, one per line…"
        className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />

      {error && (
        <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-2 flex justify-end">
        <button
          type="button"
          disabled={saving || !content.trim()}
          onClick={async () => {
            setError(null)
            setSaving(true)
            try {
              await SaveCalibrationPrompts(run.id, content)
              setContent('')
              await onSaved()
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setSaving(false)
            }
          }}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {saving ? 'Saving…' : done ? 'Replace prompts' : 'Save prompts'}
        </button>
      </div>
    </article>
  )
}

// ─── Step 2: imatrix ───────────────────────────────────────────────────

function ImatrixStep({
  run,
  installed,
}: {
  run: cal.Run
  installed: main.InstalledModel[] | null
}) {
  const ready = run.promptCount > 0
  const running = run.phase === 'imatrix'
  const done = run.phase === 'imatrix-ok' || run.phase === 'quantize' || run.phase === 'quantize-ok' || run.phase === 'eval' || run.phase === 'eval-ok'

  // Default base = highest-fidelity quant currently installed for the
  // catalog model picked. Encourage Q8 for calibration since lower
  // quants would bake their own quantization noise into the imatrix.
  const groupedByModel = useMemo(() => {
    const byModel = new Map<string, main.InstalledModel[]>()
    for (const m of installed ?? []) {
      const arr = byModel.get(m.id) ?? []
      arr.push(m)
      byModel.set(m.id, arr)
    }
    return byModel
  }, [installed])

  const [modelId, setModelId] = useState<string>(run.baseModelId ?? '')
  const [quant, setQuant] = useState<string>(run.baseQuant ?? '')
  const [error, setError] = useState<string | null>(null)

  // Snap to first available model when the run doesn't have one yet.
  useEffect(() => {
    if (modelId || installed === null) return
    const first = installed[0]
    if (first) {
      setModelId(first.id)
      setQuant(first.quant)
    }
  }, [modelId, installed])

  // Snap quant when model changes.
  useEffect(() => {
    if (!modelId) return
    const options = groupedByModel.get(modelId) ?? []
    if (!options.find((o) => o.quant === quant)) {
      setQuant(options[0]?.quant ?? '')
    }
  }, [modelId, quant, groupedByModel])

  const modelOptions = installed ? Array.from(new Set(installed.map((m) => m.id))) : []
  const quantOptions = (groupedByModel.get(modelId) ?? []).map((m) => m.quant)

  const progress = run.imatrixTotal > 0 ? (run.imatrixChunks / run.imatrixTotal) * 100 : 0

  return (
    <article className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <StepHeader n={2} title="Calibrate (llama-imatrix)" done={done} disabled={!ready} />
      <p className="mt-1 text-xs text-muted-foreground">
        Produces <code className="font-mono">imatrix.dat</code> — a per-tensor importance map
        the quantizer uses to keep the rounding decisions you actually depend on. Higher-fidelity
        base = better matrix; Q8 is the recommended source.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Select label="Base model" value={modelId} onChange={setModelId} options={modelOptions.map((id) => ({ value: id, label: id }))} disabled={running || done} />
        <Select label="Base quant" value={quant} onChange={setQuant} options={quantOptions.map((q) => ({ value: q, label: q.toUpperCase() }))} disabled={running || done} />
      </div>

      {running && (
        <div className="mt-3">
          <p className="font-mono text-[11px] text-muted-foreground">
            Calibrating — {run.imatrixChunks} / {run.imatrixTotal || '?'} chunks
          </p>
          <div className="mt-1 h-2 overflow-hidden rounded-full border border-border bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!ready || running || !modelId || !quant}
          onClick={async () => {
            setError(null)
            try {
              await RunImatrixCalibration(run.id, modelId, quant)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {running ? 'Calibrating…' : done ? 'Recalibrate' : 'Run calibration'}
        </button>
      </div>
    </article>
  )
}

// ─── Step 3: quantize ──────────────────────────────────────────────────

function QuantizeStep({ run }: { run: cal.Run }) {
  const ready = run.phase === 'imatrix-ok' || run.phase === 'quantize-ok' || run.phase === 'eval' || run.phase === 'eval-ok'
  const running = run.phase === 'quantize'
  const done = run.phase === 'quantize-ok' || run.phase === 'eval' || run.phase === 'eval-ok'

  const [selected, setSelected] = useState<string[]>(['Q4_K_M', 'IQ4_XS'])
  const [error, setError] = useState<string | null>(null)

  return (
    <article className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <StepHeader n={3} title="Quantize calibrated GGUFs" done={done} disabled={!ready} />
      <p className="mt-1 text-xs text-muted-foreground">
        For each target, runs <code className="font-mono">llama-quantize --imatrix</code> against
        the base GGUF. Outputs land in{' '}
        <code className="font-mono">~/.blueprint/calibration/{run.id}/quants/</code>.
      </p>

      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {QUANT_TARGETS.map((t) => {
          const on = selected.includes(t.value)
          return (
            <li key={t.value}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  disabled={!ready || running}
                  checked={on}
                  onChange={() => {
                    setSelected((prev) =>
                      on ? prev.filter((v) => v !== t.value) : [...prev, t.value],
                    )
                  }}
                  className="mt-0.5 h-3.5 w-3.5 accent-primary"
                />
                <span>
                  <span className="block font-mono text-[12px] font-semibold">{t.label}</span>
                  <span className="block text-[10px] text-muted-foreground">{t.note}</span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      {error && (
        <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!ready || running || selected.length === 0}
          onClick={async () => {
            setError(null)
            try {
              await RunCalibratedQuantization(run.id, selected)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {running ? 'Quantizing…' : done ? 'Re-run' : `Quantize ${selected.length} target${selected.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </article>
  )
}

// ─── Bits ──────────────────────────────────────────────────────────────

function StepHeader({
  n,
  title,
  done,
  disabled,
}: {
  n: number
  title: string
  done: boolean
  disabled?: boolean
}) {
  return (
    <header className="flex items-center gap-3">
      <span
        className={[
          'inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-mono font-semibold',
          done
            ? 'bg-chart-4/15 text-chart-4'
            : disabled
              ? 'bg-muted text-muted-foreground'
              : 'bg-primary/10 text-primary',
        ].join(' ')}
      >
        {done ? '✓' : n}
      </span>
      <h3 className={['text-base font-semibold tracking-tight', disabled ? 'text-muted-foreground' : ''].join(' ')}>
        {title}
      </h3>
    </header>
  )
}

function Select({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
      >
        {options.length === 0 && <option value="">—</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
