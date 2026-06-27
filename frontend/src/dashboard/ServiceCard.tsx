// ServiceCard — the unified server hero. There is no other "server"
// surface on the Dashboard: this card is the single source of truth
// for "is anything serving" and "how do I start something."
//
// Decision tree the card walks through:
//
//   1. Service binary missing OR not registered with SCM →
//      "Service not detected, reinstall Blueprint."
//   2. Service stopped, model configured →
//      "Service stopped — Start service" (single button does it).
//   3. Service running, no model picked yet, no models on disk →
//      "Pick a model first."
//   4. Service running, no model picked yet, models on disk →
//      "Ready to serve <model> — Start LLM."  ← writes config + restarts.
//   5. Service running, supervisor running →
//      "Serving <model> · uptime · PID" + Stop / Restart.
//   6. Service running, supervisor crashed / errored →
//      Show the last error, offer Restart.
//
// "Start LLM" auto-recovers from a stopped service: it starts the
// service first, then writes the config, then restarts the service so
// the supervisor picks the new config up. If anything fails along the
// way the error is shown right here — the user is never left with a
// silent dead state.

import { useEffect, useMemo, useState } from 'react'
import {
  ApplyServeConfig,
  CurrentServeConfig,
  InstallRuntime,
  ListLoraAdapters,
  RestartManagedServer,
  ServiceInfo,
  StartManagedServer,
  StopManagedServer,
} from '../../wailsjs/go/main/App'
import type { main, svcconfig } from '../../wailsjs/go/models'
import { EngineDisclosure } from './EngineDisclosure'
import { HelpButton } from '../help/HelpButton'

type ServeConfigDefaults = {
  quant: string
  ctxSize: number
  nGpuLayers: number
}

type Props = {
  installed: main.InstalledModel[] | null
  defaults: ServeConfigDefaults
  onPickModel: () => void
}

