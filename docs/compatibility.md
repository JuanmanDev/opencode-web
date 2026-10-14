# opencode compatibility

opencode web works with **every opencode 1.x server** and with **opencode 2.x**, which only speaks the v2 API (`/api/*`). The web app's server works out which API the opencode server speaks and adapts, so the UI behaves the same everywhere. Features a server doesn't have are hidden instead of failing.

| server | package | API the web app uses | everything works? |
| --- | --- | --- | --- |
| opencode 1.x | `opencode-ai` | 1.x API (`/session`, `/config`, `/mcp`…) | ✅ yes |
| opencode 1.18 / 1.19 forced to v2 (`NUXT_OPENCODE_PROTOCOL=v2`) | `opencode-ai` | the early v2 API (`/api/*`) | ⚠️ chat yes; no MCP, no subagents, no config (missing from that engine, see below) |
| opencode 2.x | `@opencode/cli` | v2 API (`/api/*`) | ✅ yes, MCP, config, subagents and reloads included |

## What is tested

The compat suite (`playwright.compat.config.ts`) runs the real `opencode serve` of a given version against a deterministic mock model (`scripts/mock-llm.mjs`). It then drives the UI and the APIs:

- detecting the protocol
- a streamed reply, with the prompt box unlocking afterwards
- a shell tool call behind a permission prompt, and the page reloading while it is pending
- the question tool (a form on 2.x)
- the REST prompt endpoint and the MCP `send_prompt` tool, both of which wait for the reply
- a scheduled prompt
- **agent control**: the chat calling this app's MCP tools
- **subagents**: the child session, its card in the chat and the way back to the parent
- **MCP servers**: add one, test it, reload opencode, still connected

| opencode | API | result |
| --- | --- | --- |
| 1.0.0 (first 1.x release) | 1.x | ✅ UI and API compatible; ⚠️ tool calls fail **inside opencode** with current provider packages (see below) |
| 1.1.65 | 1.x | ✅ all pass |
| 1.4.17 | 1.x | ✅ all pass |
| 1.19.0 | 1.x | ✅ all pass |
| 1.19.0, forced to v2 | early v2 | ✅ all pass; agent control and subagents skipped (that engine has neither) |
| 2.0.29 | v2 | ✅ all pass |

CI runs 1.1.65, 1.4.17, 1.14.51 and the latest 1.x release on the 1.x API, the latest 1.x forced to v2, and opencode 2.0.29 plus the latest 2.x. It also runs every week, so a new opencode release that breaks something shows up before you update.

```sh
npm run build
OPENCODE_VERSION=1.4.17 npx playwright test -c playwright.compat.config.ts
OPENCODE_VERSION=latest COMPAT_PROTOCOL=v2 npx playwright test -c playwright.compat.config.ts
OPENCODE_VERSION=2.0.29 npx playwright test -c playwright.compat.config.ts   # opencode 2.x
```

The test project lives in `<tmp>/opencode-web-compat` (`COMPAT_ROOT` overrides it), outside any checkout: opencode 2.x reads `opencode.json` from every folder above the project.

> **opencode 1.0.x and today's providers:** 1.0.x is built on AI SDK 5. The `@ai-sdk/*` provider packages it downloads today implement a newer model spec, so the server logs `Unsupported model version v4 … AI SDK 5 only supports … "v2"` and its tool steps fail (`DecimalError`). opencode web shows that error with Retry / Continue; the fix is to upgrade opencode.

## How the protocol is chosen

`NUXT_OPENCODE_PROTOCOL` (default `auto`):

| value | behaviour |
| --- | --- |
| `auto` | `GET /global/health` answers with JSON → **1.x API** (its `version` is shown on the home page). Otherwise `GET /api/info` answers → **opencode 2.x**, or `GET /api/health` → the early v2 API of a 1.x server. Servers older than 1.0.224 have no health route and are recognized by their 1.x routes. |
| `legacy` | always the 1.x API |
| `v2` | always a v2 API, even on 1.18+ servers that serve both; 2.x and the early v2 API are still told apart |

The verdict is cached for a minute and re-checked whenever the health endpoint is called. `GET /api/health` on the web app reports `protocol`, `version` and `dialect` (`1.18` or `2`). `GET /api/v1/capabilities` lists which features the UI shows.

### Servers that speak both (1.18, 1.19)

