# MCP servers & MCP UI apps

opencode web manages the [MCP](https://modelcontextprotocol.io) servers of the opencode server it fronts, shows which tools each one exposes, and renders the interactive UIs that MCP tools return.

<img src="screenshots/mcp.png" alt="MCP manager" width="800" />

## Where servers are configured

MCP servers live in opencode's own config, so the agent, the TUI and this UI all see the same list:

| scope | file (in the opencode container) | edited from |
| --- | --- | --- |
| global | `/home/node/.config/opencode/opencode.json` (the `opencode-config` volume) | MCP page → **Global** scope |
| project | `<project>/opencode.json` | MCP page → **Project** scope |

Adding a server from the MCP page registers it with the running opencode (`POST /mcp`) **and** persists it with a partial `PATCH` of the config, so it survives restarts. opencode reads its config at startup: after editing `opencode.json` by hand, restart the container (`docker compose restart opencode`).

### Remote servers (Streamable HTTP or legacy SSE)

```jsonc
{
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
    // legacy HTTP+SSE servers work too: point at the SSE endpoint
    "imdb": { "type": "remote", "url": "http://192.168.1.10:8095/sse" },
    // auth headers are sent on every request
    "internal": {
      "type": "remote",
      "url": "https://tools.example.com/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

opencode connects with Streamable HTTP and falls back to SSE. The UI's own client does the same (any 4xx except 401/403 triggers the fallback, `/sse` URLs try SSE first) and accepts both LF and CRLF framed event streams, which Python servers send.

### Local servers (stdio)

```jsonc
{
  "mcp": {
    "n8n": {
      "type": "local",
      "command": ["npx", "-y", "@leonardsellem/n8n-mcp-server"],
      // opencode's key is `environment` (not `env`): other keys are ignored
      "environment": { "N8N_API_URL": "https://n8n.example.com/api/v1", "N8N_API_KEY": "<key>" },
      // first start downloads the package: allow more than the 5s default
      "timeout": 60000
    },
    "fetch": { "type": "local", "command": ["uvx", "mcp-server-fetch"] }
  }
}
```

The opencode server image ships `node`/`npx`, `python3` and `uv`/`uvx`. The `opencode-npm` and `opencode-cache` volumes keep downloaded packages across updates.

> Anything installed into the opencode container outside its volumes (for example a plugin unpacked into `~/.local/share/<name>`) disappears when the image is updated. Keep such files in a volume or bind mount.

### The built-in demo server

`/mcp-demo` on the web app is a small MCP server whose tools return every UI flavour below. Add it from the MCP page (**MCP-UI demo** in the catalog) or by hand:

```json
{ "mcp": { "mcp-ui-demo": { "type": "remote", "url": "http://web:3000/mcp-demo" } } }
```

The URL must be reachable **from the opencode container**. In the bundled compose file that is `http://web:3000/mcp-demo`, which the MCP page uses automatically through `NUXT_PUBLIC_DEMO_MCP_URL`. The web app itself always calls its own demo server over the loopback address of the socket the request arrived on, so it also works behind a reverse proxy with forward auth.

### Browser automation (Playwright MCP)

Browser MCP servers need a real browser, which the opencode image doesn't ship. The compose file has an optional service with Microsoft's headless Playwright MCP server instead:

```sh
docker compose --profile browser up -d
```

```json
{ "mcp": { "playwright": { "type": "remote", "url": "http://playwright-mcp:8931/mcp" } } }
```

It runs on the internal network only, with an isolated profile per session.

## Server details: diagnose, edit, test

The sliders button on every row of the MCP page (or **Diagnose & fix** on a broken one) opens the server's details. When enabling, adding or retrying a server leaves it broken, this view opens by itself instead of a bare error toast.

| tab | shows |
| --- | --- |
| **Overview** | status, where the server is defined (project or global config), its URL or command, and for errors: what went wrong in plain words, the fix, and a one-click action (*Use a token instead*, *Sign in*, *Edit settings*). A broken server is also tested directly from the web app, because opencode only reports the error of its **last** transport attempt |
| **Tools** | every tool with its full description, parameters (type, required, allowed values), MCP Apps / read-only / destructive badges and the tool id to copy. Resources and prompts are counted too |
| **Edit** | type, URL or command, headers or environment variables, OAuth on/off, timeout, enabled, and which config to save to. A JSON view edits the raw opencode entry. Stored secrets show as `•••• stored`: leave them to keep the value, type to replace it. They never reach the browser |
| **Test** | connects the way opencode would (Streamable HTTP, then legacy SSE, or spawning the command) and lists each step with timings, the server's name, version and capabilities, or the failure with its fix. Nothing is saved; edited settings can be tested before saving |

**Save & reconnect** writes the entry to the chosen config and reconnects it in the running opencode, so there is nothing to restart.

### Home Assistant (and other token-only servers)

Home Assistant's *MCP Server* integration answers unauthenticated requests with an OAuth challenge but doesn't support the dynamic client registration opencode tries, so enabling it fails with `Incompatible auth server: does not support dynamic client registration`, or with `SSE error: Non-200 status code (405)` when the token is wrong. The fix:

1. In Home Assistant, create a **long-lived access token** (your profile → *Security*).
2. MCP page → **Add server** → **Home Assistant** → *Set up*, or open the existing server and press *Use a token instead*.
3. URL `https://<your-home-assistant>/api/mcp` (Streamable HTTP; the older `/mcp_server/sse` also works), header `Authorization: Bearer <token>`, **OAuth auto-detection off**. *Test*, then *Add & connect*.

```jsonc
{
  "mcp": {
    "home-assistant": {
      "type": "remote",
      "url": "https://homeassistant.example.com/api/mcp",
      "headers": { "Authorization": "Bearer <long-lived token>" },
      "oauth": false
    }
  }
}
```

## Agent control

The web app is itself an MCP server (`POST /mcp`, see the README for the tool list). The **Agent control** card on the MCP page registers it in opencode's **global** config, so the agent in every new chat can manage opencode:

- list, **test**, add, reconnect and switch MCP servers (with the same plain-language fixes as the UI)
- **reload opencode's config** for one project or all of them, the API's equivalent of restarting `opencode serve`
- see which sessions are busy, **read other chats**, prompt them (`wait: false` to dispatch work), abort them
- read the **task lists** (todos) of busy and recent sessions
- create, run and change **scheduled prompts**
- version, models, agents, commands, skills, git/LSP status and the (redacted) config

The URL must be reachable **from the opencode host**: `http://web:3000/mcp` in the bundled compose file (`NUXT_SELF_URL`), editable in the card. When `NUXT_API_TOKEN` is set, the token is added as a header automatically.

Safety:

- tools that change something (reload, add/switch MCP servers, prompt or abort sessions, schedules) are registered with the **ask** permission, so the chat shows a permission prompt first. Change that per tool on the MCP page
- a reload interrupts replies that are running in the reloaded project. `reload_opencode` therefore waits by default until no session there is busy, **including the agent's own reply**: it asks for the reload, finishes its answer, and the reload happens right after
- a session can't be prompted while it is busy, so an agent can't deadlock by prompting its own session

`GET /api/v1/reload` and `server_info` show the state of the last reload. v2-only opencode servers have no reload API: restart the process instead.

## Scheduled prompts

The **Schedules** tile in the project sidebar manages prompts that the web app sends on a timetable: every N minutes, hourly, daily, on weekdays, weekly on chosen days, or any 5-field cron expression (`minute hour day month weekday`, plus `@hourly`, `@daily`, `@weekly`, `@monthly`).

- **New session each run** keeps runs apart; **always the same session** continues one conversation (a run is skipped while that session is busy)
- optional model (`provider/model`) and agent per schedule
- *Run now*, pause/resume, and a history of the last 20 runs with status, duration, the start of the reply and a link to the chat

Schedules are stored in the web app's data volume and fire in the **web container's time zone** (`TZ`, UTC by default; the editor warns when your browser's zone differs). Runs missed while the app was down are not replayed. `NUXT_SCHEDULER=off` disables firing, for example on a second replica sharing the same volume.

## Tool discovery

opencode's API exposes MCP connection status but no MCP tool ids. The MCP page and the prompt box's per-conversation MCP picker need tool names, so the web app asks each server itself:

- **remote** servers are contacted directly (`initialize` → `tools/list`)
- **local** servers are spawned by the web app and spoken to over stdio, then killed (the whole process group). Results are exact when opencode runs on the same host, approximate otherwise. Set `NUXT_MCP_LOCAL_DISCOVERY` to `same-host` or `never` to change that. Spawned servers get a minimal environment (`PATH`, `HOME`, proxy and locale variables plus the entry's own `environment`), never the web app's secrets.

Results are cached for five minutes with stale-while-revalidate. The refresh button on the MCP page re-probes and updates the cache for every page.

## MCP UI apps

Tools can return interactive UIs. Each one renders live in a sandboxed iframe right in the chat, and can move to a side panel or fullscreen (shareable `?app=…&view=full` links).

<img src="screenshots/mcp-apps.png" alt="MCP apps in the chat" width="800" />

| flavour | how it is recognized | sandbox |
| --- | --- | --- |
| **MCP Apps** (SEP-1865) | tool declares `_meta.ui.resourceUri` (`ui://…` template) | `allow-scripts allow-forms`, host speaks JSON-RPC over `postMessage` (`ui/initialize`, `tool-input`, `tool-result`, size, display mode, open-link) |
| mcp-ui **raw HTML** | embedded resource `text/html` | `allow-scripts allow-forms` |
| mcp-ui **external URL** | embedded resource `text/uri-list` | `allow-scripts allow-same-origin allow-forms allow-popups`, **http(s) on another origin only** |
| mcp-ui **remote-dom** | `application/vnd.mcp-ui.remote-dom…` | generic web-component host shell, `allow-scripts allow-forms` |

### Why tools are sometimes run again — and when they aren't

opencode keeps only the text content of an MCP tool result: embedded `ui://` resources and `structuredContent` are dropped before they reach the UI. To show the app anyway, the web app recovers it from the MCP server:

1. **Read-only tools** (`annotations.readOnlyHint: true`) are re-run automatically. They declare that a second run has no side effects.
2. **MCP Apps tools** that are not read-only only get their template read (`resources/read`). Nothing is executed; the app receives the original text output.
3. **Anything else that looks like a UI tool** shows a **Render UI (runs the tool again)** button instead of re-running it silently.

Results are cached for five minutes, so reloading a session doesn't repeat calls. If you write MCP servers with UIs, mark pure tools with `readOnlyHint` so they render without a click.

### Security of rendered apps

- HTML apps never get `allow-same-origin`: they cannot read the web app's cookies or call its API.
- External apps must be `http:`/`https:` URLs on **another** origin. `javascript:`, `data:` and same-origin URLs are refused, because with `allow-same-origin` they would run with full access to the opencode API.
- `ui/open-link` requests from apps are limited to http(s) links.
- Resources are only scanned in MCP tool results: text that looks like a `ui://` resource inside a `bash`, `read` or `webfetch` output never renders.
