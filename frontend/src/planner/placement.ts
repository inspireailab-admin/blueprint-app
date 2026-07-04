// Placement engine — decides HOW a model would run on a given HardwareProfile,
// and produces a PlacementPlan the UI turns into a fit badge (and, later, the
// actual serve flags). Pure and deterministic so it can be unit-tested and
// reused for local + remote targets. See docs/plan-target-aware-deploy.md §6/§7.
//
// Planning sizes against TOTAL VRAM (assume a mostly-idle GPU); deploy-time
// re-validation against FREE VRAM happens separately.

import type { VramBreakdown } from './vram'
import type { HardwareProfile } from './hardware'

export type PlacementMode =
  | 'single-gpu' //     fits comfortably/tightly on one GPU
  | 'multi-gpu' //      split across several GPUs (aggregate VRAM holds it)
  | 'partial-offload' // weights on GPU, KV/remainder spilled to system RAM
  | 'cpu-only' //       no GPU help; runs on CPU + RAM (slow)
  | 'no-fit' //         doesn't fit anywhere at this quant/context

export type PlacementPlan = {
  mode: PlacementMode
  /** GPU indices used (empty for cpu-only / no-fit). */
  gpuIndices: number[]
  /** Per-GPU proportions for multi-gpu (∝ VRAM), summing to ~1. */
  tensorSplit?: number[]
  /** Total VRAM the model would occupy, in GB. */
  usedGB: number
  /** Spare VRAM on the chosen GPU (single-gpu only). */
  headroomGB?: number
  /** usedGB / chosen-GPU capacity (single-gpu only) — drives tight-fit tone. */
  fillRatio?: number
  /** How far over the largest capacity we are (no-fit only), in GB. */
  shortfallGB?: number
}

// Fixed per-GPU cost (CUDA context + compute buffers) reserved when we split
// a model across GPUs. Conservative; refine empirically.
const PER_GPU_OVERHEAD_GB = 0.5

// Reserve left for the OS + other apps when planning against system RAM. We
// size against TOTAL RAM (not current free) so the badge is stable — the box's
// momentary RAM usage shouldn't flip a model between "offloads" and "won't
// fit". Deploy-time re-validation checks actual free memory.
const RAM_OS_RESERVE_GB = 2

const GB = 1024 ** 3

/**
 * Decide the best placement for `v` (a VramBreakdown) on `hw`. Returns null
 * when hardware isn't known yet (badge stays hidden), matching the previous
 * "no userVramGB → no badge" behavior.
 */
export function planPlacement(
  v: VramBreakdown,
  hw: HardwareProfile | null,
): PlacementPlan | null {
  if (!hw) return null

  const totalGB = v.totalBytes / GB
  const weightsGB = v.weightsBytes / GB
  const usableRamGB = Math.max(0, hw.ramTotalGB - RAM_OS_RESERVE_GB)

  const caps = hw.gpus.map((g) => g.vramTotalMB / 1024) // GB per GPU (total)
  const bestIdx = caps.length
    ? caps.reduce((m, c, i) => (c > caps[m] ? i : m), 0)
    : -1
  const bestCap = bestIdx >= 0 ? caps[bestIdx] : 0

  // The severity ladder is keyed on where the WEIGHTS live, not on the
  // headline total — because the total bakes in a worst-case full-context KV
  // cache you can always trim. A model whose weights are GPU-resident runs
  // well (green/amber); one whose weights fit only in RAM runs but slowly
  // (muted); red is reserved for "weights don't fit GPU(s)+RAM at all."

  // A) Weights fit a single GPU → GPU-resident (fast).
  if (bestIdx >= 0 && weightsGB <= bestCap) {
    if (totalGB <= bestCap) {
      return {
        mode: 'single-gpu',
        gpuIndices: [hw.gpus[bestIdx].index],
        usedGB: round1(totalGB),
        headroomGB: round1(bestCap - totalGB),
        fillRatio: totalGB / bestCap,
      }
    }
    // Weights on the GPU, but the full-context total overflows it → runs with
    // a shorter context (or KV offloaded to RAM). Still GPU-resident.
    return {
      mode: 'partial-offload',
      gpuIndices: [hw.gpus[bestIdx].index],
      usedGB: round1(totalGB),
    }
  }

  // B) Weights fit across several GPUs → split, GPU-resident (fast).
  if (hw.gpus.length > 1) {
    const usable = caps.map((c) => Math.max(0, c - PER_GPU_OVERHEAD_GB))
    const aggregate = usable.reduce((s, c) => s + c, 0)
    if (weightsGB <= aggregate) {
      const split = usable.map((c) => (aggregate > 0 ? c / aggregate : 0))
      return {
        mode: 'multi-gpu',
        gpuIndices: hw.gpus.map((g) => g.index),
        tensorSplit: split.map(round2),
        usedGB: round1(totalGB),
      }
    }
  }

  // C) Weights fit only in system RAM → runs, but mostly on CPU (slow).
  if (weightsGB <= usableRamGB) {
    return { mode: 'cpu-only', gpuIndices: [], usedGB: round1(totalGB) }
  }

  // D) Weights don't fit GPU(s) or RAM → won't run acceptably here.
  const aggregateGpu =
    hw.gpus.length > 1 ? caps.reduce((s, c) => s + c, 0) : bestCap
  const biggestPool = Math.max(bestCap, aggregateGpu, usableRamGB)
  return {
    mode: 'no-fit',
    gpuIndices: [],
    usedGB: round1(totalGB),
    shortfallGB: round1(weightsGB - biggestPool),
  }
}

/**
 * Derive the llama-server split flags from a placement plan. Only a
 * multi-gpu plan produces flags; everything else runs on one GPU (or CPU)
 * with no split. main-gpu is the largest GPU (biggest tensorSplit share).
 */
export function placementToServeSplit(plan: PlacementPlan | null): {
  splitMode?: 'layer' | 'row'
  tensorSplit?: number[]
  mainGpu?: number
} {
  if (!plan || plan.mode !== 'multi-gpu' || !plan.tensorSplit?.length) return {}
  const ts = plan.tensorSplit
  const maxI = ts.reduce((m, v, i) => (v > ts[m] ? i : m), 0)
  return {
    splitMode: 'layer',
    tensorSplit: ts,
    mainGpu: plan.gpuIndices[maxI] ?? 0,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
