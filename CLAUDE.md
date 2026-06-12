# Hames Cockpit

> A GUI control surface for **HamesSystem** — a live operational dashboard that reads system
> state now, and (Phase 2) drives the same Claude Code / Agent SDK runtime that *is* Hames.
>
> Ships as a **standalone repository**, included in a Hames install as a git submodule at `cockpit/`.
> The same code runs on a personal Hames install and on the public `baek-labs/hames` template.

---

## Run

```bash
node server/index.js          # → http://127.0.0.1:8765
# optional overrides:
HAMES_ROOT=/path/to/hames HAMES_COCKPIT_PORT=8765 node server/index.js
```

No build step. No `npm install`. Node.js 18+ only.

---

## What it is

The cockpit visualizes and (incrementally) operates a HamesSystem install:

- **Reads** the live state Hames already produces — session activity, harness audit results,
  workspace locks, the workspace registry, agents, skills, git/submodule status, handoffs.
- **Operates** the system through a backend that runs safe mechanical commands directly and
  (Phase 2) routes intelligent work to Claude so the Hames hooks still fire.

It is **not** a reimplementation of Hames. The "brain" (COO routing, agent teams) stays in the
model. The cockpit is a viewer + control panel that wraps it.

---

## Architecture

```
cockpit/
├─ server/        zero-dependency Node backend
│  ├─ config.js     runtime discovery of root + state-file paths (hardcodes nothing)
│  ├─ state.js      readers → one /api/state snapshot
│  ├─ actions.js      mechanical ops (fetch/open/refresh/lock/unlock) + gated save/pull stubs
│  ├─ orchestrator.js spawns + tracks read-only-restricted `claude` child jobs
│  └─ index.js        http server: static + /api/state + /api/action + /api/spawn + /api/jobs
├─ web/           vanilla HTML/CSS/JS frontend (ShipOS aesthetic), polls /api/state
├─ CONTRACT.md    the build contract — the JSON seam between server and web
└─ CLAUDE.md      this file
```

The `/api/state` JSON shape in `CONTRACT.md` §3 is the contract between backend and frontend.
Change it in both places or not at all.

---

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

---

## Phases

- **Phase 1 (current):** reads everything + runs safe mechanical actions directly — `git fetch`,
  open a path, refresh — **plus workspace `lock`/`unlock` and agent `spawn`** (spawn launches a
  read-only-restricted `claude` child via `server/orchestrator.js`, tracked through `/api/jobs`).
  `save`/`pull` remain gated.
- **Phase 2:** route the remaining gated actions (`save`/`pull`) and richer agent work through
  `claude -p` / the Claude Agent SDK so the Hames defense-line + workspace-guard hooks execute.
  The cockpit never bypasses the harness.

---

## Safety rules (do not break)

- Bind **`127.0.0.1` only**. Never expose on `0.0.0.0`.
- **Zero npm dependencies** in Phase 1 (Node built-ins only). Phase 2 may add the Agent SDK.
- **Escape every file-sourced string** before putting it in HTML (paths/logs contain `<>&"`).
- Direct mechanical actions must **respect the Hames harness**: honor `.workspace_lock`, append
  to the audit trail, and confirm irreversible actions. Hooks do not fire for the cockpit's own
  child processes, so the cockpit enforces these itself.
- Cross-platform: pick the OS opener (`open` / `start` / `xdg-open`) via `process.platform`.

---

## Status

Phase 1 build. Backend (`server/`) and frontend (`web/`) are built against `CONTRACT.md`.
This repo is a git submodule of a Hames install; version it independently.
