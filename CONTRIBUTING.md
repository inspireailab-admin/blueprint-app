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

## Adding a help article to a card

Every card / section in the desktop UI gets a `?` icon in its header
that opens a how-to article on [llmblueprint.ai](https://llmblueprint.ai/how-to)
in the user's default browser. Two steps to wire one up:

1. **Write the article** at `blueprint-site/content/how-to/<slug>.mdx`
   with the standard frontmatter (`title`, `date`, `category`,
   `author`, `excerpt`). Categories for how-to are listed in
   `blueprint-site/lib/content/types.ts` under `HOWTO_AREAS`. Aim
   for ~300-600 words structured as **Background → How to use →
   Common pitfalls**.

2. **Add the button** to the card's header in `frontend/src/`:

   ```tsx
   import { HelpButton } from '../help/HelpButton'

   // Inside the card's <header>, alongside the title:
   <div className="flex items-center gap-2">
     <h2 className="text-base font-semibold tracking-tight">My feature</h2>
     <HelpButton slug="my-feature" label="My feature" />
   </div>
   ```

The slug must match the MDX filename. `BrowserOpenURL` opens the URL
in the user's default browser; no markdown rendering or content
bundling happens in the desktop binary itself.

## Security issues

Don't open public issues for security problems. Email security@inspireailab.com instead.

## License

By submitting a contribution, you agree it's released under the [Apache 2.0 License](LICENSE).
