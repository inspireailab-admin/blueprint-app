// Cost models for the Inspire Blueprint Step 2: on-prem one-time + monthly power,
// cloud monthly (on-demand / reserved / spot), and self-host-vs-API break-even.
// All curated estimates; surface the `asOf` date in the UI.

import type {
  CloudCostBreakdown,
  CloudInstance,
  CloudPricingTier,
  CloudProvider,
  GpuConfig,
  OnPremCostBreakdown,
  Tier,
  Usage,
  BreakEven,
} from './types'
import { getGpu, providers } from './hardware-catalog'

export const USAGE_HOURS_PER_MONTH: Record<Usage, number> = {
  '24x7': 730,
  'business-hours': 200, // ~10 hr/day × 20 working days
  spiky: 80, // ~4 hr/day × 20 working days
}

const DEFAULT_KWH_RATE_USD = 0.15

/** Frontier-API token cost (USD per million output tokens), spec §0 estimates. */
export const FRONTIER_API_PER_M_TOKENS = 5

/** Assumed token shape per request for the break-even calculation. */
export const REQUEST_TOKEN_PROFILE = {
  inputTokens: 1000,
  outputTokens: 500,
}

// ─── On-prem ────────────────────────────────────────────────────────────────

export function onPremCost({
  config,
  kwhRate = DEFAULT_KWH_RATE_USD,
  amortizeMonths = 24,
  hoursPerMonth = 730,
  chassisOverheadFraction = 0.3,
}: {
  config: GpuConfig
  kwhRate?: number
  amortizeMonths?: number
  hoursPerMonth?: number
  chassisOverheadFraction?: number
}): OnPremCostBreakdown {
  const gpuOnly = config.gpu.approxStreetPriceUSD * config.count
  // Chassis + motherboard + PSU + RAM + storage estimate as a fraction of GPU cost
  const hardwareOneTime = Math.round(gpuOnly * (1 + chassisOverheadFraction))
  const kw = (config.gpu.powerWatts * config.count) / 1000
  const monthlyPower = round(kw * hoursPerMonth * kwhRate)
  const amortizedMonthly = round(hardwareOneTime / amortizeMonths)
  return {
    hardwareOneTime,
    kw: round(kw),
    monthlyPower,
    amortizedMonthly,
    effectiveMonthly: round(amortizedMonthly + monthlyPower),
  }
}

// ─── Cloud ──────────────────────────────────────────────────────────────────

/** Among the catalog, find the cheapest instance whose total VRAM ≥ requiredGB. */
export function pickCloudInstance(
  requiredGB: number,
  providerId: string,
): { provider: CloudProvider; instance: CloudInstance } | null {
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) return null
  const candidates = provider.instances.filter((inst) => {
    const gpu = getGpu(inst.gpuId)
    if (!gpu) return false
    return gpu.vramGB * inst.gpuCount >= requiredGB
  })
  if (!candidates.length) return null
  const cheapest = [...candidates].sort((a, b) => a.onDemandPerHr - b.onDemandPerHr)[0]
  return { provider, instance: cheapest }
}

export function cloudCost({
  instance,
  provider,
  region,
  pricingTier,
  usage,
  storageMonthly = 40,
}: {
  instance: CloudInstance
  provider: CloudProvider
  region: string
  pricingTier: CloudPricingTier
  usage: Usage
  storageMonthly?: number
}): CloudCostBreakdown {
  const hoursPerMonth = USAGE_HOURS_PER_MONTH[usage]
  const hourlyRate =
    pricingTier === 'reserved'
      ? instance.reservedPerHr
      : pricingTier === 'spot'
        ? instance.spotPerHr
        : instance.onDemandPerHr
  const computeMonthly = round(hourlyRate * hoursPerMonth)
  return {
    instance,
    provider,
    region,
    pricingTier,
    hoursPerMonth,
    computeMonthly,
    storageMonthly,
    totalMonthly: round(computeMonthly + storageMonthly),
  }
}

// ─── Break-even (self-host vs API) ──────────────────────────────────────────

/**
 * At a given request volume, where does self-hosting (cloud reserved) beat the frontier API?
 * Uses the recommended tier as the self-host reference and a fixed token profile per request.
 */
export function selfHostVsApiBreakEven({
  recommendedTier,
  requestsPerDay,
  apiPerMTokens = FRONTIER_API_PER_M_TOKENS,
  tokenProfile = REQUEST_TOKEN_PROFILE,
}: {
  recommendedTier: Tier
  requestsPerDay: number
  apiPerMTokens?: number
  tokenProfile?: { inputTokens: number; outputTokens: number }
}): BreakEven {
  const requiredGB = recommendedTier.config.totalVramGB
  // Default sourcing for self-host comparison: cheapest cloud reserved instance that fits
  const candidates: { hostMonthly: number; provider: string; instance: string }[] = []
  for (const p of providers) {
    const match = pickCloudInstance(requiredGB, p.id)
    if (!match) continue
    const cost = cloudCost({
      instance: match.instance,
      provider: match.provider,
      region: match.provider.regions[0],
      pricingTier: 'reserved',
      usage: '24x7',
    })
    candidates.push({
      hostMonthly: cost.totalMonthly,
      provider: p.name,
      instance: match.instance.instanceType,
    })
  }
  candidates.sort((a, b) => a.hostMonthly - b.hostMonthly)
  const selfHostMonthly = candidates[0]?.hostMonthly ?? 0
  const selfHostProvider = candidates[0]?.provider ?? 'a cloud GPU'

  // Frontier APIs charge input < output; approximate input as half the output rate.
  const apiCostPerRequest =
    (tokenProfile.inputTokens * (apiPerMTokens / 2) + tokenProfile.outputTokens * apiPerMTokens) /
    1_000_000

  const apiMonthly = round(requestsPerDay * 30 * apiCostPerRequest)
  const breakEvenRequestsPerDay = Math.ceil(selfHostMonthly / (apiCostPerRequest * 30))

  const reason =
    apiMonthly >= selfHostMonthly
      ? `Self-hosting on ${selfHostProvider} reserved costs ~$${selfHostMonthly.toLocaleString()}/mo. At ${requestsPerDay.toLocaleString()} req/day the API costs ~$${apiMonthly.toLocaleString()}/mo — self-host wins.`
      : `Self-hosting on ${selfHostProvider} reserved costs ~$${selfHostMonthly.toLocaleString()}/mo. At ${requestsPerDay.toLocaleString()} req/day the API costs ~$${apiMonthly.toLocaleString()}/mo — keep the API until volume passes ~${breakEvenRequestsPerDay.toLocaleString()} req/day.`

  return {
    apiMonthly,
    selfHostMonthly,
    breakEvenRequestsPerDay,
    reason,
  }
}

function round(n: number): number {
  return Math.round(n)
}
