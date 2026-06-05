'use strict';

// Hames Cockpit — POST /api/action dispatch (CONTRACT section 4).
// Phase 1 enables only genuinely safe actions (no working-tree mutation).
// Phase 2 actions are gated: they return a marker and do nothing.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// SAFE MODE: save/pull are not executed in this pass — they stay gated.
const FULL_AUTO_MESSAGE = 'requires full-autonomous mode';

function withinRoot(root, abs) {
  return abs === root || abs.startsWith(root + path.sep);
}

function readLockData(lockPath) {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (data && typeof data === 'object' && data.version === 2 && data.sessions) {
      return data;
    }
  } catch (_) { /* missing / v1 / malformed → start a fresh v2 below */ }
  return { version: 2, sessions: {} };
}

function appendAudit(cfg, entry) {
  try {
    fs.appendFileSync(cfg.auditLog, JSON.stringify(entry) + '\n');
  } catch (_) { /* audit is best-effort; never fail the action on it */ }
}

// setLock/clearLock manage the cockpit's OWN lock entry (keyed 'cockpit').
// This sets the cockpit-declared lock; it does NOT force-lock other already-
// running Claude sessions (each session owns its own entry).
function setLock(cfg, workspace) {
  if (!workspace) return { ok: false, error: 'missing workspace' };
  const iso = new Date().toISOString();
  const data = readLockData(cfg.lockFile);
  data.sessions.cockpit = { workspace, locked: true, updated_at: iso };
  try {
    fs.writeFileSync(cfg.lockFile, JSON.stringify(data, null, 2));
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  appendAudit(cfg, { ts: iso, hook: 'cockpit', result: 'LOCK_SET', tool: 'cockpit', workspace });
  return { ok: true, lock: { workspace, locked: true } };
}

function clearLock(cfg) {
  const iso = new Date().toISOString();
  const data = readLockData(cfg.lockFile);
  data.sessions.cockpit = { workspace: null, locked: false, updated_at: iso };
  try {
    fs.writeFileSync(cfg.lockFile, JSON.stringify(data, null, 2));
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  appendAudit(cfg, { ts: iso, hook: 'cockpit', result: 'LOCK_CLEAR', tool: 'cockpit', workspace: null });
  return { ok: true, lock: { workspace: null, locked: false } };
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

    case 'lock':
      return setLock(cfg, arg);

    case 'unlock':
      return clearLock(cfg);

    // SAFE MODE: save/pull are not executed in this pass (no runSlash).
    case 'save':
    case 'pull':
      return { ok: false, gated: true, message: FULL_AUTO_MESSAGE };

    default:
      return { ok: false, error: `unknown action: ${type}` };
  }
}

module.exports = { handleAction, setLock, clearLock };
