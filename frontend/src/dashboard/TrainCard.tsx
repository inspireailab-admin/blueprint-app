// TrainCard — Dashboard surface for LoRA training jobs.
//
// Compact: a form for starting a job (base model + dataset path +
// epochs + LR + rank) and a list of running/recent jobs with status,
// progress, and Cancel buttons. No deep training UI — that's a real
// Fine-tune tab we'd add later. This card is enough to validate the
// pipeline end-to-end.

import { useCallback, useEffect, useState } from 'react'
import {
  CancelLoraTrainingJob,
  ListLoraTrainingJobs,
  LoraTrainingStatus,
  StartLoraTraining,
} from '../../wailsjs/go/main/App'
import type { main } from '../../wailsjs/go/models'
import { HelpButton } from '../help/HelpButton'

export function TrainCard() {
  const [status, setStatus] = useState<main.LoraTrainingStatus | null>(null)
  const [jobs, setJobs] = useState<main.LoraTrainingJob[]>([])
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  // Form fields with sane defaults.
  const [baseModel, setBaseModel] = useState('meta-llama/Llama-3.2-3B-Instruct')
  const [datasetPath, setDatasetPath] = useState('')
  const [label, setLabel] = useState('')
  const [epochs, setEpochs] = useState(3)
  const [lr, setLr] = useState(2e-4)
  const [rank, setRank] = useState(16)
  const [use4bit, setUse4bit] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const s = await LoraTrainingStatus()
      setStatus(s)
      if (s?.featureInstalled) {
        try {
          const j = await ListLoraTrainingJobs()
          setJobs(j ?? [])
        } catch {
          // sidecar might not be up yet
        }
      }
    } catch {
      // stale state is fine
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(refresh, 3000)
    return () => clearInterval(id)
  }, [refresh])

  if (!status) return null

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">LoRA training</h2>
            <HelpButton slug="lora-training" label="LoRA training" />
          </div>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            Fine-tune LoRA adapters on the client&apos;s data. Runs via the Python sidecar — needs
            the <b>LoRA training pipeline</b> feature installed and an NVIDIA GPU.
          </p>
        </div>
        {status.featureInstalled && (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
          >
            {showForm ? 'Hide form' : '+ New training job'}
          </button>
        )}
      </header>

      {!status.featureInstalled ? (
        <div className="px-6 py-4 text-xs text-muted-foreground">
          Install the LoRA training feature from the Python runtime card above to unlock this.
        </div>
      ) : (
        <>
          {showForm && (
            <div className="grid gap-3 border-b border-border bg-muted/20 px-6 py-4 sm:grid-cols-2">
              <TextField label="Base model (HF identifier)" value={baseModel} onChange={setBaseModel} placeholder="meta-llama/Llama-3.2-3B-Instruct" />
              <TextField label="Dataset path (JSONL)" value={datasetPath} onChange={setDatasetPath} placeholder="C:\path\to\train.jsonl" />
              <TextField label="Output label" value={label} onChange={setLabel} placeholder="acme-legal-q3-2026" />
              <NumberField label="Epochs" value={epochs} onChange={setEpochs} step={0.5} min={0.5} />
              <NumberField label="Learning rate" value={lr} onChange={setLr} step={0.00001} min={0.00001} />
              <NumberField label="LoRA rank" value={rank} onChange={setRank} step={1} min={1} />
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={use4bit}
                  onChange={(e) => setUse4bit(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Use 4-bit base (QLoRA) — needed for larger models on consumer GPUs
              </label>
              <div className="flex items-end justify-end sm:col-span-2">
                {error && (
                  <p className="mr-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
                    {error}
                  </p>
                )}
                <button
                  type="button"
                  disabled={starting || !baseModel || !datasetPath}
                  onClick={async () => {
                    setError(null)
                    setStarting(true)
                    try {
                      await StartLoraTraining({
                        baseModel,
                        datasetPath,
                        outputLabel: label,
                        epochs,
                        learningRate: lr,
                        loraRank: rank,
                        loraAlpha: rank * 2,
                        loraDropout: 0.05,
                        targetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
                        batchSize: 2,
                        gradAccumSteps: 4,
                        maxSeqLength: 2048,
                        use4bit,
                        useFp16: true,
                      } as main.LoraTrainStartInput)
                      setShowForm(false)
                      await refresh()
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e))
                    } finally {
                      setStarting(false)
                    }
                  }}
                  className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {starting ? 'Starting…' : 'Start training'}
                </button>
              </div>
            </div>
          )}

          {jobs.length === 0 ? (
            <p className="px-6 py-4 text-xs text-muted-foreground">No jobs yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {jobs.map((j) => (
                <JobRow key={j.jobId} job={j} onCancel={() => CancelLoraTrainingJob(j.jobId).then(refresh)} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function JobRow({ job, onCancel }: { job: main.LoraTrainingJob; onCancel: () => void }) {
  const progress = job.totalSteps > 0 ? (job.currentStep / job.totalSteps) * 100 : 0
  const tone = job.status === 'running' ? 'text-primary' : job.status === 'done' ? 'text-chart-4' : job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-3 px-6 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight">{job.label || job.jobId}</p>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {job.baseModel} · <span className={tone}>{job.status}</span>
          {job.totalSteps > 0 && <> · step {job.currentStep}/{job.totalSteps} · loss {job.lastLoss.toFixed(3)}</>}
        </p>
        {job.totalSteps > 0 && (
          <div className="mt-1 h-1.5 overflow-hidden rounded-full border border-border bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        {job.lastError && <p className="mt-1 text-[10px] text-destructive">{job.lastError}</p>}
      </div>
      {(job.status === 'running' || job.status === 'pending') && (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Cancel
        </button>
      )}
    </li>
  )
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  )
}

function NumberField({ label, value, onChange, step, min }: { label: string; value: number; onChange: (v: number) => void; step: number; min: number }) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  )
}
