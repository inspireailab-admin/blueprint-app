# Blueprint — positioning, marketing site rewrite, and pricing strategy

_Written 2026-06-25 — when Blueprint went from a quant catalog to a
full-workflow consulting product. The marketing site needs to catch
up._

## 1. What Blueprint is now (vs. what it was)

When the inspireailab.com/blueprint subdomain was first put up, the
pitch was: "Plan a model + size the hardware in your browser."
That's still in the product — but it's now the on-ramp, not the
destination.

What Blueprint actually does today:

> A desktop app + Windows / Linux service that lets a consultant
> walk a client through the full LLM optimization lifecycle:
> calibrate a custom quant on the client's prompts, fine-tune a LoRA
> on their data, pick the right inference engine, run the production
> cost optimizations (caching, routing, prompt compression), and
> hand over a one-click report.

That's a real product. The marketing site is currently selling the
old framing.

## 2. New marketing-site information architecture

### Pages

| Path | Purpose |
|---|---|
| `/` | Home — value prop + demo CTA + download CTA |
| `/calibrate` | Workflow page — what custom calibration is + screenshots + sample report |
| `/adapt` | LoRA training workflow |
| `/serve` | Multi-engine serving (llama.cpp / vLLM / TensorRT-LLM) |
| `/optimize` | Runtime optimizations (cache, routing, compression) |
| `/consulting` | The consulting offering, anchored on the same workflow |
| `/pricing` | Free / Pro / Team / Enterprise tiers (see §4) |
| `/blog/model-adaptation/*` | The six articles already drafted in `docs/blog/` |
| `/download` | OS-detected download (Win / macOS / Linux) |
| `/demo` | Book a guided demo (Calendly) |
| `/docs` | User documentation (separate from blog) |

### Home page — recommended new copy

> # Optimize LLMs for your workload — not for a benchmark
>
> Blueprint is a desktop app + service that runs every step of the
> LLM optimization workflow on your hardware: custom-calibrate quants
> on your client's prompts, train LoRA adapters on their data, route
> queries between small and large models, cache semantically-similar
> responses. The deliverable is a folder with a `report.md` and the
> trained artefacts. Yours to ship.
>
> [Download for Windows] [Download for macOS] [Download for Linux]
>
> Or: [Book a guided demo]
>
> ## The workflow
>
> 1. **Calibrate** — generate a `llama-imatrix` from your client's
>    representative prompts, quantize with it, evaluate against their
>    eval set. Custom Q4_K_M typically beats the bartowski pre-quant
>    by 8–15% on the workload that matters.
>
> 2. **Adapt** — fine-tune a LoRA adapter (or QLoRA on consumer GPUs)
>    on the client's data. Adapter loads cleanly into llama.cpp + vLLM.
>
> 3. **Serve** — three inference engines through one supervisor:
>    llama.cpp for laptops, vLLM for GPU-rich servers, TensorRT-LLM
>    for max throughput on H100s.
>
> 4. **Optimize at runtime** — semantic prompt cache, small-first
>    model routing, LLMLingua prompt compression. Track cost savings
>    in the Dashboard.
>
> 5. **Hand over** — one-click report bundles the workload description,
>    candidates evaluated, Pareto plot, and the recommended
>    deployment. The run directory IS the deliverable.
>
> ## Who uses it
>
> - **Consultants** running LLM engagements — the workflow IS the
>   engagement.
> - **Platform teams** at companies running their own LLM stack —
>   skip the bespoke tooling, use the workflow.
> - **Practitioners learning** — three bundled demo datasets walk you
>   through the full pipeline in under 10 minutes.
>
> ## Free for individuals. Paid for commercial use. See [Pricing].

### Removing from the current site

- The "Plan your model" wizard as the primary CTA. Plan + Hardware
  still exist as part of the workflow, but the home page should lead
  with the deliverable, not the planner.
- Any copy that implies "in-browser only" — the product is a
  downloaded app now.

## 3. Competitive landscape

Comparable products (none cover the full workflow):

| Product | Free / paid | What it does | Where they don't reach |
|---|---|---|---|
| **Ollama** | OSS, free | Local LLM runner + chat | No calibration, no training, no consulting workflow, no production optimizations |
| **LM Studio** | Free for personal, ToS forbids commercial w/o license | Local LLM chat + light fine-tuning UI | No custom quantization, no engine choice |
| **Jan.ai** | OSS, free | Local ChatGPT alternative | No training, no production optimizations |
| **AnythingLLM** | OSS + paid Enterprise tier | Local AI workspace + RAG | No calibration, no engine variety; RAG-focused |
| **LocalAI** | OSS, free | Self-hosted OpenAI replacement | API only, no UI workflow |
| **GPUStack** | OSS, free | GPU cluster orchestration | Orchestration only, no engagement workflow |
| **Predibase** | SaaS, paid | LoRA fine-tuning platform | Hosted only, vendor lock-in |
| **Together AI** | SaaS, pay-per-token | Managed inference + fine-tuning | Not a local tool, no consultant workflow |
| **Modal / Replicate** | SaaS, pay-per-second | Serverless GPU + model hosting | Infra layer, not product workflow |

