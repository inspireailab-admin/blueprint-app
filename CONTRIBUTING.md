# Contributing to Blueprint

Thanks for the interest. A few up-front notes so expectations line up.

## How this project is maintained

Blueprint is built and maintained by [Inspire AI Lab](https://inspireailab.com) alongside our consulting engagements. That means:

- **Responses are best-effort, not SLA-backed.** Issues and PRs land on the queue but may sit for days or weeks during heavy engagement periods.
- **Bug reports beat feature requests.** A clear reproduction with version + OS + logs is the fastest path to a fix.
- **Custom-feature asks get triaged to `needs-consultation`.** If you need something built that isn't on the public roadmap, [book a demo](https://llmblueprint.ai/demo) and we'll scope an engagement instead.

## Reporting bugs

Open an issue with:

1. Blueprint version (Help → About, or `git rev-parse HEAD` if building from source)
2. OS + version (`uname -a` / Windows build / macOS version)
3. GPU(s) if relevant (`nvidia-smi`, `rocm-smi`, or `system_profiler SPDisplaysDataType` output)
4. Exact reproduction steps
5. Logs from `~/.blueprint/logs/` if the issue involves the svc control plane

## Pull requests

Before sending a large PR, **open an issue first** to confirm the change fits the project's direction. Small PRs (typos, missing nil checks, doc fixes) can land directly.

When you do open a PR:

- Run `go build ./...` and `go vet ./...` — both must pass
- Run `gofmt -w .` on touched files
- For frontend changes: `cd frontend && pnpm tsc --noEmit` must pass
- Keep commits focused; one logical change per commit beats one mega-commit

## Code style

- **Go**: standard `gofmt` + `go vet`. Comments explain *why*, not *what* — the code says what it does.
- **TypeScript**: types over `any`. Components in `frontend/src/<feature>/` colocated with their state.
- **Commits**: short subject line in present tense (`feat(svc): add /v1/pull`), body explains motivation if non-obvious.

## Security issues

Don't open public issues for security problems. Email security@inspireailab.com instead.

## License

By submitting a contribution, you agree it's released under the [Apache 2.0 License](LICENSE).
