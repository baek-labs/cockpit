# Cockpit — Codex Lite Entry

This file is the lightweight Codex entry for Hames Cockpit.

`AGENTS.md` is the Codex default contract. `CLAUDE.md` is the Claude / Full Hames source of truth and is not loaded automatically.

## Default Mode

* Work on the current task.
* Read only files directly relevant to the requested change.
* Prefer minimal diffs.
* Do not automatically load local `CLAUDE.md`, `CONTRACT.md`, or full project architecture.

## When to Read `CLAUDE.md`

Read `CLAUDE.md` only when the task involves:

* Cockpit architecture or phase rules
* server/web contract behavior
* binding, safety, or deployment behavior
* repository-wide refactoring
* explicit Full Hames Mode

Read `CONTRACT.md` only when the task changes the server/web JSON seam.

## Safety

* Ask before destructive operations.
* Preserve unrelated local changes.
* Do not expose local services beyond approved bindings.
* Verify the repository root before commit or push; do not confuse this repo with the parent Hames gitlink.