**The gap Blueprint fills:** end-to-end calibration → fine-tune →
serve → optimize → report, on the user's own hardware, with the
client-deliverable framing. Nobody else is positioned exactly here.

Closest in spirit: **AnythingLLM** (they sell an enterprise tier on
top of OSS local tools), and **LM Studio** (commercial-license
gating on a desktop app). Both are precedents that the
"local desktop AI tool with paid tier" model can work.

## 4. Pricing recommendation

### Free — Personal
- All workflow features
- Local use only
- Bundled sample datasets
- Community support (GitHub Issues + Discord)
- **No commercial use** — license restricts to learning, personal,
  academic, OSS contribution

This is the conversion funnel. Don't gate anything technically; gate
on the **license** (the AnythingLLM / LM Studio playbook).

### Pro — $39 / month or $390 / year, per seat
- Commercial use license
- Email support (next business day)
- Priority bug fixes
- Cloud sync of calibration runs across machines (optional)
- Quarterly office-hours call

Target: solo consultants, freelancers, small teams running their own
LLM stack. The $39 / mo number lines up with how other prosumer
developer tools price (LM Studio: $25–$50 commercial; Cursor: $20;
GitHub Copilot: $10).

### Team — $290 / month for 5 seats + $40 per additional seat
- Everything in Pro
- Shared calibration runs (one engagement, multiple consultants)
- Audit log of who ran what
- Slack support channel
- Onboarding session
- SSO via Google Workspace / Okta

Target: consulting firms running multiple engagements concurrently.

### Enterprise — starts at $25k / year
- Self-hosted control plane (optional)
- SAML / OIDC SSO
- Dedicated Slack channel + named support engineer
- Quarterly architecture review
- Custom dataset / sample workflows
- **Path to consulting engagement** (a $25k subscription credits
  against a consulting SOW)

Target: companies running their own LLM stack at scale who want
Blueprint as platform tooling, not a one-off.

### Consulting (separate revenue stream, not a tier)
- Custom calibration engagement: $15k–40k (one workload, deliverable
  in 2–4 weeks)
- LoRA fine-tuning engagement: $25k–75k
- Production optimization audit: $20k–50k
- Architecture review: $5k–15k

Subscription credits against engagement SOWs — Enterprise customers
get a meaningful chunk of their first engagement covered.

### Why this structure works

1. **Free tier drives adoption.** No technical gate. Practitioners
   learn the tool on their own time. When they show up at work, they
   already know Blueprint.

2. **Commercial license is the conversion lever.** The same playbook
   AnythingLLM and LM Studio run successfully. Companies happily pay
   $39 / mo / seat for a tool the engineer already uses; they
   _won't_ go through procurement to evaluate a new tool from
   scratch.

3. **Team tier is where the margin is.** Consulting firms with 5–20
   consultants are the bullseye; $290–800 / mo per firm with low
   support cost.

4. **Enterprise + consulting are the wedge into big deals.** The
   subscription credit against consulting flips the perception of
   "another SaaS line item" into "a discount on the work we were
   already going to buy."

### Free trial mechanics

- Pro and Team tiers: **14-day free trial**, no credit card, full
  commercial license during trial.
- Trial expiry: tool keeps working in **Personal** mode (i.e. the
  app doesn't die — it just stops being commercial-licensed). User
  can upgrade at any time without re-installing.
- Trial reminder UI inside the app: small banner on the Dashboard
  starting day 10 of the trial.

## 5. Action items for you

Things only you can do:

- [ ] Decide on the pricing numbers (above are my recommendation).
- [ ] Decide on the license text (commercial-use restriction
      language).
- [ ] Hand the home-page copy in §2 to whoever maintains the
      marketing site repo, OR I can write the React/Next.js
      components if you give me access to that repo.
- [ ] Stripe + billing wiring (out of scope for the desktop app
      repo).
- [ ] Sign up for a Cloudflare Pages / Vercel hosting account if
      not done.
- [ ] Apply for an EV code-signing certificate so the Windows
      installer doesn't show a SmartScreen warning. Sectigo is
      ~$300 / year. The release pipeline already has the signing
      step gated behind a `WINDOWS_CERT` GitHub secret — just upload
      the .pfx as base64 + the password.

Things I can do (just say the word):

- [ ] Write the marketing-site copy as MDX or React components
      ready to drop in.
- [ ] Write a `LICENSE.md` for the personal-use restriction.
- [ ] Build a Pro / Team / Enterprise checkout flow with Stripe
      (separate web app, ~1 day of work).
- [ ] Add a "trial expiry" banner to the Dashboard's existing
      Status bar (~1 hour).
- [ ] Add an in-app license-key entry field on first launch
      (~2 hours).
