// Maintain tab — the housekeeping surface. Three cards:
//
//   1. Runtime    — current version, "check for updates" + "reinstall"
//   2. Models     — what GGUFs are on disk, with per-row Delete buttons
//   3. Running    — quick "stop" / "restart" buttons for the active
//                   llama-server, plus a "swap to a different model"
//                   helper that round-trips through StopServe → StartServe.

import { useCallback, useEffect, useState } from 'react'
import {
  BlueprintDataSummary,
  DeleteModel,
  InstallRuntime,
  InstalledModels,
  LatestRuntimeVersion,
  ResetBlueprintData,
  RuntimeStatus,
  ServerStatus,
  StartServe,
  StopServe,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'

type InstalledModel = {
  id: string
  displayName: string
  quant: string
  fileName: string
  path: string
  bytesSize: number
}

type RuntimeUpdate = {
  installed: string
  latest: string
  hasUpdate: boolean
}

type Runtime = {
  installed: boolean
  version: string
  binPath: string
}

type Server = {
  state: 'stopped' | 'starting' | 'running'
  modelId?: string
  quant?: string
}

export function MaintainExplorer() {
  const [models, setModels] = useState<InstalledModel[] | null>(null)
  const [runtime, setRuntime] = useState<Runtime | null>(null)
  const [updateInfo, setUpdateInfo] = useState<RuntimeUpdate | null>(null)
  const [server, setServer] = useState<Server>({ state: 'stopped' })
  const [busy, setBusy] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    const [m, r, s] = await Promise.all([
      InstalledModels(),
      RuntimeStatus(),
      ServerStatus(),
    ])
    setModels(m as InstalledModel[])
    setRuntime(r as Runtime)
    setServer(s as Server)
  }, [])

  useEffect(() => {
    refetch()
    LatestRuntimeVersion().then((u) => setUpdateInfo(u as RuntimeUpdate))
    const off = EventsOn('deploy:serve-status', (s: Server) => setServer(s))
    return () => {
      off()
    }
  }, [refetch])

  return (
    <div className="mt-8 space-y-6">
      <RuntimeCard
        runtime={runtime}
        update={updateInfo}
        busy={busy === 'runtime'}
        onReinstall={() => {
          setBusy('runtime')
          InstallRuntime()
          // Re-poll periodically until the install completes — the Go
          // side doesn't expose a synchronous Wait, so we sample the
          // status every 2 s and clear the busy flag when the version
          // changes.
          const t = setInterval(async () => {
            const fresh = await RuntimeStatus()
            const r = fresh as Runtime
            if (r.installed && r.version !== runtime?.version) {
              setRuntime(r)
              setBusy(null)
              clearInterval(t)
              LatestRuntimeVersion().then((u) => setUpdateInfo(u as RuntimeUpdate))
            }
          }, 2000)
        }}
      />

      <ServerCard
        server={server}
        models={models ?? []}
        onStop={async () => {
          setBusy('serve-stop')
          await StopServe()
          setBusy(null)
        }}
        onRestart={async () => {
          if (!server.modelId || !server.quant) return
          setBusy('serve-restart')
          await StopServe()
          // Wait for the supervisor goroutine to clear state before
          // we issue the new Start. Poll instead of guessing a sleep.
          for (let i = 0; i < 40; i++) {
            const s = (await ServerStatus()) as Server
            if (s.state === 'stopped') break
            await new Promise((r) => setTimeout(r, 200))
          }
          // Restart uses 0 / -1 sentinels — deploy.go interprets these
          // as the safe defaults (4096 ctx, all GPU layers). Maintain
          // doesn't have the Optimize tab's serveConfig in scope; if
          // the user wants different values, they restart through
          // Deploy.
          await StartServe(server.modelId, server.quant, 0, -1)
          setBusy(null)
        }}
      />

      <ModelsCard
        models={models}
        onDelete={async (m) => {
          if (server.state !== 'stopped' && server.modelId === m.id && server.quant === m.quant) {
            alert(
              'This model is currently serving. Stop the server first, then delete.',
            )
            return
          }
          if (!confirm(`Delete ${m.displayName} (${m.quant.toUpperCase()})?\n${humanBytes(m.bytesSize)} from ${m.path}`)) {
            return
          }
          setBusy(`model-${m.id}-${m.quant}`)
          try {
            await DeleteModel(m.id, m.fileName)
            await refetch()
          } catch (err: unknown) {
            alert(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(null)
          }
        }}
        busyKey={busy}
      />

      <ResetCard />
    </div>
  )
}

// ─── Reset card (destructive — bottom of the tab) ─────────────────────