opencode 1.18 and 1.19 serve the 1.x API **and** an early version of the v2 API. The web app uses the 1.x API there, because that early v2 engine has no MCP, no subagent tool and no config API. Sessions that the new engine runs (for example from opencode's new terminal UI) still show up correctly:

- their live `session.next.*` events are translated on the fly
- their messages are loaded from `/api` when the 1.x route returns nothing

## opencode 2.x

opencode 2.x (`npm i -g @opencode/cli`, or `OPENCODE_PACKAGE=@opencode/cli` when building `Dockerfile.opencode`) only serves the v2 API. The web app translates requests, events and messages, so the UI keeps its usual shapes:

| feature | how it maps |
| --- | --- |
| chat, streaming, reasoning, tools | `session.*` events and the 2.x message model, translated to the 1.x shapes |
| questions | 2.x asks through **forms** (`/api/form`); they render as the usual question card |
| permissions | `permission.asked`, replies with `{decision}` |
| sessions | real rename, delete and fork; diff, `!shell` and slash commands through their own routes |
| subagents | the `subagent` tool and child sessions (`?parentID=`), same card and links as 1.x |
| MCP servers | `GET /api/mcp`, `PUT/DELETE /api/experimental/mcp/{name}`, connect / disconnect |
| config | read from `GET /api/config`; edits are merged into the right `opencode.json` and written with `/api/experimental/fs/write`, then `POST /api/location/reload` |
| reload opencode | `POST /api/location/reload` |
| skills, agents, commands, default model | their `/api/*` routes |

Where config edits go on 2.x:

- **project**: `opencode.json` inside the opened folder (created if missing), like 1.x
- **global**: the `opencode.json` in opencode's global config folder (`~/.config/opencode`)
- `opencode.json` files in folders **above** the project are loaded by 2.x but never written by the web app: they may belong to another project or be your own
- a server's MCP entry is written 1.x-style unless it uses a 2.x-only option (`codemode`), which 2.x would drop from a 1.x-style entry: those go under `mcp.servers`
- comments in an `opencode.jsonc` are not kept when the web app rewrites it

What 2.x still lacks: session sharing (hidden), and MCP OAuth sign-in from the web (2.x moved it to integrations: run `opencode mcp auth <name>` on the server). MCP tools are offered to the model through 2.x's `execute` code tool unless the server sets `codemode: false`; agent control sets it so each state-changing tool keeps its own permission prompt.

## The early v2 API of 1.18 / 1.19

Forcing `NUXT_OPENCODE_PROTOCOL=v2` on a 1.18 or 1.19 server uses its early v2 engine. It is useful for testing, not for daily use. What that engine doesn't offer, and what the UI does instead:

| feature | on the early v2 API |
| --- | --- |
| MCP servers, MCP UI apps, per-chat MCP selection | not available: the engine only offers its built-in tools. The MCP page explains this and MCP controls are hidden |
| subagents | not available: the engine has no subagent tool |
| reading / editing opencode config, reloading it | not available; the last model you used per project is remembered by the web app |
| renaming and deleting sessions, automatic titles | emulated: titles come from the first prompt line and renames are stored by the web app; delete hides the session |
| fork, share, diff, `!shell` | hidden |
| slash commands | expanded by the web app from the server's command templates (`$ARGUMENTS`, `$1…`) |
| `/compact` | the server answers "not available yet"; the message is shown |
| undo / redo | supported (staged revert, committed on the next prompt) |
| busy / idle | derived from step events and `GET /api/session/active` |
| cost | not reported by the server (always 0) |
| agent control MCP tools | sessions, transcripts, busy status, tasks, skills, agents, commands, models and schedules work; MCP, config and reload tools explain that this API lacks them |
| scheduled prompts | supported |

Requests, events and the message/part model of both v2 dialects are covered in the maintainer reference [compat/opencode-v2.md](compat/opencode-v2.md).

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

### Routes older 1.x servers may lack

Verified on 1.19.0; on older servers that lack a route, the web app falls back:

| feature | route | fallback |
| --- | --- | --- |
| busy sessions | `GET /session/status` | derived from each recent session's last assistant message |
| reload all projects | `POST /global/dispose` | every known project is reloaded one by one (`/instance/dispose`) |
| MCP entries with `oauth: false` / `timeout` | config schema | the server editor saves without the key the server rejects and says so |
| skills | `GET /skill` | `list_skills` reports that the server has no skills API |
| git / LSP / formatter status in `server_info` | `/vcs`, `/lsp`, `/formatter` | left out |
