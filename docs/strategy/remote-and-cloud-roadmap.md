# Blueprint — remote Linux + cloud infrastructure roadmap

## Context

Blueprint v0.2.x ships a Wails desktop app that runs Blueprint
**locally** on a user's machine. The kernel, the engines
(llama.cpp / vLLM / TensorRT-LLM), the Python sidecar for LoRA
training + LLMLingua compression, and the always-on service all
assume "the GUI and the LLM are on the same box."

Three things are out of scope today:

1. **Remote Linux deployment** — managing Blueprint instances
   running on a Linux server reached over SSH, from a desktop GUI on
   a different machine.
2. **Cloud GPU provisioning** — spinning up a Lambda Labs / Runpod /
   AWS GPU instance on demand, installing Blueprint, and using it
   from the desktop GUI.
3. **First-class Linux experience** — Linux binaries exist but the
   release pipeline doesn't ship them (apt deps missing); even when
   it does, the install story is "download blueprint-svc, run
   install-linux.sh" instead of a paved path.

This document scopes the work to close each gap, in the order that
makes them shippable.

## What exists today (architectural inventory)

| Surface | State | Notes |
|---|---|---|
| `internal/remotes` | ✅ Shipped | Registry of remote OpenAI-compatible endpoints. **Reads** from them (monitor /health, /v1/models, /metrics), does not deploy or manage them. |
| `cmd/blueprint-svc` | ✅ Shipped | Windows Service + systemd unit + supervisor goroutines. Has no remote control plane API — the Wails app talks to it via in-process IPC. |
| `pkg/runtime` (kernel) | ✅ Shipped | Cross-platform runtime installer, model puller, engine spawn. Works on Linux today, just not paved. |
| Wails GUI | ✅ Shipped, Windows-first | Communicates with the local svc only. No notion of "the svc is on a different host." |
| Linux release pipeline | ⚠️ Broken | Missing `libwebkit2gtk-4.0-dev` + `libgtk-3-dev` apt deps in CI. |
| Cloud provider integration | ❌ None | Zero. |
| Remote-managed mode | ❌ None | Zero. |

## Phase A — Linux as a first-class local target

Pre-req for everything else. If Linux can't ship, "remote Linux"
can't ship either.

**A1. Fix Linux release CI**
- Add `libwebkit2gtk-4.0-dev libgtk-3-dev` apt-install to
  `.github/workflows/release.yml` Linux job
- Verify the .deb + tarball assets land on a real v0.2.x release
- Cross-test on Ubuntu 22.04 + Debian 12 minimum

**A2. systemd registration polish**
- `install-linux.sh` already exists for `blueprint-svc`; audit the
  DACL / capabilities story so a non-root user can start/stop the
  service after install
- Standardize on `~/.blueprint` for state (matches macOS); fall back
  to `/var/lib/blueprint` for system-mode installs

**A3. Headless mode**
- A `--headless` flag on `blueprint.exe` (and Linux binary) that
  skips the Wails webview and exits — used by SSH push-deploy
  later
- The GUI binary already imports the same kernel and svc code; this
  is mostly a code-path gate

**A4. Linux Wails GUI polish**
- Fix the dozen Windows-specific assumptions in the React frontend
  (path separators, default editor invocation, etc.)
- Test the full Plan → Hardware → Deploy flow on Ubuntu

**Estimate: ~1 week**. Pre-req for B onward.

## Phase B — Remote Linux from the desktop GUI

The user runs the desktop app on Windows / macOS, but the LLM runs on
a Linux server they own (rented Hetzner box, on-prem rack, home
server). This is the most common ask from solo consultants and small
platform teams.

**B1. SSH connection manager**
- New "Hosts" sidebar in the desktop GUI
- Add Host UX: SSH endpoint (user@host:port), key path, label, role
  (dev / prod / shared)
- Stored at `~/.blueprint/hosts.json` (same pattern as remotes.json)
- Connection test: SSH + run `uname -a` + report kernel + GPU detect

**B2. SSH push-install**
- "Install Blueprint on this host" button — SSH execs the install
  script (the same `install-linux.sh` we already serve from
  `llmblueprint.ai/install.sh`)
- Progress: download → install runtime → enable systemd unit → start
- Captures stdout/stderr back to the GUI in real time

**B3. Remote svc control plane API**
- `blueprint-svc` exposes a small authenticated control API on
  loopback by default; the SSH tunnel from the GUI is what makes it
  reachable
- Ed25519 mTLS pinned per host (the GUI generates a keypair per
  host, the install script registers the pubkey on the host) — same
  trust model as SSH itself
- Operations: list/load/unload model, start/stop server, scrape
  metrics, fetch logs, restart svc

**B4. Remote-aware Dashboard**
- Single Dashboard view, host selector dropdown at the top
- All the existing tabs (Plan, Hardware, Deploy, Calibrate, Maintain)
  parametrize on the selected host — local is the default
- "Deploy on this host" replaces "Deploy locally" when a remote host
  is selected; the install/model-pull commands proxy through the SSH
  tunnel

