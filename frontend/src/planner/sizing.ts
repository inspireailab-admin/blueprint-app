// Tier sizing — given a workload's VRAM requirement, pick three GPU configurations
// (minimum / recommended / high-end). Pure TS, deterministic, tested.

import type { Gpu, GpuConfig, SlaTarget, Tier, TierLabel, Model, Quant } from './types'
import { gpus, getGpu } from './hardware-catalog'
import { computeVram } from './vram'

const GB = 1024 ** 3

/** Multi-GPU multipliers we'll consider. 1 = single, larger = scale-out. */
const GPU_COUNT_OPTIONS = [1, 2, 4, 8] as const

/** Headroom thresholds per tier (model+KV must fit within this fraction of total VRAM). */
const HEADROOM: Record<TierLabel, number> = {
  minimum: 0.92,
  recommended: 0.65,
  'high-end': 0.45,
}

/** Build every reasonable GPU configuration (single + multi) sorted by total VRAM ascending. */
function allConfigs(): GpuConfig[] {
  const configs: GpuConfig[] = []
  for (const gpu of gpus) {
    for (const count of GPU_COUNT_OPTIONS) {
      // Don't multi-GPU consumer cards in our sizing — they're rare and add config complexity
      if (gpu.tier === 'consumer' && count > 1) continue
      // 1× workstation cards are fine but not commonly multi-GPU
      if (gpu.tier === 'workstation' && count > 2) continue
      configs.push({
        gpu,
        count,
        totalVramGB: gpu.vramGB * count,
        headroomGB: 0, // filled in once the workload is known
      })
    }
  }
  return configs.sort((a, b) => a.totalVramGB - b.totalVramGB)
}

const ALL_CONFIGS = allConfigs()

export type SizingInput = {
  model: Model
  weightQuant: Quant
  contextLength: number
  concurrency: number
  ttftMs: number
  kvElement?: 'fp16' | 'fp8' | 'int8'
}

/**
 * Pick three tiered GPU configurations for a workload.
 * Tries single-GPU configs first; falls back to multi-GPU when single isn't big enough.
 */
export function pickTiers(input: SizingInput): { tiers: Tier[]; totalVramGB: number } {
  const v = computeVram({
    model: input.model,
    weightQuant: input.weightQuant,
    kvElement: input.kvElement ?? 'fp16',
    contextLength: input.contextLength,
    concurrency: input.concurrency,
  })
  const totalVramGB = v.totalGB

  const sla: SlaTarget = { ttftMs: input.ttftMs, concurrency: input.concurrency }

  const findConfig = (label: TierLabel): GpuConfig | null => {
    const fitFrac = HEADROOM[label]
    const cfg = ALL_CONFIGS.find((c) => totalVramGB <= c.totalVramGB * fitFrac)
    if (!cfg) return null
    return { ...cfg, headroomGB: round1(cfg.totalVramGB - totalVramGB) }
  }

  // Minimum: smallest config that just fits
  const minConfig =
    findConfig('minimum') ??
    // If nothing fits at 92% headroom, fall back to the largest config available
    ALL_CONFIGS[ALL_CONFIGS.length - 1]

  // Recommended: smallest config with 35% headroom; if it equals minimum, bump up
  let recConfig = findConfig('recommended')
  if (!recConfig || recConfig.totalVramGB <= minConfig.totalVramGB) {
    // Step up to the next larger config
    const next = ALL_CONFIGS.find((c) => c.totalVramGB > minConfig.totalVramGB)
    if (next) recConfig = { ...next, headroomGB: round1(next.totalVramGB - totalVramGB) }
  }
  if (!recConfig) recConfig = minConfig

  // High-end: 45% headroom OR multi-GPU equivalent of recommended
  let highConfig = findConfig('high-end')
  if (!highConfig || highConfig.totalVramGB <= recConfig.totalVramGB) {
    const next = ALL_CONFIGS.find((c) => c.totalVramGB > recConfig!.totalVramGB)
    if (next) highConfig = { ...next, headroomGB: round1(next.totalVramGB - totalVramGB) }
  }
  if (!highConfig) highConfig = recConfig

  return {
    totalVramGB,
    tiers: [
      buildTier('minimum', minConfig, input, sla, totalVramGB),
      buildTier('recommended', recConfig, input, sla, totalVramGB),
      buildTier('high-end', highConfig, input, sla, totalVramGB),
    ],
  }
}

