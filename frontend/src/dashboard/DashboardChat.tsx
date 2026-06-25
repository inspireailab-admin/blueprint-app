// Inline chat + sampling controls for the Dashboard.
//
// Two categories of knobs the user can tune from here:
//
//   - Per-request sampling — temperature, top-k, top-p, min-p, the two
//     penalties, max_tokens, seed. Apply to the next request only; no
//     restart. These are the typical "make the model more / less
//     creative" controls.
//
//   - Per-request behaviour — system prompt, stop sequences. Same
//     story: take effect on the next message.
//
// Startup-time params (model, quant, ctx size, GPU layers, threads,
// batch size, flash attention, KV cache type, parallel slots) need a
// service restart and live in the ServiceCard above.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CurrentServeConfig } from '../../wailsjs/go/main/App'

export type SamplingParams = {
  temperature: number
  topK: number
  topP: number
  minP: number
  maxTokens: number
  repeatPenalty: number
  presencePenalty: number
  frequencyPenalty: number
  /** -1 for random; any other integer pins the run. */
  seed: number
  /** Persona / instructions prepended as a system message. */
  systemPrompt: string
  /** Comma-separated; we split + trim before sending. */
  stopSequences: string
}

export const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 0.7,
  topK: 40,
  topP: 0.95,
  minP: 0.05,
  maxTokens: 512,
  repeatPenalty: 1.1,
  presencePenalty: 0,
  frequencyPenalty: 0,
  seed: -1,
  systemPrompt: '',
  stopSequences: '',
}

type Message = { role: 'user' | 'assistant'; content: string }

type Props = {
  /** llama-server port (from the service's CurrentServeConfig). Used as
   *  a hint only — we re-read the config fresh on each send to avoid
   *  any prop-staleness race where the chat fires before the dashboard
   *  poll has populated the bearer. */
  port: number
  /** Initial bearer hint. The real token is re-read on each send. */
  apiKey: string
}

