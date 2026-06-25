// ServiceCard — top-of-dashboard surface for the Windows Service
// that supervises llama-server.
//
// Three primary states this card handles:
//
//   1. blueprint-svc.exe missing on disk — installer didn't ship it.
//      Show a clear error pointing at the build.ps1 + the expected path.
//   2. Service binary present but not installed with SCM.
//      Show the "Install service" CTA with what it'll do + UAC warning.
//   3. Service installed.
//      Show current SCM + supervisor state + start/stop/uninstall +
//      bind-address config + the configured model.

import { useEffect, useState } from 'react'
import {
  ApplyServeConfig,
  CurrentServeConfig,
  InstallService,
  RestartManagedServer,
  ServiceInfo,
  StartManagedServer,
  StopManagedServer,
  UninstallService,
} from '../../wailsjs/go/main/App'
import type { main, svcconfig } from '../../wailsjs/go/models'

type Props = {
  /** Lets the Dashboard force a refresh after the user-triggered changes. */
  onSelectModel: (id: string) => void
}

export function ServiceCard({}: Props) {
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
      // Non-fatal — show stale data, polling will retry.
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

  if (!info) {
    return (
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">Loading service status…</p>
      </section>
    )
  }

  // State 1 — binary missing.
  if (!info.svcBinPresent) {
    return (
      <section className="overflow-hidden rounded-2xl border border-chart-5/40 bg-chart-5/5 shadow-sm">
        <div className="px-6 py-5">
          <p className="eyebrow">Service binary missing</p>
          <p className="mt-1 text-base font-semibold tracking-tight">
            <code className="font-mono">blueprint-svc.exe</code> wasn’t found next to{' '}
            <code className="font-mono">blueprint.exe</code>.
          </p>
          <p className="mt-2 max-w-prose text-xs text-muted-foreground">
            Build it with <code className="font-mono">.\build.ps1 -SvcOnly</code> from the repo root,
            then click <em>Install service</em> here.
          </p>
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            Expected at: <span className="text-foreground">{info.svcBinExpected}</span>
          </p>
        </div>
      </section>
    )
  }

  // State 2 — not installed yet.
  if (!info.installed) {
    return (
      <section className="overflow-hidden rounded-2xl border border-primary/40 bg-primary/5 shadow-sm">
        <div className="px-6 py-5">
          <p className="eyebrow">Service not installed</p>
          <p className="mt-1 text-lg font-semibold tracking-tight">
            Install the Blueprint LLM Service for 100% uptime
          </p>
          <p className="mt-2 max-w-prose text-xs text-muted-foreground">
            A Windows Service supervises llama-server so it stays up across reboots, app exits,
            and crashes. Restart-on-crash with exponential backoff is built in. You can keep
            running llama-server directly from the Deploy tab as before — but the service is the
            recommended path for anything beyond a one-off session.
          </p>
          <ul className="mt-3 space-y-1 text-xs text-foreground/80">
            <Li>Auto-start at boot, no logged-in user required</Li>
            <Li>Supervises the child — crashes are restarted automatically</Li>
            <Li>Config + logs in <code className="font-mono">%ProgramData%\Blueprint</code></Li>
            <Li>Will ask for admin rights (UAC) to register with SCM</Li>
          </ul>

          {error && <ErrorChip msg={error} />}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={actionInFlight === 'install'}
              onClick={() => run('install', InstallService)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
            >
              {actionInFlight === 'install' ? 'Waiting on UAC…' : 'Install service'} →
            </button>
            <p className="self-center text-[11px] text-muted-foreground">
              Pops a UAC prompt. Accept to register the service with Windows.
            </p>
          </div>
        </div>
      </section>
    )
  }

  // State 3 — installed.
  const running = info.scmState === 'running' && info.phase === 'running'
  const idle = info.scmState === 'running' && info.phase === 'idle'
  const stopped = info.scmState === 'stopped' || info.scmState === ''
  const phaseLabel = scmPhraseFor(info)

  return (
    <section
      className={[
        'overflow-hidden rounded-2xl border shadow-sm',
        running ? 'border-chart-4/40 bg-chart-4/5' : 'border-border bg-card',
      ].join(' ')}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-6 py-4">
        <div>
          <p className="eyebrow">Blueprint LLM Service</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
            <StatusDot running={running} idle={idle} stopped={stopped} />
            {phaseLabel}
          </p>
          {info.lastError && <p className="mt-1 text-xs text-destructive">{info.lastError}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {stopped ? (
            <button
              type="button"
              disabled={actionInFlight !== null}
              onClick={() => run('start', StartManagedServer)}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            >
              {actionInFlight === 'start' ? 'Starting…' : 'Start service'}
            </button>
          ) : (
            <button
              type="button"
              disabled={actionInFlight !== null}
              onClick={() => run('stop', StopManagedServer)}
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
            >
              {actionInFlight === 'stop' ? 'Stopping…' : 'Stop service'}
            </button>
          )}
          <button
            type="button"
            disabled={actionInFlight !== null || !config}
            onClick={() => run('restart', RestartManagedServer)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
          >
            Restart
          </button>
          <button
            type="button"
            disabled={actionInFlight !== null}
            onClick={() => {
              if (!confirm('Uninstall the Blueprint LLM Service? This stops llama-server and removes the service from Windows.')) return
              void run('uninstall', UninstallService)
            }}
            className="rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/5 disabled:opacity-60"
          >
            Uninstall
          </button>
        </div>
      </header>

      <dl className="grid gap-x-6 gap-y-2 px-6 py-4 text-sm sm:grid-cols-2">
        <KV k="SCM state" v={info.scmState || 'unknown'} mono />
        <KV k="Supervisor phase" v={info.phase || 'idle'} mono />
        <KV k="Model" v={config ? `${config.modelId} ${config.quant.toUpperCase()}` : '— not configured —'} mono />
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
        <KV k="GPU layers" v={config ? (config.nGpuLayers >= 999 ? 'All' : String(config.nGpuLayers)) : '—'} mono />
        <KV k="Restart count" v={String(info.restartCount ?? 0)} mono />
        <KV k="PID" v={info.pid ? String(info.pid) : '—'} mono />
      </dl>

      {error && (
        <div className="border-t border-border/60 px-6 pb-4">
          <ErrorChip msg={error} />
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

function StatusDot({ running, idle, stopped }: { running: boolean; idle: boolean; stopped: boolean }) {
  if (running) return <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-chart-4" />
  if (idle) return <span className="inline-flex h-2 w-2 rounded-full bg-chart-5" />
  if (stopped) return <span className="inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" />
  return <span className="inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" />
}

function scmPhraseFor(info: main.ServiceInfo): string {
  if (info.scmState === 'running' && info.phase === 'running') {
    return `Serving ${info.modelId ?? '—'}`
  }
  if (info.scmState === 'running' && info.phase === 'idle') {
    return 'Service running, no model configured yet'
  }
  if (info.scmState === 'running' && info.phase === 'crashed') {
    return 'Service running, child llama-server keeps crashing'
  }
  if (info.scmState === 'start_pending') return 'Starting…'
  if (info.scmState === 'stop_pending') return 'Stopping…'
  if (info.scmState === 'stopped') return 'Stopped'
  return info.scmState || 'Unknown'
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

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1 inline-flex h-1 w-1 shrink-0 rounded-full bg-foreground/50" />
      <span>{children}</span>
    </li>
  )
}

function ErrorChip({ msg }: { msg: string }) {
  return (
    <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 font-mono text-[11px] text-destructive">
      {msg}
    </p>
  )
}
