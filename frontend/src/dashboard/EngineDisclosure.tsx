// EngineDisclosure — picks the inference runtime (llama.cpp, vLLM,
// TensorRT-LLM) and exposes the engine-specific model identifier
// field (catalog model+quant for llama.cpp, HF identifier for vLLM,
// engine plan directory for TensorRT-LLM).
//
// Apply writes Engine + ModelPathOverride to the service config and
// restarts the supervisor.

import { useEffect, useState } from 'react'
import {
  ApplyServeConfig,
  ListEngines,
  RestartManagedServer,
} from '../../wailsjs/go/main/App'
import type { engines, main, svcconfig } from '../../wailsjs/go/models'

type Props = {
  config: svcconfig.Config | null
  disabled: boolean
}

export function EngineDisclosure({ config, disabled }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [available, setAvailable] = useState<engines.Info[]>([])
  const [selectedID, setSelectedID] = useState<string>(config?.engine || 'llama-cpp')
  const [modelOverride, setModelOverride] = useState<string>(
    config?.engine && config.engine !== 'llama-cpp' ? config.modelPath || '' : '',
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void ListEngines().then((es) => setAvailable(es ?? []))
  }, [])

  useEffect(() => {
    setSelectedID(config?.engine || 'llama-cpp')
    if (config?.engine && config.engine !== 'llama-cpp') {
      setModelOverride(config.modelPath || '')
    }
  }, [config?.engine, config?.modelPath])

  const current = available.find((e) => e.id === selectedID)
  const initialEngine = config?.engine || 'llama-cpp'
  const initialOverride = config?.engine && config.engine !== 'llama-cpp' ? (config.modelPath || '') : ''
  const dirty = selectedID !== initialEngine || modelOverride !== initialOverride

  const needsModelField = selectedID === 'vllm' || selectedID === 'trt-llm'

  async function apply() {
    if (!config) return
    setError(null)
    setBusy(true)
    try {
      await ApplyServeConfig({
        modelId: config.modelId,
        quant: config.quant,
        bindHost: config.bindHost,
        port: config.port,
        ctxSize: config.ctxSize,
        nGpuLayers: config.nGpuLayers,
        threads: config.threads,
        batchSize: config.batchSize,
        uBatchSize: config.uBatchSize,
        flashAttn: config.flashAttn,
        memoryLock: config.memoryLock,
        noMmap: config.noMmap,
        parallelSlots: config.parallelSlots,
        contBatching: config.contBatching,
        kvCacheTypeK: config.kvCacheTypeK,
        kvCacheTypeV: config.kvCacheTypeV,
        logVerbose: config.logVerbose,
        loraAdapter: config.loraAdapter,
        loraScale: config.loraScale,
        engine: selectedID === 'llama-cpp' ? '' : selectedID,
        modelPathOverride: needsModelField ? modelOverride : '',
      } as main.ServeConfigInput)
      await RestartManagedServer()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-border/60 px-6 py-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>{expanded ? '▾' : '▸'}</span>
          Inference engine
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {(config?.engine || 'llama-cpp')}
        </span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            Choose the runtime that supervises your model. Engines that aren&apos;t installed are
            selectable here but the supervisor will refuse to start until the corresponding
            Python feature lands (Dashboard → Python runtime card).
          </p>

          <div className="grid gap-2 sm:grid-cols-3">
            {available.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={disabled || busy}
                onClick={() => setSelectedID(e.id)}
                className={[
                  'rounded-md border px-3 py-2 text-left transition',
                  selectedID === e.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background hover:bg-muted',
                ].join(' ')}
              >
                <p className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
                  {e.displayName}
                  {!e.implemented && (
                    <span className="rounded-sm bg-chart-5/15 px-1 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-chart-5">
                      Not installed
                    </span>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">{e.description}</p>
              </button>
            ))}
          </div>

          {current && (
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
              <p className="text-[11px] font-semibold">{current.displayName} recommendation</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{current.recommendation}</p>
            </div>
          )}

          {needsModelField && (
            <div className="rounded-md border border-border bg-background p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {selectedID === 'vllm' ? 'HuggingFace model identifier' : 'TensorRT-LLM engine plan directory'}
              </p>
              <input
                type="text"
                value={modelOverride}
                onChange={(e) => setModelOverride(e.target.value)}
                placeholder={
                  selectedID === 'vllm'
                    ? 'meta-llama/Llama-3.2-3B-Instruct'
                    : '/path/to/your/llama3.engine'
                }
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              {selectedID === 'trt-llm' && (
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Engine plans are produced by{' '}
                  <a
                    href="https://nvidia.github.io/TensorRT-LLM/quick-start-guide.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    trtllm-build
                  </a>{' '}
                  — pre-build outside Blueprint and point at the directory here.
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={!dirty}
              onClick={() => {
                setSelectedID(initialEngine)
                setModelOverride(initialOverride)
                setError(null)
              }}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              Revert
            </button>
            <button
              type="button"
              disabled={!dirty || busy || disabled}
              onClick={apply}
              className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Applying…' : 'Apply + restart'} →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
