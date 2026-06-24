// Deploy tab — the only place in the app where actual native work
// happens. Three cards walk the user through:
//
//   Runtime  → install llama.cpp (download + extract)
//   Model    → pull the GGUF for the selected model + quant
//   Serve    → spawn llama-server, expose the API endpoint
//
// A log tail at the bottom streams llama-server stdout/stderr lines so
// the user can see what's going on (and copy errors if something fails).
//
// All four operations are kernel-side: the Go App methods (in deploy.go)
// wrap pkg/runtime + pkg/catalog + pkg/download and emit Wails events
// that this component listens for.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  InstallRuntime,
  ModelStatus as ModelStatusFn,
  PullModel,
  RuntimeStatus as RuntimeStatusFn,
  ServerStatus as ServerStatusFn,
  StartServe,
  StopServe,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { Model, Requirements } from '../planner/types'
import { smallestQuant } from '../planner/vram'

type Props = {
  selectedModel: Model | null
  requirements: Requirements
  onBackToHardware: () => void
}

type RuntimeStatus = { installed: boolean; version: string; binPath: string }
type ModelStatus = { present: boolean; path: string; bytesGB: number }
type ServerStatus = {
  state: 'stopped' | 'starting' | 'running'
  modelId?: string
  quant?: string
  port?: number
  pid?: number
}

type RuntimeStage = {
  stage: 'idle' | 'locating' | 'downloading' | 'extracting' | 'done' | 'error'
  detail?: string
}

type DownloadProgress = {
  bytes: number
  total: number
  bps: number
}

export function DeployExplorer({ selectedModel, requirements, onBackToHardware }: Props) {
  const quant = useMemo(
    () => (selectedModel ? requirements.weightQuant ?? smallestQuant(selectedModel) : 'q4'),
    [selectedModel, requirements.weightQuant],
  )

  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [model, setModel] = useState<ModelStatus | null>(null)
  const [server, setServer] = useState<ServerStatus>({ state: 'stopped' })
  const [runtimeStage, setRuntimeStage] = useState<RuntimeStage>({ stage: 'idle' })
  const [runtimeProgress, setRuntimeProgress] = useState<DownloadProgress | null>(null)
  const [pullProgress, setPullProgress] = useState<DownloadProgress | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  const refetchAll = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([RuntimeStatusFn(), ServerStatusFn()])
      setRuntime(r as RuntimeStatus)
      setServer(s as ServerStatus)
      if (selectedModel) {
        const m = await ModelStatusFn(selectedModel.id, quant)
        setModel(m as ModelStatus)
      } else {
        setModel(null)
      }
    } catch (err: unknown) {
      console.error('refetchAll failed', err)
    }
  }, [selectedModel, quant])

  useEffect(() => {
    refetchAll()
  }, [refetchAll])

  // Subscribe to deploy:* event stream.
  useEffect(() => {
    const offRuntimeStage = EventsOn(
      'deploy:runtime-stage',
      (payload: { stage: string; detail?: string }) => {
        setRuntimeStage({ stage: payload.stage as RuntimeStage['stage'], detail: payload.detail })
        if (payload.stage === 'done') {
          setRuntimeProgress(null)
          refetchAll()
        }
      },
    )
    const offRuntimeProgress = EventsOn('deploy:runtime-progress', (p: DownloadProgress) => {
      setRuntimeProgress(p)
    })
    const offPull = EventsOn(
      'deploy:pull-progress',
      (p: DownloadProgress & { error?: string; stage?: string }) => {
        if (p.error) {
          setPullError(p.error)
          setPullProgress(null)
          return
        }
        if (p.stage === 'done') {
          setPullProgress(null)
          refetchAll()
          return
        }
        setPullProgress(p)
        setPullError(null)
      },
    )
    const offStatus = EventsOn('deploy:serve-status', (s: ServerStatus) => {
      setServer(s)
    })
    const offLog = EventsOn('deploy:serve-log', (l: { line: string }) => {
      setLogLines((prev) => {
        const next = [...prev, l.line]
        return next.length > 1000 ? next.slice(next.length - 1000) : next
      })
    })

    return () => {
      offRuntimeStage()
      offRuntimeProgress()
      offPull()
      offStatus()
      offLog()
    }
  }, [refetchAll])

  // Keep log tail scrolled to bottom.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logLines])

  if (!selectedModel) {
    return (
      <div className="mt-10 mx-auto max-w-md rounded-2xl border border-dashed border-border bg-muted/30 p-8 text-center">
        <p className="eyebrow">Pick a model first</p>
        <p className="mt-3 text-sm text-muted-foreground">
          Deploy needs a sized model — go through Plan and Hardware first.
        </p>
        <button
          type="button"
          onClick={onBackToHardware}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          ← Back to Hardware
        </button>
      </div>
    )
  }

  return (
    <div className="mt-8 space-y-6">
      <SelectedModelBanner model={selectedModel} quant={quant} />

      <RuntimeCard
        status={runtime}
        stage={runtimeStage}
        progress={runtimeProgress}
        onInstall={() => {
          setRuntimeStage({ stage: 'locating' })
          InstallRuntime()
        }}
      />

      <ModelCard
        model={selectedModel}
        quant={quant}
        status={model}
        progress={pullProgress}
        error={pullError}
        onPull={() => {
          setPullError(null)
          setPullProgress({ bytes: 0, total: 0, bps: 0 })
          PullModel(selectedModel.id, quant)
        }}
      />

      <ServeCard
        status={server}
        runtimeReady={!!runtime?.installed}
        modelReady={!!model?.present}
        onStart={() => StartServe(selectedModel.id, quant)}
        onStop={() => StopServe()}
      />

      <LogPane lines={logLines} containerRef={logRef} />
    </div>
  )
}

