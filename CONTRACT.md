# Hames Cockpit — Build Contract (Phase 1)

> Single source of truth for the cockpit build. Two workers build to this contract.
> WORKER 1 owns `cockpit/server/`. WORKER 2 owns `cockpit/web/`. Do not touch the other's folder.
> Orchestrator (parent) writes this file, integrates, and tests.

Phase 1 goal: a **portable, read-everything operational cockpit** for HamesSystem.
It must run BOTH on this personal install (16 real workspaces, `Anti/.Arsenal`) AND when
dropped into the public `baek-labs/hames` repo (0 workspaces, `arsenal/`). So: **discover
everything at runtime, hardcode nothing, degrade gracefully when data is missing.**

Hard constraints (both workers):
- **Zero npm dependencies.** Node.js built-ins only (`http`, `fs`, `path`, `child_process`, `url`).
- **Cross-platform.** macOS / Linux / Windows. No shell-specific assumptions.
- **Bind `127.0.0.1` only.** Never `0.0.0.0`.
- **No build step.** Vanilla HTML/CSS/JS on the frontend.
- **Escape all strings that come from files** (log lines, paths, descriptions may contain `<>&"`).
- Node code MAY use `Date`/`Date.now()` normally (that restriction is workflow-only).

---

## 1. Discovery rules (WORKER 1 implements in `server/config.js`)

`ROOT` = `process.env.HAMES_ROOT` (resolved) OR `path.resolve(__dirname, '..', '..')`.

Detect by first-existing candidate (relative to ROOT):

| Thing | Candidates (in order) | If none exist |
|---|---|---|
| arsenalDir | `Anti/.Arsenal`, `arsenal`, `.Arsenal` | `null` |
| logDir | `HAMES_LOG_DIR` if set; else macOS `~/Library/Logs/Hames`, Windows `%LOCALAPPDATA%/Hames/Logs`, Linux `${XDG_STATE_HOME:-~/.local/state}/hames/logs` (same rule as `Anti/.Arsenal/log_rotation.js`) | that path |
| sessionLog | `<logDir>/session_log.jsonl` | that path (missing file → 0 / empty list) |
| auditLog | `<logDir>/workspace_audit.log` | that path (missing file → 0 / empty list) |
| claudeProjectDir | `<os.homedir()>/.claude/projects/<ROOT with every non-alphanumeric char replaced by '-'>` | that path |
| registry | `.claude/workspace_paths.json` | `null` (empty registry) |
| commandsDir | `.claude/commands` | `null` |

Platform opener: `darwin`→`open`, `win32`→`cmd /c start ""`, else `xdg-open`.
`PORT` = `process.env.HAMES_COCKPIT_PORT` or `8765`. `HOST` = `127.0.0.1`.

Export a single `loadConfig()` returning an object with all resolved absolute paths + `platform`, `port`, `host`, `root`, plus an `opener` helper.

---

## 2. Real data formats (ground truth — verified on this machine)

- **session log** (`session_log.jsonl`), one JSON per line:
  `{"ts":"2026-06-04 14:23:17","tool":"Edit","workspace":"ROOT","file":"Sales/AI_Business/..."}`
  (note: `ts` is space-separated local time, NOT ISO.)
- **audit log** (`workspace_audit.log`), one JSON per line:
  `{"ts":"2026-06-05T11:35:31.595Z","hook":"workspace_guard","result":"PASS","tool":"Bash"}`
  Known `result` values: `PASS`, `BLOCKED`, `BYPASS`, `ALLOWED`, `ALLOWED_SYSADMIN`,
  `SKIPPED_SUBAGENT`, `SKIPPED_DISABLED`.
- **Claude Code subagent records** (`<claudeProjectDir>/<session>/subagents/agent-*.meta.json` + the
  same-named `agent-*.jsonl`). Read only the meta fields `description`, `agentType`, `finished` and the
  `.jsonl` modification time. Never read transcript contents. (Hames removed the workspace lock
  2026-11-11; the cockpit no longer reads or writes a lock file.)
- **registry** (`workspace_paths.json`): `{"INVEST":"Anti/00_Investment", ...}` (name → ROOT-relative path).
- **skill file** (`.claude/commands/*.md`) frontmatter: `--- \n description: ... \n ---`.

Big files: read whole + split + slice last N (audit log ~1 MB, fine). Never throw to the caller;
on any read/parse error return a safe empty default.

---

## 3. `GET /api/state` response shape (THE seam — both workers depend on this exactly)

