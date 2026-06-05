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
| sessionLog | `<arsenalDir>/.session_log.jsonl`, `.session_log.jsonl`, `.claude/.session_log.jsonl` | first candidate (for display) |
| auditLog | `.claude/workspace_audit.log` | that path |
| lockFile | `.claude/.workspace_lock` | that path |
| registry | `.claude/workspace_paths.json` | `null` (empty registry) |
| agentsDir | `.claude/agents` | `null` |
| commandsDir | `.claude/commands` | `null` |

Platform opener: `darwin`→`open`, `win32`→`cmd /c start ""`, else `xdg-open`.
`PORT` = `process.env.HAMES_COCKPIT_PORT` or `8765`. `HOST` = `127.0.0.1`.

Export a single `loadConfig()` returning an object with all resolved absolute paths + `platform`, `port`, `host`, `root`, plus an `opener` helper.

---

## 2. Real data formats (ground truth — verified on this machine)

- **session log** (`.session_log.jsonl`), one JSON per line:
  `{"ts":"2026-06-04 14:23:17","tool":"Edit","workspace":"ROOT","file":"Sales/AI_Business/..."}`
  (note: `ts` is space-separated local time, NOT ISO.)
- **audit log** (`workspace_audit.log`), one JSON per line:
  `{"ts":"2026-06-05T11:35:31.595Z","hook":"context_verifier","result":"PASS","tool":"Bash"}`
  Known `result` values: `PASS`, `BLOCKED`, `BYPASS`, `ALLOWED`, `ALLOWED_SYSADMIN`,
  `SKIPPED_SUBAGENT`, `SKIPPED_NO_TRANSCRIPT`, `SKIPPED_DISABLED`, `GRACE_FIRSTCALL`, `DEBUG_CV`.
- **lock file** (`.workspace_lock`) — TWO possible shapes, support both:
  - v2: `{"version":2,"sessions":{"<id>":{"workspace":"BUSINESS"|null,"locked":bool,"updated_at":ISO}}}`
  - v1: `{"workspace":"Youtube"|null,"locked":bool}`
  For v2, `current` = the session entry with the latest `updated_at`.
