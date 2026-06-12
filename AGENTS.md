# Hames Cockpit — Codex entry point (redirect)

> The operating guide for this repo is **`CLAUDE.md` in this same folder** (the build seam is `CONTRACT.md`). Every model — Codex, Gemini, Claude — reads those and follows them. This file (AGENTS.md) is a Codex-facing **redirect**; it keeps no second copy, to prevent dual-copy drift.

## Read first (in order)

1. **`CLAUDE.md`** — what it is, run command, architecture, phases, safety rules. Follow it over this file when they differ.
2. **`CONTRACT.md`** — the JSON seam between server and web; change it in both server and web, or not at all.

## Invariants

- Surgical edits; do not fabricate facts not in the code.
- Bind **`127.0.0.1` only**; never expose on `0.0.0.0`. Respect the Hames harness (honor `.workspace_lock`, append to the audit trail, confirm irreversible actions).
- This repo ships standalone and is included as a git submodule of a Hames install (remote `cockpit.git`) — version it independently. Verify the repo root before commit/push; don't confuse the parent Hames gitlink state with this repo's state. Preserve unrelated local changes — no reset/checkout/revert without explicit user request.

> Change guidance in one place only — `CLAUDE.md` / `CONTRACT.md`. This redirect needs no update.
