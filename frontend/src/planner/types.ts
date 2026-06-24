// Types for the Inspire Blueprint planner.
// Single source of truth — both the data files (data/*.json) and the UI
// import from here, so the catalog and the components can't drift.

export type Quant = 'fp16' | 'bf16' | 'fp8' | 'q8' | 'q4' | 'q3'
export type KvElement = 'fp16' | 'fp8' | 'int8'

export type ModelType =
  | 'text-generation'
  | 'reasoning'
  | 'code'
  | 'vision-language'
  | 'embedding'
  | 'reranker'
  | 'speech-to-text'
  | 'text-to-speech'

/** A static license identifier — keep short, recognizable on a chip. */
export type LicenseId =
  | 'apache-2.0'
  | 'mit'
  | 'llama-3.1-community'
  | 'llama-3.2-community'
  | 'llama-3.3-community'
  | 'llama-4-community'
  | 'gemma-terms'
  | 'tongyi-qianwen'
  | 'deepseek-license'
  | 'qwen-license'

/** A model in the curated catalog. Each field is what the planner needs to size + rank. */
export type Model = {
  id: string
  displayName: string
  family: string
  /** Active parameter count in billions (matters for MoE; otherwise same as totalParams). */
  params: number
  /** Total parameter count in billions (loaded into VRAM as weights). */
  totalParams: number
  type: ModelType
  license: LicenseId
  /** True if the model card requires acceptance / approval before download (HF gating). */
  gated: boolean
  /** Maximum context length in tokens. */
  maxContext: number
  isMoE: boolean
  /** Quant variants the model has publicly available. */
  quantOptions: Quant[]
  /** Transformer-architecture fields needed for the VRAM math (spec §5). */
  numLayers: number
  numKvHeads: number
  hiddenSize: number
  numAttentionHeads: number
  /** Optional capabilities — used in filters / fit reasons. */
  capabilities?: {
    /** Trustworthy JSON / tool-call output. */
    structuredOutput?: boolean
    multilingual?: boolean
    longContextProven?: boolean
  }
  /** Tail metadata for sorting and the detail pane. */
  popularityRank?: number
  /**
   * Local install metadata for the Blueprint CLI. When `available: true`, the
   * web app can hand the user a "run this locally" path and the CLI knows
   * where to pull GGUF weights from.
   */
  local?: {
    available: boolean
    /** HuggingFace repo containing the GGUF quants (e.g. "bartowski/Phi-4-GGUF"). */
    ggufRepo?: string
    /** Quant variant → file name within the repo. Only include what's actually published. */
    ggufFiles?: Partial<Record<Quant, string>>
  }
}

/** What the user has expressed they want — the source of truth for ranking, filtering, and sizing. */
export type Requirements = {
  /** Active model-type filter (multi-select). */
  types: ModelType[]
  /** Capability filters. */
  needStructuredOutput?: boolean
  needMultilingual?: boolean
  /** Context window the user expects to use. */
  context: number
  /** Number of simultaneous users / requests at peak. */
  concurrency: number
  /** TTFT target in ms (P50, roughly). */
  ttftMs: number
  /** Quant preference for sizing. If unset, the smallest publicly available quant is assumed. */
  weightQuant?: Quant
  /** KV-cache element size for sizing. Defaults to fp16 when unset. */
  kvElement?: KvElement
  /** Hard constraints — exclude non-matching models. */
  commercialOk?: boolean
  onPrem?: boolean
  notGated?: boolean
  noTrustRemoteCode?: boolean
  /** Permitted size ranges (in billions of active params). Empty array = any size. */
  sizeRanges?: SizeRange[]
  /** Family preference, used as a soft signal in ranking. */
  preferFamily?: string
}

export type SizeRange =
  | 'lt-4b'
  | '4b-14b'
  | '14b-32b'
  | '32b-70b'
  | 'gt-70b'

export type FitVerdict = {
  score: number
  /** Plain-English reason shown in the result row and detail pane. */
  reason: string
  /** Hard-block reasons. If present, score is 0 and the model is excluded. */
  excludedBy?: string[]
}

/** Result of running rank() — keeps the model + score together. */
export type RankedModel = {
  model: Model
  verdict: FitVerdict
}

// ─── Hardware & cost ────────────────────────────────────────────────────────

export type GpuTier = 'consumer' | 'workstation' | 'datacenter'

export type Gpu = {
  id: string
  name: string
  vendor: 'NVIDIA' | 'AMD'
  tier: GpuTier
  vramGB: number
  approxStreetPriceUSD: number
  powerWatts: number
  /** Used as a soft proxy for TTFT estimation. */
  computeClass: string
}

export type CloudInstance = {
  instanceType: string
  gpuId: string
  gpuCount: number
  vcpu: number
  ramGB: number
  onDemandPerHr: number
  reservedPerHr: number
  spotPerHr: number
}

export type CloudProvider = {
  id: string
  name: string
  regions: string[]
  instances: CloudInstance[]
}

export type SlaTarget = {
  /** Target tokens-per-second TTFT P50, in ms. */
  ttftMs: number
  /** Concurrent requests at peak. */
  concurrency: number
}

export type TierLabel = 'minimum' | 'recommended' | 'high-end'

/** A specific GPU configuration — how many of which GPU make up this tier. */
export type GpuConfig = {
  gpu: Gpu
  count: number
  /** Total VRAM across the GPUs in this config (GB). */
  totalVramGB: number
  /** Whether the model fits with reasonable headroom (>30% free) at the user's settings. */
  headroomGB: number
}

/** One of the three tiered hardware recommendations. */
export type Tier = {
  label: TierLabel
  config: GpuConfig
  /** Suggested system RAM in GB. */
  systemRamGB: number
  /** Suggested CPU core count. */
  cpuCores: number
  /** Suggested NVMe disk in GB. */
  diskGB: number
  /** Estimated TTFT (P50) for this tier at the user's settings, in ms. */
  expectedTtftMs: number
  /** Max concurrency this tier comfortably supports. */
  supportedConcurrency: number
  /** Short one-line note explaining the trade-off (e.g. "tight, capped context"). */
  note: string
}

export type Usage = '24x7' | 'business-hours' | 'spiky'
export type CloudPricingTier = 'onDemand' | 'reserved' | 'spot'

export type CloudCostBreakdown = {
  instance: CloudInstance
  provider: CloudProvider
  region: string
  pricingTier: CloudPricingTier
  hoursPerMonth: number
  /** Compute spend per month. */
  computeMonthly: number
  /** Storage + minor egress estimate per month. */
  storageMonthly: number
  /** Total monthly cost. */
  totalMonthly: number
}

export type OnPremCostBreakdown = {
  /** One-time hardware spend (GPUs only — chassis is added separately if asked). */
  hardwareOneTime: number
  /** Estimated kW draw at full load. */
  kw: number
  /** Monthly power spend at the given $/kWh. */
  monthlyPower: number
  /** Implicit annualized hardware cost at a given amortization. */
  amortizedMonthly: number
  /** Sum of amortized hardware + monthly power. */
  effectiveMonthly: number
}

export type BreakEven = {
  /** Frontier API cost (~$/mo) for the workload at user-stated volume. */
  apiMonthly: number
  /** Self-host cost (~$/mo) for the chosen tier on cloud reserved pricing. */
  selfHostMonthly: number
  /** Requests-per-day above which self-host is cheaper. */
  breakEvenRequestsPerDay: number
  /** Plain-English summary. */
  reason: string
}
