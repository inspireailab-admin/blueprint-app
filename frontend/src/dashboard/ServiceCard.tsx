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
  RestartManagedServer,
  ServiceInfo,
  StartManagedServer,
  StopManagedServer,
} from '../../wailsjs/go/main/App'
import type { main, svcconfig } from '../../wailsjs/go/models'

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

  const tone = serving
    ? 'border-chart-4/40 bg-chart-4/5'
    : crashed
      ? 'border-destructive/40 bg-destructive/5'
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
      return {
        eyebrow: 'Supervisor — crash loop',
        title: <>Child keeps crashing</>,
        sub: `${info.restartCount ?? 0} restarts so far`,
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
          <p className="eyebrow">{headline.eyebrow}</p>
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
            <button
              type="button"
              disabled={actionInFlight !== null}
              onClick={() => run('restart', RestartManagedServer)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
            >
              {actionInFlight === 'restart' && <Spinner />}
              {actionInFlight === 'restart' ? 'Restarting…' : 'Restart'} →
            </button>
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
