# Hames Cockpit — Build Contract (Phase 2: Operate)

> Builds on Phase 1. WORKER 1 owns `cockpit/server/`. WORKER 2 owns `cockpit/web/`.
> Do not touch the other's folder. Orchestrator (parent) writes this file, integrates, tests.
> Keep all Phase-1 behavior working; Phase 2 ADDS operation on top of the read cockpit.

Phase 2 goal: turn the gated buttons into real actions — **save, pull, and agent
spawn** — by having the backend launch real Claude Code runs (`claude -p`) and stream their
output to a live job console in the UI. The cockpit becomes operational, not just a viewer.

## ⚠ 2026-11-16 UPDATE (authoritative — overrides everything below)

- Role agents were removed from Hames. Every spawn runs as the main Hames agent: `POST /api/spawn`
  takes `{prompt}`; an `agent` field is ignored, and every job's `agent`/`label` is `"Hames"`. The
  prompt is passed as-is (no role prompt composition).
- Hames removed the workspace lock on 2026-11-11. The cockpit has no lock/unlock actions and never
  writes the lock file or the audit log.
- `/api/state` no longer has `agents`; see `CONTRACT.md` §3 for `subagents`.

## ⚠ SAFE-MODE OVERRIDE (authoritative — CEO chose advisory mode)

These rules OVERRIDE anything below that conflicts. The CEO selected **safe / advisory mode**:

1. **Agent spawns are READ-ONLY.** No `--dangerously-skip-permissions`, no `--permission-mode plan`.
   The exact spawn command is:
   ```
   claude -p "<composedPrompt>" --output-format stream-json --verbose \
     --disallowedTools Write Edit NotebookEdit Bash Task --model claude-opus-4-8
   ```
   The agent can ONLY Read/Grep/Glob/WebSearch and reason. It physically cannot write files, run
   shell, or spawn subagents. No permission bypass; default permission mode → no headless hang.
2. **save / pull are NOT executed in this pass.** Do NOT implement `orchestrator.runSlash`. The
   save/pull buttons stay **gated/disabled** with the note "requires full-autonomous mode (not enabled)".
   `POST /api/action {type:'save'|'pull'}` → `{ok:false, gated:true, message:"requires full-autonomous mode"}`.
3. **IN scope (build these):** read-only agent spawn + the live jobs console. Un-gate ONLY the
   spawn button (save/pull stay gated).
4. Ignore every `--dangerously-skip-permissions` mention and the save/pull composed-prompt lines below.

## Safety model (read carefully — this is the whole point)

- Spawned runs use `claude -p ... --dangerously-skip-permissions`. That flag only bypasses the
  *interactive permission prompts* (which cannot be answered in headless mode). **The Hames hooks
  still fire** for the spawned process — workspace_guard and compliance_auditor run. So a spawned
  agent is **autonomous but harness-governed**.
- Spawns run with `cwd = ROOT` (the Hames install), so they inherit `CLAUDE.md` + hooks.
- Agent spawns are **advisory by default** (read + reason + report). The agent may act if the
  task requires it, but the prompt steers toward analysis unless told otherwise.
- `save` / `pull` are outward/irreversible-ish → the **frontend must confirm** before launching.
- In-memory jobs only (lost on server restart) — fine for v1. Cap: **max 3 concurrent jobs**;
  reject new spawns over the cap with `{ok:false, reason:"max concurrent jobs"}`. Cap each job's
  stored event list at 2000 events (drop oldest with a truncation marker).
- The spawn prompt is passed as a **process argv element**, never through a shell — no shell
  injection. Keep using `child_process.spawn('claude', [...])`, not `exec`.

---

## Verified mechanism (ground truth — tested on this machine)

Spawn command (backend builds this):

```
claude -p "<composedPrompt>" \
  --output-format stream-json --verbose \
  --dangerously-skip-permissions \
  --model claude-opus-4-8
```

`stream-json` emits **one JSON object per line**. Relevant shapes (verified):

```json
{"type":"system","subtype":"init","session_id":"...","cwd":"..."}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{...}}]}}
{"type":"result","subtype":"success","is_error":false,"result":"<final text>","duration_ms":3528,"num_turns":1}
```

Other lines (`subtype:"hook_started"|"hook_response"`, `type:"rate_limit_event"`) are noise → ignore.
Parse each stdout line with `JSON.parse` inside try/catch; skip lines that don't parse.

---

## WORKER 1 — backend (`cockpit/server/`)

### New file: `server/orchestrator.js`
In-memory job registry + child-process spawner.

- `jobs` = Map(id → job). Job object (also the `/api/jobs/:id` response shape):
  ```js
  { id, kind: 'agent'|'save'|'pull', agent: string|null, prompt,
    status: 'running'|'done'|'error', startedAt: ISO, endedAt: ISO|null,
    exitCode: number|null, result: string|null,
    events: [ /* normalized, see below */ ] }
  ```
- `id`: short unique string (e.g. `'job_' + Date.now().toString(36) + counter`). Node `Date` is fine here.
- `spawnAgent({agent, prompt})`: compose prompt (below), spawn `claude` with the verified args
  (cwd=ROOT), wire `readline` over child.stdout, JSON.parse each line, push normalized events,
  update status on `result`/close. Returns the job id. Enforce max-3 concurrent.
