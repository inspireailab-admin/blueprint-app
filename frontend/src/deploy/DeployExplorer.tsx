// Deploy tab — the last step of the install-LLM wizard, and the only
// place in the app where actual native work happens. It has two phases:
//
//   Provisioning → a compact checklist walks itself through
//                  runtime (install llama.cpp) → weights (pull the GGUF)
//                  → serve (spawn llama-server). This runs automatically
//                  on arrival; the checklist IS the content here.
//   Ready        → once the server is up, the setup detail collapses to
//                  a slim "model is live" strip and Verify becomes the
//                  hero: the user talks to their model, then continues
//                  to the Dashboard.
//
// All the heavy operations are kernel-side: the Go App methods (in
// deploy.go) wrap pkg/runtime + pkg/catalog + pkg/download and emit
// Wails events that this component listens for.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  InstallRuntime,
  ModelStatus as ModelStatusFn,
  PullModel,
  RuntimeStatus as RuntimeStatusFn,
  ServerStatus as ServerStatusFn,
  Snapshot,
  StartServe,
  StopServe,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { Model } from '../planner/types'
import type { ServeConfig } from '../optimize/OptimizeExplorer'
import { computeVram } from '../planner/vram'
import { hardwareFromSnapshot, type HardwareProfile } from '../planner/hardware'
import { planPlacement, placementToServeSplit } from '../planner/placement'
import { VerifyChat } from './VerifyChat'