```json
{
  "generatedAt": "<ISO>",
  "root": "<abspath>",
  "platform": "darwin",
  "dataSources": {
    "sessionLog": { "path": "<abspath>", "exists": true },
    "auditLog":   { "path": "<abspath>", "exists": true },
    "claudeSubagents": { "path": "<abspath>", "exists": true },
    "registry":   { "path": "<abspath>", "exists": true }
  },
  "kpis": {
    "lastWorkspace": { "name": "BUSINESS" },
    "workspaceCount": 16,
    "recentSubagentCalls": 3,
    "runningSubagents": 0,
    "actionsToday": 7,
    "harness": { "PASS": 480, "BLOCKED": 12, "BYPASS": 1, "window": 500 },
    "submodules": { "total": 9, "dirty": 0 },
    "gitDirty": 1
  },
  "workspaces": [
    { "name": "BUSINESS", "path": "Anti/01_Business", "exists": true,
      "actions": 134, "lastActivity": "2026-06-05 11:31:56" }
  ],
  "subagents": [
    { "description": "Review draft", "agentType": "general-purpose", "running": false, "finished": true, "status": "done", "updatedAt": "<ISO>" }
  ],
  "skills": [ { "name": "save", "description": "..." } ],
  "git": {
    "branch": "main", "ahead": 0, "behind": 0,
    "dirty": [ { "status": "??", "file": "..." } ],
    "submodules": [ { "path": "Sales/AI_Business", "sha": "e32e30c", "branch": "main", "dirty": false, "state": "clean" } ]
  },
  "sessionFeed": [ { "ts": "2026-06-05 11:31:56", "tool": "Write", "workspace": "BUSINESS", "file": "..." } ],
  "auditFeed":   [ { "ts": "2026-06-05T11:35:31.595Z", "hook": "workspace_guard", "result": "PASS", "tool": "Bash" } ],
  "handoffs": [ { "name": "...", "path": "...", "mtime": "<ISO>" } ]
}
```

Rules for the data:
- `sessionFeed` / `auditFeed`: newest-first, last ~40 entries.
- `harness`: aggregate `result` counts over the last `window` (=500) audit entries.
- `kpis.actionsToday`: session-log entries whose `ts` date == today (local).
- `workspaces`: built from registry; per workspace derive `actions` (count in session log where
  `workspace` matches the NAME) and `lastActivity` (latest such `ts`).
  If registry is `null`, fall back to scanning `workspaces/*` subdirs that contain `CLAUDE.md`.
- `kpis.lastWorkspace.name`: `workspace` of the newest session-log entry that has one (`null` if none). It is the last used workspace, not a live session (the lock-based `activeWorkspace` was removed with the lock).
- `subagents`: records whose `.jsonl` changed within the last 24 h, newest first, at most 12
  (`COCKPIT_SUBAGENT_WINDOW_MS`, `COCKPIT_SUBAGENT_LIMIT` override). `finished` = meta `finished === true`.
  `status` is `done` when finished, `running` when not finished AND the `.jsonl` changed within the last
  5 min (`COCKPIT_SUBAGENT_RUNNING_MS`), otherwise `stale` (no finish record and no recent update — shown
  as "확인 필요", never as done). `running` = `status === "running"`.
  `updatedAt` = that modification time. `kpis.recentSubagentCalls` = count within 24 h before the 12 cap.
  `kpis.runningSubagents` = count of `running` records within 24 h, also before the cap; the main avatar
  lights from this value so a running call outside the 12 shown still lights it.
- `dataSources.claudeSubagents.exists` is `true` when at least one `<session>/subagents` folder exists
  under `claudeProjectDir`; `path` = `claudeProjectDir`.
- Scope: Claude Code sessions started at the Hames root only. Codex subagents and sessions started in
  other folders are not shown. Tested on macOS only; Windows and Linux behavior is untested.
- `git`: shell out via `git -C <ROOT> ...` with `execFileSync`, short timeout, catch all errors
  (a fresh clone may have no upstream → `ahead/behind` = 0). `submodules` from `git submodule status`;
  each submodule's `state` is derived with NO extra git calls by combining that flag with the root
  `git status` paths already collected: `drift` (`+` = checked-out commit ≠ recorded gitlink),
  `uninit` (`-`), `conflict` (`U`), else `dirty` if the submodule path appears in the root
  working-tree changes (uncommitted/untracked content), else `clean`. `dirty` = `state !== "clean"`.
- `handoffs`: best-effort glob of `Anti/999_AI_Communication/_Inbox/*.md` excluding `*TEMPLATE*`,
  `_Index`, `CLAUDE`, `_Master`. Empty array if the dir is absent.

---

## 4. `POST /api/action` (WORKER 1 implements in `server/actions.js`)

Request body JSON: `{ "type": "<string>", "arg": "<optional string>" }`. Response: `{ "ok": bool, ... }`.

ENABLED actions:
- `type:"git.fetch"` → `git -C ROOT fetch --all` → `{ ok, output }`.
- `type:"open"`, `arg:"<ROOT-relative path>"` → resolve, **reject if it escapes ROOT**, then open in OS → `{ ok }`.
- `type:"refresh"` → `{ ok:true }` (no-op; client just re-fetches state).

