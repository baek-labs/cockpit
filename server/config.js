'use strict';

// Hames Cockpit — runtime discovery (CONTRACT section 1).
// Hardcode nothing: detect every data source by first-existing candidate so the
// same server runs on this 16-workspace install AND a fresh public clone.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function makeOpener(platform) {
  // Returns a best-effort OS opener. Never throws to the caller; failures are swallowed.
  return function open(absPath) {
    try {
      let cmd, args;
      if (platform === 'darwin') {
        cmd = 'open'; args = [absPath];
      } else if (platform === 'win32') {
        // `start` is a cmd builtin; first quoted arg is the window title.
        cmd = 'cmd'; args = ['/c', 'start', '', absPath];
      } else {
        cmd = 'xdg-open'; args = [absPath];
      }
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch (_) {
      return false;
    }
  };
}

function loadConfig() {
  const platform = process.platform;

  const root = process.env.HAMES_ROOT
    ? path.resolve(process.env.HAMES_ROOT)
    : path.resolve(__dirname, '..', '..');

  const arsenalDir = firstExisting([
    path.join(root, 'Anti', '.Arsenal'),
    path.join(root, 'arsenal'),
    path.join(root, '.Arsenal'),
  ]); // null if none

  const sessionCandidates = [
    arsenalDir ? path.join(arsenalDir, '.session_log.jsonl') : null,
    path.join(root, '.session_log.jsonl'),
    path.join(root, '.claude', '.session_log.jsonl'),
  ].filter(Boolean);
  const sessionLog = firstExisting(sessionCandidates) || sessionCandidates[0];

  const auditLog = path.join(root, '.claude', 'workspace_audit.log');
  const lockFile = path.join(root, '.claude', '.workspace_lock');

  const registryPath = path.join(root, '.claude', 'workspace_paths.json');
  const registry = fs.existsSync(registryPath) ? registryPath : null;

  const agentsDir = firstExisting([path.join(root, '.claude', 'agents')]);
  const commandsDir = firstExisting([path.join(root, '.claude', 'commands')]);

  const handoffsDir = path.join(root, 'Anti', '999_AI_Communication', '_Inbox');
  const webDir = path.resolve(__dirname, '..', 'web');

  const port = Number(process.env.HAMES_COCKPIT_PORT) || 8765;
  const host = '127.0.0.1';

  return {
    root,
    platform,
    port,
    host,
    arsenalDir,
    sessionLog,
    auditLog,
    lockFile,
    registry,         // null when absent (=> empty registry, scan fallback)
    registryPath,     // canonical path for display even when absent
    agentsDir,
    commandsDir,
    handoffsDir,
    webDir,
    opener: makeOpener(platform),
  };
}

module.exports = { loadConfig, firstExisting };
