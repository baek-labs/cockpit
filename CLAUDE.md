# Hames Cockpit

## Directory Map / Important Paths

```
Cockpit/
├─ server/        zero-dependency Node backend
│  ├─ config.js     runtime discovery of root + state-file paths (hardcodes nothing)
│  ├─ state.js      readers → one /api/state snapshot
│  ├─ actions.js      mechanical ops (fetch/open/refresh) + gated save/pull stubs
│  ├─ orchestrator.js spawns + tracks read-only-restricted `claude` child jobs
│  ├─ doctor.js       focused installation diagnostics exposed through /api/doctor
│  └─ index.js        http server: static + /api/state + /api/action + /api/spawn + /api/jobs
├─ web/           vanilla HTML/CSS/JS frontend (ShipOS aesthetic), polls /api/state
├─ CONTRACT.md    the build contract — the JSON seam between server and web
└─ CLAUDE.md      this file
```

The `/api/state` JSON shape in `CONTRACT.md` §3 is the contract between backend and frontend.
Change it in both places or not at all.

## Folder Purpose

The cockpit visualizes and (incrementally) operates a HamesSystem install:

- **Reads** the live state Hames already produces — session activity, harness audit results
  (from the hook log folder: `HAMES_LOG_DIR`, else macOS `~/Library/Logs/Hames/`), the workspace
  registry, recent Claude Code subagent calls, skills, git/submodule status, handoffs.
- **Operates** the system through a backend that runs safe mechanical commands directly and
  routes intelligent work to Claude so the Hames hooks still fire.

It is **not** a reimplementation of Hames. The "brain" (the main agent and the general-purpose
subagents it calls) stays in the model. Role agents were removed 2026-11-16; every cockpit job runs
as the main Hames agent. The cockpit is a viewer + control panel that wraps it.

Ships as a **standalone repository**, included in a Hames install as a git submodule at `Cockpit/`.
The same code runs on a personal Hames install and on the public `baek-labs/hames` template.

## Run And Verify

```bash
node server/index.js          # → http://127.0.0.1:8765
# optional overrides:
HAMES_ROOT=/path/to/hames HAMES_COCKPIT_PORT=8765 node server/index.js
```

No build step. No `npm install`. Node.js 18+ only.

## Outputs And State

- The virtual office (`web/office.html`) shows the main Hames plus recent subagent calls read from
  `~/.claude/projects/<project>/<session>/subagents/agent-*.meta.json` (meta fields and file times
  only, never transcript contents). Only Claude Code sessions started at the Hames root are shown;
  Codex is excluded. Tested on macOS only; Windows and Linux behavior is untested.
- `/api/state` is the frontend/backend state contract defined in `CONTRACT.md`.
- `/api/jobs` tracks read-only-restricted `claude` child jobs spawned by `server/orchestrator.js`.
- Runtime paths are discovered by `server/config.js`; do not hardcode a personal Hames path.

## Portability — why nothing is hardcoded

A personal install and the public template differ:

| | personal | public `baek-labs/hames` |
|---|---|---|
| arsenal dir | `Anti/.Arsenal/` | `arsenal/` |
| workspaces | many real ones | none (scaffold only) |
| `workspace_paths.json` | present | generated per machine |
| OS | macOS | Win / mac / Linux |

So `config.js` **discovers** the root and every state-file path at runtime (first-existing
candidate), reads the workspace registry instead of assuming names, and the UI shows graceful
"no data yet" states on a fresh install. One codebase, both deployments.

## Safety rules (do not break)

- Bind **`127.0.0.1` only**. Never expose on `0.0.0.0`.
- **Zero npm dependencies** in the current runtime (Node built-ins only). Adding a dependency requires an explicit architecture decision.
- **Escape every file-sourced string** before putting it in HTML (paths/logs contain `<>&"`).
- Direct mechanical actions must **respect the Hames harness** and confirm irreversible actions.
  The workspace lock was removed 2026-11-11; the cockpit only reads the harness logs and never
  writes to them. Hooks do not fire for the cockpit's own
  child processes, so the cockpit enforces these itself.
- Cross-platform: pick the OS opener (`open` / `start` / `xdg-open`) via `process.platform`.
