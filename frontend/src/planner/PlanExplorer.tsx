// Top-level Plan tab. Loads the catalog from the Wails kernel once on
// mount and feeds it into the three-column explorer (filter panel,
// ranked results, detail pane).
//
// Mirrors the marketing site's PlanExplorer but with two differences:
//   - state is in-memory (no URL sync)
//   - the "continue to Hardware" button calls a tab-switch callback
//     instead of routing

import { useEffect, useMemo, useState } from 'react'
import { familiesIn, findModel, loadCatalog } from './catalog'
import { usePlannerState } from './state'
import { rankAll } from './rank'
import type { Model } from './types'
import { FilterPanel } from './FilterPanel'
import { ResultsList } from './ResultsList'
import { DetailPane } from './DetailPane'
import { HelpMeChoose } from './HelpMeChoose'

type Props = {
  /** Called when the user clicks Continue → Hardware. Lifted to the
   *  App shell so it can switch the active tab. */
  onContinueToHardware: () => void
}

export function PlanExplorer({ onContinueToHardware }: Props) {
  const { requirements, selectedModelId, update, selectModel, reset } = usePlannerState()
  const [helpOpen, setHelpOpen] = useState(false)
  const [models, setModels] = useState<Model[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    loadCatalog()
      .then(({ models }) => setModels(models))
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : String(err)),
      )
  }, [])

  const ranked = useMemo(
    () => (models ? rankAll(requirements, models) : []),
    [requirements, models],
  )
  const families = useMemo(() => (models ? familiesIn(models) : []), [models])
  const selectedModel = useMemo(
    () => findModel(models ?? [], selectedModelId),
    [models, selectedModelId],
  )

  if (loadError) {
    return (
      <div className="mt-8 rounded-xl border border-red-300 bg-red-50 p-6 text-sm text-red-900">
        <p className="font-semibold">Couldn&apos;t load the catalog</p>
        <p className="mt-1 text-red-800">{loadError}</p>
      </div>
    )
  }

  if (!models) {
    return <LoadingSkeleton />
  }

  return (
    <>
      <div className="mt-8 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
        <FilterPanel
          requirements={requirements}
          families={families}
          onUpdate={update}
          onOpenHelp={() => setHelpOpen(true)}
          onReset={reset}
        />

        <ResultsList
          ranked={ranked}
          selectedId={selectedModelId}
          requirements={requirements}
          onSelect={selectModel}
        />

        <DetailPane
          selectedModel={selectedModel}
          requirements={requirements}
          onContinue={onContinueToHardware}
        />
      </div>

      <HelpMeChoose
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        onApply={update}
      />
    </>
  )
}

function LoadingSkeleton() {
  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
      <div className="h-[420px] rounded-2xl border border-border bg-neutral-100" />
      <div className="h-[420px] rounded-2xl border border-border bg-neutral-100" />
      <div className="h-[260px] rounded-2xl border border-border bg-neutral-100" />
    </div>
  )
}
