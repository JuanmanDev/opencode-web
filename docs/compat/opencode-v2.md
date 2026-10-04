# opencode v2 protocol — adapter reference

> Maintainer reference for `server/utils/compat/v2/*`. Researched against opencode 1.18.34
> (which serves the v2 `/api/*` protocol next to the 1.x API) driven by `scripts/mock-llm.mjs`.
> Captured payloads referenced below as `samples/…` live (trimmed) in `tests/fixtures/opencode-v2/`.

## 0. TL;DR

* v2 lives under **`/api/*`** (plus `/experimental/project/{projectID}/copy*`). Same Basic auth as legacy
  (user `opencode`), or `?auth_token=base64(user:pass)`. Project scoping is **`location[directory]=<abs>`**
  (deepObject query) or header **`x-opencode-directory: encodeURIComponent(abs)`**; session-scoped routes
  derive the location from the session row and ignore it.
* Events: **one global SSE** `GET /api/event` (no directory filter, no `id:` lines, no replay,
  `: heartbeat` comment every 15 s, first frame `server.connected`). Payload envelope is
  `{id,type,data,location?,durable?}` instead of legacy `{id,type,properties}`.
* The v2 event vocabulary is different: **no `message.updated` / `message.part.*`, no
  `session.updated|status|idle|error`**. Live chat comes from `session.next.*` (step/text/reasoning/tool
  lifecycle with deltas); the adapter must run a small **projector** (same reducer as
  `core/src/session/message-updater.ts`) and re-emit legacy `message.updated` + `message.part.updated`.
  Busy/idle must be **synthesized** (step events + `GET /api/session/active`).
* Message model: v2 = flat list of typed messages (`user`, `assistant{content[]}`, `shell`, `synthetic`,
  `system`, `agent-switched`, `model-switched`, `compaction`); **one assistant message per LLM step**
  (legacy 1.18 also does one assistant message per step, so the UI already copes). Parts have no ids →
  adapter mints deterministic part ids.
* Big gaps in v2 (1.18.34): no MCP at all (runner advertises only built-in tools), no config read/write,
  no session delete/rename/fork/share/diff, no auto-titles, no shell, no command execution endpoint,
  no todo read endpoint, no project list, cost always 0, `compact`/`wait` return 503.
* On a **hybrid** 1.18 server keep using legacy: v2 runner lacks MCP, legacy sessions are invisible to
  `/api/session/{id}/message`, and `/api/event` dies as soon as the legacy runner emits a legacy-only
  event (verified). Use the adapter only when the server is **v2-only**.

---

## A. Detecting a v2-capable / v2-only server

Run server-side (Nitro), with the configured Basic auth, cache the verdict (~60 s, re-probe after
502/504 or 404 bursts). **Always require `content-type: application/json`**: 1.18 serves its embedded web
UI on a catch-all, so unknown paths answer `200 text/html` (verified: `/api/openapi.json`, `/openapi.json`,
`/api/doc` → 200 text/html).

| Probe | Legacy-only (pre-v2 versions) | v2-capable (1.18 hybrid, verified) | v2-only (`packages/server`, `lildax serve`; from source, not runnable here) |
|---|---|---|---|
| `GET /global/health` | 200 `{"healthy":true,"version":"…"}` | 200 `{"healthy":true,"version":"1.18.34"}` | expected 404 (route not in `Api`) |
| `GET /api/health` | HTML catch-all / 404 | 200 `{"healthy":true}` | 200 `{"healthy":true}` |
| `GET /doc` | legacy OpenAPI | legacy OpenAPI incl. the 51 `/api` paths | expected 404 |
| `GET /openapi.json` | HTML catch-all | 200 **text/html** (catch-all) | v2 OpenAPI (`HttpApiBuilder.layer(Api,{openapiPath:"/openapi.json"})`) |

Algorithm:

```
mode = env NUXT_OPENCODE_PROTOCOL ?? 'auto'            // 'legacy' | 'v2' | 'auto'
if auto:
  g = GET /global/health (json?)  -> if ok && body.healthy  => 'legacy' (version = body.version)
  a = GET /api/health    (json?)  -> if ok && body.healthy === true => 'v2'
  401 on either => auth misconfigured (body {"_tag":"UnauthorizedError",...} on v2,
                   empty 401 on legacy; both send www-authenticate: Basic realm="Secure Area")
  else => down
```

`/api/health` carries **no version**. The only version hint on v2 is `session.created.data.info.version`
(v1-shaped payload, e.g. `"1.18.34"`). `server/api/health.get.ts` (today `/app` then `/config`) must call
`/api/health` in v2 mode.

---

## B. Transport

### B.1 Base path, server, auth
* Paths: `/api/...` (see `samples/v2-openapi.json`, 54 paths extracted from 1.18 `/doc`; standalone
  server serves its own spec at `GET /openapi.json`). Project copies:
  `POST|DELETE /experimental/project/{projectID}/copy`, `POST .../copy/refresh`.
* Standalone v2 server (`packages/cli` "lildax", unpublished): `serve --hostname 127.0.0.1 [--port]`,
  default port **4096** (auto-increments while busy). **Always password protected**: generated once and
  stored in `$XDG_STATE_HOME/opencode/password` (`lildax service password [value]` to read/set);
  username fixed to `opencode` (`createRoutes(password)` ignores `OPENCODE_SERVER_USERNAME`).
  1.18 embedded: `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` (default `opencode`), open if unset.
* Auth: `Authorization: Basic base64(user:pass)` **or** query `?auth_token=base64(user:pass)` (verified on
  `/api/health` and `/api/event`; useful for a browser `EventSource`, not needed behind the Nitro proxy).
  Failure: `401 {"_tag":"UnauthorizedError","message":"Authentication required"}` +
  `www-authenticate: Basic realm="Secure Area"` (proxy already strips the latter).
* No CORS layer in the standalone router — irrelevant because opencode-web proxies same-origin.