type Props = {
  selectedModel: Model | null
  serveConfig: ServeConfig
  onBackToOptimize: () => void
  onContinueToDashboard: () => void
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

export function DeployExplorer({
  selectedModel,
  serveConfig,
  onBackToOptimize,
  onContinueToDashboard,
}: Props) {
  const quant = useMemo(() => serveConfig.quant, [serveConfig.quant])

  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [model, setModel] = useState<ModelStatus | null>(null)
  const [server, setServer] = useState<ServerStatus>({ state: 'stopped' })
  const [runtimeStage, setRuntimeStage] = useState<RuntimeStage>({ stage: 'idle' })
  const [runtimeProgress, setRuntimeProgress] = useState<DownloadProgress | null>(null)
  const [pullProgress, setPullProgress] = useState<DownloadProgress | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [hardware, setHardware] = useState<HardwareProfile | null>(null)
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

  // Detect the target's GPUs once, so serve can auto-split a model across
  // them when one GPU isn't enough (docs/plan-target-aware-deploy.md §7).
  useEffect(() => {
    Snapshot()
      .then((s) => setHardware(hardwareFromSnapshot(s)))
      .catch(() => {
        /* no snapshot → no auto-split; single-GPU/CPU serve as before */
      })
  }, [])

  // Build the ServeOptions for StartServe. An explicit split in serveConfig
  // (a future expert override) wins; otherwise we auto-compute the placement
  // from detected hardware and split only when the model needs it. On a
  // single-GPU / CPU host this returns no split flags — identical to before.
  const buildServeOpts = useCallback(
    (model: Model) => {
      const base = {
        modelId: model.id,
        quant,
        ctxSize: serveConfig.ctxSize,
        nGpuLayers: serveConfig.nGpuLayers,
      }
      if (serveConfig.tensorSplit && serveConfig.tensorSplit.length > 0) {
        return {
          ...base,
          splitMode: serveConfig.splitMode ?? 'layer',
          tensorSplit: serveConfig.tensorSplit,
          mainGpu: serveConfig.mainGpu ?? 0,
        }
      }
      const v = computeVram({
        model,
        weightQuant: quant,
        contextLength: serveConfig.ctxSize || 4096,
        concurrency: 1,
        kvElement: 'fp16',
      })
      return { ...base, ...placementToServeSplit(planPlacement(v, hardware)) }
    },
    [quant, serveConfig, hardware],
  )

  // Auto-provision: walk runtime → weights → serve without making the
  // user click each button in turn. Each step fires at most once per
  // model/quant (guarded by autoRef) so that a user who deliberately
  // Stops the server isn't fighting an auto-restart, and a failed step
  // doesn't retry-loop. The checklist keeps a Retry on any failed step
  // as a fallback.
  const autoRef = useRef({ install: false, pull: false, start: false })

  // New model (or quant) selected → allow the auto sequence to run again.
  useEffect(() => {
    autoRef.current = { install: false, pull: false, start: false }
  }, [selectedModel?.id, quant])

  useEffect(() => {
    if (!selectedModel) return
    if (runtime === null) return // wait for the first status snapshot

    // Step 1 — runtime.
    if (!runtime.installed) {
      const busy =
        runtimeStage.stage !== 'idle' &&
        runtimeStage.stage !== 'error' &&
        runtimeStage.stage !== 'done'
      if (!autoRef.current.install && runtimeStage.stage !== 'error' && !busy) {
        autoRef.current.install = true
        setRuntimeStage({ stage: 'locating' })
        InstallRuntime()
      }
      return
    }

    // Step 2 — model weights.
    if (model && !model.present) {
      if (!autoRef.current.pull && !pullError && !pullProgress) {
        autoRef.current.pull = true
        setPullError(null)
        setPullProgress({ bytes: 0, total: 0, bps: 0 })
        PullModel(selectedModel.id, quant)
      }
      return
    }

    // Step 3 — serve.
    if (model?.present && server.state === 'stopped' && !autoRef.current.start) {
      autoRef.current.start = true
      // Guard against a duplicate server: the supervisor occasionally
      // reports "stopped" while a llama-server is actually live on the
      // port (a leftover process, or state-tracking lag). Probe /health
      // first — only StartServe if nothing answers; otherwise reconcile
      // the UI to running so we advance to Verify instead of spawning a
      // second server that would fight for the port.
      const sel = selectedModel
      void serverAlreadyUp().then((up) => {
        if (up) {
          setServer((s) =>
            s.state === 'running' ? s : { ...s, state: 'running', port: s.port ?? 8080 },
          )
        } else {
          StartServe(buildServeOpts(sel))
        }
      })
    }
  }, [
    selectedModel,
    quant,
    runtime,
    model,
    server,
    runtimeStage,
    pullError,
    pullProgress,
    serveConfig,
    buildServeOpts,
  ])

  const setupError = runtimeStage.stage === 'error' || !!pullError
  const setupComplete =
    !!runtime?.installed && !!model?.present && server.state === 'running'

  if (!selectedModel) {
    return (
      <div className="mt-10 mx-auto max-w-md rounded-2xl border border-dashed border-border bg-muted/30 p-8 text-center">
        <p className="eyebrow">Pick a model first</p>
        <p className="mt-3 text-sm text-muted-foreground">
          Deploy needs a sized model — go through Plan, Hardware, and Optimize first.
        </p>
        <button
          type="button"
          onClick={onBackToOptimize}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          ← Back to Optimize
        </button>
      </div>
    )
  }

  if (setupComplete) {
    // ─── Ready phase ──────────────────────────────────────────────
    // Setup detail collapses to a slim strip; Verify is the hero.
    return (
      <div className="mt-8 space-y-5">
        <ReadyStrip
          model={selectedModel}
          quant={quant}
          runtime={runtime}
          modelStatus={model}
          server={server}
          onStop={() => StopServe()}
        />

        <VerifyChat model={selectedModel} />

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-sm text-muted-foreground">
            Sent a test prompt and happy with it? You&apos;re all set.
          </p>
          <button
            type="button"
            onClick={onContinueToDashboard}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            Continue to Dashboard
            <span aria-hidden>→</span>
          </button>
        </div>

        <CollapsibleLog key="log-ready" lines={logLines} containerRef={logRef} defaultOpen={false} />
      </div>
    )
  }

  // ─── Provisioning phase ─────────────────────────────────────────
  // The checklist is the content; it drives itself. Log stays open so
  // the model-load output is visible while the server comes up.
  const serveAttempted = autoRef.current.start
  return (
    <div className="mt-8 space-y-5">
      <SelectedModelBanner model={selectedModel} quant={quant} />

      <SetupChecklist
        error={setupError}
        runtime={runtime}
        runtimeStage={runtimeStage}
        runtimeProgress={runtimeProgress}
        model={selectedModel}
        quant={quant}
        modelStatus={model}
        pullProgress={pullProgress}
        pullError={pullError}
        server={server}
        serveAttempted={serveAttempted}
        onRetryRuntime={() => {
          setRuntimeStage({ stage: 'locating' })
          InstallRuntime()
        }}
        onRetryPull={() => {
          setPullError(null)
          setPullProgress({ bytes: 0, total: 0, bps: 0 })
          PullModel(selectedModel.id, quant)
        }}
        onRetryServe={() => StartServe(buildServeOpts(selectedModel))}
      />

      <CollapsibleLog key="log-setup" lines={logLines} containerRef={logRef} defaultOpen />
    </div>
  )
}

// ─── Provisioning UI ────────────────────────────────────────────────────────

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

/**
 * The provisioning checklist. Renders the three deploy steps as compact
 * rows (icon · title · one-line detail · inline progress), instead of
 * three tall cards. Each step derives its own state from props; a failed
 * step exposes a Retry so the user can recover without leaving the flow.
 */
function SetupChecklist({
  error,
  runtime,
  runtimeStage,
  runtimeProgress,
  model,
  quant,
  modelStatus,
  pullProgress,
  pullError,
  server,
  serveAttempted,
  onRetryRuntime,
  onRetryPull,
  onRetryServe,
}: {
  error: boolean
  runtime: RuntimeStatus | null
  runtimeStage: RuntimeStage
  runtimeProgress: DownloadProgress | null
  model: Model
  quant: string
  modelStatus: ModelStatus | null
  pullProgress: DownloadProgress | null
  pullError: string | null
  server: ServerStatus
  serveAttempted: boolean
  onRetryRuntime: () => void
  onRetryPull: () => void
  onRetryServe: () => void
}) {
  // Step 1 — runtime.
  const runtimeDone = !!runtime?.installed
  const runtimeErr = runtimeStage.stage === 'error'
  const runtimeActive =
    runtimeStage.stage === 'locating' ||
    runtimeStage.stage === 'downloading' ||
    runtimeStage.stage === 'extracting'

  // Step 2 — weights.
  const weightsDone = !!modelStatus?.present
  const weightsErr = !!pullError
  const weightsActive = !!pullProgress && !weightsDone

  // Step 3 — serve.
  const prereqsReady = runtimeDone && weightsDone
  const serveDone = server.state === 'running'

  let serveState: StepState
  let serveDetail: React.ReactNode
  let serveRetry: (() => void) | undefined
  if (serveDone) {
    serveState = 'done'
    serveDetail = (
      <>
        Serving on <span className="font-mono">127.0.0.1:{server.port ?? 8080}</span>
      </>
    )
  } else if (server.state === 'starting' || (prereqsReady && !serveAttempted)) {
    serveState = 'active'
    serveDetail = 'Starting the model server…'
  } else if (prereqsReady && serveAttempted) {
    // Auto-start already fired but the server is back to stopped — it
    // failed to come up. Offer a manual retry.
    serveState = 'error'
    serveDetail = 'Server didn’t start — retry to finish.'
    serveRetry = onRetryServe
  } else {
    serveState = 'pending'
    serveDetail = 'Waiting for the earlier steps…'
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold tracking-tight">
          {error ? 'Setup needs a nudge' : 'Setting up your model'}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {error
            ? 'A step didn’t finish — retry it below. Everything else keeps going automatically.'
            : 'Installing the runtime, pulling the weights, and starting the server — automatically. No clicks needed.'}
        </p>
      </header>
      <ol>
        <StepRow
          n={1}
          title="llama.cpp runtime"
          state={
            runtimeErr ? 'error' : runtimeDone ? 'done' : runtimeActive ? 'active' : 'pending'
          }
          detail={
            runtimeDone ? (
              <>
                Installed <b className="font-mono">{runtime?.version}</b>
              </>
            ) : runtimeErr ? (
              runtimeStage.detail ?? 'Install failed.'
            ) : runtimeActive ? (
              runtimeStageLabel(runtimeStage)
            ) : (
              'Queued…'
            )
          }
          progress={runtimeStage.stage === 'downloading' ? runtimeProgress : null}
          onRetry={runtimeErr ? onRetryRuntime : undefined}
        />
        <StepRow
          n={2}
          title="Model weights"
          state={
            weightsErr ? 'error' : weightsDone ? 'done' : weightsActive ? 'active' : 'pending'
          }
          detail={
            weightsDone ? (
              <>
                {model.displayName}{' '}
                <span className="font-mono">{quant.toUpperCase()}</span>
                {modelStatus && (
                  <span className="text-muted-foreground"> · {humanBytes(modelStatus.bytesGB)}</span>
                )}
              </>
            ) : weightsErr ? (
              pullError
            ) : weightsActive ? (
              'Downloading GGUF…'
            ) : runtimeDone ? (
              'Queued…'
            ) : (
              'Waiting for the runtime…'
            )
          }
          progress={weightsActive ? pullProgress : null}
          onRetry={weightsErr ? onRetryPull : undefined}
        />
        <StepRow
          n={3}
          title="llama-server"
          state={serveState}
          detail={serveDetail}
          onRetry={serveRetry}
        />
      </ol>
    </section>
  )
}

function runtimeStageLabel(stage: RuntimeStage): string {
  if (stage.stage === 'locating') return 'Locating the latest llama.cpp release…'
  if (stage.stage === 'downloading') return `Downloading ${stage.detail ?? 'release'}…`
  if (stage.stage === 'extracting') return `Extracting ${stage.detail ?? 'archive'}…`
  return ''
}

type StepState = 'pending' | 'active' | 'done' | 'error'

function StepRow({
  n,
  title,
  state,
  detail,
  progress,
  onRetry,
}: {
  n: number
  title: string
  state: StepState
  detail: React.ReactNode
  progress?: DownloadProgress | null
  onRetry?: () => void
}) {
  return (
    <li className="flex gap-4 border-t border-border px-6 py-4 first:border-t-0">
      <StepIcon n={n} state={state} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium tracking-tight">{title}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition hover:bg-muted"
            >
              Retry
            </button>
          )}
        </div>
        <p
          className={[
            'mt-0.5 text-xs',
            state === 'error' ? 'text-destructive' : 'text-muted-foreground',
          ].join(' ')}
        >
          {detail}
        </p>
        {progress && progress.total > 0 && (
          <div className="mt-2">
            <ProgressBar progress={progress} />
          </div>
        )}
      </div>
    </li>
  )
}

