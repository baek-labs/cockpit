'use strict';
// Hames Cockpit — /doctor reader. Shells out to hames_doctor.py, parses the
// JSON report (after a header line), caches successes ~30s. Never throws.

const path = require('path');
const { execFileSync } = require('child_process');

const TTL_MS = 30000;
const EXEC_TIMEOUT = 15000;
const MAX_BUFFER = 4 * 1024 * 1024;   // 4MB headroom vs default 1MB; bounds runaway stdout.

let _cache = { data: null, ts: 0 };   // module-level; only SUCCESS is cached.

// cfg.arsenalDir is already the resolved first-existing arsenal dir or null.
function resolveScript(cfg) {
  if (cfg && cfg.arsenalDir) return path.join(cfg.arsenalDir, 'hames_doctor.py');
  return path.join(cfg.root, 'Anti', '.Arsenal', 'hames_doctor.py');
}

// Robust: locate first '{' and JSON.parse from there (tolerates the header
// line OR any preamble/blank lines/BOM). Throws on parse failure.
function parseReport(stdout) {
  const i = stdout.indexOf('{');
  if (i === -1) throw new Error('no json object in doctor output');
  return JSON.parse(stdout.slice(i));
}

function runDoctor(cfg, opts) {
  const refresh = !!(opts && opts.refresh);
  if (!refresh && _cache.data && (Date.now() - _cache.ts) < TTL_MS) {
    return _cache.data;
  }
  const scriptPath = resolveScript(cfg);
  let stdout;
  try {
    stdout = execFileSync('python3', [scriptPath], {
      cwd: cfg.root,
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    });
  } catch (err) {
    return execError(err);
  }
  let report;
  try {
    report = parseReport(stdout);
  } catch (_) {
    return { ok: false, error: 'failed to parse doctor output' };
  }
  _cache = { data: report, ts: Date.now() };
  return report;
}

function execError(err) {
  if (err && err.code === 'ENOENT') return { ok: false, error: 'python3 not found' };
  if (err && (err.killed || err.signal === 'SIGTERM')) {
    return { ok: false, error: 'doctor timed out' };
  }
  const stderr = err && err.stderr ? String(err.stderr).trim() : '';
  if (stderr) return { ok: false, error: stderr.slice(0, 500) };
  return { ok: false, error: String((err && err.message) || err) };
}

module.exports = { runDoctor };
