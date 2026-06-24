// Thin wrapper over the Wails IPC bridge for the kernel catalog. The Plan
// tab calls loadCatalog() once on mount and caches the result in React
// state; everything downstream (rank, filter, detail pane) is pure.
//
// We deliberately re-narrow the Wails-generated `string` types into our
// own literal union types (`ModelType`, `LicenseId`, etc.). The kernel
// keeps the JSON open so future model types don't break the parser, but
// the UI wants type safety on the small set we currently render.

import { Catalog } from '../../wailsjs/go/main/App'
import type { Model } from './types'

export async function loadCatalog(): Promise<{ asOf: string; models: Model[] }> {
  const cat = await Catalog()
  return {
    asOf: cat.asOf,
    // Cast: the Wails generator gives us `type: string` and `license: string`
    // since Go doesn't carry union information. The kernel produces values
    // from the same finite set the UI knows about, so we narrow here.
    models: (cat.models ?? []) as unknown as Model[],
  }
}

/** Distinct family names in catalog declaration order. */
export function familiesIn(models: Model[]): string[] {
  return Array.from(new Set(models.map((m) => m.family)))
}

/** Lookup helper used in the detail pane + state hydration. */
export function findModel(models: Model[], id: string | null): Model | null {
  if (!id) return null
  return models.find((m) => m.id === id) ?? null
}

/** True when the kernel reports this model is install-ready. */
export function isLocallyInstallable(model: Model): boolean {
  return !!model.local?.available
}