GATED actions (return a marker, do nothing — still SAFE MODE):
- `type` in `save`,`pull` → `{ ok:false, gated:true, message:"requires full-autonomous mode" }`.

Unknown `type` → `{ ok:false, error:"unknown action: <type>" }`.

> Agent spawn is NOT an `/api/action` type — it has its own `POST /api/spawn` endpoint (§5). The cockpit only reads the harness logs; it never writes to them.

---

## 5. Server endpoints (WORKER 1 implements in `server/index.js`)

Zero-dep `http` server bound to `HOST:PORT`. Routes:
- `GET /` → serve `web/index.html`.
- `GET /<static>` → serve any file under `web/` (content-type by extension; reject path traversal); 404 if absent.
- `GET /api/state` → JSON snapshot from `state.js`. On error: 500 `{ error }`.
- `POST /api/action` → parse JSON body, dispatch to `actions.js`, return JSON (§4).
- `POST /api/spawn` → `orchestrator.spawnAgent({ prompt })`: launch a read-only-restricted `claude` child (`server/orchestrator.js`) as the main Hames agent, return the job descriptor. An `agent` field in the body is ignored; every job's `agent` and `label` are `"Hames"`.
- `GET /api/jobs` → `{ jobs: orchestrator.getJobs() }`.
- `GET /api/jobs/:id` → the job, or 404 `{ error:"job not found" }`.
- `POST /api/jobs/:id/stop` → `{ ok: orchestrator.stopJob(id) }`.
- Other methods → 405. On start, print: `Hames Cockpit → http://127.0.0.1:<port>  (root: <ROOT>)`.

---

## 6. Frontend (WORKER 2 implements in `cockpit/web/`)

Aesthetic: **ShipOS submarine command-center**. Dark, dense, professional, monospace numerics.
- Palette: bg `#0a0e17`, panels `#0d1524`/`#111a2e`, hairline borders `#1e293b`,
  text `#cbd5e1` / muted `#64748b`, accents cyan `#22d3ee` + teal/green `#34d399`,
  warn amber `#f59e0b`, alert red `#ef4444`. Numbers in `ui-monospace, "SF Mono", Menlo`.
- Layout: **top KPI bar** (chips from `kpis`) + **left nav** (sections) + **center main**
  + **right rail "Live Operations"** feed (always visible, from `sessionFeed`).
- Left-nav sections (switch center view): `Overview`, `Workspaces`, `Skills`, `Harness`, `Git`.
  - Overview: KPI summary + hero cards (Harness Health gauge, Activity chart, Tool Mix) + a **Git Sync** card — a per-module table (root row with ahead/behind/dirty, then one row per submodule showing its precise `state` badge — DRIFT/DIRTY/UNINIT/CONFLICT/CLEAN — + branch, flagged first), a risk summary of the `Git` tab (sourced from `git`); links to the `Git` section for the full working tree + submodule SHAs.
  - Workspaces: table/cards — name, path, actions, lastActivity, exists state.
  - Skills: list, name + description.
  - Harness: PASS/BLOCKED/BYPASS bars from `kpis.harness` + `auditFeed` list (color by result).
  - Git: branch, ahead/behind, dirty files, submodule table.
  - Right rail: `sessionFeed` styled like ShipOS agent activity (tool chip, workspace tag, file path, ts).
- Top-right controls: **LIVE toggle** (on = poll `GET /api/state` every 5s), manual **Refresh**, live clock.
- Action buttons (call `POST /api/action`): "git fetch" + per-workspace/file "open".
  Render only the still-gated buttons (`save`/`pull`) **disabled** with a small `gated` tag. Agent `spawn` + job control use `/api/spawn` and `/api/jobs` (§5).
- Virtual office (`web/office.html`): the main "Hames" avatar first, then one avatar per entry in
  `subagents` (name seed and caption = `description`; one color for main, one for subagents). A
  running subagent lights the `dot run` indicator; the main avatar lights when any subagent is running.
  The left roster lists the same members. Empty states: `claudeSubagents.exists:false` → "Claude Code
  기록을 찾지 못함"; `exists:true` with no entries → "최근 서브 호출 없음". The page notes that only
  Claude Code subagent calls from sessions started at the Hames root are shown (Codex excluded).
  KPI card: "최근 서브 호출 수" = `kpis.recentSubagentCalls`.
- Empty states: if `workspaceCount==0` (fresh public install) show a friendly "no workspaces yet" panel,
  never crash. Same for empty feeds.
- Single `fetch('/api/state')`; preserve scroll on re-render. Escape every file-sourced string.

---

## 7. Done signals
- WORKER 1: after building, run `node cockpit/server/index.js` in the background, then
  `curl -s http://127.0.0.1:8765/api/state | python3 -m json.tool | head -40`, paste that RAW output,
  stop the server, and print `[W1 DONE]`.
- WORKER 2: after building, print the file list and `[W2 DONE]`. (Orchestrator runs the live integration test.)
