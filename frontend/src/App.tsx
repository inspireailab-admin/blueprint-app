import { useEffect, useState } from 'react'
import { InstalledModels, Version } from '../wailsjs/go/main/App'
import type { main } from '../wailsjs/go/models'
import { loadCatalog, findModel } from './planner/catalog'
import { usePlannerState } from './planner/state'
import type { Model } from './planner/types'
import { PlanExplorer } from './planner/PlanExplorer'
import { HardwareExplorer } from './hardware/HardwareExplorer'
import { DashboardExplorer } from './dashboard/DashboardExplorer'
import { StartOverlay } from './start/StartOverlay'
import { LicenseGate } from './license/LicenseGate'
import type { ServeConfig } from './optimize/OptimizeExplorer'
import { DeployExplorer } from './deploy/DeployExplorer'
import { AboutDialog } from './AboutDialog'
import { smallestQuant } from './planner/vram'

// Top-level navigation is just the Dashboard. Plan / Hardware / Deploy
// are a wizard (one journey, not three peer tabs), and Calibrate +
// Maintain live as sub-tabs INSIDE the Dashboard, not at the top.
//
// The "+ Add new LLM" button in the title bar opens the wizard; the
// Dashboard is the home and the user lives there.

type WizardStep = 'plan' | 'hardware' | 'deploy'

export function App() {
  // Start overlay shows on every launch as a full-screen welcome.
  const [showStart, setShowStart] = useState(true)

  // null = on the Dashboard, otherwise the wizard is open at this step.
  const [wizard, setWizard] = useState<WizardStep | null>(null)

  // Which Dashboard sub-tab is showing.
  const [dashTab, setDashTab] = useState<DashboardTabId>('overview')

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
      // First-launch: no model on disk → open the wizard at step 1.
      if (!installed || installed.length === 0) {
        setWizard('plan')
      }
    } catch {
      setWizard('plan')
    }
    setShowStart(false)
  }

  function closeWizard() {
    setWizard(null)
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {showStart && <StartOverlay onDismiss={() => void dismissStart()} />}
      <LicenseGate />
      <TitleBar
        version={version}
        wizardActive={wizard !== null}
        onAddLLM={() => setWizard('plan')}
        onCloseWizard={closeWizard}
        onGoToMaintain={() => {
          setWizard(null)
          setDashTab('maintain')
        }}
      />

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto">
          <div className="px-6 py-5 selectable">
            {catalogError ? (
              <CatalogError message={catalogError} />
            ) : wizard !== null ? (
              <WizardSurface
                step={wizard}
                models={models}
                selectedModel={selectedModel}
                planner={planner}
                catalogAsOf={catalogAsOf}
                serveConfig={serveConfig}
                onSetStep={setWizard}
                onClose={closeWizard}
              />
            ) : (
              <DashboardSurface
                active={dashTab}
                onSelect={setDashTab}
                serveConfig={serveConfig}
                onSelectModel={planner.selectModel}
                onAddLLM={() => setWizard('plan')}
              />
            )}
          </div>
        </main>
      </div>

      <StatusBar version={version} versionError={versionError} />
    </div>
  )
}

// ─── Wizard surface ────────────────────────────────────────────────