function StepIcon({ n, state }: { n: number; state: StepState }) {
  const base = 'mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full'
  if (state === 'done') {
    return (
      <span className={`${base} bg-chart-4/15 text-chart-4`} aria-label="done">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span className={`${base} bg-destructive/15 text-destructive`} aria-label="error">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span className={`${base} bg-primary/10 text-primary`} aria-label="in progress">
        <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  return (
    <span className={`${base} border border-border font-mono text-[11px] text-muted-foreground`} aria-label="pending">
      {n}
    </span>
  )
}

// ─── Ready UI ────────────────────────────────────────────────────────────────

/**
 * The slim "your model is live" strip shown once the server is up.
 * Keeps the reassuring status to a single line, with a Details
 * disclosure for the runtime/endpoint/weights particulars and a Stop
 * button — so Verify below it gets the vertical space instead.
 */
function ReadyStrip({
  model,
  quant,
  runtime,
  modelStatus,
  server,
  onStop,
}: {
  model: Model
  quant: string
  runtime: RuntimeStatus | null
  modelStatus: ModelStatus | null
  server: ServerStatus
  onStop: () => void
}) {
  const [open, setOpen] = useState(false)
  const port = server.port ?? 8080
  return (
    <section className="rounded-2xl border border-chart-4/30 bg-chart-4/[0.06] px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-chart-4/15 text-chart-4">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight">
            {model.displayName}{' '}
            <span className="font-mono text-xs text-muted-foreground">{quant.toUpperCase()}</span>{' '}
            is live
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-chart-4 align-middle" aria-hidden />
            serving on 127.0.0.1:{port}/v1
            {server.pid != null && ` · pid ${server.pid}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          {open ? 'Hide details' : 'Details'}
        </button>
        <button
          type="button"
          onClick={onStop}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
        >
          Stop
        </button>
      </div>
      {open && (
        <dl className="mt-3 grid gap-x-6 gap-y-1.5 border-t border-chart-4/20 pt-3 text-[11px] sm:grid-cols-2">
          <DetailRow
            label="Runtime"
            value={<span className="font-mono">llama.cpp {runtime?.version}</span>}
          />
          <DetailRow
            label="Endpoint"
            value={<span className="font-mono">http://127.0.0.1:{port}/v1</span>}
          />
          <DetailRow
            label="Weights"
            value={
              <span className="font-mono">
                {quant.toUpperCase()}
                {modelStatus && ` · ${humanBytes(modelStatus.bytesGB)}`}
              </span>
            }
          />
          <DetailRow
            label="Path"
            value={<span className="font-mono">{modelStatus?.path}</span>}
          />
        </dl>
      )}
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{value}</dd>
    </div>
  )
}

// ─── Shared ──────────────────────────────────────────────────────────────────

/**
 * The llama-server log, tucked into a collapsible drawer. Open during
 * provisioning (model-load output is reassuring), collapsed once ready
 * (Verify wants the space). `defaultOpen` seeds the initial state per
 * phase; the distinct `key` on each usage remounts it across the flip.
 */
function CollapsibleLog({
  lines,
  containerRef,
  defaultOpen,
}: {
  lines: string[]
  containerRef: React.RefObject<HTMLDivElement | null>
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="overflow-hidden rounded-2xl border border-border bg-card"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-6 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-medium tracking-tight">
          llama-server log
          <span className="ml-2 font-mono text-[11px] text-muted-foreground">
            {lines.length ? `${lines.length} lines` : 'idle'}
          </span>
        </span>
        <span
          className={[
            'font-mono text-xs text-muted-foreground transition-transform',
            open ? 'rotate-180' : '',
          ].join(' ')}
          aria-hidden
        >
          ▾
        </span>
      </summary>
      <div
        ref={containerRef}
        className="selectable max-h-[240px] min-h-[100px] overflow-y-auto border-t border-border bg-neutral-950 p-4 font-mono text-[11px] leading-relaxed text-neutral-200"
      >
        {lines.length === 0 ? (
          <p className="text-neutral-500">Empty — nothing logged yet.</p>
        ) : (
          lines.map((l, i) => <div key={i}>{l}</div>)
        )}
      </div>
    </details>
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

// Health-probe used by the auto-provision guard. A plain fetch against
// llama-server's unauthenticated /health endpoint; resolves true if a
// server is already answering on the local port, false on any error or
// timeout. Dependency-free (manual AbortController) so it works in every
// WebView build.
const SERVE_HEALTH_URL = 'http://127.0.0.1:8080/health'

async function serverAlreadyUp(): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch(SERVE_HEALTH_URL, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
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
