// Verify chat — once llama-server is running, the user wants to actually
// talk to it. Hits the local OpenAI-compatible endpoint at
// http://127.0.0.1:8080/v1/chat/completions with streaming, renders
// tokens as they arrive. For vision-language models (MiniCPM-V etc.)
// the user can also attach an image, encoded as a data URL in the
// content array per the OpenAI vision schema.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Model } from '../planner/types'

const ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions'
const API_KEY = 'blueprint-local'

type Message = { role: 'user' | 'assistant'; content: string; imageUrl?: string }

type Props = {
  model: Model
}

export function VerifyChat({ model }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const supportsImages = model.type === 'vision-language'

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if ((!text && !imageDataUrl) || sending) return

    const userMsg: Message = { role: 'user', content: text, imageUrl: imageDataUrl ?? undefined }
    const next: Message[] = [...messages, userMsg, { role: 'assistant', content: '' }]
    setMessages(next)
    setInput('')
    setImageDataUrl(null)
    setSending(true)
    setError(null)

    try {
      const apiMessages = next.slice(0, -1).map((m) => {
        if (m.imageUrl) {
          return {
            role: m.role,
            content: [
              { type: 'image_url', image_url: { url: m.imageUrl } },
              { type: 'text', text: m.content || 'Describe this image.' },
            ],
          }
        }
        return { role: m.role, content: m.content }
      })

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ model: 'local', messages: apiMessages, stream: true }),
      })

      if (!res.ok || !res.body) {
        throw new Error(`Local server returned ${res.status}`)
      }

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
  }, [input, imageDataUrl, messages, sending])

  const onPickImage = useCallback((file: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setImageDataUrl(reader.result)
    }
    reader.readAsDataURL(file)
  }, [])

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold tracking-tight">Verify</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Send a test prompt. Hits <code>http://127.0.0.1:8080/v1/chat/completions</code> with the
          standard OpenAI shape — same request your application code will make.
          {supportsImages && ' This model is multimodal — attach an image to test vision.'}
        </p>
      </header>

      <div
        ref={scrollRef}
        className="max-h-[400px] min-h-[160px] overflow-y-auto bg-background px-6 py-4"
      >
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Try{' '}
            <em>
              &ldquo;
              {supportsImages
                ? 'Describe this image in two sentences.'
                : 'Summarize quantum entanglement in two sentences.'}
              &rdquo;
            </em>
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
                  {m.imageUrl && (
                    <img
                      src={m.imageUrl}
                      alt="user upload"
                      className="mb-2 max-h-40 rounded-md object-contain"
                    />
                  )}
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

      {imageDataUrl && (
        <div className="mx-6 mb-2 flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <img src={imageDataUrl} alt="staged" className="h-10 w-10 rounded object-cover" />
          <span className="flex-1 truncate text-muted-foreground">Image attached</span>
          <button
            type="button"
            onClick={() => setImageDataUrl(null)}
            className="text-muted-foreground transition hover:text-foreground"
          >
            Remove
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
        className="flex items-center gap-2 border-t border-border bg-muted/30 px-6 py-3"
      >
        {supportsImages && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              + Image
            </button>
          </>
        )}
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
          disabled={sending || (!input.trim() && !imageDataUrl)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
        >
          {sending ? 'Sending…' : 'Send'}
          {!sending && <span aria-hidden>→</span>}
        </button>
      </form>
    </section>
  )
}
