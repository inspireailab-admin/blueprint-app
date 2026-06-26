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

## Phase B — Remote Linux from the desktop GUI ✅ SHIPPED (2026-06-26)

The user runs the desktop app on Windows / macOS, but the LLM runs on
a Linux server they own (rented Hetzner box, on-prem rack, home
server). This is the most common ask from solo consultants and small
platform teams.

End-to-end flow now works: add host → push-install → connect → see
live status → start a model → chat with it. From a Windows laptop you
can stand up and drive a model on a remote Linux box without opening
a terminal.

**B.1 — Hosts registry + sidebar** ✅ shipped commit `bc51ae8`
- `internal/hosts` package mirrors `internal/remotes`. Persists to
  `~/.blueprint/hosts.json` (label, user, host, port, key path, role,
  provenance, last-seen).
- New Hosts sub-tab in the Dashboard with add form, role badges, empty
  state, and per-row Remove.

**B.2 — SSH connect + test-connect + push-install** ✅ shipped commit `99a1bce`
- `internal/ssh` wraps `golang.org/x/crypto/ssh`: Dial with key-file
  OR ssh-agent auth, Run, RunStream with per-line callbacks, WriteFile
  via `tee`, ReadFile via `cat`, DialTCP for tunneling.
- Test connect: SSH session, `uname -a`, `/etc/os-release`, `nproc`,
  `MemTotal`, optional `nvidia-smi`. Updates LastSeenAtMs on success.
- Push-install: SCPs install-linux.sh and the embedded
  blueprint-svc-linux binary to /tmp, runs under sudo, streams output
  via the `host:install:line` Wails event.

**B.3 — Bearer-auth HTTP control plane on blueprint-svc** ✅ shipped commits `a353338` + `35bd91f`
- 127.0.0.1:17832 only — never the public interface. Bearer token
  persisted at `~/.blueprint/svc-token` (0600). Same trust model as
  docker.sock.
- Read endpoints: `/v1/health`, `/v1/info` (svc status + host
  metadata), `/v1/models` (.gguf on disk, catalog-cross-referenced
  for display names).
- Write endpoints: `/v1/serve` (POST a partial svcconfig.Config; the
  supervisor picks up the new config in ~5s) and `/v1/stop` (delete
  config; supervisor stops the child).
- Snapshot endpoint: `/v1/snapshot` returns CPU%, RAM% used/total,
  per-GPU snapshot via `nvidia-smi`. gopsutil for CPU/RAM.
- `/llama/*` reverse-proxy to the supervised llama-server with auto-
  injected APIKey. SSE-friendly flush interval so streamed chat
  travels through unmodified.

**B.4 — SSH-tunneled svc client + Connect button** ✅ shipped commit `1ab6b9a`
- `internal/svcclient`: http.Client with a custom Transport.DialContext
  routing through the SSH connection. From caller code it looks like a
  normal HTTP client; under the hood every byte goes through the same
  SSH session.
- ConnectHost dials SSH, `cat`s the svc token, hits `/v1/health` to
  confirm the control plane is alive. Disconnect closes both.
- Pool keyed by host ID — at most one connection per registered host.
  IsHostConnected lets the UI restore per-host pill state on mount.

**B.5 — Host selector + remote-aware Dashboard** ✅ shipped commits `95985ea` + `f345426` + `06d2392` + `12101fb` + `23b1c88`
- Host selector dropdown in the title bar (Local + each connected
  host). Banner above the Dashboard so the user can't lose track of
  which host they're operating on.
- Overview: live `/v1/info` poll, server card with Phase + model +
  PID + bind address, Start a model (picker pulls from
  RemoteHostModels) → POST `/v1/serve`, Stop → POST `/v1/stop`. Live
  system tiles for CPU% + RAM% + per-GPU utilization and VRAM.
- Models: lists everything on the remote's disk (catalog-matched
  display name + quant pill + file size).
- Inference: streamed chat via `/llama/*` proxy. SSE chunks arrive
  through the SSH tunnel and the assistant message updates in place.
  Full sampling controls (temp, max tokens, top-k, top-p, min-p,
  repeat, presence, frequency, seed, stops, system prompt).

**B.6 — Embed blueprint-svc-linux in the desktop app** ✅ shipped commit `e837d7c`
- Cross-compiled svc binary embedded via `go:embed` so push-install
  works without the user pre-staging anything. CI cross-compiles on
  every matrix OS so the wails build always finds the embedded asset.

**Deferred from the original scope**

The original B5 ("Auth + secrets") was scoped to OS-keychain
encryption (DPAPI / macOS Keychain / libsecret) for the host registry.
We landed somewhere defensible without it for v1: the registry only
stores **non-secret** material (label, user, host, port, *path* to
key file, role) — same trust model as `~/.ssh/config`. The svc bearer
token is fetched fresh per session via SSH `cat ~/.blueprint/svc-token`
and held in memory in the svcclient.Client; on Disconnect the client
is GC'd and the token goes with it. Nothing secret touches the host
registry on disk.

Keychain integration is still worth doing — would let the GUI **remember**
the svc token between sessions instead of re-fetching every Connect —
but it's not blocking shipping.

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
