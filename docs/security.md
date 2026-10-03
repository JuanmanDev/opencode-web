# Security model

opencode can read and write files and run shell commands in your projects. Anyone who can use this UI can do the same. Treat access to it like SSH access to the box.

## Layers

| layer | protects against | how |
| --- | --- | --- |
| Reverse-proxy auth (tinyauth, Authelia…) | strangers on the internet | one Traefik router for pages, API, proxy and SSE stream; the forward-auth cookie covers all of it |
| opencode basic auth | other containers / hosts reaching opencode | the `opencode` service is only on the internal network; the web app injects the password server-side, the browser never sees it |
| **Origin check** (CSRF) | a malicious website you visit driving your instance, especially LAN-only ones without any login | every `POST`/`PUT`/`PATCH`/`DELETE` whose `Origin` header is not this app's own host gets **403**. Requests without `Origin` (curl, MCP clients, opencode) are unaffected |
| API token (optional) | scripts and MCP clients when the API is exempt from forward auth | `NUXT_API_TOKEN`: `Authorization: Bearer <token>` on `/api/v1/*`, `/mcp` and `/api/opencode/*` |
| Secret redaction | API keys and MCP credentials leaking to browsers | `/config`, `/global/config`, `/config/providers` and the `list_models` MCP tool replace every key/token/secret/password/authorization value with `***`, at any depth |
| iframe sandbox | MCP UI apps reaching the opencode API | see [MCP UI security](mcp.md#security-of-rendered-apps) |

## API token and the UI cookie

With `NUXT_API_TOKEN` set:

- external clients send `Authorization: Bearer <token>`
- every page load hands the browser an `HttpOnly`, `SameSite=Strict` cookie derived from the token (`ocw_ui`), so the UI's own requests keep working without the token ever reaching JavaScript

Typical Traefik setup: keep pages behind tinyauth and give `/api/v1` and `/mcp` a second router **without** the forward-auth middleware. Pages can only be loaded after logging in, so only logged-in browsers get the cookie, while scripts use the token.

```yaml
labels:
  - traefik.http.routers.opencode-web.middlewares=tinyauth@docker
  # token-protected API for scripts / MCP clients, no forward auth
  - traefik.http.routers.opencode-web-api.rule=Host(`${WEB_DOMAIN}`) && (PathPrefix(`/api/v1`) || Path(`/mcp`))
  - traefik.http.routers.opencode-web-api.entrypoints=websecure
  - traefik.http.routers.opencode-web-api.tls=true
  - traefik.http.routers.opencode-web-api.service=opencode-web
```

## Browser-based MCP clients

Browser tools (for example the MCP Inspector) send an `Origin` header and are refused by default. Allow them explicitly:

```sh
NUXT_ALLOWED_ORIGINS=http://localhost:6274,https://inspector.example.com
```

## LAN-only without any login

Running on a LAN without a proxy (`ports: ["3000:3000"]`) means everyone on that network has full agent access. The Origin check stops other websites from using it through your browser. It does not stop DNS rebinding: if that matters to you, put the app behind a proxy that checks the `Host` header, or use the token.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/JuanmanDev/opencode-web/security/advisories/new) instead of a public issue.