**B5. Auth + secrets**
- Host registry encrypted at rest (OS keychain — DPAPI on Windows,
  Keychain on macOS, libsecret on Linux)
- Per-host bearer tokens for the svc control plane never touch disk
  unencrypted

**Estimate: ~3-4 weeks**. Unlocks the "consultant managing a client's
on-prem box" persona — the single biggest TAM lift available.

## Phase C — Cloud GPU provisioning

Once remote hosts work, treat a cloud GPU instance as a host that
Blueprint provisions on demand instead of one the user pre-owns.

**C1. Provider abstraction**
- `internal/cloud` interface: Provision / Terminate / List / Stop /
  Resume / Pricing
- Concrete providers: Lambda Labs (cheapest H100), Runpod (best UX),
  Vast.ai (cheapest community)
- Skip AWS/GCP/Azure for v1 — their GPU pricing is 2-5× higher and
  the API surface is much bigger

**C2. Cloud-init bootstrap**
- The provider's "user-data" script runs at boot:
  - Install Blueprint runtime + svc
  - Generate Ed25519 keypair, register pubkey via instance metadata
  - Open the svc control plane on the public network (not loopback)
  - Start systemd unit
- GUI polls instance metadata until pubkey is registered, then
  connects

**C3. Cloud cost panel**
- Real-time spend tracking per active instance
- Auto-stop on idle (configurable: stop the instance if no requests
  for N minutes)
- Budget alarms ("you've spent $X this month")

**C4. Spot / interruption handling**
- For spot instances, persist serve config so a re-provision picks
  up where it left off
- Auto-redeploy on interruption (optional)

**C5. Storage strategy**
- Models are 20-100GB each; downloading them on every provision is
  expensive
- Provider-specific persistent volume integration (Lambda Labs:
  attach volume; Runpod: network volume)
- Fall back to: download once per session and discard

**Estimate: ~6-8 weeks**. Unlocks the "calibrate this on an H100 for
2 hours, then shut it down" workflow — turns the consulting demo into
a self-service product.

## Phase D — Fleet management

Once N hosts (remote + cloud) are in the registry, treat them as a
pool.

**D1. Multi-host Dashboard**
- One screen, all hosts, sortable by load/cost/GPU type
- Aggregated metrics: total VRAM, total throughput, total spend

**D2. Cross-host model deployment**
- Push the same model + serve config to N hosts in one action
- Blue/green updates: roll the new model to host A, drain to it,
  retire host B

**D3. Cross-host routing**
- Extend `internal/router` to load-balance across hosts in addition
  to across model sizes
- Failover policy

**D4. Calibration runs across hosts**
- Calibration on a 70B is GPU-heavy; user wants to run it on a
  cloud H100 even if their serve workload runs on-prem
- "Run calibrate on host X, save artifacts to host Y"

**Estimate: ~3 weeks** (after B + C land). Adds little marginal cost
since the infrastructure is in place from B and C.

## Phase E — Blueprint Cloud (managed SaaS)

Customer doesn't bring their own hardware. They pay us a per-token
or per-hour rate and we manage everything.

**E1. Decision: do we build this?**
- This is a different business model than the desktop product
- Direct competitors: Together AI, Modal, Replicate, Anyscale
- The differentiator is "the same Blueprint optimizations as your
  on-prem, just hosted" — same imatrix, same LoRA, same routing
- High moat for existing Blueprint customers; low moat against
  new entrants

**E2. If yes**:
- Multi-tenant runtime on top of K8s (we'd write a Helm chart for
  the kernel)
- Per-customer license + cost
- Different pricing model (per-token, per-hour, or seat + usage)
- New surface: web app for the SaaS (NOT bundled with llmblueprint.ai)

**Recommendation**: defer this until we have ≥ 50 paying Pro
customers. Don't compete with Together AI from a standing start.

## Implication for pricing tiers

Adding remote + cloud changes the tier math:

| Tier today | Today's value | After Phase B + C |
|---|---|---|
| Personal Free | Local-only, all features | Local-only, all features (unchanged) |
| Pro $39/mo | Local commercial use | + 1 remote host included |
| Team $290/mo | 5 commercial seats | + 5 remote hosts pooled |
| Enterprise $25k/yr | Self-hosted control | + cloud provider integration with cost passthrough |

The cloud spend is passed through to the customer's cloud account
(we provision in **their** Lambda Labs / Runpod account using their
API key, not ours). We don't take a margin on cloud GPU spend — that
would put us in the SaaS-arbitrage business.

## What blocks starting

| Phase | Pre-reqs |
|---|---|
| A | Fix CI for Linux release + private kernel auth (already a known blocker) |
| B | A complete |
| C | B complete + Lambda Labs / Runpod API keys for testing |
| D | B + C complete |
| E | Strategic decision; commercial validation of A-D first |

## Order of operations

```
A (1 week) → B (3-4 weeks) → C (6-8 weeks) → D (3 weeks) → E (TBD)
```

Critical path to "consultants can use Blueprint to manage client
on-prem servers": **A + B**, ~5 weeks of focused work.

Critical path to "self-service GPU calibration runs from the GUI":
**A + B + C**, ~12 weeks.
