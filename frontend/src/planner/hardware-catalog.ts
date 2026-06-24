// Typed accessors for the curated GPU + cloud-pricing data files.

import gpusRaw from '../data/gpus.json'
import cloudRaw from '../data/cloud-pricing.json'
import type { CloudProvider, Gpu } from './types'

type GpuFile = { asOf: string; note: string; gpus: Gpu[] }
type CloudFile = { asOf: string; note: string; providers: CloudProvider[] }

const gpuFile = gpusRaw as GpuFile
const cloudFile = cloudRaw as CloudFile

export const gpus: Gpu[] = gpuFile.gpus
export const gpusAsOf: string = gpuFile.asOf

export const providers: CloudProvider[] = cloudFile.providers
export const cloudAsOf: string = cloudFile.asOf

export function getGpu(id: string): Gpu | undefined {
  return gpus.find((g) => g.id === id)
}

export function getProvider(id: string): CloudProvider | undefined {
  return providers.find((p) => p.id === id)
}
