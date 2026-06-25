// EvaluateStep — Tier 1 step 5 (run llama-server per candidate +
// score) and step 6 (Pareto plot of quality vs speed vs size).
//
// Sub-sections:
//   1. Eval set upload (JSONL)
//   2. Candidate picker — calibrated GGUFs from this run + any same-
//      model stock pre-quants on disk so we can show the "ours vs
//      theirs" comparison the consulting pitch hinges on.
//   3. Run controls + per-candidate / per-prompt progress.
//   4. Results table + Pareto scatter.
//   5. Download client report (step 7 — delegates to backend that
//      builds report.md from results.json).

import { useCallback, useEffect, useState } from 'react'
import {
  GetCalibrationEvalResults,
  ListEvalCandidates,
  RunCalibrationEval,
  SaveCalibrationEvalSet,
} from '../../wailsjs/go/main/App'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import type { calibration as cal, main } from '../../wailsjs/go/models'

const SCORING_OPTIONS = [
  { value: 'rouge-l', label: 'ROUGE-L F1 (token overlap)' },
  { value: 'exact', label: 'Exact match (normalized)' },
] as const

type Props = {
  run: cal.Run
  onChanged: () => void | Promise<void>
}

export function EvaluateStep({ run, onChanged }: Props) {
  const ready = run.phase === 'quantize-ok' || run.phase === 'eval' || run.phase === 'eval-ok'
  const running = run.phase === 'eval'
  const done = run.phase === 'eval-ok'

  const [candidates, setCandidates] = useState<main.EvalCandidate[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scoring, setScoring] = useState<'rouge-l' | 'exact'>('rouge-l')
  const [maxTokens, setMaxTokens] = useState<number>(256)
  const [evalText, setEvalText] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<cal.EvalResults | null>(null)
  const [progress, setProgress] = useState<{
    candidate?: string
    row?: number
    of?: number
    score?: number
    stage?: string
  } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const cs = await ListEvalCandidates(run.id)
      setCandidates(cs ?? [])
      // Default-select every calibrated candidate (the run's own outputs).
      setSelected((prev) => {
        if (prev.size > 0) return prev
        const next = new Set<string>()
        for (const c of cs ?? []) {
          if (c.source === 'calibrated') next.add(c.ggufPath)
        }
        return next
      })
      const r = await GetCalibrationEvalResults(run.id)
      setResults(r)
    } catch (e) {
      console.warn('eval refresh', e)
    }
  }, [run.id])

  useEffect(() => {
    if (ready) void refresh()
  }, [ready, refresh])

  useEffect(() => {
    const off = EventsOn('calibrate:eval-progress', (p: typeof progress) => {
      setProgress(p)
      if (p?.stage === 'done' || p?.stage === 'all-done') {
        void refresh()
      }
    })
    return () => off()
  }, [refresh])

  if (!ready) {
    return (
      <article className="rounded-2xl border border-dashed border-border bg-muted/20 p-5">
        <StepHeader n={4} title="Evaluate + Pareto report" done={false} disabled />
        <p className="mt-1 text-xs text-muted-foreground">
          Finish the quantize step first. The eval harness needs at least one calibrated GGUF
          to score against the client&apos;s eval set.
        </p>
      </article>
    )
  }

  async function saveEval() {
    setError(null)
    try {
      await SaveCalibrationEvalSet(run.id, evalText)
      setEvalText('')
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function runEval() {
    setError(null)
    if (selected.size === 0) {
      setError('Select at least one candidate to evaluate.')
      return
    }
    try {
      await RunCalibrationEval({
        runId: run.id,
        candidates: Array.from(selected),
        defaultScoring: scoring,
        maxTokens,
        ctxSize: 4096,
        nGpuLayers: 999,
      } as main.EvalRunInput)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <article className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <StepHeader n={4} title="Evaluate + Pareto report" done={done} />
      <p className="mt-1 text-xs text-muted-foreground">
        Upload a JSONL eval set (
        <code className="font-mono">
          {`{"prompt": "...", "expected": "..."}`}
        </code>
        ), pick which GGUFs to score, and Blueprint will spin a temporary llama-server per
        candidate, replay every eval prompt, and produce a Pareto plot + a client-ready
        report.
      </p>

      {/* ── Eval set upload ── */}
      <div className="mt-4 rounded-md border border-border bg-background p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Eval set (JSONL, one entry per line)
        </p>
        {run.evalSetCount > 0 && (
          <p className="mt-1 text-xs">
            <b>{run.evalSetCount}</b> eval entries saved. You can replace them below.
          </p>
        )}
        <textarea
          value={evalText}
          onChange={(e) => setEvalText(e.target.value)}
          rows={5}
          placeholder={`{"prompt": "Summarize the user agreement clause about indemnity.", "expected": "The clause indemnifies the platform against …"}\n…`}
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={!evalText.trim()}
            onClick={saveEval}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {run.evalSetCount > 0 ? 'Replace eval set' : 'Save eval set'}
          </button>
        </div>
      </div>

      {/* ── Candidate picker ── */}
      <div className="mt-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Candidates to evaluate
        </p>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {(candidates ?? []).map((c) => {
            const on = selected.has(c.ggufPath)
            return (
              <li key={c.ggufPath}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    disabled={running}
                    checked={on}
                    onChange={() => {
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (on) next.delete(c.ggufPath)
                        else next.add(c.ggufPath)
                        return next
                      })
                    }}
                    className="mt-0.5 h-3.5 w-3.5 accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12px] font-semibold">{c.label}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {c.source} · {humanBytes(c.fileSize)}
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
          {candidates && candidates.length === 0 && (
            <li className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground sm:col-span-2">
              No GGUFs found. Make sure the quantize step finished, then refresh.
            </li>
          )}
        </ul>
      </div>

      {/* ── Run controls ── */}
      <div className="mt-4 grid items-end gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs font-medium">Default scoring</span>
          <select
            value={scoring}
            onChange={(e) => setScoring(e.target.value as 'rouge-l' | 'exact')}
            disabled={running}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] disabled:opacity-50"
          >
            {SCORING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium">Max tokens per response</span>
          <input
            type="number"
            min={32}
            max={4096}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Math.max(32, Number(e.target.value) || 0))}
            disabled={running}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          disabled={running || run.evalSetCount === 0 || selected.size === 0}
          onClick={runEval}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {running ? 'Evaluating…' : done ? 'Re-run evaluation' : `Evaluate ${selected.size} candidate${selected.size === 1 ? '' : 's'}`}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* ── Live progress ── */}
      {running && progress && (
        <div className="mt-4 rounded-md border border-border bg-muted/30 px-3 py-2">
          <p className="font-mono text-[11px] text-muted-foreground">
            {progress.candidate ? `Candidate: ${basename(progress.candidate)}` : '—'}
            {progress.row && progress.of ? ` · ${progress.row}/${progress.of}` : ''}
            {progress.score !== undefined ? ` · last score ${progress.score.toFixed(2)}` : ''}
          </p>
        </div>
      )}

      {/* ── Results ── */}
      {results && results.candidates && results.candidates.length > 0 && (
        <ResultsSection results={results} runId={run.id} />
      )}
    </article>
  )
}

// ─── Results section ──────────────────────────────────────────────────

function ResultsSection({ results, runId }: { results: cal.EvalResults; runId: string }) {
  const sorted = [...results.candidates].sort((a, b) => b.meanScore - a.meanScore)
  const headline = headlineFinding(sorted)

  return (
    <section className="mt-5 border-t border-border pt-5">
      <p className="eyebrow">Results</p>

      {headline && (
        <p className="mt-1 max-w-prose text-sm font-semibold tracking-tight">
          {headline}
        </p>
      )}

      <ParetoPlot results={results} />

      <div className="mt-4 overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <Th>Candidate</Th>
              <Th align="right">Mean score</Th>
              <Th align="right">P50 TTFT</Th>
              <Th align="right">P95 TTFT</Th>
              <Th align="right">Tok/s</Th>
              <Th align="right">Size</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.ggufPath} className="border-t border-border/40">
                <Td><span className="font-mono text-[12px]">{c.label}</span><span className="ml-2 text-[10px] text-muted-foreground">{c.source}</span></Td>
                <Td align="right" mono>{(c.meanScore * 100).toFixed(1)}%</Td>
                <Td align="right" mono>{c.medianTTFTms} ms</Td>
                <Td align="right" mono>{c.p95TTFTms} ms</Td>
                <Td align="right" mono>{c.meanTokPerSec.toFixed(1)}</Td>
                <Td align="right" mono>{humanBytes(c.fileSizeBytes)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ReportExport runId={runId} />
    </section>
  )
}

function headlineFinding(sortedByScore: cal.CandidateResult[]): string | null {
  if (sortedByScore.length === 0) return null
  // If we have a calibrated and a stock version of the same quant, compare.
  for (const c of sortedByScore) {
    if (c.source !== 'calibrated') continue
    const stockPair = sortedByScore.find((other) =>
      other.source === 'stock' && other.quantTarget === c.quantTarget,
    )
    if (stockPair && c.meanScore > stockPair.meanScore) {
      const deltaPct = ((c.meanScore - stockPair.meanScore) / Math.max(stockPair.meanScore, 1e-9)) * 100
      return `Custom-calibrated ${c.quantTarget} beats the stock pre-quant by ${deltaPct.toFixed(1)}% on this eval set.`
    }
  }
  const top = sortedByScore[0]
  return `Top candidate: ${top.label} at ${(top.meanScore * 100).toFixed(1)}% mean quality.`
}

// ─── Pareto scatter plot ──────────────────────────────────────────────

function ParetoPlot({ results }: { results: cal.EvalResults }) {
  const W = 520
  const H = 260
  const padL = 40, padR = 12, padT = 10, padB = 36
  const xs = results.candidates.map((c) => Math.max(1, c.fileSizeBytes / (1024 ** 3))) // GB
  const ys = results.candidates.map((c) => c.meanScore)
  if (xs.length === 0 || ys.length === 0) return null
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const yMin = Math.min(...ys, 0)
  const yMax = Math.max(...ys, 1)
  const xR = xMax - xMin || 1
  const yR = yMax - yMin || 1
  const sx = (v: number) => padL + ((v - xMin) / xR) * (W - padL - padR)
  const sy = (v: number) => H - padB - ((v - yMin) / yR) * (H - padT - padB)

  // Pareto frontier = points not dominated by any other (higher Y at
  // lower X). Mark them so we can highlight in the plot.
  const frontier = new Set<number>()
  for (let i = 0; i < results.candidates.length; i++) {
    let dominated = false
    for (let j = 0; j < results.candidates.length; j++) {
      if (i === j) continue
      if (xs[j] <= xs[i] && ys[j] >= ys[i] && (xs[j] < xs[i] || ys[j] > ys[i])) {
        dominated = true
        break
      }
    }
    if (!dominated) frontier.add(i)
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-md border border-border bg-background p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[260px] w-full">
        {/* Y grid + label */}
        {[0, 0.25, 0.5, 0.75, 1].map((q) => (
          <g key={q}>
            <line x1={padL} y1={sy(q)} x2={W - padR} y2={sy(q)} stroke="oklch(0.92 0 0)" />
            <text x={padL - 4} y={sy(q) + 3} textAnchor="end" fontFamily="monospace" fontSize="9" fill="oklch(0.55 0 0)">
              {(q * 100).toFixed(0)}%
            </text>
          </g>
        ))}
        <text x={6} y={padT + 8} fontFamily="monospace" fontSize="9" fill="oklch(0.55 0 0)">quality</text>
        <text x={W - padR} y={H - 6} textAnchor="end" fontFamily="monospace" fontSize="9" fill="oklch(0.55 0 0)">file size (GB)</text>

        {/* points */}
        {results.candidates.map((c, i) => {
          const isFront = frontier.has(i)
          const fill = c.source === 'calibrated' ? 'oklch(0.45 0.17 262)' : 'oklch(0.55 0.10 30)'
          return (
            <g key={c.ggufPath}>
              <circle
                cx={sx(xs[i])}
                cy={sy(ys[i])}
                r={isFront ? 7 : 5}
                fill={fill}
                stroke={isFront ? fill : 'white'}
                strokeWidth={isFront ? 2 : 1.5}
                opacity={isFront ? 1 : 0.7}
              />
              <text
                x={sx(xs[i]) + 9}
                y={sy(ys[i]) + 3}
                fontFamily="monospace"
                fontSize="9"
                fill="oklch(0.3 0 0)"
              >
                {c.quantTarget}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Pareto frontier highlighted. <b>Blue</b> = calibrated (this run), <b>orange</b> = stock pre-quant.
      </p>
    </div>
  )
}

// ─── Report export (step 7) ───────────────────────────────────────────

function ReportExport({ runId }: { runId: string }) {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)

  async function generate() {
    setError(null)
    setGenerating(true)
    try {
      const { GenerateCalibrationReport } = await import('../../wailsjs/go/main/App')
      const p = await GenerateCalibrationReport(runId)
      setPath(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-4 py-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Client report</p>
        <p className="text-xs">
          Generates <code className="font-mono">report.md</code> in the run directory — the
          consulting deliverable.
        </p>
        {path && (
          <p className="mt-1 font-mono text-[11px] text-chart-4">Saved to {path}</p>
        )}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <button
        type="button"
        disabled={generating}
        onClick={generate}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
      >
        {generating ? 'Generating…' : 'Generate report'}
      </button>
    </div>
  )
}

// ─── Bits ──────────────────────────────────────────────────────────────

function StepHeader({ n, title, done, disabled }: { n: number; title: string; done: boolean; disabled?: boolean }) {
  return (
    <header className="flex items-center gap-3">
      <span
        className={[
          'inline-flex h-6 w-6 items-center justify-center rounded-full font-mono text-[11px] font-semibold',
          done ? 'bg-chart-4/15 text-chart-4' : disabled ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
        ].join(' ')}
      >
        {done ? '✓' : n}
      </span>
      <h3 className={['text-base font-semibold tracking-tight', disabled ? 'text-muted-foreground' : ''].join(' ')}>{title}</h3>
    </header>
  )
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <th className={['px-3 py-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-foreground', align === 'right' ? 'text-right' : 'text-left'].join(' ')}>
      {children}
    </th>
  )
}

function Td({ children, align, mono }: { children: React.ReactNode; align?: 'right'; mono?: boolean }) {
  return (
    <td className={['px-3 py-2', align === 'right' ? 'text-right' : 'text-left', mono ? 'font-mono text-[12px]' : 'text-sm'].join(' ')}>
      {children}
    </td>
  )
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function humanBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
