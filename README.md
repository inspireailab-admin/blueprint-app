# Blueprint

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

**Blueprint is a cross-platform desktop application for running open LLMs on your own hardware.** Plan a model, size the hardware, deploy locally, monitor, and maintain — in one app, without a CLI or the bash-plumbing.

> ⚠️ **In active build (Phase 1).** This is the scaffolding commit — the app shell + kernel binding work, the per-tab functionality lands in subsequent phases. See [Roadmap](#roadmap) for what ships when.

---

## What this is

- A **Wails 2** desktop app: Go backend + React/Vite frontend, compiled to a native binary per OS.
- The Go side imports the [`inspireailab-admin/blueprint`](https://github.com/inspireailab-admin/blueprint) kernel directly — same code that powers the public CLI's `pull` / `runtime install` / `serve` also powers the app's Deploy tab.
- Frontend stack: React 19, Vite 7, TypeScript 5, Tailwind v4.

## Roadmap

| Phase | What ships |
|---|---|
| **1 — Scaffold** *(this commit)* | App shell, tab nav, kernel-bind IPC roundtrip, cross-platform build pipeline. |
| **2 — Plan** | Catalog browser, faceted filters, ranked results, model detail pane. |
| **3 — Hardware** | VRAM utilization chart, three-tier recommendations, what-if sliders. |
| **4 — Deploy** | Detect GPU, install llama.cpp, pull model, supervise `llama-server`. |
| **5 — Monitor** | Live GPU / VRAM / RAM / CPU / tokens-per-second. |
| **6 — Maintain** | Update runtime, swap models, restart, tail logs. |
| **7 — Distribution** | Signed installers (Windows EV, macOS notarized, Linux `.deb` + AppImage), auto-update. |
| **8 — Polish + launch** | First-run experience, crash reporting, ready for v1. |

## Development

```sh
# Prerequisites
go install github.com/wailsapp/wails/v2/cmd/wails@latest
# Plus: Go 1.23+, Node 20+, pnpm 10+

# Live-reloading dev window
wails dev

# Production build for the current OS
wails build
# → build/bin/blueprint(.exe)
```

The `wails dev` command starts the Vite dev server, the Wails Go process, and a hot-reloading window — frontend edits show up instantly, Go changes trigger a rebuild.

## Architecture

```
blueprint-app/
├── main.go                          # Wails entry point + window options
├── app.go                           # IPC binding surface (App struct)
├── frontend/
│   ├── src/
│   │   ├── App.tsx                  # React root + tab shell
│   │   ├── main.tsx                 # Vite entry
│   │   └── style.css                # Tailwind v4 + globals
│   ├── wailsjs/                     # Auto-generated Go ↔ TS bindings (gitignored)
│   ├── package.json
│   └── vite.config.ts
└── build/
    └── bin/                         # Compiled binaries (gitignored)
```

Anything exposed as a method on `App` in `app.go` becomes callable from the frontend via `import { Method } from '../wailsjs/go/main/App'`. Wails regenerates those bindings on every build.

## Related

- **[`inspireailab-admin/blueprint`](https://github.com/inspireailab-admin/blueprint)** — the CLI + kernel library this app imports. Apache 2.0.
- **[`inspireailab.com`](https://inspireailab.com)** — the marketing site, the Plan + Hardware/Cost web flow that walks visitors to this app.

## License

Apache 2.0 — see [`LICENSE`](LICENSE).

Copyright © 2026 Inspire AI Lab LLC.
