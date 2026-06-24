// VRAM sizing math — implements spec §5 of INSPIRE_AI_LAB_BUILD_SPEC.md.
// Pure, deterministic, framework-free. Used by both the planner UI and Phase 4 tiering.

import type { KvElement, Model, Quant } from './types'

/**
 * Approximate bytes per parameter for a given weight quantization.
 * These match the spec; the Q4 figure averages over Q4_K variants
 * (4-4.5 bits/param in practice).
 */
export function bytesPerParam(quant: Quant): number {
  switch (quant) {
    case 'fp16':
    case 'bf16':
      return 2.0
    case 'fp8':
    case 'q8':
      return 1.0
    case 'q4':
      return 0.5
    case 'q3':
      return 0.4
  }
}

/** Bytes per KV-cache element (K and V are stored separately). */
export function bytesPerKvElement(kv: KvElement): number {
  switch (kv) {
    case 'fp16':
      return 2
    case 'fp8':
    case 'int8':
      return 1
  }
}

export type VramBreakdown = {
  /** weights size in bytes. */
  weightsBytes: number
  /** KV cache size in bytes, scaled by context × concurrency. */
  kvCacheBytes: number
  /** Activations + fragmentation + runtime overhead in bytes. */
  overheadBytes: number
  /** Sum of the three. */
  totalBytes: number
  /** KV bytes attributable to a single token of context, for a single request. */
  kvBytesPerToken: number
  /** Per-component GB (rounded to 1 decimal) for display. */
  weightsGB: number
  kvCacheGB: number
  overheadGB: number
  totalGB: number
}

const GB = 1024 ** 3

export type SizingInput = {
  model: Model
  /** Weight quantization the user is sizing for. */
  weightQuant: Quant
  /** KV-cache element size — defaults to fp16 if not provided. */
  kvElement?: KvElement
  /** Context length, in tokens. */
  contextLength: number
  /** Number of concurrent requests / users at peak. */
  concurrency: number
  /** Overhead fraction. Defaults to 0.12 per spec; expose so it's overridable. */
  overheadFraction?: number
}

/**
 * Encoder-only model types have no autoregressive KV cache — they process
 * an input sequence in one pass and emit either an embedding vector (for
 * embedding models) or a relevance score (for rerankers). The VRAM math
 * for these is just weights + overhead; concurrent requests reuse the
 * same forward pass machinery without growing per-context memory.
 */
function isEncoderOnly(type: Model['type']): boolean {
  return type === 'embedding' || type === 'reranker'
}

/** Compute the VRAM breakdown for a model under a given workload. */
export function computeVram({
  model,
  weightQuant,
  kvElement = 'fp16',
  contextLength,
  concurrency,
  overheadFraction = 0.12,
}: SizingInput): VramBreakdown {
  // Weights: count is in BILLIONS of params. Use total params — for MoE,
  // every expert is loaded into VRAM even though only some are active per token.
  const numParams = model.totalParams * 1e9
  const weightsBytes = numParams * bytesPerParam(weightQuant)

  // KV cache: 2 × layers × kv_heads × head_dim × bytes_per_kv_element bytes per token.
  // Encoder-only models (embeddings, rerankers) skip the KV cache term entirely.
  const headDim = model.hiddenSize / model.numAttentionHeads
  const kvBytesPerToken = isEncoderOnly(model.type)
    ? 0
    : 2 * model.numLayers * model.numKvHeads * headDim * bytesPerKvElement(kvElement)
  const kvCacheBytes = kvBytesPerToken * contextLength * concurrency

  const overheadBytes = (weightsBytes + kvCacheBytes) * overheadFraction
  const totalBytes = weightsBytes + kvCacheBytes + overheadBytes

  return {
    weightsBytes,
    kvCacheBytes,
    overheadBytes,
    totalBytes,
    kvBytesPerToken,
    weightsGB: round1(weightsBytes / GB),
    kvCacheGB: round1(kvCacheBytes / GB),
    overheadGB: round1(overheadBytes / GB),
    totalGB: round1(totalBytes / GB),
  }
}

/** Smallest publicly available quant for a model — picks lowest bytes/param. */
export function smallestQuant(model: Model): Quant {
  return [...model.quantOptions].sort(
    (a, b) => bytesPerParam(a) - bytesPerParam(b),
  )[0]
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
