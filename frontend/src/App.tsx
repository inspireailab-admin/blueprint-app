import { useEffect, useState } from 'react'
import { Version } from '../wailsjs/go/main/App'
import type { main } from '../wailsjs/go/models'
import { loadCatalog, findModel } from './planner/catalog'
import { usePlannerState } from './planner/state'
import type { Model } from './planner/types'
import { PlanExplorer } from './planner/PlanExplorer'
import { HardwareExplorer } from './hardware/HardwareExplorer'
import { DeployExplorer } from './deploy/DeployExplorer'
import { MonitorExplorer } from './monitor/MonitorExplorer'
import { MaintainExplorer } from './maintain/MaintainExplorer'

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

  // Planner state lives at the App level so Plan + Hardware see the same
  // selected model + requirements as the user moves between tabs.
  const planner = usePlannerState()
  const [models, setModels] = useState<Model[] | null>(null)
  const [catalogAsOf, setCatalogAsOf] = useState<string>('')
  const [catalogError, setCatalogError] = useState<string | null>(null)

  useEffect(() => {
    Version()
      .then(setVersion)
      .catch((err: unknown) =>
        setVersionError(err instanceof Error ? err.message : String(err)),
      )

    loadCatalog()
      .then(({ models, asOf }) => {
        setModels(models)
        setCatalogAsOf(asOf)
      })
      .catch((err: unknown) =>
        setCatalogError(err instanceof Error ? err.message : String(err)),
      )
  }, [])

  const activeTab = TABS.find((t) => t.id === active)!
  const selectedModel = findModel(models ?? [], planner.selectedModelId)

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TitleBar />
      <TabBar tabs={TABS} active={active} onSelect={setActive} />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8 selectable">
          <p className="eyebrow">{activeTab.label}</p>
          <h1 className="mt-2 text-balance text-2xl font-semibold tracking-tight">
            {activeTab.description}
          </h1>

          {catalogError ? (
            <CatalogError message={catalogError} />
          ) : active === 'plan' ? (
            <PlanExplorer
              models={models}
              planner={planner}
              onContinueToHardware={() => setActive('hardware')}
            />
          ) : active === 'hardware' ? (
            <HardwareExplorer
              selectedModel={selectedModel}
              requirements={planner.requirements}
              catalogAsOf={catalogAsOf}
              onUpdate={planner.update}
              onBackToPlan={() => setActive('plan')}
              onContinueToDeploy={() => setActive('deploy')}
            />
          ) : active === 'deploy' ? (
            <DeployExplorer
              selectedModel={selectedModel}
              requirements={planner.requirements}
              onBackToHardware={() => setActive('hardware')}
            />
          ) : active === 'monitor' ? (
            <MonitorExplorer />
          ) : active === 'maintain' ? (
            <MaintainExplorer />
          ) : (
            <PlaceholderBody tab={activeTab} />
          )}
        </div>
      </main>

      <StatusBar version={version} versionError={versionError} />
    </div>
  )
}

function CatalogError({ message }: { message: string }) {
  return (
    <div className="mt-8 rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-sm">
      <p className="font-semibold text-destructive">Couldn&apos;t load the catalog</p>
      <p className="mt-1 text-foreground/80">{message}</p>
      <p className="mt-3 text-xs text-muted-foreground">
        This usually means the embedded catalog is malformed or the kernel
        version is out of sync. Try reinstalling the app.
      </p>
    </div>
  )
}

function TitleBar() {
  return (
    <div className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold tracking-tight">Blueprint</h2>
        <p className="text-xs text-muted-foreground">
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
      className="flex gap-1 border-b border-border bg-card px-4"
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
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
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
    <div className="mt-8 rounded-2xl border border-dashed border-border bg-card p-10">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Coming in Phase {phaseFor(tab.id)}
      </p>
      <p className="mt-2 text-base font-semibold tracking-tight">
        {tab.label} tab is a scaffold today.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Phase {phaseFor(tab.id)} ships the actual {tab.label.toLowerCase()} surface —
        see the project roadmap for details.
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
    <footer className="flex items-center justify-between border-t border-border bg-card px-6 py-2 font-mono text-[11px] text-muted-foreground">
      {versionError ? (
        <span className="text-destructive">Kernel error: {versionError}</span>
      ) : version ? (
        <span>
          Blueprint <b className="text-foreground">v{version.app}</b>
          <span className="mx-2 opacity-40">·</span>
          <b className="text-foreground">{version.modelCount}</b> models
          <span className="mx-2 opacity-40">·</span>
          catalog as of <b className="text-foreground">{version.catalogAsOf}</b>
        </span>
      ) : (
        <span>Loading…</span>
      )}
      <span className="opacity-70">127.0.0.1 · no telemetry</span>
    </footer>
  )
}
