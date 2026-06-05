'use strict';

// Hames Cockpit — state snapshot (CONTRACT sections 2 & 3).
// Every reader degrades gracefully: on any read/parse error return a safe empty
// default, never throw to the caller. Big files are read whole then sliced.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FEED_LIMIT = 40;
const HARNESS_WINDOW = 500;
const GIT_TIMEOUT = 4000;

// ---------- low-level safe readers ----------

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// Parse a .jsonl file into an array of objects (chronological order), skipping
// blank / malformed lines.
function readJSONL(p) {
  const raw = readText(p);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch (_) {
      /* skip malformed line */
    }
  }
  return out;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

// Minimal YAML frontmatter reader for `--- ... ---` blocks. Returns flat
// key->value map (top-level scalar fields only — all we need here).
function readFrontmatter(p) {
  const raw = readText(p);
  if (!raw) return {};
  const m = raw.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[kv[1]] = val;
  }
  return out;
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- lock file (v1 / v2) ----------

function readLock(lockPath) {
  const empty = { current: { name: null, locked: false }, lockedSessions: 0, lockedWorkspaces: new Set() };
  const data = readJSON(lockPath, null);
  if (!data || typeof data !== 'object') return empty;

  const lockedWorkspaces = new Set();
  let lockedSessions = 0;

  if (data.version === 2 && data.sessions && typeof data.sessions === 'object') {
    let current = { name: null, locked: false };
    let latest = -Infinity;
    for (const entry of Object.values(data.sessions)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.locked) {
        lockedSessions += 1;
        if (entry.workspace) lockedWorkspaces.add(entry.workspace);
      }
      const t = Date.parse(entry.updated_at || '');
      if (!Number.isNaN(t) && t >= latest) {
        latest = t;
        current = { name: entry.workspace || null, locked: !!entry.locked };
      }
    }
    return { current, lockedSessions, lockedWorkspaces };
  }

  // v1 shape
  const locked = !!data.locked;
  if (locked) {
    lockedSessions = 1;
    if (data.workspace) lockedWorkspaces.add(data.workspace);
  }
  return {
    current: { name: data.workspace || null, locked },
    lockedSessions,
    lockedWorkspaces,
  };
}

// ---------- workspaces ----------

function buildWorkspaces(cfg, sessionEntries, lock) {
  // index session activity by workspace name
  const counts = new Map();
  const last = new Map();
  for (const e of sessionEntries) {
    const ws = e && e.workspace;
    if (!ws) continue;
    counts.set(ws, (counts.get(ws) || 0) + 1);
    const ts = e.ts || '';
    if (!last.has(ws) || ts > last.get(ws)) last.set(ws, ts);
  }

  const make = (name, rel) => ({
    name,
    path: rel,
    exists: exists(path.join(cfg.root, rel)),
    actions: counts.get(name) || 0,
    lastActivity: last.get(name) || null,
    locked: lock.lockedWorkspaces.has(name),
  });

  const registry = cfg.registry ? readJSON(cfg.registry, null) : null;
  if (registry && typeof registry === 'object') {
    return Object.keys(registry).map((name) => make(name, registry[name]));
  }

  // Fallback: scan workspaces/* subdirs containing CLAUDE.md
  const out = [];
  const wsRoot = path.join(cfg.root, 'workspaces');
  if (exists(wsRoot)) {
    let subs = [];
    try {
      subs = fs.readdirSync(wsRoot, { withFileTypes: true });
    } catch (_) {
      subs = [];
    }
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      if (exists(path.join(wsRoot, d.name, 'CLAUDE.md'))) {
        out.push(make(d.name, path.join('workspaces', d.name)));
      }
    }
  }
  return out;
}

// ---------- agents / skills ----------