function WizardSurface({
  step,
  models,
  selectedModel,
  planner,
  catalogAsOf,
  serveConfig,
  onSetStep,
  onClose,
}: {
  step: WizardStep
  models: Model[] | null
  selectedModel: Model | null
  planner: ReturnType<typeof usePlannerState>
  catalogAsOf: string
  serveConfig: ServeConfig
  onSetStep: (s: WizardStep) => void
  onClose: () => void
}) {
  const steps: { id: WizardStep; label: string }[] = [
    { id: 'plan', label: '1. Plan' },
    { id: 'hardware', label: '2. Hardware' },
    { id: 'deploy', label: '3. Deploy' },
  ]
  return (
    <div>
      <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          {steps.map((s, i) => {
            const isActive = s.id === step
            return (
              <div key={s.id} className="flex items-center gap-2">
                {i > 0 && <span aria-hidden className="text-muted-foreground">›</span>}
                <button
                  type="button"
                  onClick={() => onSetStep(s.id)}
                  className={[
                    'rounded px-2 py-1 text-sm font-medium transition',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  {s.label}
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          ✕ Cancel
        </button>
      </div>

      {step === 'plan' && (
        <PlanExplorer
          models={models}
          planner={planner}
          onContinueToHardware={() => onSetStep('hardware')}
        />
      )}
      {step === 'hardware' && (
        <HardwareExplorer
          selectedModel={selectedModel}
          requirements={planner.requirements}
          catalogAsOf={catalogAsOf}
          onUpdate={planner.update}
          onBackToPlan={() => onSetStep('plan')}
          onContinueToDeploy={() => onSetStep('deploy')}
        />
      )}
      {step === 'deploy' && (
        <DeployExplorer
          selectedModel={selectedModel}
          serveConfig={serveConfig}
          onBackToOptimize={onClose}
        />
      )}
    </div>
  )
}

// ─── Dashboard surface ─────────────────────────────────────────────

type DashboardTabId = 'overview' | 'inference' | 'models' | 'calibrate' | 'maintain'

const DASH_TABS: { id: DashboardTabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'inference', label: 'Inference' },
  { id: 'models', label: 'Models' },
  { id: 'calibrate', label: 'Calibrate' },
  { id: 'maintain', label: 'Maintain' },
]

function DashboardSurface({
  active,
  onSelect,
  serveConfig,
  onSelectModel,
  onAddLLM,
}: {
  active: DashboardTabId
  onSelect: (id: DashboardTabId) => void
  serveConfig: ServeConfig
  onSelectModel: (modelId: string) => void
  onAddLLM: () => void
}) {
  return (
    <div>
      <nav
        role="tablist"
        aria-label="Dashboard"
        className="-mx-2 mb-4 flex gap-1 border-b border-border"
      >
        {DASH_TABS.map((tab) => {
          const isActive = tab.id === active
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={isActive}
              onClick={() => onSelect(tab.id)}
              className={[
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
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

      <DashboardExplorer
        section={active}
        serveConfig={serveConfig}
        onSelectModel={onSelectModel}
        onAddLLM={onAddLLM}
      />
    </div>
  )
}

// ─── Chrome ────────────────────────────────────────────────────────

function CatalogError({ message }: { message: string }) {
  return (
    <div className="mt-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
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
  wizardActive,
  onAddLLM,
  onCloseWizard,
  onGoToMaintain,
}: {
  version: main.VersionInfo | null
  wizardActive: boolean
  onAddLLM: () => void
  onCloseWizard: () => void
  onGoToMaintain: () => void
}) {
  const [aboutOpen, setAboutOpen] = useState(false)
  return (
    <>
      <div className="flex items-center justify-between border-b border-border bg-card px-5 py-2.5">
        <div className="flex items-center gap-2.5">
          <BlueprintMark />
          <h2 className="text-base font-semibold tracking-tight">Blueprint</h2>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Run open LLMs on your own hardware.
          </span>
        </div>
        <div className="flex items-center gap-2">
          {wizardActive ? (
            <button
              type="button"
              onClick={onCloseWizard}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
            >
              ← Back to Dashboard
            </button>
          ) : (
            <button
              type="button"
              onClick={onAddLLM}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              + Add new LLM
            </button>
          )}
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            About
          </button>
        </div>
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

function BlueprintMark() {
  return (
    <svg
      viewBox="0 0 48 48"
      className="h-6 w-6 text-primary"
      fill="none"
      aria-hidden
    >
      <circle cx="24" cy="24" r="22" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="24" cy="24" r="5" fill="currentColor" />
      <line x1="24" y1="0" x2="24" y2="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="24" y1="38" x2="24" y2="48" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="0" y1="24" x2="10" y2="24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="38" y1="24" x2="48" y2="24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function StatusBar({
  version,
  versionError,
}: {
  version: main.VersionInfo | null
  versionError: string | null
}) {
  return (
    <footer className="flex items-center justify-between border-t border-border bg-card px-5 py-1.5 font-mono text-[11px] text-muted-foreground">
      {versionError ? (
        <span className="text-destructive">Kernel error: {versionError}</span>
      ) : version ? (
        <span>
          Blueprint <b className="text-foreground">v{version.app}</b>
          <span className="mx-2 opacity-40">·</span>
          <b className="text-foreground">{version.modelCount}</b> models
          <span className="mx-2 opacity-40">·</span>
          catalog <b className="text-foreground">{version.catalogAsOf}</b>
        </span>
      ) : (
        <span>Loading…</span>
      )}
      <span className="opacity-70">127.0.0.1 · no telemetry</span>
    </footer>
  )
}
