import { useEffect, useState } from 'react'
import { InstalledModels, Version } from '../wailsjs/go/main/App'
import type { main } from '../wailsjs/go/models'
import { loadCatalog, findModel } from './planner/catalog'
import { usePlannerState } from './planner/state'
import type { Model } from './planner/types'
import { PlanExplorer } from './planner/PlanExplorer'
import { HardwareExplorer } from './hardware/HardwareExplorer'
import { CalibrateExplorer } from './calibrate/CalibrateExplorer'
import { DashboardExplorer } from './dashboard/DashboardExplorer'
import { StartOverlay } from './start/StartOverlay'
import type { ServeConfig } from './optimize/OptimizeExplorer'
import { DeployExplorer } from './deploy/DeployExplorer'
import { MaintainExplorer } from './maintain/MaintainExplorer'
import { AboutDialog } from './AboutDialog'
import { smallestQuant } from './planner/vram'

// Navigable views. `dashboard` is the operational home — Start is not in
// here because it's a one-time-per-launch overlay, not a navigable view.
//
// "optimize" is gone — quant, ctx size, GPU layers, and the advanced
// runtime flags all live in the Dashboard's ServiceCard now. Plan +
// Hardware are still here for the catalog browse + sizing math; once
// the user has picked a model and pulled it via the installer, they
// live entirely in the Dashboard.
// Two groups of tabs, separated visually:
//
//   Setup wizard (linear): Plan -> Hardware -> Deploy
//   Operational (peer):    Dashboard, Calibrate, Maintain
//
// Monitor is gone — its content (CPU / RAM / VRAM tiles, sparklines,
// GPU breakdown) all lives in the Dashboard now. After the user
// finishes the Deploy wizard the operational life of the app is
// Dashboard-centric.
type TabId = 'dashboard' | 'plan' | 'hardware' | 'deploy' | 'calibrate' | 'maintain'

const TABS: { id: TabId; label: string; description: string }[] = [
  { id: 'dashboard', label: 'Dashboard', description: 'Live status. Tune sampling and server config from here.' },
  { id: 'plan', label: 'Plan', description: 'Pick a model that fits your workload.' },
  { id: 'hardware', label: 'Hardware', description: 'Size the hardware. Three configurations, no pricing.' },
  { id: 'deploy', label: 'Deploy', description: 'Install runtime, pull the model, start serving, verify.' },
  { id: 'calibrate', label: 'Calibrate', description: 'Custom imatrix calibration + quantization for a client workload.' },
  { id: 'maintain', label: 'Maintain', description: 'Updates, swap models, restart, logs.' },
]

export function App() {
  // Start overlay shows on every launch as a full-screen welcome.
  // Clicking OK dismisses it for the session; there's no way back to
  // it from the menu (it isn't a view) — the user is routed to
  // Dashboard if any model is on disk, otherwise to Plan.
  const [showStart, setShowStart] = useState(true)
  const [active, setActive] = useState<TabId>('dashboard')

  const [version, setVersion] = useState<main.VersionInfo | null>(null)
  const [versionError, setVersionError] = useState<string | null>(null)

  const planner = usePlannerState()
  const [models, setModels] = useState<Model[] | null>(null)
  const [catalogAsOf, setCatalogAsOf] = useState<string>('')
  const [catalogError, setCatalogError] = useState<string | null>(null)

  const [serveConfig, setServeConfig] = useState<ServeConfig>({
    quant: 'q4',
    ctxSize: 4096,
    nGpuLayers: 999,
  })

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

  useEffect(() => {
    if (!selectedModel) return
    if (!selectedModel.quantOptions.includes(serveConfig.quant)) {
      setServeConfig((prev) => ({ ...prev, quant: smallestQuant(selectedModel) }))
    }
  }, [selectedModel, serveConfig.quant])

  async function dismissStart() {
    try {
      const installed = await InstalledModels()
      setActive(installed && installed.length > 0 ? 'dashboard' : 'plan')
    } catch {
      setActive('plan')
    }
    setShowStart(false)
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {showStart && <StartOverlay onDismiss={() => void dismissStart()} />}
      <TitleBar version={version} onGoToMaintain={() => setActive('maintain')} />
      <TabBar tabs={TABS} active={active} onSelect={setActive} />

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-8 py-8 selectable">
            <p className="eyebrow">{activeTab.label}</p>
            <h1 className="mt-2 text-balance text-2xl font-semibold tracking-tight">
              {activeTab.description}
            </h1>

            {catalogError ? (
              <CatalogError message={catalogError} />
            ) : active === 'dashboard' ? (
              <DashboardExplorer
                onGoTo={setActive}
                serveConfig={serveConfig}
                onSelectModel={planner.selectModel}
              />
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
                serveConfig={serveConfig}
                onBackToOptimize={() => setActive('dashboard')}
              />
            ) : active === 'calibrate' ? (
              <CalibrateExplorer />
            ) : active === 'maintain' ? (
              <MaintainExplorer />
            ) : (
              <PlaceholderBody tab={activeTab} />
            )}
          </div>
        </main>
      </div>

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

function TitleBar({
  version,
  onGoToMaintain,
}: {
  version: main.VersionInfo | null
  onGoToMaintain: () => void
}) {
  const [aboutOpen, setAboutOpen] = useState(false)
  return (
    <>
      <div className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold tracking-tight">Blueprint</h2>
          <p className="text-xs text-muted-foreground">
            Run open LLMs on your own hardware.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          About
        </button>
      </div>
      {aboutOpen && (
        <AboutDialog
          version={version}
          onClose={() => setAboutOpen(false)}
          onGoToMaintain={onGoToMaintain}
        />
      )}
    </>
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
    case 'dashboard':
      return 1
    case 'plan':
      return 2
    case 'hardware':
      return 3
    case 'deploy':
      return 4
    case 'calibrate':
      return 4.5
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
