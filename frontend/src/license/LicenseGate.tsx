// LicenseGate renders three pieces:
//
//   1. A first-launch modal asking "Personal or commercial?" — only
//      shows when status === 'uninitialized'.
//
//   2. A persistent banner above the tab bar that paints:
//        info  — soft, blue (trial reminder day 10+)
//        warn  — orange (license expiring soon)
//        expired — red (trial over, no license)
//      Hidden when there's nothing to say (personal mode or fully-
//      licensed-with-plenty-of-time).
//
//   3. A "Enter license key" sheet the user can open from the banner
//      (or About dialog later). Validates locally — no network call.
//
// All three are driven by LicenseSnapshot which the Dashboard polls
// every 10 seconds; mutations refresh immediately.

import { useCallback, useEffect, useState } from 'react'
import {
  ClearLicenseKey,
  LicenseSnapshot,
  PickLicenseUseType,
  SubmitLicenseKey,
} from '../../wailsjs/go/main/App'
import type { license } from '../../wailsjs/go/models'

export function LicenseGate() {
  const [snap, setSnap] = useState<license.Snapshot | null>(null)
  const [showEntry, setShowEntry] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await LicenseSnapshot()
      setSnap(s)
    } catch {
      // stale state is fine
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
  }, [refresh])

  if (!snap) return null

  return (
    <>
      {/* First-launch modal */}
      {snap.status === 'uninitialized' && (
        <FirstLaunchModal
          onPick={async (choice) => {
            await PickLicenseUseType(choice)
            await refresh()
          }}
        />
      )}

      {/* Persistent banner */}
      {snap.banner && snap.status !== 'uninitialized' && (
        <Banner
          level={snap.bannerLevel}
          text={snap.banner}
          onAction={() => setShowEntry(true)}
          actionLabel={
            snap.status === 'licensed' ? 'Renew' :
            snap.status === 'trial_expired' ? 'Buy commercial license' :
            'Have a key?'
          }
        />
      )}

      {/* License entry sheet */}
      {showEntry && (
        <LicenseEntry
          current={snap}
          onClose={() => setShowEntry(false)}
          onSubmit={async (key) => {
            await SubmitLicenseKey(key)
            await refresh()
            setShowEntry(false)
          }}
          onClear={async () => {
            await ClearLicenseKey()
            await refresh()
            setShowEntry(false)
          }}
        />
      )}
    </>
  )
}

// ─── First-launch modal ───────────────────────────────────────────────

function FirstLaunchModal({ onPick }: { onPick: (choice: 'personal' | 'commercial') => Promise<void> }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur"
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-8 py-7">
          <p className="eyebrow">Welcome to Blueprint</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            How will you use Blueprint?
          </h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Blueprint is free for personal, learning, and academic use. Commercial use — running
            client engagements, in-house production work, paid consulting — needs a Pro / Team /
            Enterprise license. Pick what fits, then start the tool.
          </p>
        </div>

        <div className="grid gap-3 px-8 py-6 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onPick('personal')}
            className="rounded-xl border border-border bg-background p-5 text-left transition hover:border-primary/50 hover:bg-primary/5"
          >
            <p className="text-base font-semibold tracking-tight">Personal use</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Learning, academic research, OSS contribution, internal experimentation. All
              features unlocked. Forever free.
            </p>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              No license required
            </p>
          </button>

          <button
            type="button"
            onClick={() => onPick('commercial')}
            className="rounded-xl border border-primary/40 bg-primary/5 p-5 text-left transition hover:border-primary hover:bg-primary/10"
          >
            <p className="text-base font-semibold tracking-tight">Commercial use</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Client work, in-house production, paid consulting. 14-day trial starts now; after
              that buy a Pro / Team / Enterprise license at{' '}
              <code className="font-mono">blueprint.inspireailab.com/pricing</code>.
            </p>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-primary">
              14-day free trial
            </p>
          </button>
        </div>

        <p className="border-t border-border bg-muted/30 px-8 py-3 text-[11px] text-muted-foreground">
          You can switch later from the About menu — picking commercial here doesn't lock you in.
        </p>
      </div>
    </div>
  )
}

// ─── Banner ──────────────────────────────────────────────────────────

function Banner({
  level,
  text,
  actionLabel,
  onAction,
}: {
  level: string
  text: string
  actionLabel: string
  onAction: () => void
}) {
  const tone =
    level === 'expired'
      ? 'border-destructive/40 bg-destructive/5 text-destructive'
      : level === 'warn'
        ? 'border-chart-5/40 bg-chart-5/5 text-chart-5'
        : 'border-border bg-muted/40 text-foreground'

  return (
    <div className={['flex items-center justify-between gap-3 border-b px-6 py-2 text-xs', tone].join(' ')}>
      <p className="min-w-0 truncate">{text}</p>
      <div className="flex gap-2">
        <a
          href="https://blueprint.inspireailab.com/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-current/30 px-2.5 py-1 text-[11px] font-medium hover:bg-current/10"
        >
          See pricing
        </a>
        <button
          type="button"
          onClick={onAction}
          className="rounded-md bg-current px-2.5 py-1 text-[11px] font-semibold text-card hover:opacity-90"
          style={{ color: 'inherit' }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  )
}

// ─── License entry sheet ─────────────────────────────────────────────

function LicenseEntry({
  current,
  onClose,
  onSubmit,
  onClear,
}: {
  current: license.Snapshot
  onClose: () => void
  onSubmit: (key: string) => Promise<void>
  onClear: () => Promise<void>
}) {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-border px-6 py-5">
          <p className="eyebrow">License</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">
            {current.status === 'licensed' ? 'Replace license key' : 'Enter your license key'}
          </h2>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            License keys are emailed by the Inspire AI Lab billing system right after checkout. Paste
            the full key — it's two URL-safe base64 strings joined by a dot.
          </p>
        </header>

        <div className="space-y-3 px-6 py-5">
          {current.license && (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Current
              </p>
              <p className="mt-1">
                <b>{current.license.plan.toUpperCase()}</b> · {current.license.email}
                {current.license.seats ? ` · ${current.license.seats} seats` : ''}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                Expires {new Date(current.license.expiresAtMs).toLocaleDateString()}
              </p>
            </div>
          )}

          <label className="block">
            <span className="text-xs font-medium">License key</span>
            <textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              rows={4}
              placeholder="eyJlbWFpbCI6Im…2vd9.GpQrR8K…"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </label>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-6 py-4">
          <div className="flex gap-2">
            <a
              href="https://blueprint.inspireailab.com/pricing"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Buy a license
            </a>
            {current.status === 'licensed' && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!confirm('Remove the stored license key? Tool keeps working in trial / personal mode.')) return
                  setBusy(true)
                  try {
                    await onClear()
                  } finally {
                    setBusy(false)
                  }
                }}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                Clear key
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !key.trim()}
              onClick={async () => {
                setError(null)
                setBusy(true)
                try {
                  await onSubmit(key.trim())
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setBusy(false)
                }
              }}
              className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Activate'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
