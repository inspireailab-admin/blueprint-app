// PythonRuntimeCard — Dashboard surface for the optional Python
// install. Each feature renders as a row with:
//   - Name + summary
//   - Marginal size in MB / GB
//   - "Needs NVIDIA" pill where applicable
//   - Install / Uninstall button
//
// Plus a disk-space tile at the top showing free space on the volume
// that holds ~/.blueprint, and a live progress chip during installs.

import { useCallback, useEffect, useState } from 'react'
import {
  CheckPythonFeatureDiskSpace,
  InstallPythonFeature,
  PythonRuntimeStatus,
  UninstallPythonFeature,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { main } from '../../wailsjs/go/models'

type ProgressEvent = {
  featureId: string
  stage: string
  detail?: string
  done?: number
  total?: number
}

export function PythonRuntimeCard() {
  const [status, setStatus] = useState<main.PythonRuntimeStatus | null>(null)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [confirmFeatureID, setConfirmFeatureID] = useState<string | null>(null)
  const [spaceCheck, setSpaceCheck] = useState<main.DiskSpaceCheck | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await PythonRuntimeStatus()
      setStatus(s)
    } catch {
      // stale state is fine
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    const off = EventsOn('pyruntime:install-progress', (p: ProgressEvent) => {
      setProgress(p)
      if (p.stage === 'log' && p.detail) {
        setLogLines((prev) => {
          const next = [...prev, p.detail!]
          return next.length > 200 ? next.slice(next.length - 200) : next
        })
      }
      if (p.stage === 'done') {
        void refresh()
      }
    })
    return () => off()
  }, [refresh])

  if (!status) return null

  async function confirmInstall(id: string) {
    setConfirmFeatureID(id)
    try {
      const check = await CheckPythonFeatureDiskSpace(id)
      setSpaceCheck(check)
    } catch {
      setSpaceCheck(null)
    }
  }

  async function doInstall(id: string) {
    setLogLines([])
    setConfirmFeatureID(null)
    setSpaceCheck(null)
    try {
      await InstallPythonFeature(id)
    } catch (e) {
      setProgress({ featureId: id, stage: 'error', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  async function doUninstall(id: string) {
    if (!confirm('Remove this feature? Dependencies stay installed (uninstall them separately).')) return
    setLogLines([])
    try {
      await UninstallPythonFeature(id)
    } catch (e) {
      setProgress({ featureId: id, stage: 'error', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const busy = !!status.installInFlight

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Python runtime</h2>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            Optional Python install for LoRA training, vLLM serving, TensorRT-LLM, and prompt
            compression. Managed via <code className="font-mono">uv</code> at
            <code className="ml-1 font-mono">{status.runtimeDir || '~/.blueprint/python'}</code>.
          </p>
        </div>
        {busy && (
          <span className="rounded-full bg-primary/15 px-3 py-1 font-mono text-[10px] text-primary">
            installing {status.installInFlight}
          </span>
        )}
      </header>

      <div className="grid gap-px bg-border sm:grid-cols-3">
        <Tile
          label="Free space"
          value={humanBytes(status.disk.freeBytes)}
          sub={`of ${humanBytes(status.disk.totalBytes)} on ${status.disk.path}`}
        />
        <Tile
          label="uv binary"
          value={status.uvPresent ? 'Installed' : 'Will download on first install'}
          sub={status.uvPresent ? status.uvPath : 'astral.sh/uv — ~30 MB single binary'}
        />
        <Tile
          label="Installed features"
          value={String(status.features.filter((f) => f.installed).length)}
          sub={`${status.features.length - status.features.filter((f) => f.installed).length} available to install`}
        />
      </div>

      <ul className="divide-y divide-border">
        {status.features.map((f) => (
          <li key={f.id} className="px-6 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                  {f.name}
                  {f.requiresGPU && (
                    <span className="rounded-sm bg-chart-5/15 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.1em] text-chart-5">
                      Needs NVIDIA
                    </span>
                  )}
                  {f.installed && (
                    <span className="rounded-sm bg-chart-4/15 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.1em] text-chart-4">
                      Installed
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{f.summary}</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  +{humanBytes(f.addedSizeBytes)}
                </p>
              </div>
              <div className="flex gap-2">
                {f.installed ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => doUninstall(f.id)}
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
                  >
                    Uninstall
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => confirmInstall(f.id)}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    Install
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Install confirmation modal — inline at the bottom rather than a real modal so screencast captures everything */}
      {confirmFeatureID && spaceCheck && (
        <div className="border-t border-border bg-muted/30 px-6 py-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Confirm install
          </p>
          <p className="mt-1 text-sm">
            <b>{humanBytes(spaceCheck.requestedBytes)}</b> will be downloaded and installed.
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            You have <b>{humanBytes(spaceCheck.disk.freeBytes)}</b> free on{' '}
            <code className="font-mono">{spaceCheck.disk.path}</code>.
            {spaceCheck.feasible ? ' Fits with comfortable headroom.' : ' Not enough free space.'}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => doInstall(confirmFeatureID)}
              disabled={!spaceCheck.feasible}
              className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {spaceCheck.feasible ? 'Install' : 'Not enough disk'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmFeatureID(null)
                setSpaceCheck(null)
              }}
              className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Live progress + log */}
      {progress && progress.stage !== 'done' && (
        <div className="border-t border-border bg-muted/20 px-6 py-3">
          <p className="font-mono text-[11px] text-muted-foreground">
            <b className="text-foreground">{progress.featureId}</b>
            <span className="mx-2 opacity-40">·</span>
            {progress.stage}
            {progress.detail && <span className="ml-2 truncate">— {progress.detail}</span>}
            {progress.total && progress.done !== undefined && progress.total > 0 && (
              <span className="ml-2">
                {Math.round((progress.done / progress.total) * 100)}%
              </span>
            )}
          </p>
          {progress.total && progress.done !== undefined && progress.total > 0 && (
            <div className="mt-1.5 h-2 overflow-hidden rounded-full border border-border bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="mt-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {showLog ? 'Hide log' : 'Show log'}
          </button>
          {showLog && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-neutral-950 p-2 font-mono text-[10px] text-neutral-200">
              {logLines.length === 0 ? (
                <p className="text-neutral-500">Waiting for output…</p>
              ) : (
                logLines.map((l, i) => <div key={i}>{l}</div>)
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-mono text-base font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>
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