### B.2 Location (project directory)
`server/src/location.ts`:
```
workspace = query 'location[workspace]' || header 'x-opencode-workspace'
directory = query 'location[directory]' || decodeURIComponent(header 'x-opencode-directory') || process.cwd() of the server
```
* Location-scoped routes (agent, model, provider, integration, credential, command, skill, reference,
  fs, pty, permission.request.list, question.request.list, location): pass
  `location[directory]=<abs>` (OpenAPI `style: deepObject`). **Omitting it silently uses the server cwd.**
* Session-scoped routes (`/api/session/{id}/...`, incl. permission/question replies): location comes from
  the session row (`SessionLocationMiddleware`); query/header ignored. Invalid id → `400
  {"_tag":"InvalidRequestError","message":"Invalid session ID","field":"sessionID"}`; unknown →
  `404 SessionNotFoundError`.
* `POST /api/session` takes `body.location = {directory, workspaceID?}` (defaults to server cwd).
* `GET /api/session` filters with **plain** `directory=` (exact string match on the stored directory),
  or `project=<projectID>[&subpath=]`, or nothing (all sessions).
* Location-scoped responses are wrapped: `{ location: {directory, workspaceID?, project:{id, directory}}, data }`.
  Use `GET /api/location?location[directory]=D` once per directory to canonicalize `D` and learn the
  project root (`project.directory`) and `project.id`.
* Directory strings are echoed verbatim (Windows backslashes kept). Normalize when comparing:
  `/` separators, strip trailing separator, case-fold on Windows.

### B.3 Envelopes, status codes, errors
* Success: session routes `{data: ...}`; list routes with paging `{data:[], cursor:{previous?, next?}}`;
  history `{data:[], hasMore}`; actions `204 No Content` (empty body); `fs.read` raw bytes with the file's
  mime (`text/markdown` for README.md).
* Timestamps are epoch **ms** numbers everywhere (`DateTimeUtcFromMillis`).
* Errors: `{ "_tag": "<Name>", "message": "...", ...extra }`:

| status | `_tag` | extra | seen when |
|---|---|---|---|
| 400 | `InvalidRequestError` | `kind` (`"Payload"`…), `field?` | schema rejection, bad session id, integration auth (`kind: integration_authorization` / `integration_code_required`) |
| 400 | `InvalidCursorError` | | bad cursor / cursor+order |
| 401 | `UnauthorizedError` | | auth |
| 403 | `ForbiddenError` | | pty |
| 404 | `SessionNotFoundError` `{sessionID}` / `MessageNotFoundError` / `PermissionNotFoundError {requestID}` / `QuestionNotFoundError {requestID}` / `ProviderNotFoundError` / `PtyNotFoundError` | | |
| 409 | `ConflictError` | `resource` | prompt `id` reuse (verified) |
| 500 | `UnknownError` | `ref` | snapshot/decoding failures |
| 503 | `ServiceUnavailableError` | `service` (`session.compact`, `session.wait`) | **compact & wait not implemented in 1.18.34** (verified) |

The UI reads `err.data.message`; v2 bodies already have a top-level `message`, so ofetch's `e.data.message`
keeps working. For legacy NamedError consumers wrap as `{name: _tag, data: {message}}`.

### B.4 Pagination & ids
* Sessions: `limit` (default 50), `order` asc|desc (default desc, by `time.created`), `search` (title LIKE),
  opaque base64url `cursor` (`cursor.next`/`previous` always present when the page is non-empty → loop until
  a page is shorter than `limit`).
* Messages: `limit` 1..200 (default 50), `order` (default **desc**), `cursor` (must not be combined with
  `order`; cursor encodes the order).
* History: `limit` ≤ 100 (default 50), `after` = exclusive aggregate `seq`, `hasMore`.
* Id prefixes: `ses_` (descending-time), `msg_` (ascending-time — string order == creation order),
  `evt_`, `per_`, `que_`, `con_`/`cred_`. No part ids. A client may supply `id: "msg_…"` on prompt
  for idempotency (same id twice → 409).

### B.5 SSE
**Global stream** `GET /api/event` (`server/src/handlers/event.ts`):
```
HTTP 200  content-type: text/event-stream  cache-control: no-cache, no-transform  x-accel-buffering: no
data: {"id":"evt_…","type":"server.connected","data":{}}          <- always first, per connection

: heartbeat                                                      <- SSE comment every 15 s

data: {"id":"evt_…","type":"session.next.text.delta","location":{"directory":"C:\\…\\work"},"data":{…}}

data: {"id":"evt_…","type":"session.next.text.ended","durable":{"aggregateID":"ses_…","seq":7,"version":1},"location":{…},"data":{…}}
```
* No `event:`/`id:`/`retry:` fields → browser `EventSource.onmessage` works, but `Last-Event-ID` resume
  does not exist. **No replay**: anything published while disconnected is lost → resync via REST
  (the UI already refetches on `server.connected`).
* **Not filtered**: every directory, every session, plus `plugin.added` ×45, `catalog.updated`,
  `integration.updated`, `reference.updated`… at location boot. Filter by
  `norm(event.location.directory) === norm(D)`; events without `location` (only `server.connected`) pass.
* Per-subscriber **bounded queue of 256 (dropping → stream failure)**. A slow consumer gets
  disconnected → reconnect (backoff 0.5 s…15 s) and resync. Deltas are high-volume: consume promptly,
  fan-out from ONE upstream connection per Nitro process.
* `durable` present only on durable session events (`aggregateID` = sessionID, monotonically increasing
  `seq` per session, `version` = schema version: `step.ended`/`step.failed` are v2, others v1).

**Per-session durable stream** `GET /api/session/{id}/event?after=<seq>`: replays durable events with
`seq > after` then continues live. **Durable only**: no `*.delta`, no permission/question/todo events;
no heartbeat (verified 0 comments). Same events, without `location`. Use it (or the paged
`GET /api/session/{id}/history?after=&limit=`) for gap-free catch-up after a reconnect
(`samples/p2-session-event-replay-after3.sse.txt` starts at seq 4).

---

## C. Endpoint mapping (legacy → v2)

`D` = `?directory=` sent by the UI; `L(D)` = `location[directory]=D`. "Derived" = composed by the adapter.