- **registry** (`workspace_paths.json`): `{"INVEST":"Anti/00_Investment", ...}` (name → ROOT-relative path).
- **agent file** (`.claude/agents/*.md`) frontmatter: `--- \n name: CTO \n description: ... \n ---`
  (`name` may be absent → derive from filename without `.md`.)
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
    "lock":       { "path": "<abspath>", "exists": true },
    "registry":   { "path": "<abspath>", "exists": true }
  },
  "kpis": {
    "activeWorkspace": { "name": "BUSINESS", "locked": true },
    "workspaceCount": 16,
    "lockedSessions": 12,
    "actionsToday": 7,
    "harness": { "PASS": 480, "BLOCKED": 12, "BYPASS": 1, "window": 500 },
    "submodules": { "total": 9, "dirty": 0 },
    "gitDirty": 1
  },
  "workspaces": [
    { "name": "BUSINESS", "path": "Anti/01_Business", "exists": true,
      "actions": 134, "lastActivity": "2026-06-05 11:31:56", "locked": true }
  ],
  "agents": {
    "level1": [ { "name": "CTO", "file": "cto.md", "description": "..." } ],
    "level2": [ { "name": "cto_coder", "file": "cto_coder.md", "description": "..." } ]
  },
  "skills": [ { "name": "save", "description": "..." } ],
  "git": {
    "branch": "main", "ahead": 0, "behind": 0,
    "dirty": [ { "status": "??", "file": "..." } ],
    "submodules": [ { "path": "Sales/AI_Business", "sha": "e32e30c", "branch": "main", "dirty": false } ]
  },
  "sessionFeed": [ { "ts": "2026-06-05 11:31:56", "tool": "Write", "workspace": "BUSINESS", "file": "..." } ],
  "auditFeed":   [ { "ts": "2026-06-05T11:35:31.595Z", "hook": "context_verifier", "result": "PASS", "tool": "Bash" } ],
  "handoffs": [ { "name": "...", "path": "...", "mtime": "<ISO>" } ]
}
```

Rules for the data:
- `sessionFeed` / `auditFeed`: newest-first, last ~40 entries.
- `harness`: aggregate `result` counts over the last `window` (=500) audit entries.
- `kpis.actionsToday`: session-log entries whose `ts` date == today (local).
- `workspaces`: built from registry; per workspace derive `actions` (count in session log where
  `workspace` matches the NAME) and `lastActivity` (latest such `ts`); `locked` from lock file.
  If registry is `null`, fall back to scanning `workspaces/*` subdirs that contain `CLAUDE.md`.
- agent level: filename without `_` (e.g. `cto.md`) → level1; with `_` (e.g. `cto_coder.md`) → level2.
- `git`: shell out via `git -C <ROOT> ...` with `execFileSync`, short timeout, catch all errors
  (a fresh clone may have no upstream → `ahead/behind` = 0). `submodules` from `git submodule status`.
- `handoffs`: best-effort glob of `Anti/999_AI_Communication/_Inbox/*.md` excluding `*TEMPLATE*`,
  `_Index`, `CLAUDE`, `_Master`. Empty array if the dir is absent.

---

## 4. `POST /api/action` (WORKER 1 implements in `server/actions.js`)

Request body JSON: `{ "type": "<string>", "arg": "<optional string>" }`. Response: `{ "ok": bool, ... }`.

Phase-1 ENABLED actions (genuinely safe — no working-tree mutation):
- `type:"git.fetch"` → `git -C ROOT fetch --all` → `{ ok, output }`.
- `type:"open"`, `arg:"<ROOT-relative path>"` → resolve, **reject if it escapes ROOT**, then open in OS → `{ ok }`.
- `type:"refresh"` → `{ ok:true }` (no-op; client just re-fetches state).

Phase-2 GATED actions (return without doing anything):
- `type` in `lock`,`unlock`,`save`,`pull`,`spawn` → `{ ok:false, gated:true, phase:2,
  message:"Phase 2 — routed through Claude/Agent SDK so harness hooks fire." }`.

---

## 5. Server endpoints (WORKER 1 implements in `server/index.js`)

Zero-dep `http` server bound to `HOST:PORT`. Routes:
- `GET /` → serve `web/index.html`.
- `GET /style.css`, `GET /app.js` → serve from `web/` (content-type set; reject path traversal).
- `GET /api/state` → JSON snapshot from `state.js`. On error: 500 `{ error }`.
- `POST /api/action` → parse JSON body, dispatch to `actions.js`, return JSON.
- On start, print: `Hames Cockpit → http://127.0.0.1:<port>  (root: <ROOT>)`.

---

## 6. Frontend (WORKER 2 implements in `cockpit/web/`)

Aesthetic: **ShipOS submarine command-center**. Dark, dense, professional, monospace numerics.
- Palette: bg `#0a0e17`, panels `#0d1524`/`#111a2e`, hairline borders `#1e293b`,
  text `#cbd5e1` / muted `#64748b`, accents cyan `#22d3ee` + teal/green `#34d399`,
  warn amber `#f59e0b`, alert red `#ef4444`. Numbers in `ui-monospace, "SF Mono", Menlo`.
- Layout: **top KPI bar** (chips from `kpis`) + **left nav** (sections) + **center main**
  + **right rail "Live Operations"** feed (always visible, from `sessionFeed`).
- Left-nav sections (switch center view): `Overview`, `Workspaces`, `Agents`, `Skills`, `Harness`, `Git`.
  - Overview: KPI summary + workspaces-as-"programs" cards (activity bar from `actions`, lock badge) + recent activity.
  - Workspaces: table/cards — name, path, actions, lastActivity, lock badge, exists state.
  - Agents: Level-1 and Level-2 grouped grid, each card name + description.
  - Skills: list, name + description.
  - Harness: PASS/BLOCKED/BYPASS bars from `kpis.harness` + `auditFeed` list (color by result).
  - Git: branch, ahead/behind, dirty files, submodule table.
  - Right rail: `sessionFeed` styled like ShipOS agent activity (tool chip, workspace tag, file path, ts).
- Top-right controls: **LIVE toggle** (on = poll `GET /api/state` every 5s), manual **Refresh**, live clock.
- Action buttons (call `POST /api/action`): "git fetch" + per-workspace/file "open".
  Render gated Phase-2 buttons (lock/save/pull/spawn) **disabled** with a small `Phase 2` tag.
- Empty states: if `workspaceCount==0` (fresh public install) show a friendly "no workspaces yet" panel,
  never crash. Same for empty feeds.
- Single `fetch('/api/state')`; preserve scroll on re-render. Escape every file-sourced string.

---

## 7. Done signals
- WORKER 1: after building, run `node cockpit/server/index.js` in the background, then
  `curl -s http://127.0.0.1:8765/api/state | python3 -m json.tool | head -40`, paste that RAW output,
  stop the server, and print `[W1 DONE]`.
- WORKER 2: after building, print the file list and `[W2 DONE]`. (Orchestrator runs the live integration test.)
