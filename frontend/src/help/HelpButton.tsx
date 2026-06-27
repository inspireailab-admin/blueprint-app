// HelpButton renders a small "?" icon next to a card title that opens
// the corresponding /how-to article on llmblueprint.ai in the user's
// default browser.
//
// Why hosted vs bundled help: the marketing site already has the MDX
// pipeline, shiki syntax highlighting, and indexes articles for SEO.
// Bundling the same content inside the desktop binary would duplicate
// rendering infrastructure and force a desktop release for every typo
// fix. The web-hosted approach gives us one source of truth + SEO
// + linkable URLs users can share in team chats.
//
// Offline degradation: BrowserOpenURL is best-effort. When the user
// has no internet, the browser will simply show its own offline page
// — we don't try to render anything in-app.
//
// Author: Amar Mond.

import { BrowserOpenURL } from '../../wailsjs/runtime/runtime'

const BASE_URL = 'https://llmblueprint.ai/how-to'

export interface HelpButtonProps {
  /**
   * Slug of the /how-to article to open. Maps to the MDX filename on
   * the site (e.g. "prompt-cache" → llmblueprint.ai/how-to/prompt-cache).
   */
  slug: string

  /**
   * Human-readable feature name, surfaced in the button's title
   * attribute (the OS tooltip on hover).
   */
  label: string

  /**
   * Optional className override for embedding in card headers with
   * specific spacing requirements. Defaults to a small inline-flex
   * button.
   */
  className?: string
}

export function HelpButton({ slug, label, className }: HelpButtonProps) {
  const url = `${BASE_URL}/${slug}`
  return (
    <button
      type="button"
      onClick={() => BrowserOpenURL(url)}
      title={`Help: ${label} (opens ${url} in your browser)`}
      aria-label={`Help: ${label}`}
      className={
        className ??
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[11px] font-semibold text-muted-foreground transition hover:border-foreground/40 hover:text-foreground'
      }
    >
      ?
    </button>
  )
}
