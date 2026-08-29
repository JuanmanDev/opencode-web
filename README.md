<div align="center">

# ⌨️ opencode web

<br>

## 💖 Support this project
If you found this project helpful, please consider supporting it!

[![GitHub Sponsor](https://img.shields.io/badge/Sponsor-JuanmanDev-ea4aaa?style=for-the-badge&logo=github)](https://github.com/sponsors/JuanmanDev) [![Ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/juanmandev) [![PayPal](https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://paypal.me/juanmandev)

<br>


**A better self-hosted web UI for [opencode](https://opencode.ai)** — chat with your AI coding agent from any device, manage projects and MCP servers, behind your own reverse proxy.

[![CI](https://github.com/JuanmanDev/opencode-web/actions/workflows/ci.yml/badge.svg)](https://github.com/JuanmanDev/opencode-web/actions/workflows/ci.yml)
[![Release](https://github.com/JuanmanDev/opencode-web/actions/workflows/release.yml/badge.svg)](https://github.com/JuanmanDev/opencode-web/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/JuanmanDev/opencode-web?display_name=tag&sort=semver)](https://github.com/JuanmanDev/opencode-web/releases)
[![Docker](https://img.shields.io/badge/ghcr.io-opencode--web-blue?logo=docker)](https://github.com/JuanmanDev/opencode-web/pkgs/container/opencode-web)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Built with **Nuxt 4 + Nuxt UI**, keeping the opencode look & feel.

<img src="docs/screenshots/chat.png" alt="Chat view" width="800" />

<sub>Screenshots are generated automatically by CI on every release.</sub>

</div>

## Why

The stock opencode web UI talks to the opencode server **directly from the browser**, which breaks behind forward-auth proxies (tinyauth, Authelia…) and needs CORS setup. This app puts a **same-origin Nitro proxy** in front: the browser only ever talks to the Nuxt app, which injects opencode's basic-auth credentials server-side.

One origin → no CORS, no double auth, SSE streaming included. **Works behind Traefik + tinyauth out of the box.**

## Features

|  |  |
| --- | --- |
| 🗂️ **Project picker** | Start page with known projects + recents, open any folder by path or browse the server filesystem. Everything is scoped per project via opencode's `?directory=` API. |
| 💬 **Live chat** | SSE streaming: markdown, collapsible thinking, tool calls with input/output, per-step tokens & cost, abort, permission prompts (allow once / always / reject). |
| 🧠 **Model + think level** | Model picker across all providers with pricing & context details, think-level selector for reasoning models, agent picker. Persisted per project. |
| 🔌 **MCP manager** | Per-project MCP status, enable/disable toggles, add remote/local servers, and **per-conversation MCP selection** in the prompt box. Tool lists are discovered from the servers themselves — over HTTP for remote ones, over stdio for local ones — because opencode exposes no MCP tool ids. Broken servers get inline **Retry** and OAuth **Sign in** actions. |
| 🧩 **MCP UI / apps** | Tool results with `ui://` resources render live in sandboxed iframes: **MCP Apps** (SEP-1865 template + JSON-RPC host, theme & display-mode aware), mcp-ui **raw HTML**, **external URLs** and **remote-dom** components. Tools that declare a UI are flagged in discovery (**UI** badge) so their app is recovered even when opencode strips it. Side panel / fullscreen viewer with shareable `?app=` links. A built-in demo server (`/mcp-demo`) showcases every flavour. |
| 🔑 **Provider config from the UI** | "Configure providers…" right inside the model dropdown: add or update API keys without touching the server. |
| 📱 **Fully responsive** | Desktop sidebar (resizable, collapsible to an icon rail, optional projects panel) becomes a slideover on mobile — continue any session from your phone. |
| 🛡️ **Health aware** | Fail-fast proxy, "server not responding" states everywhere, auto-recovering error modal, reply chime. |

<table>
  <tr>
    <td><img src="docs/screenshots/home.png" alt="Project picker" /></td>
    <td><img src="docs/screenshots/mcp.png" alt="MCP manager" /></td>
    <td><img src="docs/screenshots/mobile.png" alt="Mobile" width="180" /></td>
  </tr>
  <tr align="center">
    <td>Project picker</td>
    <td>MCP manager</td>
    <td>Mobile</td>
  </tr>
</table>

## Quick start (Docker Compose)

```sh
git clone https://github.com/JuanmanDev/opencode-web.git
cd opencode-web
cp .env.example .env   # set OPENCODE_SERVER_PASSWORD, PROJECTS_DIR, WEB_DOMAIN, provider keys
docker compose up -d --build
```

Or use the prebuilt images:

```yaml
services:
  opencode:
    image: ghcr.io/juanmandev/opencode-web-server:latest
    environment:
      OPENCODE_SERVER_PASSWORD: ${OPENCODE_SERVER_PASSWORD}
    volumes:
      - ./projects:/projects
      - opencode-data:/home/node/.local/share/opencode
  web:
    image: ghcr.io/juanmandev/opencode-web:latest
    environment:
      NUXT_OPENCODE_URL: http://opencode:4096
      NUXT_OPENCODE_PASSWORD: ${OPENCODE_SERVER_PASSWORD}
    ports: ["3000:3000"]
volumes:
  opencode-data:
```

| service | role | exposure |
| --- | --- | --- |
| `opencode` | `opencode serve` (basic-auth protected) | internal network only |
| `web` | this app, proxies `/api/opencode/*` | Traefik / your port |

### Provider auth

API keys pass through as env vars, or add them **from the UI** (model dropdown → *Configure providers…*). For OAuth providers (Anthropic Pro/Max):

```sh
docker compose exec opencode opencode auth login
```

### Traefik + tinyauth

The compose file ships labels for a `websecure` router with a `tinyauth@docker` forward-auth middleware. Because pages, API, and the SSE stream are all same-origin behind one router, tinyauth's cookie protects everything — zero extra config. The `flushinterval=100ms` label keeps SSE unbuffered.

## Architecture

```mermaid
flowchart LR
    B[Browser] -->|https| T[Traefik + tinyauth]
    T --> W["Nuxt app (SSR + API proxy)"]
    W -->|"/api/opencode/** + basic auth"| O[opencode serve]
    O --> P["/projects/… (your code)"]
```

- `server/api/opencode/[...].ts` — streaming proxy: auth injection, fail-fast timeouts, SSE-safe
- `app/composables/useOpencodeApi.ts` — typed client, directory-scoped, feeds global health state
- `app/composables/useOpencodeEvents.ts` — shared `EventSource` per project with reconnect
- `app/pages/p/[dir]/…` — project shell (directory travels base64url in the URL)
- `app/components/chat/McpHtmlFrame.vue` — sandboxed renderer for MCP UI resources

Verified against opencode **1.18.x**.

## Development

```sh
npm install
npm run mock    # mock opencode API on :4517 (no keys needed)
NUXT_OPENCODE_URL=http://127.0.0.1:4517 npm run dev
```

```sh
npm run typecheck   # vue-tsc
npm run test:unit   # vitest
npm run build && npm run test:e2e   # playwright e2e + screenshots
```

See [CONTRIBUTING.md](CONTRIBUTING.md) — conventional commits drive [semantic-release](https://github.com/semantic-release/semantic-release) (changelog, GitHub releases, Docker tags — all automatic).

## API & MCP

The app is scriptable three ways — automate opencode from n8n, scripts, or any AI agent:

**REST API** (`/api/v1/*`, spec at [`/api/v1/openapi.json`](http://localhost:3000/api/v1/openapi.json)):

```sh
# send a prompt and wait for the reply
curl -X POST https://opencode.example.com/api/v1/sessions/$SESSION/prompt \
  -H 'content-type: application/json' \
  -d '{"directory": "/projects/my-app", "text": "Fix the failing tests", "variant": "high"}'
```

Endpoints: projects, sessions (list/create/delete), messages, prompt (waits for the full reply), abort, models, agents, MCP status.

**MCP server** (Streamable HTTP at `POST /mcp`) — plug opencode-web into Claude, Cursor, or any MCP client:

```json
{ "mcpServers": { "opencode": { "url": "https://opencode.example.com/mcp" } } }
```

Tools: `list_projects`, `list_sessions`, `create_session`, `send_prompt` (waits for the reply, auto-creates sessions), `get_messages`, `abort_session`, `list_models`, `mcp_status`.

**WebMCP** — on browsers with `navigator.modelContext`, the page registers its own tools (`opencode_send_prompt`, `opencode_open_project`, …) so in-browser agents can drive the UI directly.

**Auth:** set `NUXT_API_TOKEN` and clients must send `Authorization: Bearer <token>` for `/api/v1/*` and `/mcp`. Unset, these routes rely on your reverse-proxy auth — note tinyauth cookies won't work for MCP clients, so either use the token and exempt `/mcp` from forward-auth, or keep everything LAN-only.

## Configuration

| env (web) | default | purpose |
| --- | --- | --- |
| `NUXT_OPENCODE_URL` | `http://127.0.0.1:4096` | opencode server base URL |
| `NUXT_OPENCODE_USERNAME` | `opencode` | basic-auth user |
| `NUXT_OPENCODE_PASSWORD` | *(empty)* | basic-auth password |
| `NUXT_API_TOKEN` | *(empty)* | bearer token required for `/api/v1/*` and `/mcp` when set |

Health endpoint: `GET /api/health` → `{ ok, opencode }` (used by the Docker healthcheck).

## License

[MIT](LICENSE) © Juan Manuel Bécares


<br>

## 💖 Support this project
If you found this project helpful, please consider supporting it!

[![GitHub Sponsor](https://img.shields.io/badge/Sponsor-JuanmanDev-ea4aaa?style=for-the-badge&logo=github)](https://github.com/sponsors/JuanmanDev) [![Ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/juanmandev) [![PayPal](https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://paypal.me/juanmandev)

<br>