// ─── UI pieces ────────────────────────────────────────────────────────────

function SelectedModelBanner({ model, quant }: { model: Model; quant: string }) {
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-3 text-sm">
      <p className="eyebrow">Selected model</p>
      <p className="mt-1 font-semibold tracking-tight">
        {model.displayName}{' '}
        <span className="ml-1 font-mono text-xs text-muted-foreground">{quant.toUpperCase()}</span>
      </p>
    </section>
  )
}

function RuntimeCard({
  status,
  stage,
  progress,
  onInstall,
}: {
  status: RuntimeStatus | null
  stage: RuntimeStage
  progress: DownloadProgress | null
  onInstall: () => void
}) {
  const busy = stage.stage !== 'idle' && stage.stage !== 'done' && stage.stage !== 'error'

  return (
    <SectionCard title="llama.cpp runtime" description="The native inference runtime Blueprint drives.">
      {status?.installed && stage.stage !== 'downloading' && stage.stage !== 'extracting' ? (
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm">
            <span className="mr-2 inline-flex h-2 w-2 rounded-full bg-chart-4" aria-hidden />
            Installed <b className="font-mono text-foreground">{status.version}</b>
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">{status.binPath}</p>
        </div>
      ) : (
        <div>
          <p className="text-sm">
            <span className="mr-2 inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden />
            Not installed
          </p>
          {busy && <RuntimeBusy stage={stage} progress={progress} />}
          {stage.stage === 'error' && (
            <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 font-mono text-xs text-destructive">
              {stage.detail}
            </p>
          )}
          {!busy && (
            <button
              type="button"
              onClick={onInstall}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              Install runtime
              <span aria-hidden>→</span>
            </button>
          )}
        </div>
      )}
    </SectionCard>
  )
}

function RuntimeBusy({ stage, progress }: { stage: RuntimeStage; progress: DownloadProgress | null }) {
  const label =
    stage.stage === 'locating'
      ? 'Locating latest llama.cpp release…'
      : stage.stage === 'downloading'
        ? `Downloading ${stage.detail ?? 'release'}`
        : stage.stage === 'extracting'
          ? `Extracting ${stage.detail ?? 'archive'}`
          : ''
  return (
    <div className="mt-3 space-y-2">
      <p className="font-mono text-xs text-muted-foreground">{label}</p>
      {stage.stage === 'downloading' && progress && progress.total > 0 && (
        <ProgressBar progress={progress} />
      )}
    </div>
  )
}

