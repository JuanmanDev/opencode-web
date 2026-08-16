# Contributing

Thanks for helping improve opencode web!

## Development setup

```sh
npm install
npm run mock          # terminal 1: mock opencode API on :4517
NUXT_OPENCODE_URL=http://127.0.0.1:4517 npm run dev   # terminal 2
```

Or point `NUXT_OPENCODE_URL` at a real `opencode serve` instance (see `.env.example`).

## Tests

```sh
npm run typecheck     # vue-tsc
npm run test:unit     # vitest
npm run build && npm run test:e2e   # playwright against the mock server
```

E2E tests run against the production build with the bundled mock opencode server — no API keys needed.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org) — releases and the changelog are generated automatically by semantic-release.

| Prefix | Effect |
| --- | --- |
| `fix: …` | patch release |
| `feat: …` | minor release |
| `feat!: …` or `BREAKING CHANGE:` footer | major release |
| `docs:` `chore:` `refactor:` `test:` `ci:` | no release |

Examples:

```
feat(chat): add per-conversation MCP selection
fix(proxy): buffer request bodies to avoid chunked upload failures
docs: explain traefik + tinyauth setup
```

## Pull requests

- Keep PRs focused; one topic per PR.
- CI must pass: typecheck, unit, e2e, docker build, commitlint.
- Screenshots for UI changes are appreciated (CI regenerates the official ones on release).
