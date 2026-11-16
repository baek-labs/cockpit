'use strict';

// Hames Cockpit — runtime discovery (CONTRACT section 1).
// Hardcode nothing: detect every data source by first-existing candidate so the
// same server runs on a full install AND a fresh public clone.

const fs = require('fs');
const os = require('os');
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

// Mirrors getHamesLogDir() in Anti/.Arsenal/log_rotation.js.
function hamesLogDir(platform) {
  const env = process.env.HAMES_LOG_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  if (platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Hames', 'Logs');
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Logs', 'Hames');
  return path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
    'hames',
    'logs'
  );
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

  // Hook logs live outside the repository (see Anti/.Arsenal/log_rotation.js):
  // HAMES_LOG_DIR if set, else the per-OS log folder.
  const logDir = hamesLogDir(platform);
  const sessionLog = path.join(logDir, 'session_log.jsonl');
  const auditLog = path.join(logDir, 'workspace_audit.log');

  // Claude Code keeps per-project transcripts under ~/.claude/projects/<key>,
  // where <key> is the absolute root path with every non-alphanumeric char
  // replaced by '-'. Subagent records sit in <session>/subagents/.
  const claudeProjectDir = path.join(
    os.homedir(), '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-')
  );

  const registryPath = path.join(root, '.claude', 'workspace_paths.json');
  const registry = fs.existsSync(registryPath) ? registryPath : null;

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
    logDir,
    claudeProjectDir,
    registry,         // null when absent (=> empty registry, scan fallback)
    registryPath,     // canonical path for display even when absent
    commandsDir,
    handoffsDir,
    webDir,
    opener: makeOpener(platform),
  };
}

module.exports = { loadConfig, firstExisting };