function ModelCard({
  model,
  quant,
  status,
  progress,
  error,
  onPull,
}: {
  model: Model
  quant: string
  status: ModelStatus | null
  progress: DownloadProgress | null
  error: string | null
  onPull: () => void
}) {
  const sizeOnDisk = status?.present ? humanBytes(status.bytesGB) : null
  return (
    <SectionCard
      title="Model weights"
      description="The GGUF file the runtime loads into VRAM."
    >
      {status?.present ? (
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm">
            <span className="mr-2 inline-flex h-2 w-2 rounded-full bg-chart-4" aria-hidden />
            <b>{model.displayName}</b> <span className="font-mono text-xs">{quant.toUpperCase()}</span>{' '}
            on disk{sizeOnDisk && <span className="text-muted-foreground"> · {sizeOnDisk}</span>}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{status.path}</p>
        </div>
      ) : (
        <div>
          <p className="text-sm">
            <span className="mr-2 inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden />
            Not on disk
          </p>
          {progress && (
            <div className="mt-3 space-y-2">
              <p className="font-mono text-xs text-muted-foreground">Downloading GGUF…</p>
              <ProgressBar progress={progress} />
            </div>
          )}
          {error && (
            <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 font-mono text-xs text-destructive">
              {error}
            </p>
          )}
          {!progress && (
            <button
              type="button"
              onClick={onPull}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              Pull model
              <span aria-hidden>→</span>
            </button>
          )}
        </div>
      )}
    </SectionCard>
  )
}

function ServeCard({
  status,
  runtimeReady,
  modelReady,
  onStart,
  onStop,
}: {
  status: ServerStatus
  runtimeReady: boolean
  modelReady: boolean
  onStart: () => void
  onStop: () => void
}) {
  return (
    <SectionCard
      title="llama-server"
      description="Local OpenAI-compatible API on 127.0.0.1:8080. Stays on this machine."
    >
      {status.state === 'running' ? (
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm">
            <span className="mr-2 inline-flex h-2 w-2 animate-pulse rounded-full bg-chart-4" aria-hidden />
            <b>Running</b> <span className="font-mono text-xs text-muted-foreground">
              · pid {status.pid} · http://127.0.0.1:{status.port}/v1
            </span>
          </p>
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            Stop
          </button>
        </div>
      ) : status.state === 'starting' ? (
        <p className="text-sm">
          <span className="mr-2 inline-flex h-2 w-2 animate-pulse rounded-full bg-chart-5" aria-hidden />
          Starting llama-server…
        </p>
      ) : (
        <div>
          <p className="text-sm">
            <span className="mr-2 inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden />
            Stopped
          </p>
          {!runtimeReady || !modelReady ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {!runtimeReady && 'Install the runtime first. '}
              {runtimeReady && !modelReady && 'Pull the model first.'}
            </p>
          ) : (
            <button
              type="button"
              onClick={onStart}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              Start serve
              <span aria-hidden>→</span>
            </button>
          )}
        </div>
      )}
    </SectionCard>
  )
}

function LogPane({
  lines,
  containerRef,
}: {
  lines: string[]
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-4">
        <h2 className="text-balance text-base font-semibold tracking-tight">llama-server log</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Live tail of stdout/stderr. Shows model load, weights mmap, GPU layer offload, and any errors.
        </p>
      </header>
      <div
        ref={containerRef}
        className="selectable max-h-[260px] min-h-[120px] overflow-y-auto bg-neutral-950 p-4 font-mono text-[11px] leading-relaxed text-neutral-200"
      >
        {lines.length === 0 ? (
          <p className="text-neutral-500">Empty — start the server to see output.</p>
        ) : (
          lines.map((l, i) => <div key={i}>{l}</div>)
        )}
      </div>
    </section>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function SectionCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-4">
        <h2 className="text-balance text-base font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </header>
      <div className="p-6">{children}</div>
    </section>
  )
}

function ProgressBar({ progress }: { progress: DownloadProgress }) {
  const pct = progress.total > 0 ? (progress.bytes / progress.total) * 100 : 0
  const speed = humanBytes(progress.bps) + '/s'
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full border border-border bg-muted">
        <div
          className="h-full bg-primary transition-[width]"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <p className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>
          {humanBytes(progress.bytes)}
          {progress.total > 0 && ` / ${humanBytes(progress.total)}`}
          {progress.total > 0 && ` · ${pct.toFixed(1)}%`}
        </span>
        <span>{speed}</span>
      </p>
    </div>
  )
}

function humanBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
