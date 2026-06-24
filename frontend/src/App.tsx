import { useEffect, useState } from 'react'
import { Version } from '../wailsjs/go/main/App'
import type { main } from '../wailsjs/go/models'

type TabId = 'plan' | 'hardware' | 'deploy' | 'monitor' | 'maintain'

const TABS: { id: TabId; label: string; description: string }[] = [
  { id: 'plan', label: 'Plan', description: 'Pick a model that fits your workload.' },
  { id: 'hardware', label: 'Hardware', description: 'Size the hardware. Three configurations, no pricing.' },
  { id: 'deploy', label: 'Deploy', description: 'Install runtime, pull the model, start serving.' },
  { id: 'monitor', label: 'Monitor', description: 'Live GPU, VRAM, CPU, throughput.' },
  { id: 'maintain', label: 'Maintain', description: 'Updates, swap models, restart, logs.' },
]

export function App() {
  const [active, setActive] = useState<TabId>('plan')
  const [version, setVersion] = useState<main.VersionInfo | null>(null)
  const [versionError, setVersionError] = useState<string | null>(null)

  useEffect(() => {
    Version()
      .then(setVersion)
      .catch((err: unknown) =>
        setVersionError(err instanceof Error ? err.message : String(err)),
      )
  }, [])

  const activeTab = TABS.find((t) => t.id === active)!

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <TitleBar />
      <TabBar tabs={TABS} active={active} onSelect={setActive} />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-10 selectable">
          <p className="eyebrow">{activeTab.label}</p>
          <h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight">
            {activeTab.description}
          </h1>
          <PlaceholderBody tab={activeTab} />
        </div>
      </main>

      <StatusBar version={version} versionError={versionError} />
    </div>
  )
}

function TitleBar() {
  return (
    <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold tracking-tight">Blueprint</h2>
        <p className="text-xs text-neutral-500">
          Run open LLMs on your own hardware.
        </p>
      </div>
    </div>
  )
}

function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: typeof TABS
  active: TabId
  onSelect: (id: TabId) => void
}) {
  return (
    <nav
      role="tablist"
      aria-label="Main"
      className="flex gap-1 border-b border-neutral-200 bg-white px-4"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onSelect(tab.id)}
            className={[
              '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition',
              isActive
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-neutral-500 hover:text-neutral-900',
            ].join(' ')}
          >
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}

function PlaceholderBody({ tab }: { tab: (typeof TABS)[number] }) {
  return (
    <div className="mt-8 rounded-2xl border border-dashed border-neutral-300 bg-white p-10">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
        Coming in Phase {phaseFor(tab.id)}
      </p>
      <p className="mt-2 text-base font-semibold tracking-tight">
        {tab.label} tab is a scaffold today.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-neutral-600">
        Phase 1 ships the app shell and wires the Blueprint kernel into the
        frontend. The actual {tab.label.toLowerCase()} surface lands in the next
        phase — see <code>App Phase {phaseFor(tab.id)}</code> in the project
        tracker.
      </p>
    </div>
  )
}

function phaseFor(id: TabId): number {
  switch (id) {
    case 'plan':
      return 2
    case 'hardware':
      return 3
    case 'deploy':
      return 4
    case 'monitor':
      return 5
    case 'maintain':
      return 6
  }
}

function StatusBar({
  version,
  versionError,
}: {
  version: main.VersionInfo | null
  versionError: string | null
}) {
  return (
    <footer className="flex items-center justify-between border-t border-neutral-200 bg-white px-6 py-2 font-mono text-[11px] text-neutral-500">
      {versionError ? (
        <span className="text-red-600">Kernel error: {versionError}</span>
      ) : version ? (
        <span>
          Blueprint <b className="text-neutral-700">v{version.app}</b>
          <span className="mx-2 text-neutral-300">·</span>
          <b className="text-neutral-700">{version.modelCount}</b> models in catalog
        </span>
      ) : (
        <span>Loading…</span>
      )}
      <span className="text-neutral-400">127.0.0.1 · no telemetry</span>
    </footer>
  )
}
