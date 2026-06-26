// Hosts — the registry of remote SSH-reachable machines this Blueprint
// instance can deploy to and manage. Phase B.1: registry only (list +
// add + remove). Phase B.2 adds test-connect + push-install; B.4 makes
// the rest of the Dashboard host-aware.

import { useCallback, useEffect, useState } from 'react'
import {
  AddHost,
  ListHosts,
  RemoveHost,
} from '../../wailsjs/go/main/App'
import type { hosts as hostsModel } from '../../wailsjs/go/models'

type Role = 'dev' | 'shared' | 'prod'

const EMPTY_FORM = {
  label: '',
  user: '',
  host: '',
  port: 22,
  keyPath: '',
  role: 'dev' as Role,
}

export function HostsExplorer() {
  const [items, setItems] = useState<hostsModel.Host[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [addError, setAddError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await ListHosts()
      setItems(list ?? [])
    } catch (err) {
      console.error('ListHosts failed:', err)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function submitAdd() {
    setAddError(null)
    if (!form.label.trim() || !form.user.trim() || !form.host.trim()) {
      setAddError('Label, user, and host are all required.')
      return
    }
    setBusy(true)
    try {
      await AddHost({
        id: '',
        label: form.label.trim(),
        user: form.user.trim(),
        host: form.host.trim(),
        port: form.port || 22,
        keyPath: form.keyPath.trim(),
        role: form.role,
        provenance: 'byo',
        lastSeenAtMs: 0,
        addedAtMs: 0,
      })
      setForm(EMPTY_FORM)
      setShowAdd(false)
      await refresh()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Remove "${label}" from the host registry?`)) return
    try {
      await RemoveHost(id)
      await refresh()
    } catch (err) {
      console.error('RemoveHost failed:', err)
    }
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Hosts</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Remote Linux machines reachable over SSH. Local machine is
              always implicit and doesn&apos;t appear here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
          >
            {showAdd ? '✕ Cancel' : '+ Add host'}
          </button>
        </header>

        {showAdd && (
          <div className="border-b border-border bg-muted/30 px-6 py-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Label"
                hint="What you&rsquo;ll see in the sidebar"
                value={form.label}
                onChange={(v) => setForm({ ...form, label: v })}
                placeholder="Client A — Hetzner box"
              />
              <Field
                label="Role"
                hint="dev / shared / prod"
                select
                value={form.role}
                onChange={(v) => setForm({ ...form, role: v as Role })}
                options={['dev', 'shared', 'prod']}
              />
              <Field
                label="SSH user"
                hint="The login name on the remote box"
                value={form.user}
                onChange={(v) => setForm({ ...form, user: v })}
                placeholder="ubuntu"
              />
              <Field
                label="Host"
                hint="Hostname or IP"
                value={form.host}
                onChange={(v) => setForm({ ...form, host: v })}
                placeholder="10.0.1.42"
              />
              <Field
                label="Port"
                hint="Default 22"
                value={String(form.port)}
                onChange={(v) =>
                  setForm({ ...form, port: parseInt(v, 10) || 22 })
                }
                inputMode="numeric"
              />
              <Field
                label="SSH key path"
                hint="Leave blank to use SSH agent or default key"
                value={form.keyPath}
                onChange={(v) => setForm({ ...form, keyPath: v })}
                placeholder="~/.ssh/id_ed25519"
                mono
              />
            </div>
            {addError && (
              <p className="mt-3 text-xs text-destructive">{addError}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false)
                  setForm(EMPTY_FORM)
                  setAddError(null)
                }}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitAdd()}
                disabled={busy}
                className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? 'Adding…' : 'Add host'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <EmptyState onAdd={() => setShowAdd(true)} />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((h) => (
              <HostRow
                key={h.id}
                host={h}
                onRemove={() => void remove(h.id, h.label)}
              />
            ))}
          </ul>
        )}
      </section>

      <PhaseNote />
    </div>
  )
}

function HostRow({
  host,
  onRemove,
}: {
  host: hostsModel.Host
  onRemove: () => void
}) {
  return (
    <li className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-6 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight">
          {host.label}
          <RoleBadge role={host.role as Role} />
        </p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {host.user}@{host.host}
          {host.port && host.port !== 22 ? `:${host.port}` : ''}
          {host.keyPath ? `  ·  key: ${host.keyPath}` : '  ·  agent / default key'}
        </p>
      </div>
      <span
        className="font-mono text-[11px] text-muted-foreground"
        title={
          host.lastSeenAtMs
            ? new Date(host.lastSeenAtMs).toISOString()
            : 'Never connected'
        }
      >
        {host.lastSeenAtMs
          ? `seen ${formatRelative(host.lastSeenAtMs)}`
          : 'never connected'}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-destructive/10 hover:text-destructive"
      >
        Remove
      </button>
    </li>
  )
}

function RoleBadge({ role }: { role: Role }) {
  const tone =
    role === 'prod'
      ? 'bg-chart-5/15 text-chart-5'
      : role === 'shared'
        ? 'bg-chart-4/15 text-chart-4'
        : 'bg-muted text-muted-foreground'
  return (
    <span
      className={`ml-2 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
    >
      {role}
    </span>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-sm font-semibold tracking-tight">No remote hosts yet.</p>
      <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">
        Blueprint can also manage LLMs running on a remote Linux box you own
        — your own Hetzner server, a rented GPU machine, the client&apos;s
        on-prem rack. Add one here to push-install Blueprint to it and
        manage it like a local host.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
      >
        + Add your first host
      </button>
    </div>
  )
}

function PhaseNote() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/50 px-5 py-4 text-xs text-muted-foreground">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em]">
        Coming in the next pass
      </p>
      <p className="mt-1.5">
        <b>Test connect</b> button per host, <b>push-install</b> Blueprint
        over SSH, and <b>host-aware Dashboard</b> so Overview / Models /
        Calibrate target the selected host instead of always local. The
        registry above is the data layer for all of it.
      </p>
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  inputMode,
  mono,
  select,
  options,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputMode?: 'numeric' | 'text'
  mono?: boolean
  select?: boolean
  options?: string[]
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      {select && options ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode={inputMode}
          className={`mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm shadow-sm transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 ${mono ? 'font-mono' : ''}`}
        />
      )}
      {hint && (
        <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      )}
    </label>
  )
}

function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