export function DashboardChat({ port, apiKey: initialApiKey }: Props) {
  const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`

  const [params, setParams] = useState<SamplingParams>(DEFAULT_SAMPLING)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Tracks the in-flight fetch so the user can stop a streaming response.
   *  Set on send(), aborted by stop(), cleared in the finally block. */
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  function stop() {
    abortRef.current?.abort()
  }

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
      // Re-read the API key from the service config right before we
      // fire. Belt-and-braces vs. the race where DashboardChat mounts
      // before the dashboard's CurrentServeConfig poll has the bearer.
      let apiKey = initialApiKey
      try {
        const fresh = await CurrentServeConfig()
        if (fresh?.apiKey) apiKey = fresh.apiKey
      } catch {
        // Fall back to the prop hint; the request may still 401.
      }
      if (!apiKey) {
        throw new Error('No API key in service config — wait for the supervisor to settle, then retry.')
      }

      // Prepend a system message when the user has set a system prompt.
      const apiMessages: { role: string; content: string }[] = []
      if (params.systemPrompt.trim()) {
        apiMessages.push({ role: 'system', content: params.systemPrompt.trim() })
      }
      for (const m of next.slice(0, -1)) {
        apiMessages.push({ role: m.role, content: m.content })
      }

      const stops = params.stopSequences
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      const body: Record<string, unknown> = {
        model: 'local',
        messages: apiMessages,
        stream: true,
        temperature: params.temperature,
        top_k: params.topK,
        top_p: params.topP,
        min_p: params.minP,
        max_tokens: params.maxTokens,
        repeat_penalty: params.repeatPenalty,
        presence_penalty: params.presencePenalty,
        frequency_penalty: params.frequencyPenalty,
      }
      if (params.seed !== -1) body.seed = params.seed
      if (stops.length > 0) body.stop = stops

      const ctrl = new AbortController()
      abortRef.current = ctrl

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })

      if (res.status === 401) {
        throw new Error(
          `401 from llama-server — bearer mismatch. The service config has key ${apiKey.slice(0, 4)}…${apiKey.slice(-4)}. ` +
            `If the service was restarted with a fresh config, give the supervisor a couple of seconds and retry.`,
        )
      }
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
      // User clicked Stop — keep whatever was streamed so far, no error.
      if (err instanceof DOMException && err.name === 'AbortError') {
        // intentional, swallow
      } else if (err instanceof Error && err.message.includes('aborted')) {
        // older runtimes surface AbortError as a generic TypeError; check
        // the message as a fallback
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        setMessages((m) => m.slice(0, -1))
      }
    } finally {
      setSending(false)
      abortRef.current = null
    }
  }, [initialApiKey, endpoint, input, messages, params, sending])

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Run a query</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Streams from local <code className="font-mono">/v1/chat/completions</code>. Sampling +
            behaviour parameters apply to the next request — no restart needed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setParams(DEFAULT_SAMPLING)}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title="Reset all sampling parameters to defaults"
          >
            Reset params
          </button>
          <button
            type="button"
            onClick={() => setMessages([])}
            disabled={messages.length === 0 || sending}
            className="rounded-md border border-border px-3 py-1 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
          >
            Clear chat
          </button>
        </div>
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
          if (!sending) send()
        }}
        className="flex items-center gap-2 border-t border-border bg-muted/30 px-6 py-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={sending ? 'Streaming response…' : 'Message your local model…'}
          disabled={sending}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        {sending ? (
          /* Stop — same position + size as Send, dark fg, square icon */
          <button
            type="button"
            onClick={stop}
            title="Stop response"
            aria-label="Stop response"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-foreground text-background shadow-sm transition hover:bg-foreground/85"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            title="Send"
            aria-label="Send"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        )}
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
          Per-request — applied to the next message
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
          max={8192}
          step={32}
          value={params.maxTokens}
          onChange={(v) => onChange({ ...params, maxTokens: v })}
          format={(v) => String(v)}
        />
      </div>

      {showAdvanced && (
        <>
          <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Sampling
          </p>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <Slider
              label="Top-k"
              hint="Limit candidates to top K. 0 = disabled"
              min={0}
              max={200}
              step={1}
              value={params.topK}
              onChange={(v) => onChange({ ...params, topK: v })}
              format={(v) => String(v)}
            />
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
              label="Min-p"
              hint="Min probability relative to the most likely token"
              min={0}
              max={1}
              step={0.01}
              value={params.minP}
              onChange={(v) => onChange({ ...params, minP: v })}
              format={(v) => v.toFixed(2)}
            />
            <Slider
              label="Repeat penalty"
              hint="Discourages repeated tokens"
              min={1}
              max={1.5}
              step={0.01}
              value={params.repeatPenalty}
              onChange={(v) => onChange({ ...params, repeatPenalty: v })}
              format={(v) => v.toFixed(2)}
            />
            <Slider
              label="Presence penalty"
              hint="Penalises tokens that have appeared at all"
              min={-2}
              max={2}
              step={0.05}
              value={params.presencePenalty}
              onChange={(v) => onChange({ ...params, presencePenalty: v })}
              format={(v) => v.toFixed(2)}
            />
            <Slider
              label="Frequency penalty"
              hint="Penalises tokens by usage frequency"
              min={-2}
              max={2}
              step={0.05}
              value={params.frequencyPenalty}
              onChange={(v) => onChange({ ...params, frequencyPenalty: v })}
              format={(v) => v.toFixed(2)}
            />
          </div>

          <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Behaviour
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <TextField
              label="Seed"
              hint="Same seed + prompt = same output. -1 for random"
              value={String(params.seed)}
              onChange={(v) => {
                const n = parseInt(v, 10)
                onChange({ ...params, seed: Number.isFinite(n) ? n : -1 })
              }}
              inputMode="numeric"
            />
            <TextField
              label="Stop sequences"
              hint="Comma-separated. Streaming halts when any matches"
              value={params.stopSequences}
              onChange={(v) => onChange({ ...params, stopSequences: v })}
              placeholder="</answer>, ###"
            />
          </div>

          <div className="mt-3">
            <label className="block">
              <span className="text-xs font-medium">System prompt</span>
              <textarea
                value={params.systemPrompt}
                onChange={(e) => onChange({ ...params, systemPrompt: e.target.value })}
                placeholder="You are a concise technical assistant. Answer in 2-3 sentences."
                rows={2}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Sent as a <code className="font-mono">role: &quot;system&quot;</code> message before the chat history.
              </p>
            </label>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Need to change the <b>context window</b>, <b>quantization</b>, <b>GPU layers</b>,{' '}
            <b>threads</b>, <b>batch size</b>, or <b>flash attention</b>? Those are server-startup
            params — set them in the ServiceCard above and the service will restart cleanly.
          </p>
        </>
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

function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputMode?: 'text' | 'numeric'
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </label>
  )
}
