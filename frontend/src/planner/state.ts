// In-memory planner state for the desktop app. The marketing site has a
// URL-synced version for deep-linkable plans; the desktop app doesn't
// need URL state, so a plain useState-based store keeps things simple.
//
// Same default Requirements as the marketing site so the two surfaces
// behave identically out of the box.

import { useCallback, useState } from 'react'
import type { Requirements } from './types'

export const DEFAULT_REQUIREMENTS: Requirements = {
  types: ['text-generation'],
  context: 32_768,
  concurrency: 5,
  ttftMs: 300,
  kvElement: 'fp16',
  commercialOk: true,
  notGated: false,
  needStructuredOutput: false,
  needMultilingual: false,
  sizeRanges: [],
}

export type PlannerStore = {
  requirements: Requirements
  selectedModelId: string | null
  update: (patch: Partial<Requirements>) => void
  selectModel: (id: string | null) => void
  reset: () => void
}

export function usePlannerState(): PlannerStore {
  const [requirements, setRequirements] = useState<Requirements>(DEFAULT_REQUIREMENTS)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)

  const update = useCallback((patch: Partial<Requirements>) => {
    setRequirements((prev) => ({ ...prev, ...patch }))
  }, [])

  const selectModel = useCallback((id: string | null) => {
    setSelectedModelId(id)
  }, [])

  const reset = useCallback(() => {
    setRequirements(DEFAULT_REQUIREMENTS)
    setSelectedModelId(null)
  }, [])

  return { requirements, selectedModelId, update, selectModel, reset }
}
