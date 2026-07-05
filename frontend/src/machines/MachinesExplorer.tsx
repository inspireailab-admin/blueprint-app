// Machines — relay-enrolled remote machines (docs plan §4/§5). "Add a machine"
// shows a join code the user runs the Blueprint installer with; the box pairs
// over the relay (E2E-encrypted) and appears here as a deploy target. Distinct
// from the SSH-based Hosts tab.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  StartEnrollment,
  ListEnrolledMachines,
  RemoveEnrolledMachine,
  IsMachineConnected,
  RemoteInstallRuntime,
  RemotePullModel,
  RemoteServe,
  RemoteStop,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { fleet, agent } from '../../wailsjs/go/models'
import type { Model } from '../planner/types'
import { loadCatalog } from '../planner/catalog'
import { smallestQuant } from '../planner/vram'

type ProgressEvt = { machineId: string; op: string; stage: string; pct: number; detail?: string }

export function MachinesExplorer() {
  const [machines, setMachines] = useState<fleet.Machine[]>([])
  const [online, setOnline] = useState<Record<string, boolean>>({})
  const [enroll, setEnroll] = useState<{ code: string; label: string } | null>(null)
  const [enrollError, setEnrollError] = useState<string | null>(null)
  const [models, setModels] = useState<Model[]>([])

  const refresh = useCallback(async () => {
    try {
      const list = (await ListEnrolledMachines()) ?? []
      setMachines(list)
      const status: Record<string, boolean> = {}
      for (const m of list) {
        try {
          status[m.id] = await IsMachineConnected(m.id)
        } catch {
          status[m.id] = false
        }
      }
      setOnline(status)
    } catch (err) {
      console.error('ListEnrolledMachines failed', err)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void loadCatalog()
      .then(({ models }) => setModels(models))
      .catch(() => {})
  }, [refresh])

  // A machine finished pairing → refresh and clear the enrollment panel.
  useEffect(() => {
    const offEnrolled = EventsOn('fleet:enrolled', () => {
      setEnroll(null)
      setEnrollError(null)
      void refresh()
    })
    const offErr = EventsOn('fleet:enroll-error', (e: { error: string }) => {
      setEnrollError(e.error)
    })
    return () => {
      offEnrolled()
      offErr()
    }
  }, [refresh])

  async function addMachine() {
    setEnrollError(null)
    const label = `Machine ${machines.length + 1}`
    try {
      const res = await StartEnrollment(label)
      setEnroll({ code: res.code, label })
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : String(err))
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this machine from your fleet?')) return
    try {
      await RemoveEnrolledMachine(id)
      await refresh()
    } catch (err) {
      console.error('remove failed', err)
    }
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Machines</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Remote machines enrolled over the relay — no SSH, no open ports. Run
              our installer on a box, paste the code, and it appears here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void addMachine()}
            className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            + Add a machine
          </button>
        </header>

        {enroll && <EnrollPanel code={enroll.code} onCancel={() => setEnroll(null)} />}
        {enrollError && (
          <p className="mx-6 my-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {enrollError}
          </p>
        )}

        {machines.length === 0 && !enroll ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-semibold tracking-tight">No machines yet.</p>
            <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">
              Add a Linux or Windows box you own — your GPU server, a rented cloud
              instance — and manage the LLMs on it right from here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {machines.map((m) => (
              <li key={m.id}>
                <MachineRow
                  machine={m}
                  online={online[m.id] ?? false}
                  models={models}
                  onRemove={() => void remove(m.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ─── Enrollment panel ───────────────────────────────────────────────────────

function EnrollPanel({ code, onCancel }: { code: string; onCancel: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="border-b border-border bg-primary/5 px-6 py-5">
      <p className="text-sm font-semibold">Add this machine</p>
      <ol className="mt-3 space-y-3 text-sm text-foreground/90">
        <li>
          1. On the machine you want to add, install the Blueprint agent and give
          it this code:
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm tracking-wide">
              {code}
            </code>
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            e.g. run the installer with{' '}
            <span className="text-foreground">BLUEPRINT_ENROLL_CODE={code}</span>
          </p>
        </li>
        <li className="flex items-center gap-2 text-muted-foreground">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
          2. Waiting for the machine to connect… it appears below automatically.
        </li>
      </ol>
      <button
        type="button"
        onClick={onCancel}
        className="mt-4 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
      >
        ✕ Cancel
      </button>
    </div>
  )
}

// ─── One enrolled machine ───────────────────────────────────────────────────

function MachineRow({
  machine,
  online,
  models,
  onRemove,
}: {
  machine: fleet.Machine
  online: boolean
  models: Model[]
  onRemove: () => void
}) {
  const [deployOpen, setDeployOpen] = useState(false)
  const hw = machine.hardware
  const gpuSummary =
    hw?.gpus && hw.gpus.length > 0
      ? hw.gpus.map((g) => `${g.name} ${Math.round(g.vramTotalMB / 1024)}GB`).join(' · ')
      : 'no GPU'

  return (
    <div className="px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">
            {machine.label}
            <span
              className={[
                'ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
                online
                  ? 'bg-chart-4/15 text-chart-4'
                  : 'bg-muted text-muted-foreground',
              ].join(' ')}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-chart-4' : 'bg-muted-foreground/50'}`}
              />
              {online ? 'connected' : 'offline'}
            </span>
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {hw?.os || 'unknown OS'} · {hw?.cpuCores ?? '?'} cores ·{' '}
            {Math.round(hw?.ramTotalGB ?? 0)} GB RAM · {gpuSummary}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!online}
            onClick={() => setDeployOpen((v) => !v)}
            className="rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/10 disabled:opacity-40"
          >
            {deployOpen ? 'Close' : 'Deploy a model'}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-destructive/10 hover:text-destructive"
          >
            Remove
          </button>
        </div>
      </div>

      {deployOpen && online && <RemoteDeploy machine={machine} models={models} />}
    </div>
  )
}

// ─── Remote deploy: install runtime → pull → serve, with live progress ──────

type DeployPhase =
  | { kind: 'idle' }
  | { kind: 'running'; step: string; pct: number; detail?: string }
  | { kind: 'served'; endpoint: string }
  | { kind: 'error'; error: string }

function RemoteDeploy({ machine, models }: { machine: fleet.Machine; models: Model[] }) {
  const textModels = useMemo(
    () => models.filter((m) => m.type === 'text-generation'),
    [models],
  )
  const [modelId, setModelId] = useState(textModels[0]?.id ?? '')
  const model = textModels.find((m) => m.id === modelId)
  const quant = model ? (requirementsQuant(model)) : 'q4'
  const [phase, setPhase] = useState<DeployPhase>({ kind: 'idle' })

  // Progress events for THIS machine.
  useEffect(() => {
    const off = EventsOn('fleet:progress', (e: ProgressEvt) => {
      if (e.machineId !== machine.id) return
      setPhase({
        kind: 'running',
        step: e.op === 'install-runtime' ? 'Installing runtime' : 'Pulling model',
        pct: e.pct,
        detail: e.detail,
      })
    })
    return () => off()
  }, [machine.id])

  async function deploy() {
    if (!modelId) return
    setPhase({ kind: 'running', step: 'Installing runtime', pct: 0 })
    try {
      await RemoteInstallRuntime(machine.id)
      setPhase({ kind: 'running', step: 'Pulling model', pct: 0 })
      await RemotePullModel(machine.id, modelId, quant)
      setPhase({ kind: 'running', step: 'Starting server', pct: 100 })
      const st = await RemoteServe(machine.id, {
        modelId,
        quant,
        ctxSize: 4096,
        nGpuLayers: 999,
      } as agent.ServeSpec)
      setPhase({ kind: 'served', endpoint: st.endpoint || 'serving' })
    } catch (err) {
      setPhase({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function stop() {
    try {
      await RemoteStop(machine.id)
      setPhase({ kind: 'idle' })
    } catch (err) {
      setPhase({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm shadow-sm focus:border-primary focus:outline-none"
        >
          {textModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} · {quantFor(m).toUpperCase()}
            </option>
          ))}
        </select>
        {phase.kind === 'served' ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="rounded-md border border-border bg-background px-4 py-1.5 text-sm font-medium transition hover:bg-muted"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={phase.kind === 'running' || !modelId}
            onClick={() => void deploy()}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
          >
            {phase.kind === 'running' ? 'Deploying…' : 'Deploy'}
          </button>
        )}
      </div>

      {phase.kind === 'running' && (
        <div className="mt-3">
          <p className="font-mono text-[11px] text-muted-foreground">
            {phase.step}
            {phase.pct > 0 && ` · ${phase.pct}%`}
            {phase.detail ? ` · ${phase.detail}` : ''}
          </p>
          <div className="mt-1 h-2 overflow-hidden rounded-full border border-border bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${phase.pct}%` }} />
          </div>
        </div>
      )}
      {phase.kind === 'served' && (
        <p className="mt-3 flex items-center gap-2 text-sm">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-chart-4" aria-hidden />
          Serving on <span className="font-mono text-xs">{phase.endpoint}</span>
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {phase.error}
        </p>
      )}
    </div>
  )
}

function quantFor(model: Model): string {
  return smallestQuant(model)
}
function requirementsQuant(model: Model): string {
  return smallestQuant(model)
}