- `runSlash(kind)`: same machinery; `kind` is `'save'` or `'pull'`; composes the slash prompt below.
- `getJobs()` → array (newest first) of `{id, kind, agent, label, status, startedAt, endedAt, summary}`
  where `label` = agent or kind, `summary` = first ~80 chars of latest text/result.
- `getJob(id)` → full job object (or null).
- `stopJob(id)` → kill the child (`child.kill('SIGTERM')`), set status `'error'`/`endedAt`. Returns bool.

Normalized event shapes (what the frontend renders):
- `{ t:'system', text:'session started' }`            ← from `type:system, subtype:init`
- `{ t:'text', text:'...' }`                            ← assistant text content
- `{ t:'tool', tool:'Read', brief:'<short input>' }`    ← assistant tool_use (brief = e.g. file path / cmd, truncated 120c)
- `{ t:'result', text:'<final>', isError:false }`       ← result line (also sets job.result/status)
- `{ t:'error', text:'...' }`                           ← spawn error / nonzero exit / parse-fatal

Composed prompts:
- agent spawn: `userPrompt` as-is (main Hames agent).
- save: `"Run the /save command (the Hames save skill) now: commit all changes and push to main with the submodule safety checks. Report the outcome concisely."`
- pull: `"Run the /pull command (the Hames pull skill) now: pull the parent and update all submodules. Report the outcome concisely."`

### Edit `server/index.js`
Keep Phase-1 routes. ADD:
- `POST /api/spawn`  body `{prompt}` (any `agent` field ignored) → `orchestrator.spawnAgent` → `{ok:true, jobId}` (or `{ok:false,reason}`).
- `GET  /api/jobs`             → `{ jobs: orchestrator.getJobs() }`.
- `GET  /api/jobs/:id`         → full job, or 404 `{error}`.
- `POST /api/jobs/:id/stop`    → `{ ok: orchestrator.stopJob(id) }`.
- Extend `POST /api/action` dispatch:
  - `type:"save"` → `{ok:true, jobId: orchestrator.runSlash('save')}`
  - `type:"pull"` → `{ok:true, jobId: orchestrator.runSlash('pull')}`
  - existing `git.fetch`/`open`/`refresh` unchanged.
- Parse `:id` from the path manually (no framework). Keep zero dependencies.

### W1 done signal
Start the server, then run a REAL pipeline test (cheap):
`curl -s -X POST http://127.0.0.1:8765/api/spawn -H 'content-type: application/json' -d '{"prompt":"Reply with exactly one word: PONG"}'`
then poll `GET /api/jobs/<id>` until status != running and paste the final job JSON (RAW). Then
`curl -s http://127.0.0.1:8765/api/state | head -c 200` to confirm Phase 1 still works. Stop server, print `[W1 DONE]`.

---

## WORKER 2 — frontend (`cockpit/web/`)

Keep all Phase-1 panels working. CHANGES:

1. **Un-gate** the disabled save/pull/spawn buttons (remove the `gatedBtn` disabling).
2. **New left-nav section `Operations`** (add to the nav list) containing:
   - **Spawn form:** a prompt `<textarea>` and a **Launch** button (runs the main Hames agent). On launch → `confirm()`
     ("Launch an autonomous Hames agent? It runs under the harness.") → `POST /api/spawn` →
     on `{jobId}` open that job's console.
   - **Jobs list:** poll `GET /api/jobs` every 2s; render newest-first rows (kind/agent chip,
     status badge running/done/error, started time, summary). Click a row → job console.
   - **Job console:** for the selected job, poll `GET /api/jobs/:id` every 1.5s **while running**
     (stop polling when done/error). Render `events` in order: `text`→assistant text block,
     `tool`→`⚙ {tool}: {brief}` line, `result`→final block (green if ok, red if isError),
     `system`/`error`→muted line. Running → show a spinner + a **Stop** button (`POST /api/jobs/:id/stop`).
     **Escape every event string** (agent output can contain `<>&"`).
3. **Wire save/pull:** the `save`/`pull` buttons → `confirm()` → `POST /api/action {type}` →
   on `{jobId}` jump to that job console (they stream like any job).
5. Keep the ShipOS aesthetic; the job console should feel like the ShipOS live-agent stream
   (monospace, tool chips, status colors). Reuse existing CSS variables/classes.

### W2 done signal
Print the changed file list and `[W2 DONE]`. (Orchestrator runs the live end-to-end test.)

---

## Shared API summary (the seam)

```
POST /api/spawn        {prompt}                  -> {ok, jobId} | {ok:false, reason}
GET  /api/jobs                                   -> {jobs:[{id,kind,agent,label,status,startedAt,endedAt,summary}]}
GET  /api/jobs/:id                               -> full job {id,kind,agent,prompt,status,startedAt,endedAt,exitCode,result,events:[{t,...}]}
POST /api/jobs/:id/stop                          -> {ok}
POST /api/action {type:'save'|'pull'}            -> {ok, jobId}
POST /api/action {type:'git.fetch'|'open'|'refresh'}   (Phase 1, unchanged)
GET  /api/state                                  (Phase 1, unchanged)
```
