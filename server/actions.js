'use strict';

// Hames Cockpit — POST /api/action dispatch (CONTRACT section 4).
// Phase 1 enables only genuinely safe actions (no working-tree mutation).
// Phase 2 actions are gated: they return a marker and do nothing.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const GATED = new Set(['lock', 'unlock', 'save', 'pull', 'spawn']);
const GATED_MESSAGE =
  'Phase 2 — routed through Claude/Agent SDK so harness hooks fire.';

function withinRoot(root, abs) {
  return abs === root || abs.startsWith(root + path.sep);
}

function handleAction(cfg, body) {
  const type = body && typeof body.type === 'string' ? body.type : '';
  const arg = body && typeof body.arg === 'string' ? body.arg : '';

  if (!type) return { ok: false, error: 'missing action type' };

  switch (type) {
    case 'refresh':
      return { ok: true };

    case 'git.fetch': {
      try {
        const output = execFileSync('git', ['-C', cfg.root, 'fetch', '--all'], {
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: true, output: (output || '').trim() };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }

    case 'open': {
      if (!arg) return { ok: false, error: 'missing path arg' };
      const abs = path.resolve(cfg.root, arg);
      if (!withinRoot(cfg.root, abs)) {
        return { ok: false, error: 'path escapes ROOT' };
      }
      if (!fs.existsSync(abs)) {
        return { ok: false, error: 'path not found' };
      }
      const opened = cfg.opener(abs);
      return opened ? { ok: true } : { ok: false, error: 'opener failed' };
    }

    default:
      if (GATED.has(type)) {
        return { ok: false, gated: true, phase: 2, message: GATED_MESSAGE };
      }
      return { ok: false, error: `unknown action: ${type}` };
  }
}

module.exports = { handleAction };
