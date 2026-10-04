# opencode compatibility

opencode web works with **every opencode 1.x server** and with servers that only speak opencode's **v2 protocol** (`/api/*`). The web app's server works out which API the opencode server speaks and adapts, so the UI behaves the same everywhere. Features a server doesn't have are hidden instead of failing.

## What is tested

The compat suite (`playwright.compat.config.ts`) runs the real `opencode serve` of a given version against a deterministic mock model (`scripts/mock-llm.mjs`). It then drives the UI and the APIs:

- detecting the protocol
- a streamed reply, with the prompt box unlocking afterwards
- a bash tool call behind a permission prompt
- the question tool
- reloading the page while a permission is pending
- the REST prompt endpoint and the MCP `send_prompt` tool, both of which wait for the reply

| opencode | API | result |
| --- | --- | --- |
| 1.0.0 (first 1.x release) | 1.x | ✅ all pass |
| 1.1.65 | 1.x | ✅ all pass |
| 1.4.17 | 1.x | ✅ all pass |
| 1.18.34 | 1.x | ✅ all pass |
| 1.18.34, forced to v2 (`NUXT_OPENCODE_PROTOCOL=v2`) | v2 `/api/*` | ✅ all pass |

CI runs 1.0.0, 1.4.17, 1.14.51 and the latest release on the 1.x API, plus the latest release on v2. It also runs every week, so a new opencode release that breaks something shows up before you update.

```sh
npm run build
OPENCODE_VERSION=1.4.17 npx playwright test -c playwright.compat.config.ts
OPENCODE_VERSION=latest COMPAT_PROTOCOL=v2 npx playwright test -c playwright.compat.config.ts
```

## How the protocol is chosen

`NUXT_OPENCODE_PROTOCOL` (default `auto`):

| value | behaviour |
| --- | --- |
| `auto` | `GET /global/health` answers → **1.x API** (its `version` is shown on the home page). Otherwise `GET /api/health` answers → **v2**. Servers older than 1.0.224 have no health route and are recognized by their 1.x routes. |
| `legacy` | always the 1.x API |
| `v2` | always the v2 protocol, even on 1.18+ servers that serve both |

The verdict is cached for a minute and re-checked whenever the health endpoint is called. `GET /api/health` on the web app reports `protocol` and `version`. `GET /api/v1/capabilities` lists which features the UI shows.

### Servers that speak both (1.18+)

opencode 1.18 serves the 1.x API **and** the v2 protocol. The web app uses the 1.x API there, because the v2 engine in 1.18 has no MCP support yet. Sessions that the new v2 engine runs (for example from opencode's new terminal UI) still show up correctly:

- their live `session.next.*` events are translated on the fly
- their messages are loaded from `/api` when the 1.x route returns nothing

## Differences between 1.x versions

All of these are handled; they matter only if you script against opencode yourself.

| change | since | handling |
| --- | --- | --- |
| text streams as `message.part.delta` events; `message.part.updated` only arrives at the start and the end of a part | 1.2 | deltas are applied live (before this fix, replies appeared all at once on ≥ 1.2) |
| unknown routes answer `200 text/html` (the server's own web UI) | ≈ 1.4 | the proxy turns that into a 404 instead of handing HTML to the UI |
| `GET /global/health` with `version` | 1.0.224 | older: detected through `/config` |
| `permission.updated` → `permission.asked` / `permission.replied`, `GET /permission`, `POST /permission/{id}/reply` | 1.0.224 | both event names are handled; replies use `POST /session/{id}/permissions/{id}`, which every version has |
| `question` tool, `GET /question`, `question.*` events | 1.1.65 | the question card simply never appears on older servers |
| MCP add / connect / disconnect / OAuth routes | 1.0.142 | on 1.0.0 these MCP page actions report an error; status and toggles work |
| `GET /global/config` (MCP page **Global** scope) | 1.1.65 | the project scope works everywhere |
| `GET /session/{id}/diff` | all | the UI used `POST`, which never existed (fixed) |

## The v2 protocol (opencode 2.x)

v2 is a different API: everything sits under `/api/*`, the project comes from `location[directory]`, a single global event stream carries `session.next.*` events, and the message model is new. The web app translates all of it, so the UI keeps its usual shapes. Requests, events and the message/part model are covered in the maintainer reference [compat/opencode-v2.md](compat/opencode-v2.md).

What v2 servers (as of 1.18.34) don't offer, and what the UI does instead:

| feature | on v2 |
| --- | --- |
| MCP servers, MCP UI apps, per-chat MCP selection | not available: the v2 engine only uses its built-in tools. The MCP page explains this and MCP controls are hidden |
| reading / editing opencode config | not available; the last model you used per project is remembered by the web app |
| renaming and deleting sessions, automatic titles | emulated: titles come from the first prompt line and renames are stored by the web app; delete hides the session |
| fork, share, diff, `!shell` | hidden |
| slash commands | expanded by the web app from the server's command templates (`$ARGUMENTS`, `$1…`) |
| `/compact` | the server answers "not available yet" on 1.18.34; the message is shown |
| undo / redo | supported (staged revert, committed on the next prompt) |
| busy / idle | derived from step events and `GET /api/session/active` |
| cost | not reported by the server (always 0) |
