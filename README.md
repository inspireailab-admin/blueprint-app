# Blueprint

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/inspireailab-admin/blueprint-app)](https://github.com/inspireailab-admin/blueprint-app/releases)

**Blueprint is an open-source desktop toolkit to run, tune, and operate open LLMs on your own hardware.** Plan a model, size the hardware, deploy locally or to a fleet of GPU boxes over SSH, calibrate quantizations against your prompts, fine-tune LoRAs on your data, and monitor it all from one place — without a CLI, without bash plumbing, without your data leaving your network.

Built and maintained by [Inspire AI Lab](https://inspireailab.com) — the toolkit we use on every LLM optimization engagement.

---

## What it does

- **Plan** — curated catalog of open models with per-quant VRAM math, hardware-tier recommendations, and on-prem-vs-cloud cost comparisons.
- **Deploy** — one-click `llama.cpp` install + GGUF download + supervised serve, OpenAI-compatible API on a port you choose. Multi-engine path (vLLM, TensorRT-LLM) for production tiers.
- **Tune** — custom imatrix calibration against your prompts; LoRA / QLoRA fine-tuning via a bundled Python sidecar; LLMLingua prompt compression.
- **Operate (fleet)** — register Linux GPU hosts, push-install Blueprint over SSH, manage them from one dashboard. Pull models directly onto remote hosts; stream chat through the same SSH tunnel.
- **Monitor** — live GPU / VRAM / RAM, NVIDIA + AMD ROCm + Apple Silicon detection, llama-server Prometheus metrics surfaced in-app.

## Install

Pre-built binaries for Windows, macOS, and Linux on the [releases page](https://github.com/inspireailab-admin/blueprint-app/releases).

CLI-only path (no GUI) via the kernel:

```sh
# macOS / Linux
curl -sSL https://llmblueprint.ai/install.sh | sh

# Windows (PowerShell)
iwr -useb https://llmblueprint.ai/install.ps1 | iex
```

## Build from source

```sh
# Prereqs: Go 1.24+, Node 20+, pnpm 10+
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# Live-reloading dev window
wails dev

# Production build for the current OS
wails build
# → build/bin/blueprint(.exe)
```

On Linux you also need `libwebkit2gtk-4.1-dev` (Ubuntu/Debian) or the equivalent WebKit2GTK headers for your distro.

## Architecture

```
blueprint-app/
├── main.go                          # Wails entry point + window options
├── app.go                           # IPC binding surface (App struct)
├── internal/
│   ├── hosts/                       # Persisted SSH host registry
│   ├── svcapi/                      # blueprint-svc HTTP control plane
│   ├── svcclient/                   # SSH-tunneled client into svcapi
│   ├── secrets/                     # OS-keychain svc-token cache
│   ├── calibration/                 # Custom imatrix calibration
│   ├── engines/                     # llama.cpp / vLLM / TensorRT-LLM drivers
│   ├── router/                      # Semantic routing between models
│   ├── promptcache/                 # KV-state cache for shared prefixes
│   ├── remotes/                     # OpenAI-compatible remote endpoints
│   └── pyruntime/                   # Bundled Python sidecar manager
├── cmd/
│   └── blueprint-svc/               # Headless control plane (push-installed
│                                    # onto remote hosts)
└── frontend/
    └── src/                         # React 19 + Vite + Tailwind v4
```

Anything exposed as a method on `App` in `app.go` becomes callable from the frontend via `import { Method } from '../wailsjs/go/main/App'`. Wails regenerates those bindings on every build.

The CLI kernel lives in [`inspireailab-admin/blueprint-cli`](https://github.com/inspireailab-admin/blueprint-cli) — the same code path powers both the desktop app and the standalone CLI.

## Consulting

We're [Inspire AI Lab](https://inspireailab.com). We run LLM optimization engagements — calibration, fine-tuning, production deployment, ongoing operations — using Blueprint end-to-end. If you'd rather hand the engagement to us instead of running it yourself, [book a 30-minute review](https://llmblueprint.ai/demo).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: issues and PRs welcome, **responses as time permits alongside paid engagements** — please don't expect same-day turnaround. Issues that are actually requests for custom work get labeled `needs-consultation` and pointed at our services page.

## License

Apache 2.0 — see [LICENSE](LICENSE).

Copyright © 2026 Inspire AI Lab LLC.
