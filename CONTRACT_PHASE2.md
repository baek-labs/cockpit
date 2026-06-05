# Hames Cockpit — Build Contract (Phase 2: Operate)

> Builds on Phase 1. WORKER 1 owns `cockpit/server/`. WORKER 2 owns `cockpit/web/`.
> Do not touch the other's folder. Orchestrator (parent) writes this file, integrates, tests.
> Keep all Phase-1 behavior working; Phase 2 ADDS operation on top of the read cockpit.

Phase 2 goal: turn the gated buttons into real actions — **lock/unlock, save, pull, and agent
spawn** — by having the backend launch real Claude Code runs (`claude -p`) and stream their
output to a live job console in the UI. The cockpit becomes operational, not just a viewer.

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
3. **IN scope (build these):** read-only agent spawn + lock/unlock (direct safe writes) + the live
   jobs console. Un-gate ONLY the spawn / lock / unlock buttons (save/pull stay gated).
4. Ignore every `--dangerously-skip-permissions` mention and the save/pull composed-prompt lines below.

## Safety model (read carefully — this is the whole point)

- Spawned runs use `claude -p ... --dangerously-skip-permissions`. That flag only bypasses the
  *interactive permission prompts* (which cannot be answered in headless mode). **The Hames hooks
  still fire** for the spawned process — defense lines (context_verifier), workspace_guard, and
  compliance_auditor all run. So a spawned agent is **autonomous but harness-governed**.
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
- agent in {CFO,CSO,CBO,CTO,Marketer}: 
  `"You are acting as the Hames ${agent}. Task: ${userPrompt}\n\nDefault to advisory mode — read what you need and return a clear, structured result. Make file changes only if the task explicitly requires it."`
- agent == 'COO' or empty: `userPrompt` as-is.
- save: `"Run the /save command (the Hames save skill) now: commit all changes and push to main with the submodule safety checks. Report the outcome concisely."`
- pull: `"Run the /pull command (the Hames pull skill) now: pull the parent and update all submodules. Report the outcome concisely."`

### Edit `server/actions.js`
Keep Phase-1 actions. ADD:
- `setLock(workspace)`: read `.claude/.workspace_lock` (v2 `{version:2,sessions:{}}`; if missing/v1, create v2),
  set `sessions['cockpit'] = { workspace, locked:true, updated_at: new Date().toISOString() }`, write back
  (pretty JSON). Append one line to the audit log: `{"ts":ISO,"hook":"cockpit","result":"LOCK_SET","tool":"cockpit","workspace":workspace}`.
  Return `{ ok:true, lock:{ workspace, locked:true } }`.
- `clearLock()`: same but `sessions['cockpit'] = { workspace:null, locked:false, updated_at:ISO }`; audit `"LOCK_CLEAR"`.
  Return `{ ok:true, lock:{ workspace:null, locked:false } }`.
- These manage the cockpit's OWN lock entry (keyed `'cockpit'`). Document inline that this sets the
  cockpit-declared lock; it does not force-lock other already-running Claude sessions.

### Edit `server/index.js`
Keep Phase-1 routes. ADD:
- `POST /api/spawn`  body `{agent, prompt}` → `orchestrator.spawnAgent` → `{ok:true, jobId}` (or `{ok:false,reason}`).
- `GET  /api/jobs`             → `{ jobs: orchestrator.getJobs() }`.
- `GET  /api/jobs/:id`         → full job, or 404 `{error}`.
- `POST /api/jobs/:id/stop`    → `{ ok: orchestrator.stopJob(id) }`.
- Extend `POST /api/action` dispatch:
  - `type:"save"` → `{ok:true, jobId: orchestrator.runSlash('save')}`
  - `type:"pull"` → `{ok:true, jobId: orchestrator.runSlash('pull')}`
  - `type:"lock"`, `arg:"<workspace>"` → `actions.setLock(arg)`
  - `type:"unlock"` → `actions.clearLock()`
  - existing `git.fetch`/`open`/`refresh` unchanged.
- Parse `:id` from the path manually (no framework). Keep zero dependencies.

### W1 done signal
Start the server, then run a REAL pipeline test (cheap):
`curl -s -X POST http://127.0.0.1:8765/api/spawn -H 'content-type: application/json' -d '{"agent":"COO","prompt":"Reply with exactly one word: PONG"}'`
then poll `GET /api/jobs/<id>` until status != running and paste the final job JSON (RAW). Then
`curl -s http://127.0.0.1:8765/api/state | head -c 200` to confirm Phase 1 still works. Stop server, print `[W1 DONE]`.

---

## WORKER 2 — frontend (`cockpit/web/`)

Keep all Phase-1 panels working. CHANGES:

1. **Un-gate** the disabled lock/unlock/save/pull/spawn buttons (remove the `gatedBtn` disabling).
2. **New left-nav section `Operations`** (add to the nav list) containing:
   - **Spawn form:** an agent `<select>` populated from `state.agents.level1` names plus a `COO`
     option (default `COO`); a prompt `<textarea>`; a **Launch** button. On launch → `confirm()`
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
4. **Wire lock/unlock:** a small control (in the KPI area or Workspaces header) — a workspace
   `<select>` + **Lock**/**Unlock** buttons → `POST /api/action {type:'lock',arg:ws}` /
   `{type:'unlock'}` → on success refresh state so the KPI active-workspace updates. (No confirm
   needed — reversible.)
5. Keep the ShipOS aesthetic; the job console should feel like the ShipOS live-agent stream
   (monospace, tool chips, status colors). Reuse existing CSS variables/classes.

### W2 done signal
Print the changed file list and `[W2 DONE]`. (Orchestrator runs the live end-to-end test.)

---

## Shared API summary (the seam)

```
POST /api/spawn        {agent,prompt}            -> {ok, jobId} | {ok:false, reason}
GET  /api/jobs                                   -> {jobs:[{id,kind,agent,label,status,startedAt,endedAt,summary}]}
GET  /api/jobs/:id                               -> full job {id,kind,agent,prompt,status,startedAt,endedAt,exitCode,result,events:[{t,...}]}
POST /api/jobs/:id/stop                          -> {ok}
POST /api/action {type:'save'|'pull'}            -> {ok, jobId}
POST /api/action {type:'lock', arg:'<ws>'}       -> {ok, lock:{workspace,locked}}
POST /api/action {type:'unlock'}                 -> {ok, lock:{workspace:null,locked:false}}
POST /api/action {type:'git.fetch'|'open'|'refresh'}   (Phase 1, unchanged)
GET  /api/state                                  (Phase 1, unchanged)
```
