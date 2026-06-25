// PromptCacheCard — Dashboard surface for the semantic prompt cache.
//
// Shows the user three things and lets them tune two:
//
//   - Toggle: enable/disable the whole cache.
//   - Stats: lifetime hits, misses, hit ratio, current entry count,
//     approximate bytes on disk.
//   - Config: similarity threshold (0..1), TTL (seconds), max entries.
//
// The cache is wired into DashboardChat: every Send checks the cache
// first; on a hit, the cached response is returned without touching
// llama-server, the response is rendered as if it streamed instantly.

import { useCallback, useEffect, useState } from 'react'
import {
  ClearPromptCache,
  PromptCacheConfig,
  PromptCacheStats,
  SetPromptCacheConfig,
} from '../../wailsjs/go/main/App'
import type { promptcache } from '../../wailsjs/go/models'

export function PromptCacheCard() {
  const [stats, setStats] = useState<promptcache.Stats | null>(null)
  const [config, setConfig] = useState<promptcache.Config | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pendingConfig, setPendingConfig] = useState<promptcache.Config | null>(null)
  const [clearing, setClearing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([PromptCacheStats(), PromptCacheConfig()])
      setStats(s)
      if (!dirty) {
        setConfig(c)
        setPendingConfig(c)
      }
    } catch {
      // stale data is fine
    }
  }, [dirty])

  useEffect(() => {
    void refresh()
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [refresh])

  if (!stats || !config || !pendingConfig) {
    return null
  }

  const update = (patch: Partial<promptcache.Config>) => {
    setPendingConfig({ ...pendingConfig, ...patch })
    setDirty(true)
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Semantic prompt cache</h2>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            Returns cached responses when a new prompt is semantically similar to one we&apos;ve
            already answered. Off by default — turn it on once you understand the trade-off
            (the user gets a previous answer, not a fresh one).
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={pendingConfig.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="h-4 w-4 accent-primary"
          />
          {pendingConfig.enabled ? 'Enabled' : 'Disabled'}
        </label>
      </header>

      <div className="grid gap-px bg-border sm:grid-cols-4">
        <Tile label="Hit ratio" value={`${(stats.hitRatio * 100).toFixed(0)}%`} sub={`${stats.hits.toLocaleString()} hits / ${stats.misses.toLocaleString()} misses`} />
        <Tile label="Entries" value={stats.entries.toLocaleString()} sub={`cap ${config.maxEntries || '∞'}`} />
        <Tile label="On disk" value={humanBytes(stats.bytesApprox)} sub="~ JSON footprint" />
        <Tile label="State" value={stats.enabled ? 'Active' : 'Off'} sub={stats.enabled ? 'next Send checks the cache' : 'cache is disabled'} />
      </div>

      <div className="grid gap-4 px-6 py-4 sm:grid-cols-3">
        <NumberField
          label="Similarity threshold"
          hint="0..1 cosine. 0.95 = essentially identical, 0.85 = same intent."
          value={pendingConfig.threshold}
          step={0.01}
          min={0}
          max={1}
          onChange={(v) => update({ threshold: v })}
        />
        <NumberField
          label="TTL (seconds)"
          hint="Entries past this age miss + drop. 0 = no expiry."
          value={pendingConfig.ttlSeconds}
          step={60}
          min={0}
          onChange={(v) => update({ ttlSeconds: v })}
        />
        <NumberField
          label="Max entries"
          hint="LRU eviction. 0 = unbounded (don't, on a long-lived install)."
          value={pendingConfig.maxEntries}
          step={50}
          min={0}
          onChange={(v) => update({ maxEntries: v })}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-6 py-3">
        <button
          type="button"
          disabled={clearing || stats.entries === 0}
          onClick={async () => {
            if (!confirm(`Drop all ${stats.entries} cached entries? Hit/miss counters are kept.`)) return
            setClearing(true)
            try {
              await ClearPromptCache()
              await refresh()
            } finally {
              setClearing(false)
            }
          }}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
        >
          {clearing ? 'Clearing…' : 'Clear cache'}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              setPendingConfig(config)
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
              await SetPromptCacheConfig(pendingConfig)
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

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}

function NumberField({
  label,
  hint,
  value,
  step,
  min,
  max,
  onChange,
}: {
  label: string
  hint: string
  value: number
  step: number
  min: number
  max?: number
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </label>
  )
}

function humanBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
