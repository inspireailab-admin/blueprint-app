// RouterCard — Dashboard surface for the small-first model router.
//
// Three editable sections:
//   1. Small + Large endpoint config (URL, API key, model name, label).
//   2. Escalation patterns — case-insensitive substrings that, when
//      present in the small model's response, trigger a re-run against
//      the large endpoint.
//   3. Prefix rules — always-escalate prompt prefixes.
//
// Plus tiles for route distribution + escalation ratio so the user
// can see the "we kept X% of calls on the small model" story render
// live as they chat.

import { useCallback, useEffect, useState } from 'react'
import {
  RouterConfig,
  RouterResetStats,
  RouterStats,
  SetRouterConfig,
} from '../../wailsjs/go/main/App'
import type { router } from '../../wailsjs/go/models'
import { HelpButton } from '../help/HelpButton'

export function RouterCard() {
  const [config, setConfig] = useState<router.Config | null>(null)
  const [stats, setStats] = useState<router.Stats | null>(null)
  const [pending, setPending] = useState<router.Config | null>(null)
  const [dirty, setDirty] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([RouterConfig(), RouterStats()])
      setStats(s)
      if (!dirty) {
        setConfig(c)
        setPending(c)
      }
    } catch {
      // stale state is fine
    }
  }, [dirty])

  useEffect(() => {
    void refresh()
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [refresh])

  if (!config || !pending || !stats) {
    return null
  }

  const update = (patch: Partial<router.Config>) => {
    setPending({ ...pending, ...patch } as router.Config)
    setDirty(true)
  }
  const updateSmall = (patch: Partial<router.Endpoint>) =>
    update({ small: { ...pending.small, ...patch } as router.Endpoint })
  const updateLarge = (patch: Partial<router.Endpoint>) =>
    update({ large: { ...pending.large, ...patch } as router.Endpoint })

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Model routing</h2>
            <HelpButton slug="semantic-router" label="Semantic router" />
          </div>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            Small-model-first, escalate-on-uncertainty. Every prompt hits the small endpoint
            first; if the response matches an escalation pattern (or the prompt matches a
            prefix rule), the prompt re-runs against the large endpoint.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={pending.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="h-4 w-4 accent-primary"
          />
          {pending.enabled ? 'Enabled' : 'Disabled'}
        </label>
      </header>

      <div className="grid gap-px bg-border sm:grid-cols-4">
        <Tile label="Small handled" value={String(stats.smallOnly)} sub="no escalation needed" />
        <Tile label="Escalated" value={String(stats.escalated)} sub="pattern matched, re-ran" />
        <Tile label="Prefix-skipped" value={String(stats.prefixSkipped)} sub="went straight to large" />
        <Tile
          label="Escalation ratio"
          value={stats.totalCalls > 0 ? `${(stats.escalationRatio * 100).toFixed(0)}%` : '—'}
          sub={`across ${stats.totalCalls} calls`}
        />
      </div>

      <div className="grid gap-4 px-6 py-4 sm:grid-cols-2">
        <EndpointEditor
          title="Small endpoint"
          subtitle="Fast / cheap model. Hit first."
          endpoint={pending.small}
          onChange={updateSmall}
        />
        <EndpointEditor
          title="Large endpoint"
          subtitle="Slow / expensive model. Escalation target."
          endpoint={pending.large}
          onChange={updateLarge}
        />
      </div>

      <div className="border-t border-border bg-muted/20 px-6 py-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground transition hover:text-foreground"
        >
          <span className="flex items-center gap-2">
            <span aria-hidden>{showAdvanced ? '▾' : '▸'}</span>
            Escalation rules
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            substring patterns + prefix rules
          </span>
        </button>

        {showAdvanced && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <PatternList
              label="Escalation patterns (substring, case-insensitive)"
              hint="When the small model's response contains any of these, re-run against the large."
              patterns={pending.escalationPatterns ?? []}
              onChange={(patterns) => update({ escalationPatterns: patterns })}
            />
            <PatternList
              label="Always-escalate prefixes"
              hint="When the prompt starts with any of these, skip the small model entirely."
              patterns={pending.alwaysEscalateOnPrefix ?? []}
              onChange={(prefixes) => update({ alwaysEscalateOnPrefix: prefixes })}
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-6 py-3">
        <button
          type="button"
          onClick={async () => {
            if (!confirm('Reset router stats counters? Settings survive.')) return
            await RouterResetStats()
            await refresh()
          }}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
        >
          Reset stats
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              setPending(config)
              setDirty(false)
            }}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            Revert
          </button>
          <button
            type="button"
            disabled={!dirty}
            onClick={async () => {
              await SetRouterConfig(pending)
              setDirty(false)
              await refresh()
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            Save config
          </button>
        </div>
      </div>
    </section>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}

function EndpointEditor({
  title,
  subtitle,
  endpoint,
  onChange,
}: {
  title: string
  subtitle: string
  endpoint: router.Endpoint
  onChange: (patch: Partial<router.Endpoint>) => void
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
      <div className="mt-2 grid gap-2">
        <TextField label="Label" value={endpoint.label} onChange={(v) => onChange({ label: v })} />
        <TextField label="Base URL" value={endpoint.baseUrl} onChange={(v) => onChange({ baseUrl: v })} placeholder="http://127.0.0.1:8080/v1" />
        <TextField label="API key" value={endpoint.apiKey} onChange={(v) => onChange({ apiKey: v })} type="password" />
        <TextField label="Model id (API)" value={endpoint.model} onChange={(v) => onChange({ model: v })} placeholder="local" />
      </div>
    </div>
  )
}

function TextField({
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
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      <input
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  )
}

function PatternList({
  label,
  hint,
  patterns,
  onChange,
}: {
  label: string
  hint: string
  patterns: string[]
  onChange: (patterns: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      <ul className="mt-2 space-y-1">
        {patterns.map((p, i) => (
          <li key={i} className="flex items-center justify-between gap-2 rounded-sm bg-muted px-2 py-1">
            <span className="truncate font-mono text-[11px]">{p}</span>
            <button
              type="button"
              onClick={() => onChange(patterns.filter((_, j) => j !== i))}
              className="text-[10px] text-muted-foreground hover:text-destructive"
            >
              remove
            </button>
          </li>
        ))}
        {patterns.length === 0 && (
          <li className="text-[10px] italic text-muted-foreground">No entries.</li>
        )}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const t = draft.trim()
          if (!t) return
          onChange([...patterns, t])
          setDraft('')
        }}
        className="mt-2 flex gap-2"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add another"
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  )
}
