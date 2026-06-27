// Plan tab — same three-column shape as the marketing site's /plan page,
// minus the URL state. Catalog + planner state are owned by App so that
// switching tabs doesn't lose the user's filter / selection.

import { useEffect, useMemo, useState } from 'react'
import { familiesIn, findModel } from './catalog'
import { rankAll } from './rank'
import type { Model } from './types'
import type { PlannerStore } from './state'
import { FilterPanel } from './FilterPanel'
import { ResultsList } from './ResultsList'
import { DetailPane } from './DetailPane'
import { HelpMeChoose } from './HelpMeChoose'
import { Snapshot } from '../../wailsjs/go/main/App'

type Props = {
  models: Model[] | null
  planner: PlannerStore
  onContinueToHardware: () => void
}

export function PlanExplorer({ models, planner, onContinueToHardware }: Props) {
  const [helpOpen, setHelpOpen] = useState(false)
  // Total VRAM across detected GPUs (in GB). Used by ResultsList to
  // render a per-model "fits / tight / won't fit" badge so a new user
  // can quickly spot a model they can actually run on this machine.
  // null while loading or when no GPU is detected (CPU-only host).
  const [userVramGB, setUserVramGB] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const snap = (await Snapshot()) as { gpus?: { vramTotalMB?: number }[] }
        if (!alive) return
        const totalMB = (snap.gpus ?? []).reduce(
          (sum, g) => sum + (g.vramTotalMB ?? 0),
          0,
        )
        if (totalMB > 0) setUserVramGB(Math.round((totalMB / 1024) * 10) / 10)
      } catch {
        // Snapshot can fail on machines without an svc available; the
        // fit-badge just stays hidden, no harm done.
      }
    })()
    return () => {
      alive = false
    }
  }, [])

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
          userVramGB={userVramGB}
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