function ResetCard() {
  const [summary, setSummary] = useState<{ path: string; bytesTotal: number } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    BlueprintDataSummary()
      .then((s) => setSummary(s as { path: string; bytesTotal: number }))
      .catch(() => setSummary(null))
  }, [])

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-destructive/30 bg-destructive/5 shadow-sm">
        <header className="border-b border-destructive/20 px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight text-destructive">
            Reset Blueprint data
          </h2>
          <p className="mt-1 text-xs text-foreground/80">
            Removes the entire Blueprint home directory — installed llama.cpp
            runtime, every pulled model, and the first-run marker. Doesn&apos;t
            uninstall the app binary itself; use your OS&apos;s &ldquo;Apps&rdquo; control
            panel for that.
          </p>
        </header>
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="text-sm">
            <p className="font-mono text-[11px] text-muted-foreground">
              {summary?.path ?? '~/.blueprint'}
            </p>
            <p className="mt-1">
              On disk: <b className="font-mono">{summary ? humanBytes(summary.bytesTotal) : '—'}</b>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-4 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10"
          >
            Reset & quit…
          </button>
        </div>
        {error && (
          <p className="mx-6 mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </section>

      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
        >
          <div className="mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            <header className="border-b border-border px-6 py-5">
              <p className="eyebrow text-destructive">Destructive</p>
              <h3 id="reset-confirm-title" className="mt-1 text-lg font-semibold tracking-tight">
                Delete all Blueprint data?
              </h3>
            </header>
            <div className="space-y-3 px-6 py-5 text-sm">
              <p>
                This stops the local server, removes{' '}
                <code className="font-mono text-xs">{summary?.path ?? '~/.blueprint'}</code>{' '}
                (<b>{summary ? humanBytes(summary.bytesTotal) : '?'}</b>),
                then quits the app.
              </p>
              <p className="text-muted-foreground">
                The blueprint.exe binary itself stays where it is — use your OS to
                remove it. To start fresh, just relaunch after the reset.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-6 py-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={resetting}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setResetting(true)
                  setError(null)
                  try {
                    await ResetBlueprintData()
                    // App will quit ~200ms later; no UI to update.
                  } catch (err: unknown) {
                    setError(err instanceof Error ? err.message : String(err))
                    setResetting(false)
                    setConfirmOpen(false)
                  }
                }}
                disabled={resetting}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground shadow-sm transition hover:bg-destructive/90 disabled:opacity-60"
              >
                {resetting ? 'Resetting…' : 'Delete & quit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────

function RuntimeCard({
  runtime,
  update,
  busy,
  onReinstall,
}: {
  runtime: Runtime | null
  update: RuntimeUpdate | null
  busy: boolean
  onReinstall: () => void
}) {
  return (
    <SectionCard
      title="llama.cpp runtime"
      description="The native inference runtime Blueprint drives. Update when a new release ships."
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          {runtime?.installed ? (
            <p className="text-sm">
              <span className="mr-2 inline-flex h-2 w-2 rounded-full bg-chart-4" aria-hidden />
              Installed <b className="font-mono text-foreground">{runtime.version}</b>
              {update?.hasUpdate && update.latest && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-chart-5/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-chart-5">
                  Update available · {update.latest}
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm">
              <span className="mr-2 inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden />
              Not installed
            </p>
          )}
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{runtime?.binPath ?? ''}</p>
        </div>
        <button
          type="button"
          onClick={onReinstall}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
        >
          {busy ? 'Reinstalling…' : runtime?.installed ? 'Reinstall / update' : 'Install runtime'}
        </button>
      </div>
    </SectionCard>
  )
}

function ServerCard({
  server,
  models,
  onStop,
  onRestart,
}: {
  server: Server
  models: InstalledModel[]
  onStop: () => void
  onRestart: () => void
}) {
  const running = server.state === 'running'
  const sm = models.find((m) => m.id === server.modelId && m.quant === server.quant)
  return (
    <SectionCard
      title="Active serve"
      description="Stop or restart the currently-running llama-server."
    >
      {running ? (
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm">
            <span className="mr-2 inline-flex h-2 w-2 animate-pulse rounded-full bg-chart-4" aria-hidden />
            Running <b>{sm?.displayName ?? server.modelId}</b>{' '}
            <span className="font-mono text-xs text-muted-foreground">{server.quant?.toUpperCase()}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRestart}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
            >
              Restart
            </button>
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
            >
              Stop
            </button>
          </div>
        </div>
      ) : server.state === 'starting' ? (
        <p className="text-sm">
          <span className="mr-2 inline-flex h-2 w-2 animate-pulse rounded-full bg-chart-5" aria-hidden />
          Starting…
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          <span className="mr-2 inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden />
          No server running. Start one from the Deploy tab.
        </p>
      )}
    </SectionCard>
  )
}

function ModelsCard({
  models,
  onDelete,
  busyKey,
}: {
  models: InstalledModel[] | null
  onDelete: (m: InstalledModel) => void
  busyKey: string | null
}) {
  return (
    <SectionCard
      title="Installed models"
      description="GGUFs sitting in ~/.blueprint/models. Pulled models stay until you delete them — re-pulling is free if you change your mind."
    >
      {models === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : models.length === 0 ? (
        <p className="text-sm text-muted-foreground">No models on disk yet. Pull one from the Deploy tab.</p>
      ) : (
        <ul className="divide-y divide-border">
          {models.map((m) => {
            const key = `model-${m.id}-${m.quant}`
            return (
              <li key={key} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold tracking-tight">
                    {m.displayName}{' '}
                    <span className="font-mono text-xs text-muted-foreground">{m.quant.toUpperCase()}</span>
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{m.path}</p>
                </div>
                <p className="font-mono text-xs text-muted-foreground">{humanBytes(m.bytesSize)}</p>
                <button
                  type="button"
                  onClick={() => onDelete(m)}
                  disabled={busyKey === key}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
                >
                  {busyKey === key ? 'Deleting…' : 'Delete'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </SectionCard>
  )
}

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

function humanBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