| # | Legacy call (UI) | v2 call(s) | Request transform | Response transform |
|---|---|---|---|---|
| 1 | `GET /project` | derived: `GET /api/session?limit=200` (paged, all) + `GET /api/location` (server default) + `GET /api/location?L(dir)` per distinct dir | — | `[{id: project.id, worktree: project.directory, vcs: undefined, time:{created: min(session.created)}}]` deduped by project.id; merge opencode-web meta dirs |
| 2 | `GET /path?directory=D` | `GET /api/location?L(D)` | — | `{directory, worktree: project.directory, home: undefined, config: undefined}` |
| 3 | `GET /file?directory=D&path=P` (DirectoryBrowser uses `path='.'`, moves `directory`) | `GET /api/fs/list?L(D)[&path=P]` (omit `path` for `.`/empty; `path` must be relative) | — | `data.map(e => ({ name: basename(trimSep(e.path)), path: toPosix(trimSep(e.path)), absolute: join(D, e.path), type: e.type, ignored: false }))`. Entries come back as `".git\\"`, `"src\\"`, `"README.md"` (dir = trailing separator) |
| 4 | `GET /config?directory=D` / `GET /global/config` | **none** | — | return `{}` (no `model`, no `mcp`) — see §E |
| 5 | `PATCH /config`, `PATCH /global/config` | **none** | — | `501 {message:"not supported by opencode v2"}` |
| 6 | `GET /config/providers?directory=D` | `GET /api/provider?L(D)` + `GET /api/model?L(D)` | — | §C.6 |
| 7 | `GET /agent?directory=D` | `GET /api/agent?L(D)` | — | §C.7 |
| 8 | `PUT /auth/{providerID}` `{type:'api', key}` | `POST /api/integration/{integrationID}/connect/key?L(D)` `{key, label?}` | `integrationID = provider.integrationID ?? providerID` | 204 → `true`; 400 `integration_authorization` → error |
| 9 | `GET /mcp` (+ `/api/v1/mcp*`) | **none** | — | `{}` (no servers) |
| 10 | `POST /mcp`, `/mcp/{n}/connect|disconnect|auth|auth/callback` | **none** | — | 501 |
| 11 | `GET /session?directory=D` | `GET /api/session?directory=D&limit=200` (+cursor loop, cap ~1000) | canonical D (§B.2) | `data.map(toLegacySession)` (§C.1) |
| 12 | `GET /session/{id}` | `GET /api/session/{id}` | — | `toLegacySession(data)` |
| 13 | `POST /session` `{title?}` | `POST /api/session` `{location:{directory:D}, agent?, model?}` | `title` dropped (store in opencode-web meta, §E) | `toLegacySession(data)` |
| 14 | `DELETE /session/{id}` | **none** | — | 501, or soft-hide in meta (§E) |
| 15 | `PATCH /session/{id}` `{title}` | **none** | — | 501, or meta title override (§E) |
| 16 | `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt` | — | 204 → `true` (no-op when idle) |
| 17 | `GET /session/{id}/message[?limit=N]` | `GET /api/session/{id}/message?order=asc&limit=200` (+`cursor=next` loop); with `limit=N`: `order=desc&limit=N` then reverse. Plus `GET /api/session/active` and `GET /api/session/{id}` | — | `toLegacyMessages(v2msgs, ctx)` (§C.2) |
| 18 | `GET /session/{id}/todo` | derived from #17 raw messages | — | last assistant `tool` with `name==='todowrite'` and `state.status==='completed'` → `state.structured.todos` (fallback `state.input.todos`), else `[]` |
| 19 | `POST /session/{id}/message` (prompt; UI fire-and-forget, `/api/v1/sessions/:id/prompt` + MCP route **await** the reply) | 1) if `session.revert` set → `POST /api/session/{id}/revert/commit`; 2) model differs → `POST /api/session/{id}/model` `{model:{id:modelID, providerID, variant?}}`; 3) agent differs → `POST /api/session/{id}/agent` `{agent}`; 4) `POST /api/session/{id}/prompt` | §C.3 | async: `200 {}`; sync: §C.3 wait + last assistant `{info, parts}` |
| 20 | `POST /session/{id}/command` `{command, arguments}` | `GET /api/command?L(D)` (cached) → expand → as #19 | §C.4 | as #19 |
| 21 | `POST /session/{id}/shell` `{command}` | **none** (`SessionV2.shell` → OperationUnavailable, no route) | — | 501 |
| 22 | `POST /session/{id}/summarize` (`/compact`) | `POST /api/session/{id}/compact` | — | 204 → `true`; **503 in 1.18.34** → surface "not available yet" |
| 23 | `POST /session/{id}/revert` (undo; UI sends `{}`) | `POST /api/session/{id}/revert/stage` `{messageID: B, files: true}` | **semantics differ**: legacy `messageID` = first message to drop; v2 `messageID` = **last message kept** (boundary). Undo-last-turn ⇒ `B` = message immediately before the last `user` message (none ⇒ cannot undo the first turn → 409/note) | `{data: Revert.State{messageID, snapshot?, diff, files[]}}` → `true` |
| 24 | `POST /session/{id}/unrevert` | `POST /api/session/{id}/revert/clear` | — | 204 → `true` |
| 25 | `POST /session/{id}/fork`, `/share`, `/diff`, `/init` | **none** (init → command `init` via #20) | — | 501 (`diff`: optionally return `session.revert.files` when staged) |
| 26 | `GET /command?directory=D` | `GET /api/command?L(D)` (+ optionally `GET /api/skill?L(D)`) | — | §C.5 |
| 27 | `GET /question?directory=D` | `GET /api/question/request?L(D)` | — | `data` as-is (same shape as legacy `question.asked`: `{id, sessionID, questions:[{question, header, options:[{label,description}], multiple?, custom?}], tool?:{messageID, callID}}`); remember `id → sessionID` |
| 28 | `POST /question/{rid}/reply` `{answers}` | `POST /api/session/{sid}/question/{rid}/reply` `{answers: string[][]}` | **needs sessionID**: from cache (#27, `question.v2.asked`), else refetch #27 | 204 → `true` |
| 29 | `POST /question/{rid}/reject` | `POST /api/session/{sid}/question/{rid}/reject` | same lookup | 204 → `true` |
| 30 | `GET /permission?directory=D` | `GET /api/permission/request?L(D)` | — | `data.map(toLegacyPermission)` (§C.8) |
| 31 | `POST /session/{sid}/permissions/{pid}` `{response}` (and newer `POST /permission/{pid}/reply` `{reply, message?}`) | `POST /api/session/{sid}/permission/{pid}/reply` `{reply: response, message?}` | `reply ∈ once|always|reject`; newer legacy route needs `sid` lookup (cache from #30 / events) | 204 → `true` |
| 32 | `GET /event?directory=D` | one shared upstream `GET /api/event` | — | §D (translator) |
| 33 | `GET /app`, `/config` (health) | `GET /api/health` | — | `{healthy:true}` |

New v2-only capabilities worth exposing later: `GET /api/session/active`, `GET /api/permission/saved`
+ `DELETE /api/permission/saved/{id}` ("always" approvals), `GET /api/fs/find?L(D)&query=&type=&limit=`
(fuzzy file search, verified `query=README` → `[{path:"README.md",type:"file"}]`), `GET /api/fs/read/<rel>`,
`GET /api/integration` (provider auth methods/connections, OAuth via `connect/oauth` + `attempt/*`),
`PATCH|DELETE /api/credential/{id}`, `/api/pty*`, `GET /api/session/{id}/context`, `/history`.

### C.1 `toLegacySession(v2: Session.Info)`

| legacy `SessionInfo` | v2 source |
|---|---|
| `id` | `id` |
| `slug` | — (not in v2; `session.created` v1 payload has one) |
| `projectID` | `projectID` |
| `workspaceID` | `location.workspaceID` |
| `directory` | `location.directory` |
| `path` | `subpath ?? ""` |
| `parentID` | `parentID` (never set in 1.18.34: no task/subagent tool) |
| `title` | `title` — always `"New session - <ISO>"` (no title generation in v2 runner); apply meta override / derived title (§E) |
| `version` | — (`"v2"`) |
| `agent` | `agent` |
| `model` | `model` (`{id, providerID, variant?}` — same shape) |
| `cost`, `tokens` | `cost`, `tokens` — **stay 0** (runner publishes `cost: 0`, projector does not aggregate step tokens); compute from messages if needed |
| `time.created/updated/archived` | same (ms). **`updated` is only bumped by agent/model switch & revert, not by prompts/steps** → adapter keeps `lastActivity[sessionID]` from events and uses `max()` |
| `revert` | `revert` `{messageID (boundary!), partID?, snapshot?, diff?, files?}` — UI does not read it |
| `share`, `summary`, `permission`, `metadata` | — |

`session.created` events already carry a **v1-shaped** `info` (slug, directory, path, version, time) —
usable as-is.

### C.2 Message model mapping (`toLegacyMessages`)

Context needed: `sessionID`, `session` (for directory/agent/model), `active = sessionID ∈ /api/session/active`.
Walk v2 messages in ascending order, tracking `lastUserID`, `lastAgent`, `lastModel`:

**v2 `user`** `{id, time.created, text, files?[{uri, mime, name?, source?}], agents?[{name, source?}], metadata?}` →
```
info  = { id, sessionID, role:'user', time:{created}, agent: lastAgent ?? session.agent ?? 'build',
          model:{ providerID, modelID, variant } (from lastModel ?? session.model ?? next assistant) }
parts = [ text  {id:`prt_${id}_text`, type:'text', text}                       (if text)
        , file  {id:`prt_${id}_file_${i}`, type:'file', mime, filename:name, url:uri, source?}  (each file)
        , agent {id:`prt_${id}_agent_${i}`, type:'agent', name, source?}       (each agent) ]
```
**v2 `assistant`** `{id, time{created, completed?}, agent, model{id, providerID, variant?}, content[], snapshot?{start?,end?,files?}, finish?, cost?, tokens?, error?{type:'unknown', message}}` →
```
info = { id, sessionID, role:'assistant', parentID: lastUserID,
         time:{ created, completed },  modelID: model.id, providerID: model.providerID, variant: model.variant,
         agent, mode: agent, path:{cwd: session.location.directory, root: project.directory},
         cost: cost ?? 0, tokens: tokens ?? {input:0,output:0,reasoning:0,cache:{read:0,write:0}},
         finish, error: mapError(error) }
parts = [ {id:`prt_${id}_start`, type:'step-start', snapshot: snapshot?.start}
        , ...content.map(mapContent)
        , finish && finish!=='error' ? {id:`prt_${id}_finish`, type:'step-finish', reason: finish,
                                        snapshot: snapshot?.end, cost: cost??0, tokens} : none ]
```
Zombie fix (verified bug: after a **question reject** the assistant keeps `time.completed` undefined
forever): if `!active` and an assistant lacks `time.completed` → `time.completed = max(inner times) ??
created`, `error ??= {name:'MessageAbortedError', data:{message:'Interrupted'}}`. Without this the UI
(`loadAll`) keeps the input locked for 6 h.

`mapError({message})`: `"Provider turn interrupted"` / `"Tool execution interrupted"` →
`{name:'MessageAbortedError', data:{message}}`; anything else → `{name:'UnknownError', data:{message}}`
(v2 has no structured provider errors; e.g. `"HTTP transport failed"`,
`"OpenAI Chat does not support media type text/plain"`).

`mapContent` (part ids: `prt_${messageID}_${key}`; `key` = `textID`/`reasoningID`/tool `id`(callID);
if the same `textID` repeats within one message (lifecycles restart at `text-0`) append `_${n}` by
occurrence order — the live projector counts `*.started` events the same way):

| v2 content | legacy part |
|---|---|
| `{type:'text', id, text}` | `{type:'text', text, time?}` |
| `{type:'reasoning', id, text, providerMetadata?, time?{created, completed?}}` | `{type:'reasoning', text, metadata: providerMetadata, time:{start: created, end: completed}}` |
| `{type:'tool', id, name, provider?, state, time{created, ran?, completed?, pruned?}}` | `{type:'tool', callID: id, tool: name, state: mapToolState(...)}`, `metadata: provider?.metadata` |

`mapToolState` (legacy UI reads `status`, `input`, `output` string, `title`, `metadata` (MCP-UI scan),
`error` string):

| v2 `state` | legacy `state` |
|---|---|
| `pending {input: <raw JSON text so far>}` | `{status:'pending', input:{}, raw: input}` |
| `running {input, structured, content}` | `{status:'running', input, title: toolTitle(name,input), metadata: structured, time:{start: ran ?? created}}` |
| `completed {input, content[], structured, outputPaths?, attachments?, result?}` | `{status:'completed', input, output: textOf(content), title, metadata: {...structured, outputPaths?, result?}, time:{start: ran??created, end: completed ?? ran}, attachments: fileOf(content).map(f => ({id, sessionID, messageID, type:'file', mime:f.mime, url:f.uri, filename:f.name}))}` |
| `error {input, content, structured, error{message}, result?}` | `{status:'error', input, error: error.message, metadata: structured, time:{start, end}}` |

`textOf(content) = content.filter(c=>c.type==='text').map(c=>c.text).join('\n')` (bash verified:
`["hello-from-bash\r\n","Command exited with code 0."]`, `structured:{exit:0,truncated:false}`; legacy had
`output:"hello-from-bash\n"`, `metadata:{output,exit,truncated}`). `toolTitle`: bash → `input.command`;
read/write/edit → `input.filePath ?? input.path`; glob/grep → `input.pattern`; webfetch → `input.url`;
websearch → `input.query`; todowrite → `${n} todos`; question → `Asked ${n} question(s)`; else
`input.description ?? name`.

Other v2 message types:

| v2 | legacy |
|---|---|
| `synthetic {text}` | user message, one text part with `synthetic: true` |
| `shell {callID, command, output, time{created, completed?}}` | assistant message (`agent` = session agent) with one `tool` part `{tool:'bash', callID, state: completed? {input:{command}, output, title: command} : running}` |
| `compaction {reason, summary, recent}` | assistant message `info.summary = true`, text part = `summary` (legacy also had a user part `{type:'compaction', auto: reason==='auto'}`) |
| `system {text}` | skip (hidden context) |
| `agent-switched {agent}` / `model-switched {model}` | skip; update `lastAgent`/`lastModel` |

Verified samples: `samples/session-messages-final.json` (v2) vs `samples/legacy-messages.json`
(legacy runner, same mock, same prompts) — legacy also splits a tool turn into two assistant messages
(`finish:'tool-calls'` then `finish:'stop'`), both with `parentID` = the user message.

### C.3 Prompt (`POST /session/{id}/message`)

Legacy body `{parts:[{type:'text',text}|{type:'file',mime,filename,url}|{type:'agent',name}], model?:{providerID,modelID}, agent?, variant?, tools?, system?, messageID?, noReply?}` →
```
POST /api/session/{id}/prompt
{ id?: messageID (must start with 'msg_'),
  prompt: { text: textParts.join('\n\n'),
            files?: fileParts.map(p => ({ uri: p.url, name: p.filename })),   // mime is re-derived server-side from data: URL or extension
            agents?: agentParts.map(p => ({ name: p.name })) },
  delivery: 'steer',            // 'queue' leaves input admitted-but-invisible until the current run ends; the UI queues client-side anyway
  resume: noReply ? false : undefined }
→ 200 {data:{admittedSeq, id, sessionID, prompt, delivery, timeCreated}}
```
* `model`/`variant`/`agent` are **session state** in v2: call `/model` / `/agent` first (each emits a
  durable `*.switched` event and a hidden message). `switchModel` is a no-op if unchanged.
* `tools` (per-prompt MCP on/off map) and `system` have **no v2 equivalent** → dropped.
* Text attachments: the OpenAI-compatible chat protocol rejects non-image files
  (`step.failed: "OpenAI Chat does not support media type text/plain"`, verified). Emulate legacy by
  decoding `data:text/*` URLs and appending them to `prompt.text` as fenced blocks; keep images/PDF as files.
* If the session has a staged revert, `POST .../revert/commit` first (legacy implicitly drops reverted
  messages on the next prompt; v2 does not).
* Sync mode (needed by `server/api/v1/sessions/[id]/prompt.post.ts` and `server/routes/mcp.post.ts`,
  which read `reply.parts`): `POST .../wait` is 503 in 1.18 → wait for idle (§D.3) with the request's
  timeout, then `GET /api/session/{id}/message?order=desc&limit=50`, take assistant messages with
  `id > admitted.id` (ids sort by time), return the **last** one mapped to `{info, parts}`. If no
  `step.started` arrives within ~15 s (e.g. no model resolvable) return 502 with a clear message.

### C.4 Commands (`POST /session/{id}/command`)
No execution endpoint. Adapter: find `name` in `GET /api/command?L(D)` (`{name, template, description?,
agent?, model?:{id,providerID,variant?}, subtask?}`); expand `$ARGUMENTS` → full args, `$1..$n` →
positional (last placeholder swallows the rest); then `switchAgent`/`switchModel` if the command sets
them and prompt the text (§C.3). Unsupported vs legacy: `` !`shell` `` interpolation, `@file`
expansion, `subtask: true` (no subagents) — run inline. `init` exists as a command (template verified).

### C.5 Command list
`GET /api/command` → `data.map(c => ({name, description, template, agent, model: c.model && `${c.model.providerID}/${c.model.id}`, subtask, source:'command'}))`.
Optionally append `GET /api/skill` entries with `slash !== false` as `{name, description, source:'skill', template: content}`.

### C.6 Providers (`GET /config/providers`)
v2 `Provider.Info {id, integrationID?, name, disabled?, api{type, package?, url?, settings?}, request{headers, body}}`,
v2 `Model.Info {id, providerID, family?, name, api, capabilities{tools, input[], output[]}, request{headers, body, variant?}, variants[{id, headers, body}], time{released}, cost[{tier?, input, output, cache{read,write}}], status, enabled, limit{context, input?, output}}`.

```
providers = provider.data.filter(p => !p.disabled).map(p => ({
  id: p.id, name: p.name, source: 'v2', env: [],
  models: Object.fromEntries(model.data.filter(m => m.providerID === p.id && m.enabled).map(m => [m.id, {
    id: m.id, providerID: m.providerID, name: m.name, family: m.family, status: m.status,
    release_date: m.time.released ? new Date(m.time.released).toISOString().slice(0,10) : undefined,
    capabilities: { toolcall: m.capabilities.tools,
                    attachment: m.capabilities.input.some(x => x !== 'text'),
                    reasoning: m.variants.length > 0,            // heuristic: v2 has no reasoning flag
                    input: {text:true, image: has('image'), pdf: has('pdf'), audio: has('audio'), video: has('video')} },
    reasoning: m.variants.length > 0,
    cost: pick(m.cost.find(c => !c.tier) ?? m.cost[0]),       // {input, output, cache:{read,write}} per 1M tokens
    limit: m.limit,
    variants: Object.fromEntries(m.variants.map(v => [v.id, v.body])) }]))
}))
default = {}   // v2 exposes no default model (catalog.model.default() is internal); see §E
```
**Redact**: both `/api/provider` and `/api/model` return secrets in clear
(`api.settings.apiKey: "sk-mock"` verified) and possibly `request.headers`/`body`. Never forward `api`,
`request`, or variant `headers`.

### C.7 Agents
`Agent.Info {id, model?, request, system?, description?, mode: primary|subagent|all, hidden, color?, steps?, permissions[{action, resource, effect}]}` →
`{name: id, description, mode, hidden, color, steps, model: model && {providerID: model.providerID, modelID: model.id}, variant: model?.variant, prompt: system, permission: permissions.map(r => ({permission: r.action, pattern: r.resource, action: r.effect}))}`.
1.18.34 list: `build`, `plan` (primary), `general`, `explore` (subagent), `compaction`, `title`, `summary`
(hidden). Filter `hidden` in selectors.

### C.8 Permissions
v2 `Permission.Request {id:'per_…', sessionID, action, resources[], save?[], metadata?, source?:{type:'tool', messageID, callID}}`
(verified: `{action:'bash', resources:['echo hello-from-bash'], save:['echo hello-from-bash'], source:{…}}`, no metadata) →
```
{ id, sessionID,
  permission: action, patterns: resources, always: save ?? [], metadata: metadata ?? {},
  tool: source?.type==='tool' ? {messageID: source.messageID, callID: source.callID} : undefined,
  // fields the current PermissionPrompt.vue reads:
  title: action === 'bash' ? `Run: ${resources.join(' ')}` : `${action}: ${resources.join(', ')}`,
  type: action, pattern: resources, messageID: source?.messageID, callID: source?.callID }
```
Behavioural note (verified): replying `reject` makes the tool fail (`"Unable to execute command: …"`)
and **the loop continues** (model sees the error and answers); legacy v1 halted the turn.

---

## D. Events: v2 → legacy

### D.1 Translator architecture
* One upstream `GET /api/event` per Nitro process (auth injected), fan-out to browser
  `/api/opencode/event?directory=D` clients; per client filter on `event.location.directory`.
* Downstream frame format = legacy: `data: {"id": <v2 id>, "type": <legacy type>, "properties": {...}}\n\n`.
  Forward `: heartbeat` comments (keeps Traefik/tinyauth idle timers alive; EventSource ignores them).
* On upstream (re)connect emit `server.connected` to every client (the UI then refetches messages,
  questions, permissions); also run the idle reconciliation (§D.3).
* Stateful projector keyed by `assistantMessageID` (and `sessionID` for user/shell): holds the legacy
  `info` + ordered parts + raw accumulators. When an event references an unknown assistant message
  (client connected mid-turn), seed it with `GET /api/session/{sid}/message/{mid}` and buffer events
  until the seed resolves. Evict state after idle.
* Deltas: emit `message.part.updated` with the **accumulated** text, throttled to ≤ 1 per 50–100 ms per
  part, and always on `*.ended` (the UI only consumes full parts). Optionally also emit legacy
  `message.part.delta {sessionID, messageID, partID, field:'text', delta}`.

### D.2 Event table

| v2 event (`data` fields) | legacy event(s) emitted (`properties`) |
|---|---|
| `server.connected {}` | `server.connected {}` |
| `session.created {sessionID, info(v1 shape)}` (durable seq 0) | `session.created {info}` **and** `session.updated {info}` (the sidebar only upserts on `session.updated`) |
| `session.updated` / `session.deleted` (v1 shape; in the v2 union but never emitted by the v2 runner) | pass-through |
| `session.next.prompt.admitted {messageID, prompt, delivery}` | `delivery==='steer'` → busy (§D.3). No message yet (the user message only exists after `prompted`) |
| `session.next.prompted {messageID, prompt{text, files?, agents?}, delivery, timestamp}` | `message.updated {info: user(§C.2)}` + `message.part.updated` per text/file/agent part; `session.updated {info: cached session with time.updated = timestamp, derived title}`; busy |
| `session.next.step.started {assistantMessageID, agent, model, snapshot?}` | `message.updated {info: assistant, no completed}` + `message.part.updated step-start`; busy |
| `session.next.reasoning.started {reasoningID, providerMetadata?}` / `.delta {delta}` / `.ended {text}` | `message.part.updated reasoning` (`time.start` on started, accumulated text on delta, final text + `time.end` on ended) |
| `session.next.text.started {textID}` / `.delta {delta}` / `.ended {text}` | `message.part.updated text` (same pattern) |
| `session.next.tool.input.started {callID, name}` | `message.part.updated tool {state:{status:'pending', input:{}, raw:''}}` |
| `session.next.tool.input.delta {callID, delta}` | accumulate `raw` (throttled update optional) |
| `session.next.tool.input.ended {callID, text}` | `tool pending raw = text` |
| `session.next.tool.called {callID, tool, input, provider}` | `tool {status:'running', input, title, time.start}` |
| `session.next.tool.progress {callID, structured, content}` | `tool running` with `metadata: structured` |
| `session.next.tool.success {callID, structured, content, outputPaths?, result?, provider}` | `tool {status:'completed', …}` (§C.2) |
| `session.next.tool.failed {callID, error, result?, provider}` | `tool {status:'error', error: error.message}`; if `"Tool execution interrupted"` → idle check (question-reject path emits **no** step event) |
| `session.next.step.ended {assistantMessageID, finish, cost, tokens, snapshot?, files?}` | `message.part.updated step-finish {reason: finish, cost, tokens, snapshot}` + `message.updated {info + time.completed = timestamp, finish, cost, tokens}`; `finish !== 'tool-calls'` → idle check |
| `session.next.step.failed {assistantMessageID, error}` | `message.updated {info + completed, finish:'error', error: mapError}`; `session.error {sessionID, error: mapError}` **unless** MessageAbortedError (user stop must not raise the Retry toast); idle check |
| `session.next.retried {attempt, error{message, statusCode?, isRetryable}}` | `session.status {sessionID, status:{type:'retry', attempt, message: error.message, next: now}}` (schema only; not emitted by 1.18 runner) |
| `session.next.compaction.started {messageID, reason}` / `.delta {text}` | busy |
| `session.next.compaction.ended {messageID, reason, text, recent}` | `message.updated` (assistant, `summary:true`, completed) + text part; `session.compacted {sessionID}` |
| `session.next.synthetic {messageID, text}` | user message + text part `synthetic:true` |
| `session.next.context.updated {messageID, text}` | drop (system context) |
| `session.next.shell.started {messageID, callID, command}` / `.ended {callID, output}` | assistant message + bash tool part running → completed |
| `session.next.agent.switched {agent}` / `.model.switched {model}` | `session.updated {info: cached session + agent/model}` |
| `session.next.moved {location, subdirectory?}` | `session.updated` (refetch session) |
| `session.next.revert.staged {revert}` / `.cleared` / `.committed {messageID}` | `session.updated {info + revert}`; after `committed` emit `message.removed {sessionID, messageID}` for every cached message after the boundary (or rely on the UI's `loadAll()` after undo/redo) |
| `permission.v2.asked {…Request}` | `permission.asked` (§C.8 shape) |
| `permission.v2.replied {sessionID, requestID, reply}` | `permission.replied {sessionID, requestID, permissionID: requestID, reply, response: reply}` |
| `question.v2.asked {…Request}` | `question.asked` (same shape) |
| `question.v2.replied {sessionID, requestID, answers}` | `question.replied` (same) |
| `question.v2.rejected {sessionID, requestID}` | `question.rejected` (same) |
| `todo.updated {sessionID, todos[{content,status,priority}]}` | pass-through (same name/shape) |
| `file.edited`, `file.watcher.updated` | pass-through |
| `catalog.updated`, `models-dev.refreshed`, `integration.updated`, `integration.connection.updated` | optional: invalidate providers cache; may forward |
| `plugin.added`, `reference.updated`, `project.directories.updated`, `pty.*` | drop |
| (synthesized, §D.3) | `session.status {sessionID, status:{type:'busy'}}` on idle→busy; `session.status {…{type:'idle'}}` + `session.idle {sessionID}` on busy→idle |

Observed sequences (from `samples/event-type-sequence.json`, `p4-reject.json`):
* text turn: `prompt.admitted → prompted → step.started → reasoning.started → reasoning.delta×N →
  reasoning.ended → text.started → text.delta×N → text.ended → step.ended(stop)`
* tool turn with permission: `… step.started → tool.input.started → tool.input.delta×2 → tool.input.ended →
  tool.called → permission.v2.asked → permission.v2.replied → tool.success → step.ended(tool-calls) →
  step.started → text… → step.ended(stop)` (second assistant message)
* provider down: `prompted → step.started → step.failed("HTTP transport failed")` (~300 ms)
* interrupt: `… text.delta×N → step.failed("Provider turn interrupted")` (queued prompt stays admitted, not run)
* question reject: `… tool.called → question.v2.asked → question.v2.rejected → tool.failed("Tool execution interrupted")` — **then nothing**; session leaves `/api/session/active` within ~250 ms

### D.3 Busy / idle synthesis
v2 has **no status events** (runner TODO: "Mark busy, retrying, idle … status durably"). `GET
/api/session/active` → `{data: {[sessionID]: {type:'running'}}}` (absent = idle) is the source of truth.
```
busy[sid] := true on prompted | step.started | compaction.started | prompt.admitted(steer)   -> emit busy on transition
candidate idle on step.ended(finish != 'tool-calls') | step.failed | tool.failed('Tool execution interrupted')
              | question.v2.rejected | permission reply 'reject' | interrupt
  -> debounce 300 ms, GET /api/session/active; if sid absent: busy=false, emit idle (+ session.idle);
     if the projector holds an incomplete assistant for sid: emit message.updated with synthesized
     time.completed + MessageAbortedError (question-reject bug)
     else retry at 1 s, 2 s, 4 s
safety net: while any busy[sid], poll /api/session/active every 5 s (catches interrupts from other
clients, runner crashes, lost events); on upstream reconnect: reconcile busy map with /api/session/active
```
Measured: `active` cleared 100–800 ms after the terminal event; during a pending permission/question the
session stays `running`.

### D.4 Per-page resync (optional, gap-free)
Track `lastSeq[sid] = durable.seq` from frames. After an upstream gap, for each session with an open page:
`GET /api/session/{sid}/history?after=lastSeq&limit=100` (loop while `hasMore`) and feed the durable events
through the projector (no deltas needed: `*.ended` carry full text). Simpler alternative (what the UI does
today): refetch `/message` on `server.connected`.

---

## E. Gaps (v2 in 1.18.34) and suggested UI degradation

Expose a capability map from the adapter (e.g. `GET /api/v1/capabilities` → `{protocol:'v2', mcp:false, …}`)
and gate UI affordances on it instead of letting calls 501.

| Legacy feature | v2 status | Degradation |
|---|---|---|
| MCP: `GET/POST /mcp`, connect/disconnect/auth, MCP tools in chat, MCP Apps, `tools` toggles per prompt | **absent**: no MCP routes; v2 runner advertises only `apply_patch, bash, edit, glob, grep, question, read, skill, todowrite, webfetch, websearch, write` (mock LLM request log) | Hide MCP page, `/mcp` chat command, MCP mode control; `/api/v1/mcp-*` and `/mcp` route return "unsupported". `integration` is provider credentials only |
| Config read/write (`/config`, `/global/config`) | absent | Hide config editing; model default unknown → persist the user's last model per project in opencode-web meta and always send it (switchModel) |
| Default model (`providers.default`, `config.model`) | absent | Fallback order: meta last-used → `build` agent `model` → first enabled model of the first provider |
| Session rename / auto title | absent (titles stay `"New session - <ISO>"`) | Client-side titles in opencode-web meta: on first `prompted` derive `title = first line of prompt (≤60 chars)`; rename writes meta; `toLegacySession` applies the override |
| Session delete | absent | "Hide" in meta (soft delete) + filter list; label it as such |
| Fork, share, diff (`/session/{id}/diff`) | absent | Hide buttons/menus; diff: show `revert.files` only while a revert is staged |
| `!shell` | absent (`OperationUnavailable`, no route) | Hide `!` shortcut (PTY API exists but is a terminal, not a session shell) |
| Slash commands execution | no endpoint | Client/adapter template expansion (§C.4); no `` !`…` ``/`@file`/subtask |
| `/compact` `/summarize` | route exists, **503** "not available yet" | Show the server message; enable when 204 |
| `/undo` `/redo` | stage/clear/commit with different boundary semantics | §C #23–24; first turn cannot be undone; commit before next prompt |
| Todos read | no endpoint | Derive from last `todowrite` (§C #18) + live `todo.updated` |
| Projects list (`/project`) | absent | Derive from sessions + `/api/location` + meta favorites (§C #1) |
| `/path` home/config | only `directory` + project root | Hide host-home hints (MCP page) |
| Busy/idle/retry status, `session.error` | absent | Synthesized (§D.3); retry info unavailable |
| Cost | always 0 (runner TODO), session tokens 0 | Stats page: sum tokens from messages; cost = Σ tokens × `model.cost` (per 1M) or hide |
| Subagents / child sessions | no task tool, `parentID` never set | nothing to do |
| Text-file attachments | rejected by OpenAI-compatible chat path | Inline as text (§C.3) |
| Queued prompts (`delivery:'queue'`) | admitted but invisible until promoted; dropped run on interrupt | Keep the UI's client-side queue; always send `steer` when idle |
| `wait` | 503 | Poll `/api/session/active` |
| Permission "always" management | **new**: `GET /api/permission/saved?projectID=`, `DELETE /api/permission/saved/{id}` | Optional new settings panel |
| Provider auth | `integration.connect.key` / OAuth attempts | `PUT /auth` maps to key connect; OAuth needs new UI |

Hybrid 1.18 caveats (why the adapter must not be used when legacy is available):
* Sessions created/run by the legacy runner are invisible to v2 messages
  (`samples/legacy-session-v2-view.json` → `{"data":[]}`).
* `/api/event` encodes with the v2 union; the first legacy-only event (`session.status`,
  `message.part.delta`, `session.diff`…) ends the stream — verified: after a legacy prompt it stopped
  right after `session.updated` seq 4 (`samples/legacy-runner.api-event.sse.txt`).
* 1.18 mirrors v2 events onto the legacy `/event` bus untouched (`samples/legacy-event.sse.txt` contains
  `session.next.*`), so today's UI would not render v2-runner sessions even on legacy transport.
* The v2 runner ignores MCP; `GET /session/{id}/message` (legacy) for v2-run sessions was not verified.

---

## F. Samples (`./samples/`)

Paths contain the scratch project dir `…\compat-v2\work`; credentials are fake (`secretpw`, `sk-mock`).

| File | What |
|---|---|
| `v2-openapi.json` | v2 subset (54 paths, 246 schemas) extracted from 1.18 `/doc`; `legacy-doc-openapi.json` = full `/doc` |
| `api-event.sse.txt` / `.parsed.json` | **raw global SSE** for the whole probe (connect, plugin boot noise, 3 sessions: text, bash+permission, question, failed attachment, dead provider, interrupt+queue) |
| `api-session-event.sse.txt` / `.parsed.json` | raw per-session durable SSE (no deltas) |
| `p2-api-event.sse.txt` | global SSE via `?auth_token=`: todowrite → `todo.updated`, read tool → `tool.failed` |
| `p2-session-event-replay-after3.sse.txt` | `?after=3` replay starts at seq 4 |
| `p2-unauth-event.txt` | 401 body |
| `event-type-sequence.json` | compressed type sequences (api / session / legacy streams) |
| `p4-reject.json` | permission reject + question reject sequences, `/api/session/active` timeline, zombie assistant |
| `health`, `location-*`, `agent`, `model`, `provider`, `provider-get`, `integration`, `command`, `skill`, `reference`, `fs-*`, `p2-fs-find-readme` | discovery responses (`*.json` = `{request, status, contentType, body}`) |
| `session-create*`, `session-get*`, `session-list-*`, `session-active-*` | session CRUD/listing (`session-get-reverted` shows agent/model/revert) |
| `session-prompt-*`, `session-messages-*`, `session-message-one`, `session-context`, `session-history*` | prompt admission, projected messages (text/tool/question/error/interrupt), durable history |
| `session-permission-*`, `permission-request-*`, `permission-saved`, `session-question-*`, `question-request-*` | permission/question flows |
| `session-compact`, `session-wait` (503), `session-prompt-conflict` (409), `err-*` (400/404) | error shapes |
| `session-revert-stage`, `session-revert-clear`, `session-switch-agent`, `session-switch-model`, `session-interrupt` | actions |
| `legacy-*.json`, `legacy-runner.*.sse.txt`, `legacy-event.*` | same server, **legacy runner** target shapes (messages, session, permission, legacy SSE) and the `/api/event` truncation |
| `probe-log.txt` | request log + session ids |

Re-run against any server: `OPENCODE_VERSION=<v> COMPAT_PROTOCOL=v2 npx playwright test -c playwright.compat.config.ts`
(real opencode + `scripts/mock-llm.mjs`, see `scripts/compat-server.mjs`).