function listMd(dir) {
  if (!dir || !exists(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (_) {
    return [];
  }
}

function buildAgents(cfg) {
  const level1 = [];
  const level2 = [];
  for (const file of listMd(cfg.agentsDir)) {
    const base = file.replace(/\.md$/i, '');
    const fm = readFrontmatter(path.join(cfg.agentsDir, file));
    const entry = { name: fm.name || base, file, description: fm.description || '' };
    if (base.includes('_')) level2.push(entry);
    else level1.push(entry);
  }
  return { level1, level2 };
}

function buildSkills(cfg) {
  const out = [];
  for (const file of listMd(cfg.commandsDir)) {
    const fm = readFrontmatter(path.join(cfg.commandsDir, file));
    out.push({ name: file.replace(/\.md$/i, ''), description: fm.description || '' });
  }
  return out;
}

// ---------- handoffs ----------

function buildHandoffs(cfg) {
  const dir = cfg.handoffsDir;
  if (!exists(dir)) return [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (/TEMPLATE/i.test(f)) continue;
    if (/^_Index/i.test(f) || /^CLAUDE/i.test(f) || /^_Master/i.test(f)) continue;
    const abs = path.join(dir, f);
    let mtime = null;
    try {
      mtime = fs.statSync(abs).mtime.toISOString();
    } catch (_) {
      mtime = null;
    }
    out.push({ name: f, path: abs, mtime });
  }
  return out;
}

// ---------- git ----------

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function buildGit(root) {
  const result = { branch: '', ahead: 0, behind: 0, dirty: [], submodules: [] };

  try {
    result.branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (_) { /* not a repo / no HEAD */ }

  try {
    // left-right count of @{u}...HEAD => "<behind>\t<ahead>"
    const lr = git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).trim();
    const [behind, ahead] = lr.split(/\s+/).map((n) => parseInt(n, 10) || 0);
    result.behind = behind || 0;
    result.ahead = ahead || 0;
  } catch (_) { /* no upstream (fresh clone) => 0/0 */ }

  try {
    const out = git(root, ['status', '--porcelain']);
    result.dirty = out.split(/\r?\n/).filter(Boolean).map((line) => ({
      status: line.slice(0, 2).trim(),
      file: line.slice(3),
    }));
  } catch (_) { /* leave empty */ }

  try {
    const out = git(root, ['submodule', 'status']);
    result.submodules = out.split(/\r?\n/).filter(Boolean).map((line) => {
      const m = line.match(/^([ +\-U])([0-9a-fA-F]+)\s+(\S+)(?:\s+\((.+)\))?/);
      if (!m) return null;
      return {
        path: m[3],
        sha: m[2].slice(0, 7),
        branch: (m[4] || '').replace(/^heads\//, ''),
        dirty: m[1] !== ' ',
      };
    }).filter(Boolean);
  } catch (_) { /* leave empty */ }

  return result;
}

// ---------- assembly ----------

function buildState(cfg) {
  const sessionEntries = readJSONL(cfg.sessionLog);
  const auditEntries = readJSONL(cfg.auditLog);
  const lock = readLock(cfg.lockFile);

  // harness aggregate over last window
  const harness = { window: HARNESS_WINDOW };
  for (const e of auditEntries.slice(-HARNESS_WINDOW)) {
    const r = e && e.result;
    if (!r) continue;
    harness[r] = (harness[r] || 0) + 1;
  }

  const today = todayLocal();
  const actionsToday = sessionEntries.filter(
    (e) => (e && typeof e.ts === 'string' ? e.ts.slice(0, 10) : '') === today
  ).length;

  const workspaces = buildWorkspaces(cfg, sessionEntries, lock);
  const gitInfo = buildGit(cfg.root);
  const submoduleDirty = gitInfo.submodules.filter((s) => s.dirty).length;

  const sessionFeed = sessionEntries.slice(-FEED_LIMIT).reverse();
  const auditFeed = auditEntries.slice(-FEED_LIMIT).reverse();

  return {
    generatedAt: new Date().toISOString(),
    root: cfg.root,
    platform: cfg.platform,
    dataSources: {
      sessionLog: { path: cfg.sessionLog, exists: exists(cfg.sessionLog) },
      auditLog: { path: cfg.auditLog, exists: exists(cfg.auditLog) },
      lock: { path: cfg.lockFile, exists: exists(cfg.lockFile) },
      registry: {
        path: cfg.registry || cfg.registryPath,
        exists: exists(cfg.registry || cfg.registryPath),
      },
    },
    kpis: {
      activeWorkspace: { name: lock.current.name, locked: lock.current.locked },
      workspaceCount: workspaces.length,
      lockedSessions: lock.lockedSessions,
      actionsToday,
      harness,
      submodules: { total: gitInfo.submodules.length, dirty: submoduleDirty },
      gitDirty: gitInfo.dirty.length,
    },
    workspaces,
    agents: buildAgents(cfg),
    skills: buildSkills(cfg),
    git: gitInfo,
    sessionFeed,
    auditFeed,
    handoffs: buildHandoffs(cfg),
  };
}

module.exports = { buildState };