export function ServiceCard({ installed, defaults, onPickModel }: Props) {
  const [info, setInfo] = useState<main.ServiceInfo | null>(null)
  const [config, setConfig] = useState<svcconfig.Config | null>(null)
  const [actionInFlight, setActionInFlight] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingBind, setEditingBind] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)

  async function refresh() {
    try {
      const [i, c] = await Promise.all([ServiceInfo(), CurrentServeConfig()])
      setInfo(i)
      setConfig(c)
    } catch (e) {
      console.warn('service refresh', e)
    }
  }

  useEffect(() => {
    void refresh()
    const id = setInterval(refresh, 2500)
    return () => clearInterval(id)
  }, [])

  async function run(label: string, fn: () => Promise<void>) {
    setError(null)
    setActionInFlight(label)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActionInFlight(null)
      await refresh()
    }
  }

  // Quick-start target: the first installed model. Future iteration: let the
  // user choose, but defaulting to "the one you have" is the right move for
  // the common case of a single installed model.
  const quickStartModel = useMemo<main.InstalledModel | null>(() => {
    if (!installed || installed.length === 0) return null
    return installed[0]
  }, [installed])

  // The Start-LLM flow: ensure the service is running, write config,
  // restart the supervisor so it picks up the new config and spawns
  // llama-server.
  async function startLLM() {
    if (!quickStartModel) {
      onPickModel()
      return
    }
    const desired: main.ServeConfigInput = {
      modelId: quickStartModel.id,
      quant: quickStartModel.quant || defaults.quant,
      bindHost: config?.bindHost || '127.0.0.1',
      port: config?.port || 8080,
      ctxSize: config?.ctxSize || defaults.ctxSize,
      nGpuLayers: config?.nGpuLayers || defaults.nGpuLayers,
    } as main.ServeConfigInput

    await run('start-llm', async () => {
      if (info?.scmState === 'stopped' || !info?.scmState) {
        // Service down. Bring it up first.
        await StartManagedServer()
        // Brief wait so SCM transitions to running before we Restart.
        await sleep(800)
      }
      await ApplyServeConfig(desired)
      await RestartManagedServer()
    })
  }

  if (!info) {
    return (
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">Loading service status…</p>
      </section>
    )
  }

  // ─── State 1: Service not detected ──────────────────────────────────
  if (!info.svcBinPresent || !info.installed) {
    return (
      <section className="overflow-hidden rounded-2xl border border-chart-5/40 bg-chart-5/5 shadow-sm">
        <div className="px-6 py-5">
          <p className="eyebrow">Service not detected</p>
          <p className="mt-1 text-lg font-semibold tracking-tight">
            Blueprint LLM Service isn’t installed
          </p>
          <p className="mt-2 max-w-prose text-xs text-muted-foreground">
            The service supervises llama-server with auto-restart and survives reboots. It
            normally ships with the Blueprint installer; if you see this, the installer didn’t
            complete or the service was removed.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Fix it by re-running the Blueprint installer. Building from source? Run the install
            command from an admin shell:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]">
            {info.svcBinPresent
              ? `${info.svcBinExpected} install`
              : `.\\build.ps1 -SvcOnly\n${info.svcBinExpected} install`}
          </pre>
        </div>
      </section>
    )
  }

  // ─── Derived state ──────────────────────────────────────────────────
  const serving = info.scmState === 'running' && info.phase === 'running'
  const idle = info.scmState === 'running' && (info.phase === 'idle' || !info.phase)
  const crashed = info.scmState === 'running' && info.phase === 'crashed'
  const stopped = info.scmState !== 'running'
  const hasModels = (installed?.length ?? 0) > 0

  // Detect known recoverable error patterns so we can surface specific
  // guidance instead of leaving the user staring at a generic "child
  // keeps crashing" red wall.
  const lastErr = (info.lastError ?? '').toLowerCase()
  const runtimeMissing =
    crashed && (lastErr.includes('llama-server not found') ||
                lastErr.includes('llama-server.exe') ||
                lastErr.includes('runtime not installed') ||
                lastErr.includes('file not found') ||
                lastErr.includes('no such file'))

  // Use a warning (amber) tone for crashes instead of destructive red.
  // A red wall on first-launch is brand-corrosive; amber-with-guidance
  // reads as "we know what happened, here's the fix."
  const tone = serving
    ? 'border-chart-4/40 bg-chart-4/5'
    : crashed
      ? 'border-amber-500/40 bg-amber-500/[0.06]'
      : 'border-border bg-card'

  // ─── Headline + lead controls ───────────────────────────────────────
  const headline = (() => {
    if (serving) {
      return {
        eyebrow: 'Serving',
        title: <>Serving <code className="font-mono">{info.modelId}</code></>,
        sub: info.startedAtMs
          ? `${(config?.quant ?? '').toUpperCase()} · port ${info.port} · PID ${info.pid} · up ${formatUptime(info.startedAtMs)}`
          : undefined,
      }
    }
    if (crashed) {
      if (runtimeMissing) {
        return {
          eyebrow: 'Runtime not installed',
          title: <>llama-server isn&apos;t on disk yet</>,
          sub: 'Install the runtime first, then start serving — see Maintain → Runtime.',
        }
      }
      return {
        eyebrow: 'Supervisor stopped',
        title: <>Model server keeps exiting</>,
        sub:
          (info.restartCount ?? 0) > 0
            ? `${info.restartCount} restart attempt${info.restartCount === 1 ? '' : 's'} so far`
            : 'Tried to start but the child process exited immediately.',
      }
    }
    if (stopped) {
      return {
        eyebrow: 'Service stopped',
        title: <>Click Start to bring the LLM up</>,
        sub: 'Starts the service and then the model in one step.',
      }
    }
    // idle — service running, nothing serving
    if (!hasModels) {
      return {
        eyebrow: 'Service ready · no models',
        title: <>No models on disk yet</>,
        sub: 'Pick a model from the Plan tab to start serving.',
      }
    }
    return {
      eyebrow: 'Service ready',
      title: <>Ready to serve <code className="font-mono">{quickStartModel?.displayName}</code></>,
      sub: `${(quickStartModel?.quant ?? defaults.quant).toUpperCase()} · ${defaults.ctxSize.toLocaleString()} ctx · GPU layers ${defaults.nGpuLayers >= 999 ? 'all' : defaults.nGpuLayers}`,
    }
  })()

  return (
    <section className={['overflow-hidden rounded-2xl border shadow-sm', tone].join(' ')}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 px-6 py-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="eyebrow">{headline.eyebrow}</p>
            <HelpButton slug="service-install" label="Service" />
          </div>
          <p className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
            <StatusDot serving={serving} idle={idle} stopped={stopped} crashed={crashed} />
            {headline.title}
          </p>
          {headline.sub && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{headline.sub}</p>}
          {info.lastError && (
            <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
              {info.lastError}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Primary action: depends on state */}
          {serving ? (
            <>
              <button
                type="button"
                disabled={actionInFlight !== null}
                onClick={() => run('restart', RestartManagedServer)}
                className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
              >
                {actionInFlight === 'restart' ? 'Restarting…' : 'Restart'}
              </button>
              <button
                type="button"
                disabled={actionInFlight !== null}
                onClick={() => run('stop', StopManagedServer)}
                className="inline-flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-4 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/5 disabled:opacity-60"
              >
                {actionInFlight === 'stop' && <Spinner />}
                {actionInFlight === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </>
          ) : crashed ? (
            <div className="flex flex-wrap gap-2">
              {runtimeMissing ? (
                // Specific recovery: install the runtime, then the next
                // supervisor cycle (~5s) sees the binary and starts.
                <button
                  type="button"
                  disabled={actionInFlight !== null}
                  onClick={() => run('install-runtime', InstallRuntime)}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
                >
                  {actionInFlight === 'install-runtime' && <Spinner />}
                  {actionInFlight === 'install-runtime'
                    ? 'Installing runtime…'
                    : 'Install runtime'}
                  {actionInFlight !== 'install-runtime' && <span aria-hidden>→</span>}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={actionInFlight !== null}
                  onClick={() => run('restart', RestartManagedServer)}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
                >
                  {actionInFlight === 'restart' && <Spinner />}
                  {actionInFlight === 'restart' ? 'Restarting…' : 'Try again'}
                  {actionInFlight !== 'restart' && <span aria-hidden>→</span>}
                </button>
              )}
              <button
                type="button"
                disabled={actionInFlight !== null}
                onClick={() => run('stop', StopManagedServer)}
                title="Stop the supervisor so it stops trying to restart the crashed model. The service stays installed; you can apply a different config from below."
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
              >
                {actionInFlight === 'stop' && <Spinner />}
                {actionInFlight === 'stop' ? 'Stopping…' : 'Stop trying'}
              </button>
            </div>
          ) : !hasModels ? (
            <button
              type="button"
              onClick={onPickModel}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              Pick a model →
            </button>
          ) : (
            <button
              type="button"
              disabled={actionInFlight !== null}
              onClick={startLLM}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
            >
              {actionInFlight === 'start-llm' && <Spinner />}
              {actionInFlight === 'start-llm'
                ? 'Starting…'
                : stopped
                  ? `Start LLM — ${quickStartModel?.displayName}`
                  : `Start LLM — ${quickStartModel?.displayName}`}
              {actionInFlight !== 'start-llm' && <span aria-hidden>→</span>}
            </button>
          )}
        </div>
      </header>

      {/* Config detail rows */}
      <dl className="grid gap-x-6 gap-y-2 px-6 py-4 text-sm sm:grid-cols-2">
        <KV k="Service state" v={info.scmState || 'unknown'} mono />
        <KV k="Supervisor phase" v={info.phase || 'idle'} mono />
        <KV k="Engine" v={engineLabel(config?.engine)} mono />
        <KV
          k="Model"
          v={config ? `${config.modelId} ${config.quant.toUpperCase()}` : '— not configured —'}
          mono
        />
        <KV
          k="Bind"
          v={
            <BindToggle
              current={config?.bindHost ?? '127.0.0.1'}
              editing={editingBind}
              busy={actionInFlight !== null}
              onEdit={() => setEditingBind(true)}
              onSelect={async (host) => {
                setEditingBind(false)
                if (!config) return
                if (host === config.bindHost) return
                await run('reconfigure', async () => {
                  await ApplyServeConfig({
                    modelId: config.modelId,
                    quant: config.quant,
                    bindHost: host,
                    port: config.port,
                    ctxSize: config.ctxSize,
                    nGpuLayers: config.nGpuLayers,
                  } as main.ServeConfigInput)
                  await RestartManagedServer()
                })
              }}
            />
          }
        />
        <KV k="Port" v={config ? String(config.port) : '—'} mono />
        <KV k="Ctx size" v={config ? config.ctxSize.toLocaleString() : '—'} mono />
        <KV
          k="GPU layers"
          v={config ? (config.nGpuLayers >= 999 ? 'All' : String(config.nGpuLayers)) : '—'}
          mono
        />
        <KV k="Restart count" v={String(info.restartCount ?? 0)} mono />
      </dl>

      <EngineDisclosure config={config} disabled={actionInFlight !== null} />

      <OptimizeDisclosure
        config={config}
        installed={installed}
        disabled={actionInFlight !== null}
        onApply={async (patch) => {
          if (!config) return
          await run('optimize', async () => {
            await ApplyServeConfig({
              modelId: patch.modelId ?? config.modelId,
              quant: patch.quant ?? config.quant,
              bindHost: config.bindHost,
              port: config.port,
              ctxSize: patch.ctxSize ?? config.ctxSize,
              nGpuLayers: patch.nGpuLayers ?? config.nGpuLayers,
              // Preserve advanced flags unchanged.
              threads: config.threads,
              batchSize: config.batchSize,
              uBatchSize: config.uBatchSize,
              flashAttn: config.flashAttn,
              memoryLock: config.memoryLock,
              noMmap: config.noMmap,
              parallelSlots: config.parallelSlots,
              contBatching: config.contBatching,
              kvCacheTypeK: config.kvCacheTypeK,
              kvCacheTypeV: config.kvCacheTypeV,
              logVerbose: config.logVerbose,
              loraAdapter: config.loraAdapter,
              loraScale: config.loraScale,
            } as main.ServeConfigInput)
            await RestartManagedServer()
          })
        }}
      />

      <LoraDisclosure
        config={config}
        disabled={actionInFlight !== null}
        onApply={async (loraAdapter, loraScale) => {
          if (!config) return
          await run('lora', async () => {
            await ApplyServeConfig({
              modelId: config.modelId,
              quant: config.quant,
              bindHost: config.bindHost,
              port: config.port,
              ctxSize: config.ctxSize,
              nGpuLayers: config.nGpuLayers,
              threads: config.threads,
              batchSize: config.batchSize,
              uBatchSize: config.uBatchSize,
              flashAttn: config.flashAttn,
              memoryLock: config.memoryLock,
              noMmap: config.noMmap,
              parallelSlots: config.parallelSlots,
              contBatching: config.contBatching,
              kvCacheTypeK: config.kvCacheTypeK,
              kvCacheTypeV: config.kvCacheTypeV,
              logVerbose: config.logVerbose,
              loraAdapter,
              loraScale,
            } as main.ServeConfigInput)
            await RestartManagedServer()
          })
        }}
      />

      <ServerSettingsDisclosure
        config={config}
        expanded={showServerSettings}
        onToggle={() => setShowServerSettings((v) => !v)}
        disabled={actionInFlight !== null}
        onApply={async (patch) => {
          if (!config) return
          await run('reconfigure', async () => {
            await ApplyServeConfig({
              modelId: config.modelId,
              quant: config.quant,
              bindHost: config.bindHost,
              port: config.port,
              ctxSize: config.ctxSize,
              nGpuLayers: config.nGpuLayers,
              ...patch,
            } as main.ServeConfigInput)
            await RestartManagedServer()
          })
        }}
      />

      {error && (
        <div className="border-t border-border/60 px-6 pb-4">
          <ErrorChip msg={error} />
          {error.toLowerCase().includes('service') && (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              If this persists, try: <code>sc.exe start BlueprintLLM</code> from a PowerShell window.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ─── Bits ───────────────────────────────────────────────────────────────

function BindToggle({
  current,
  editing,
  busy,
  onEdit,
  onSelect,
}: {
  current: string
  editing: boolean
  busy: boolean
  onEdit: () => void
  onSelect: (host: string) => void
}) {
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="font-mono">{current === '0.0.0.0' ? '0.0.0.0 (LAN)' : '127.0.0.1 (local)'}</span>
        <button
          type="button"
          disabled={busy}
          onClick={onEdit}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
        >
          change
        </button>
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {(['127.0.0.1', '0.0.0.0'] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          disabled={busy}
          onClick={() => onSelect(opt)}
          className={[
            'rounded-md border px-2 py-0.5 font-mono text-[11px] transition',
            opt === current
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-background hover:bg-muted',
          ].join(' ')}
        >
          {opt === '0.0.0.0' ? '0.0.0.0 (LAN)' : '127.0.0.1 (local)'}
        </button>
      ))}
    </span>
  )
}

function StatusDot({
  serving,
  idle,
  stopped,
  crashed,
}: {
  serving: boolean
  idle: boolean
  stopped: boolean
  crashed: boolean
}) {
  if (serving) return <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-chart-4" />
  if (crashed) return <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-destructive" />
  if (idle) return <span className="inline-flex h-2 w-2 rounded-full bg-chart-5" />
  if (stopped) return <span className="inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" />
  return <span className="inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" />
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  )
}

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/30 pb-2 last:border-b-0 last:pb-0 sm:border-b-0 sm:pb-0">
      <span className="text-muted-foreground">{k}</span>
      <span className={['min-w-0 truncate text-right', mono ? 'font-mono text-[12px]' : ''].join(' ')}>
        {v}
      </span>
    </div>
  )
}

function ErrorChip({ msg }: { msg: string }) {
  return (
    <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 font-mono text-[11px] text-destructive">
      {msg}
    </p>
  )
}

function formatUptime(startedAtMs: number): string {
  const s = Math.floor((Date.now() - startedAtMs) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// ─── Optimize disclosure ────────────────────────────────────────────────
//
// The three knobs that used to live in the Optimize tab — quant,
// context window, GPU layers — now expand right here in the
// ServiceCard. Apply writes the new config and restarts the
// supervisor in one step.

type OptimizePatch = Partial<{
  modelId: string
  quant: string
  ctxSize: number
  nGpuLayers: number
}>

function OptimizeDisclosure({
  config,
  installed,
  disabled,
  onApply,
}: {
  config: svcconfig.Config | null
  installed: main.InstalledModel[] | null
  disabled: boolean
  onApply: (patch: OptimizePatch) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)

  // Quants installed for the currently-configured model.
  const sameModelQuants = (installed ?? [])
    .filter((m) => m.id === config?.modelId)
    .map((m) => m.quant)
  // Other models on disk — let the user swap.
  const otherModels = (installed ?? []).filter((m) => m.id !== config?.modelId)

  const initial: Required<OptimizePatch> = {
    modelId: config?.modelId ?? '',
    quant: config?.quant ?? '',
    ctxSize: config?.ctxSize ?? 4096,
    nGpuLayers: config?.nGpuLayers ?? 999,
  }
  const [patch, setPatch] = useState<Required<OptimizePatch>>(initial)
  useEffect(() => {
    setPatch(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.modelId, config?.quant, config?.ctxSize, config?.nGpuLayers])

  const dirty =
    patch.modelId !== initial.modelId ||
    patch.quant !== initial.quant ||
    patch.ctxSize !== initial.ctxSize ||
    patch.nGpuLayers !== initial.nGpuLayers

  return (
    <div className="border-t border-border/60 px-6 py-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>{expanded ? '▾' : '▸'}</span>
          Optimize — quant, context, GPU offload
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          changes restart the supervisor
        </span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Model + quantization
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Model"
                hint="Models on disk. Pick one to swap what's served."
                value={patch.modelId}
                options={[
                  ...(config
                    ? [{ value: config.modelId, label: config.modelId }]
                    : []),
                  ...otherModels.map((m) => ({ value: m.id, label: m.id })),
                ]}
                onChange={(v) => {
                  // When switching model, snap quant to the first
                  // available quant for that model.
                  const firstQuant =
                    (installed ?? []).find((m) => m.id === v)?.quant ??
                    patch.quant
                  setPatch({ ...patch, modelId: v, quant: firstQuant })
                }}
              />
              <SelectField
                label="Quantization"
                hint="Lower = less VRAM, slightly lower quality"
                value={patch.quant}
                options={(patch.modelId === config?.modelId
                  ? sameModelQuants
                  : (installed ?? [])
                      .filter((m) => m.id === patch.modelId)
                      .map((m) => m.quant)
                ).map((q) => ({ value: q, label: q.toUpperCase() }))}
                onChange={(v) => setPatch({ ...patch, quant: v })}
              />
            </div>
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Context window
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <NumberField
                label="Tokens"
                hint="--ctx-size. Bigger = more VRAM for KV cache."
                value={patch.ctxSize}
                onChange={(v) => setPatch({ ...patch, ctxSize: v })}
              />
              <div className="flex flex-wrap items-end gap-1.5">
                {[2048, 4096, 8192, 16_384, 32_768].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setPatch({ ...patch, ctxSize: preset })}
                    className={[
                      'rounded-md border px-2 py-1 font-mono text-[11px] transition',
                      patch.ctxSize === preset
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background hover:bg-muted',
                    ].join(' ')}
                  >
                    {preset >= 1024 ? `${preset / 1024}K` : preset}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              GPU offload
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <NumberField
                label="GPU layers"
                hint="--n-gpu-layers. 999 = offload all that fit"
                value={patch.nGpuLayers}
                onChange={(v) => setPatch({ ...patch, nGpuLayers: v })}
              />
              <div className="flex flex-wrap items-end gap-1.5">
                {[0, 16, 32, 64, 999].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setPatch({ ...patch, nGpuLayers: preset })}
                    className={[
                      'rounded-md border px-2 py-1 font-mono text-[11px] transition',
                      patch.nGpuLayers === preset
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background hover:bg-muted',
                    ].join(' ')}
                  >
                    {preset === 0 ? 'CPU' : preset === 999 ? 'All' : preset}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={disabled || !dirty}
              onClick={() => setPatch(initial)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
            >
              Revert
            </button>
            <button
              type="button"
              disabled={disabled || !dirty}
              onClick={() => onApply(patch)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
            >
              {disabled ? 'Applying…' : 'Apply + restart'} →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Server settings disclosure ─────────────────────────────────────────
//
// Startup flags that need a service restart to take effect. The form
// starts in a collapsed state because for the common case the llama.cpp
// defaults are fine — these are power-user knobs. Clicking Apply
// writes the new config and restarts the service in one step.

type ServerSettingsPatch = {
  threads: number
  batchSize: number
  uBatchSize: number
  flashAttn: boolean
  memoryLock: boolean
  noMmap: boolean
  parallelSlots: number
  contBatching: boolean
  kvCacheTypeK: string
  kvCacheTypeV: string
  logVerbose: boolean
}

function ServerSettingsDisclosure({
  config,
  expanded,
  disabled,
  onToggle,
  onApply,
}: {
  config: svcconfig.Config | null
  expanded: boolean
  disabled: boolean
  onToggle: () => void
  onApply: (patch: ServerSettingsPatch) => Promise<void>
}) {
  const initial: ServerSettingsPatch = {
    threads: config?.threads ?? 0,
    batchSize: config?.batchSize ?? 0,
    uBatchSize: config?.uBatchSize ?? 0,
    flashAttn: config?.flashAttn ?? false,
    memoryLock: config?.memoryLock ?? false,
    noMmap: config?.noMmap ?? false,
    parallelSlots: config?.parallelSlots ?? 0,
    contBatching: config?.contBatching ?? false,
    kvCacheTypeK: config?.kvCacheTypeK ?? '',
    kvCacheTypeV: config?.kvCacheTypeV ?? '',
    logVerbose: config?.logVerbose ?? false,
  }

  const [patch, setPatch] = useState<ServerSettingsPatch>(initial)

  // Resync when the config changes underneath us (e.g., after a restart).
  useEffect(() => {
    setPatch(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config?.threads,
    config?.batchSize,
    config?.uBatchSize,
    config?.flashAttn,
    config?.memoryLock,
    config?.noMmap,
    config?.parallelSlots,
    config?.contBatching,
    config?.kvCacheTypeK,
    config?.kvCacheTypeV,
    config?.logVerbose,
  ])

  const dirty = JSON.stringify(patch) !== JSON.stringify(initial)

  return (
    <div className="border-t border-border/60 px-6 py-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>{expanded ? '▾' : '▸'}</span>
          Advanced server settings
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          changing requires service restart
        </span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              CPU / batch
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <NumberField
                label="Threads"
                hint="--threads. 0 = auto"
                value={patch.threads}
                onChange={(v) => setPatch({ ...patch, threads: v })}
              />
              <NumberField
                label="Batch size"
                hint="--batch-size. 0 = default (2048)"
                value={patch.batchSize}
                onChange={(v) => setPatch({ ...patch, batchSize: v })}
              />
              <NumberField
                label="UBatch size"
                hint="--ubatch-size. 0 = default (512)"
                value={patch.uBatchSize}
                onChange={(v) => setPatch({ ...patch, uBatchSize: v })}
              />
            </div>
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Concurrency
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <NumberField
                label="Parallel slots"
                hint="--parallel. 0 = 1 slot"
                value={patch.parallelSlots}
                onChange={(v) => setPatch({ ...patch, parallelSlots: v })}
              />
              <ToggleField
                label="Continuous batching"
                hint="--cont-batching. Recommended when parallel > 1"
                value={patch.contBatching}
                onChange={(v) => setPatch({ ...patch, contBatching: v })}
              />
            </div>
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Memory / GPU
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <ToggleField
                label="Flash attention"
                hint="--flash-attn. Faster prefill on supported GPUs"
                value={patch.flashAttn}
                onChange={(v) => setPatch({ ...patch, flashAttn: v })}
              />
              <ToggleField
                label="Memory lock"
                hint="--mlock. Pin weights in RAM"
                value={patch.memoryLock}
                onChange={(v) => setPatch({ ...patch, memoryLock: v })}
              />
              <ToggleField
                label="No mmap"
                hint="--no-mmap. Copies weights, eats more RAM"
                value={patch.noMmap}
                onChange={(v) => setPatch({ ...patch, noMmap: v })}
              />
            </div>
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              KV cache
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Key cache type"
                hint="--cache-type-k. Quantize the K cache to save VRAM"
                value={patch.kvCacheTypeK}
                options={KV_CACHE_OPTIONS}
                onChange={(v) => setPatch({ ...patch, kvCacheTypeK: v })}
              />
              <SelectField
                label="Value cache type"
                hint="--cache-type-v. Same options"
                value={patch.kvCacheTypeV}
                options={KV_CACHE_OPTIONS}
                onChange={(v) => setPatch({ ...patch, kvCacheTypeV: v })}
              />
            </div>
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Logging
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <ToggleField
                label="Verbose"
                hint="--verbose. Logs every slot decision"
                value={patch.logVerbose}
                onChange={(v) => setPatch({ ...patch, logVerbose: v })}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={disabled || !dirty}
              onClick={() => setPatch(initial)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
            >
              Revert
            </button>
            <button
              type="button"
              disabled={disabled || !dirty}
              onClick={() => onApply(patch)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
            >
              {disabled ? 'Applying…' : 'Apply + restart'} →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── LoRA adapter disclosure ────────────────────────────────────────────
//
// Picks a LoRA adapter file from ~/.blueprint/lora/ and tunes the
// blend scale (0..1). Restart applies. Tier 2 step 2 — the loading
// half of the LoRA story. Training (step 1) is Python-side and ships
// separately.

function LoraDisclosure({
  config,
  disabled,
  onApply,
}: {
  config: svcconfig.Config | null
  disabled: boolean
  onApply: (path: string, scale: number) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [adapters, setAdapters] = useState<main.LoraAdapterEntry[] | null>(null)
  const [adapter, setAdapter] = useState<string>(config?.loraAdapter ?? '')
  const [scale, setScale] = useState<number>(config?.loraScale && config.loraScale > 0 ? config.loraScale : 1.0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded) return
    void ListLoraAdapters()
      .then((list) => setAdapters(list ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [expanded])

  useEffect(() => {
    setAdapter(config?.loraAdapter ?? '')
    setScale(config?.loraScale && config.loraScale > 0 ? config.loraScale : 1.0)
  }, [config?.loraAdapter, config?.loraScale])

  const dirty =
    adapter !== (config?.loraAdapter ?? '') ||
    Math.abs(scale - (config?.loraScale && config.loraScale > 0 ? config.loraScale : 1.0)) > 1e-6

  return (
    <div className="border-t border-border/60 px-6 py-3">
      <button
        type="button"
        onClick={() => setExpanded((v: boolean) => !v)}
        className="flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>{expanded ? '▾' : '▸'}</span>
          LoRA adapter
          {config?.loraAdapter && (
            <span className="ml-2 rounded-full bg-chart-4/15 px-2 py-0.5 font-mono text-[10px] text-chart-4">
              active
            </span>
          )}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          requires service restart
        </span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            Drop trained adapter files (<code className="font-mono">.gguf</code> or{' '}
            <code className="font-mono">.bin</code>) into{' '}
            <code className="font-mono">~/.blueprint/lora/</code> and they show up here.
            Scale blends the adapter with the base — <b>1.0</b> = full adapter behavior,{' '}
            <b>0.5</b> = halfway, <b>0</b> = base only.
          </p>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="text-xs font-medium">Adapter</span>
              <select
                value={adapter}
                onChange={(e) => setAdapter(e.target.value)}
                disabled={disabled || adapters === null}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
              >
                <option value="">— none (base model only) —</option>
                {(adapters ?? []).map((a) => (
                  <option key={a.path} value={a.path}>
                    {a.name} ({humanBytesLora(a.sizeBytes)})
                  </option>
                ))}
              </select>
              {adapters !== null && adapters.length === 0 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  No adapters found in <code className="font-mono">~/.blueprint/lora/</code>.
                </p>
              )}
            </label>
            <label className="block w-32">
              <span className="text-xs font-medium">Scale</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.05}
                value={scale}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  setScale(Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1.0)
                }}
                disabled={disabled || !adapter}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
              />
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={disabled || !dirty}
              onClick={() => {
                setAdapter(config?.loraAdapter ?? '')
                setScale(config?.loraScale && config.loraScale > 0 ? config.loraScale : 1.0)
              }}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
            >
              Revert
            </button>
            <button
              type="button"
              disabled={disabled || !dirty}
              onClick={() => onApply(adapter, scale)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
            >
              {disabled ? 'Applying…' : 'Apply + restart'} →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function engineLabel(id?: string): string {
  switch (id) {
    case 'vllm':
      return 'vLLM (not yet implemented)'
    case 'trt-llm':
      return 'TensorRT-LLM (not yet implemented)'
    case 'llama-cpp':
    case '':
    case undefined:
      return 'llama.cpp'
    default:
      return id
  }
}

function humanBytesLora(n: number): string {
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

const KV_CACHE_OPTIONS = [
  { value: '', label: 'f16 (default)' },
  { value: 'f16', label: 'f16' },
  { value: 'q8_0', label: 'q8_0 (½ VRAM)' },
  { value: 'q4_0', label: 'q4_0 (¼ VRAM, quality cost)' },
]

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10)
          onChange(Number.isFinite(n) ? Math.max(0, n) : 0)
        }}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </label>
  )
}

function ToggleField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border accent-primary"
      />
      <span>
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[10px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function SelectField({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string
  hint: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </label>
  )
}
