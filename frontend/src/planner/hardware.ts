// HardwareProfile — the normalized view of a deploy target's compute that
// the planner sizes against. Today it's built from the local `Snapshot()`
// binding; the same shape will later be filled from a remote agent's probe
// (see docs/plan-target-aware-deploy.md §6), so the placement engine below
// never has to care whether the hardware is local or remote.

export type HwGpu = {
  index: number
  name: string
  vramTotalMB: number
  /** Free VRAM right now — used for deploy-time re-validation, not planning. */
  vramFreeMB: number
}

export type HardwareProfile = {
  hasGpuDriver: boolean
  vendor: string
  gpus: HwGpu[]
  ramTotalGB: number
  ramFreeGB: number
}

/** Loose shape of the Go `Snapshot` struct (monitor.go) we consume. */
type SnapshotShape = {
  hasGpuDriver?: boolean
  gpuVendor?: string
  gpus?: {
    index?: number
    name?: string
    vramTotalMB?: number
    vramFreeMB?: number
  }[]
  ramTotalBytes?: number
  ramUsedBytes?: number
}

const GB = 1024 ** 3

/** Map a raw local `Snapshot()` into a HardwareProfile. */
export function hardwareFromSnapshot(snap: SnapshotShape): HardwareProfile {
  const gpus: HwGpu[] = (snap.gpus ?? [])
    .map((g, i) => ({
      index: g.index ?? i,
      name: g.name ?? `GPU ${i}`,
      vramTotalMB: g.vramTotalMB ?? 0,
      vramFreeMB: g.vramFreeMB ?? 0,
    }))
    .filter((g) => g.vramTotalMB > 0)

  const ramTotalGB = (snap.ramTotalBytes ?? 0) / GB
  const ramUsedGB = (snap.ramUsedBytes ?? 0) / GB

  return {
    hasGpuDriver: !!snap.hasGpuDriver,
    vendor: snap.gpuVendor ?? '',
    gpus,
    ramTotalGB,
    ramFreeGB: Math.max(0, ramTotalGB - ramUsedGB),
  }
}

/** Total VRAM across all detected GPUs, in GB. */
export function totalVramGB(hw: HardwareProfile): number {
  return hw.gpus.reduce((sum, g) => sum + g.vramTotalMB / 1024, 0)
}
