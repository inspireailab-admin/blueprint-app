// RemoteServersCard — register + monitor OpenAI-compatible LLM
// endpoints outside this machine. Each entry runs through ProbeAllRemoteServers
// every few seconds; the dot turns green when /v1/models answers
// within 3 seconds.

import { useCallback, useEffect, useState } from 'react'
import {
  AddRemoteServer,
  ListRemoteServers,
  ProbeAllRemoteServers,
  RemoveRemoteServer,
  UpdateRemoteServer,
} from '../../wailsjs/go/main/App'
import type { main, remotes } from '../../wailsjs/go/models'

export function RemoteServersCard() {
  const [list, setList] = useState<remotes.Remote[]>([])
  const [probes, setProbes] = useState<Record<string, main.RemoteProbeResult>>({})
  const [showForm, setShowForm] = useState(false)
  const [editingID, setEditingID] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const ls = await ListRemoteServers()
      setList(ls ?? [])
      const ps = await ProbeAllRemoteServers()
      const map: Record<string, main.RemoteProbeResult> = {}
      for (const p of ps ?? []) map[p.id] = p
      setProbes(map)
    } catch {
      // stale state is fine
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Remote LLMs</h2>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            Monitor OpenAI-compatible endpoints anywhere reachable on HTTP — your other Blueprint
            hosts, a self-hosted vLLM cluster, a vendor API. Probes <code className="font-mono">/v1/models</code>{' '}
            every 5 seconds.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowForm(true)
            setEditingID(null)
          }}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
        >
          + Add remote
        </button>
      </header>

      {showForm && (
        <RemoteForm
          editing={editingID ? list.find((r) => r.id === editingID) : undefined}
          onSave={async (entry) => {
            if (editingID) {
              await UpdateRemoteServer(entry)
            } else {
              await AddRemoteServer(entry)
            }
            setShowForm(false)
            setEditingID(null)
            await refresh()
          }}
          onCancel={() => {
            setShowForm(false)
            setEditingID(null)
          }}
        />
      )}

      {list.length === 0 ? (
        <p className="px-6 py-4 text-xs text-muted-foreground">
          No remotes registered yet. Click <b>Add remote</b> to wire one up.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((r) => {
            const probe = probes[r.id]
            const reachable = probe?.reachable
            return (
              <li key={r.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-6 py-3">
                <span
                  className={[
                    'inline-flex h-2.5 w-2.5 rounded-full',
                    reachable === undefined
                      ? 'bg-muted'
                      : reachable
                        ? 'bg-chart-4'
                        : 'bg-destructive',
                  ].join(' ')}
                  title={reachable === undefined ? 'probing…' : reachable ? 'reachable' : (probe?.error || 'unreachable')}
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold tracking-tight">{r.label}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                    {r.baseUrl}
                    {probe?.latencyMs ? ` · ${probe.latencyMs} ms` : ''}
                    {probe?.models && probe.models.length > 0 ? ` · ${probe.models.length} model${probe.models.length === 1 ? '' : 's'}` : ''}
                  </p>
                  {probe?.error && reachable === false && (
                    <p className="mt-0.5 truncate text-[10px] text-destructive">{probe.error}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingID(r.id)
                      setShowForm(true)
                    }}
                    className="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium hover:bg-muted"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Remove remote ${r.label}?`)) return
                      await RemoveRemoteServer(r.id)
                      await refresh()
                    }}
                    className="rounded-md border border-destructive/40 bg-background px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/5"
                  >
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function RemoteForm({
  editing,
  onSave,
  onCancel,
}: {
  editing?: remotes.Remote
  onSave: (entry: remotes.Remote) => Promise<void>
  onCancel: () => void
}) {
  const [label, setLabel] = useState(editing?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(editing?.apiKey ?? '')
  const [model, setModel] = useState(editing?.model ?? 'local')
  const [kind, setKind] = useState<'llamacpp' | 'vllm' | 'vendor'>(
    (editing?.kind as 'llamacpp' | 'vllm' | 'vendor') ?? 'llamacpp',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="grid gap-3 border-b border-border bg-muted/20 px-6 py-4 sm:grid-cols-2">
      <Field label="Label" value={label} onChange={setLabel} placeholder="Production vLLM (DC-1)" />
      <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder="http://10.0.1.42:8080/v1" />
      <Field label="API key" value={apiKey} onChange={setApiKey} type="password" placeholder="optional" />
      <Field label="Model identifier" value={model} onChange={setModel} placeholder="local" />
      <label className="block">
        <span className="text-xs font-medium">Kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'llamacpp' | 'vllm' | 'vendor')}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px]"
        >
          <option value="llamacpp">llama.cpp / llama-server</option>
          <option value="vllm">vLLM</option>
          <option value="vendor">Vendor API (OpenAI, Anthropic, …)</option>
        </select>
      </label>
      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive sm:col-span-2">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !label.trim() || !baseUrl.trim()}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await onSave({
                id: editing?.id ?? '',
                label: label.trim(),
                baseUrl: baseUrl.trim(),
                apiKey,
                model,
                kind,
                addedAtMs: editing?.addedAtMs ?? 0,
              } as remotes.Remote)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setBusy(false)
            }
          }}
          className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Saving…' : editing ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'password'
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <input
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  )
}
