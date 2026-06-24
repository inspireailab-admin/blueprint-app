// Plan tab — same three-column shape as the marketing site's /plan page,
// minus the URL state. Catalog + planner state are owned by App so that
// switching tabs doesn't lose the user's filter / selection.

import { useMemo, useState } from 'react'
import { familiesIn, findModel } from './catalog'
import { rankAll } from './rank'
import type { Model } from './types'
import type { PlannerStore } from './state'
import { FilterPanel } from './FilterPanel'
import { ResultsList } from './ResultsList'
import { DetailPane } from './DetailPane'
import { HelpMeChoose } from './HelpMeChoose'

type Props = {
  models: Model[] | null
  planner: PlannerStore
  onContinueToHardware: () => void
}

export function PlanExplorer({ models, planner, onContinueToHardware }: Props) {
  const [helpOpen, setHelpOpen] = useState(false)

  const ranked = useMemo(
    () => (models ? rankAll(planner.requirements, models) : []),
    [planner.requirements, models],
  )
  const families = useMemo(() => (models ? familiesIn(models) : []), [models])
  const selectedModel = useMemo(
    () => findModel(models ?? [], planner.selectedModelId),
    [models, planner.selectedModelId],
  )

  if (!models) {
    return <LoadingSkeleton />
  }

  return (
    <>
      <div className="mt-8 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
        <FilterPanel
          requirements={planner.requirements}
          families={families}
          onUpdate={planner.update}
          onOpenHelp={() => setHelpOpen(true)}
          onReset={planner.reset}
        />

        <ResultsList
          ranked={ranked}
          selectedId={planner.selectedModelId}
          requirements={planner.requirements}
          onSelect={planner.selectModel}
        />

        <DetailPane
          selectedModel={selectedModel}
          requirements={planner.requirements}
          onContinue={onContinueToHardware}
        />
      </div>

      <HelpMeChoose
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        onApply={planner.update}
      />
    </>
  )
}

function LoadingSkeleton() {
  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
      <div className="h-[420px] rounded-2xl border border-border bg-muted/30" />
      <div className="h-[420px] rounded-2xl border border-border bg-muted/30" />
      <div className="h-[260px] rounded-2xl border border-border bg-muted/30" />
    </div>
  )
}
