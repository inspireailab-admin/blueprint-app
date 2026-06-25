// Inline chat + sampling controls for the Dashboard.
//
// Sampling params are applied per request, so changing temperature or
// top_p takes effect on the very next message — no server restart.
// Startup params (model, quant, ctx size, GPU layers) need a restart;
// those live in the ServerConfigCard above and link to Optimize.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { main } from '../../wailsjs/go/models'

export type SamplingParams = {
  temperature: number
  topP: number
  maxTokens: number
  repeatPenalty: number
}

export const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 512,
  repeatPenalty: 1.1,
}

type Message = { role: 'user' | 'assistant'; content: string }

type Props = {
  server: main.ServerStatus
}

export function DashboardChat({ server }: Props) {
  const port = server.port ?? 8080
  const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`

  const [params, setParams] = useState<SamplingParams>(DEFAULT_SAMPLING)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return

    const userMsg: Message = { role: 'user', content: text }
    const next: Message[] = [...messages, userMsg, { role: 'assistant', content: '' }]
    setMessages(next)
    setInput('')
    setSending(true)
    setError(null)

    try {
      const apiMessages = next.slice(0, -1).map((m) => ({ role: m.role, content: m.content }))
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer blueprint-local',
        },
        body: JSON.stringify({
          model: 'local',
          messages: apiMessages,
          stream: true,
          temperature: params.temperature,
          top_p: params.topP,
          max_tokens: params.maxTokens,
          repeat_penalty: params.repeatPenalty,
        }),
      })

      if (!res.ok || !res.body) throw new Error(`Local server returned ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let acc = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            buffer = ''
            break
          }
          try {
            const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
            const chunk = json.choices?.[0]?.delta?.content
            if (chunk) {
              acc += chunk
              setMessages((m) => {
                const out = m.slice()
                out[out.length - 1] = { role: 'assistant', content: acc }
                return out
              })
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setMessages((m) => m.slice(0, -1))
    } finally {
      setSending(false)
    }
  }, [endpoint, input, messages, params, sending])

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Run a query</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Hits the local <code className="font-mono">/v1/chat/completions</code> endpoint with
            streaming. Sampling parameters below apply to the next request — no restart needed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMessages([])}
          disabled={messages.length === 0 || sending}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
        >
          Clear
        </button>
      </header>

      <SamplingControls
        params={params}
        onChange={setParams}
        showAdvanced={showAdvanced}
        onToggleAdvanced={() => setShowAdvanced((v) => !v)}
      />

      <div
        ref={scrollRef}
        className="max-h-[360px] min-h-[140px] overflow-y-auto border-t border-border bg-background px-6 py-4"
      >
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Try <em>&ldquo;Summarize the difference between MoE and dense models.&rdquo;</em>
          </p>
        ) : (
          <ul className="space-y-3">
            {messages.map((m, i) => (
              <li key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
                <div
                  className={[
                    'max-w-[80%] rounded-2xl px-4 py-2 text-sm',
                    m.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground',
                  ].join(' ')}
                >
                  {m.content || (m.role === 'assistant' && (
                    <span className="inline-block h-3 w-1.5 animate-pulse bg-foreground/50" />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p className="mx-6 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
        className="flex items-center gap-2 border-t border-border bg-muted/30 px-6 py-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message your local model…"
          disabled={sending}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
        >
          {sending ? 'Sending…' : 'Send'}
          {!sending && <span aria-hidden>→</span>}
        </button>
      </form>
    </section>
  )
}

// ─── Sampling controls ──────────────────────────────────────────────────

function SamplingControls({
  params,
  onChange,
  showAdvanced,
  onToggleAdvanced,
}: {
  params: SamplingParams
  onChange: (p: SamplingParams) => void
  showAdvanced: boolean
  onToggleAdvanced: () => void
}) {
  return (
    <div className="border-b border-border bg-muted/20 px-6 py-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Sampling — applied to the next request
        </p>
        <button
          type="button"
          onClick={onToggleAdvanced}
          className="text-xs text-muted-foreground transition hover:text-foreground"
        >
          {showAdvanced ? 'Hide advanced' : 'Show advanced'}
        </button>
      </div>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Slider
          label="Temperature"
          hint="Lower = focused, higher = creative"
          min={0}
          max={2}
          step={0.05}
          value={params.temperature}
          onChange={(v) => onChange({ ...params, temperature: v })}
          format={(v) => v.toFixed(2)}
        />
        <Slider
          label="Max tokens"
          hint="Cap on response length"
          min={32}
          max={4096}
          step={32}
          value={params.maxTokens}
          onChange={(v) => onChange({ ...params, maxTokens: v })}
          format={(v) => String(v)}
        />
        {showAdvanced && (
          <>
            <Slider
              label="Top-p"
              hint="Nucleus sampling cutoff"
              min={0}
              max={1}
              step={0.01}
              value={params.topP}
              onChange={(v) => onChange({ ...params, topP: v })}
              format={(v) => v.toFixed(2)}
            />
            <Slider
              label="Repeat penalty"
              hint="Higher discourages repetition"
              min={1}
              max={1.5}
              step={0.01}
              value={params.repeatPenalty}
              onChange={(v) => onChange({ ...params, repeatPenalty: v })}
              format={(v) => v.toFixed(2)}
            />
          </>
        )}
      </div>

      {showAdvanced && (
        <p className="mt-3 text-xs text-muted-foreground">
          Need to change the <b>context window</b>, <b>quantization</b>, or <b>GPU layer count</b>?
          Those require a server restart — set them in the Optimize tab.
        </p>
      )}
    </div>
  )
}

function Slider({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string
  hint: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  format: (v: number) => string
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium">{label}</span>
        <span className="font-mono text-[11px] font-semibold text-foreground">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-1 h-1.5 w-full appearance-none rounded-full bg-muted accent-primary"
      />
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </label>
  )
}