function buildTier(
  label: TierLabel,
  config: GpuConfig,
  input: SizingInput,
  sla: SlaTarget,
  totalVramGB: number,
): Tier {
  const expectedTtftMs = estimateTtftMs(config.gpu, input.model, input.weightQuant, input.contextLength)
  const supportedConcurrency = estimateConcurrency(config, input, totalVramGB)

  const systemRamGB = recommendedSystemRam(config)
  const cpuCores = recommendedCpuCores(label, config)
  const diskGB = recommendedDisk(label)

  return {
    label,
    config,
    systemRamGB,
    cpuCores,
    diskGB,
    expectedTtftMs,
    supportedConcurrency,
    note: noteForTier(label, config, sla, expectedTtftMs, supportedConcurrency),
  }
}

// ─── Heuristics ─────────────────────────────────────────────────────────────

/** Per-GPU TTFT baseline at 14B Q4 / 32K context. Real numbers vary; treat as estimates. */
const TTFT_BASE_MS: Record<string, number> = {
  'ada-consumer': 240,
  'blackwell-consumer': 180,
  'ampere-workstation': 200,
  'ada-datacenter': 180,
  'ampere-datacenter': 90,
  'hopper-datacenter': 60,
}

function estimateTtftMs(gpu: Gpu, model: Model, quant: Quant, ctx: number): number {
  const base = TTFT_BASE_MS[gpu.computeClass] ?? 200
  // Scale up linearly with active params past 14B; less for smaller models
  const paramFactor = Math.max(0.5, model.params / 14)
  // Long context adds TTFT (prefill scales with input length)
  const ctxFactor = ctx >= 65_536 ? 1.4 : ctx >= 16_384 ? 1.1 : 1.0
  // FP16 weights take longer than Q4
  const quantFactor = quant === 'fp16' || quant === 'bf16' ? 1.3 : 1.0
  return Math.round(base * paramFactor * ctxFactor * quantFactor)
}

function estimateConcurrency(
  config: GpuConfig,
  input: SizingInput,
  totalVramGB: number,
): number {
  // How much VRAM is free for additional KV cache beyond the requested concurrency
  const freeGB = config.totalVramGB - totalVramGB
  if (freeGB <= 0) return input.concurrency
  // Approximate additional concurrent capacity at the current context
  const v = computeVram({
    model: input.model,
    weightQuant: input.weightQuant,
    kvElement: input.kvElement ?? 'fp16',
    contextLength: input.contextLength,
    concurrency: 1,
  })
  const kvPerUserGB = v.kvCacheGB
  if (kvPerUserGB <= 0) return input.concurrency
  const extraUsers = Math.floor(freeGB / kvPerUserGB)
  return input.concurrency + extraUsers
}

function recommendedSystemRam(config: GpuConfig): number {
  // Rough: 2× total VRAM, rounded to common sizes
  const target = config.totalVramGB * 2
  const sizes = [32, 64, 128, 256, 384, 512, 1024, 2048]
  return sizes.find((s) => s >= target) ?? Math.ceil(target / 256) * 256
}

function recommendedCpuCores(label: TierLabel, config: GpuConfig): number {
  if (label === 'minimum') return 8
  if (label === 'recommended') return config.count * 12
  return config.count * 16
}

function recommendedDisk(label: TierLabel): number {
  return label === 'minimum' ? 100 : label === 'recommended' ? 200 : 500
}

function noteForTier(
  label: TierLabel,
  _config: GpuConfig,
  sla: SlaTarget,
  ttftMs: number,
  concurrency: number,
): string {
  const meetsTtft = ttftMs <= sla.ttftMs
  const meetsConcurrency = concurrency >= sla.concurrency
  if (label === 'minimum') {
    if (!meetsTtft) return 'Fits the model but TTFT may miss your target.'
    if (!meetsConcurrency) return 'Tight on KV cache at peak concurrency.'
    return 'Just fits — limited headroom for growth.'
  }
  if (label === 'recommended') {
    return 'Meets your SLA with comfortable headroom.'
  }
  return 'Absorbs peak load, larger context, or a failover replica.'
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// Re-export for convenience in components
export { getGpu, gpus }
export { GB }
