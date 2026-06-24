// Pure ranking — given a model and the user's requirements, returns
// a deterministic fit score (0–100) plus a plain-English reason.
// Tested in rank.test.ts. The UI sorts by score descending and shows
// the reason on each result row.

import type { Model, Requirements, FitVerdict, RankedModel, SizeRange } from './types'
import { computeVram, smallestQuant } from './vram'

/** Map license id → human-readable summary used in fit reasons + chip text. */
export const LICENSE_LABEL: Record<string, string> = {
  'apache-2.0': 'Apache 2.0',
  mit: 'MIT',
  'llama-3.1-community': 'Llama 3.1 Community',
  'llama-3.2-community': 'Llama 3.2 Community',
  'llama-3.3-community': 'Llama 3.3 Community',
  'llama-4-community': 'Llama 4 Community',
  'gemma-terms': 'Gemma Terms',
  'tongyi-qianwen': 'Tongyi Qianwen',
  'deepseek-license': 'DeepSeek License',
  'qwen-license': 'Qwen License',
}

const NON_COMMERCIAL_LICENSES = new Set([
  'tongyi-qianwen',
])

const SIZE_RANGE_BOUNDS: Record<SizeRange, [number, number]> = {
  'lt-4b': [0, 4],
  '4b-14b': [4, 14],
  '14b-32b': [14, 32],
  '32b-70b': [32, 70],
  'gt-70b': [70, Infinity],
}

export function inSizeRange(paramsB: number, range: SizeRange): boolean {
  const [lo, hi] = SIZE_RANGE_BOUNDS[range]
  return paramsB >= lo && paramsB < hi
}

/** Score a single model against the user's requirements. */
export function score(model: Model, req: Requirements): FitVerdict {
  const excluded: string[] = []

  // ─── Hard filters ─────────────────────────────────────────────────────────
  if (req.types.length > 0 && !req.types.includes(model.type)) {
    excluded.push(`wrong type (${model.type})`)
  }
  if (req.commercialOk && NON_COMMERCIAL_LICENSES.has(model.license)) {
    excluded.push(`license isn't commercial (${LICENSE_LABEL[model.license] ?? model.license})`)
  }
  if (req.notGated && model.gated) {
    excluded.push('gated (HF approval required)')
  }
  if (req.context > model.maxContext) {
    excluded.push(`context exceeds max (${formatTokens(model.maxContext)})`)
  }
  if (req.needStructuredOutput && !model.capabilities?.structuredOutput) {
    excluded.push('no proven structured output')
  }
  if (req.needMultilingual && !model.capabilities?.multilingual) {
    excluded.push('not multilingual')
  }
  if (req.sizeRanges && req.sizeRanges.length > 0) {
    const ok = req.sizeRanges.some((r) => inSizeRange(model.params, r))
    if (!ok) excluded.push('outside selected size range')
  }

  if (excluded.length) {
    return { score: 0, reason: excluded.join(' · '), excludedBy: excluded }
  }

  // ─── Soft scoring ────────────────────────────────────────────────────────
  let s = 50
  const positives: string[] = []

  // Context fit: bigger bonus for substantial headroom
  const ctxHeadroom = model.maxContext / Math.max(req.context, 1)
  if (ctxHeadroom >= 4) {
    s += 12
    positives.push('long-context headroom')
  } else if (ctxHeadroom >= 2) {
    s += 8
    positives.push('handles your context comfortably')
  } else if (ctxHeadroom >= 1.25) {
    s += 4
  }

  // Capability boosts
  if (model.capabilities?.structuredOutput) s += 4
  if (model.capabilities?.multilingual) s += 2
  if (model.capabilities?.longContextProven && req.context >= 32_000) {
    s += 6
    positives.push('proven at long context')
  }

  // License preference: Apache/MIT > others
  if (model.license === 'apache-2.0' || model.license === 'mit') {
    s += 8
    positives.push(`${LICENSE_LABEL[model.license]} license`)
  } else if (req.commercialOk && !NON_COMMERCIAL_LICENSES.has(model.license)) {
    s += 3
  }

  // Family preference
  if (req.preferFamily && model.family.toLowerCase() === req.preferFamily.toLowerCase()) {
    s += 10
    positives.push(`prefers ${model.family}`)
  }

  // Size shape: favor mid-range models for typical workloads; penalize giants
  // unless the user explicitly opted into them
  if (req.sizeRanges && req.sizeRanges.length > 0) {
    // user opted into specific size buckets — no penalty
  } else {
    if (model.params >= 70) s -= 6 // big models are costly to host
    else if (model.params <= 4) s -= 2 // tiny models often underperform on complex tasks
  }

  // VRAM pressure: how much VRAM the model needs at the smallest quant available
  const sizingQuant = req.weightQuant ?? smallestQuant(model)
  const v = computeVram({
    model,
    weightQuant: sizingQuant,
    contextLength: req.context,
    concurrency: req.concurrency,
    kvElement: req.kvElement ?? 'fp16',
  })
  // Penalty for huge VRAM footprint (>160 GB needs multi-GPU); reward
  // configurations that fit on a single 80 GB card
  if (v.totalGB > 160) {
    s -= 8
    positives.push('multi-GPU at this workload')
  } else if (v.totalGB <= 80) {
    s += 4
  }

  // Popularity tail-breaker
  if (model.popularityRank) {
    s += Math.max(0, 6 - model.popularityRank * 0.3)
  }

  // Clamp + build reason
  const finalScore = Math.max(0, Math.min(100, Math.round(s)))
  const reason = positives.length
    ? positives.slice(0, 2).join(' · ')
    : `fits your spec at ${sizingQuant.toUpperCase()}`

  return { score: finalScore, reason }
}

/**
 * Rank every model against the requirements. Takes the model list as
 * a parameter (rather than importing a static one) so the desktop app
 * can feed in the catalog it received over Wails IPC.
 */
export function rankAll(req: Requirements, models: Model[]): RankedModel[] {
  return models
    .map((model) => ({ model, verdict: score(model, req) }))
    .sort((a, b) => {
      // included before excluded; then by score desc; then popularity asc
      const aOk = !a.verdict.excludedBy
      const bOk = !b.verdict.excludedBy
      if (aOk !== bOk) return aOk ? -1 : 1
      if (b.verdict.score !== a.verdict.score) return b.verdict.score - a.verdict.score
      return (a.model.popularityRank ?? 99) - (b.model.popularityRank ?? 99)
    })
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_048_576)}M`
  if (n >= 1_000) return `${Math.round(n / 1024)}K`
  return `${n}`
}
