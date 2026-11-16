'use strict';

// Hames Cockpit — state snapshot (CONTRACT sections 2 & 3).
// Every reader degrades gracefully: on any read/parse error return a safe empty
// default, never throw to the caller. Big files are read whole then sliced.

const fs = require('fs');
const os = require('os');
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

// ---------- workspaces ----------

function buildWorkspaces(cfg, sessionEntries) {
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

// ---------- subagents / skills ----------

function listMd(dir) {
  if (!dir || !exists(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (_) {
    return [];
  }
}

// Recent Claude Code subagent calls for the virtual office. Reads only each
// agent-*.meta.json (description, agentType, finished) and the mtime of the
// matching agent-*.jsonl. Transcript contents are never read.
// Covers Claude Code sessions started at the Hames root only (Codex excluded).
const SUBAGENT_WINDOW_MS = Number(process.env.COCKPIT_SUBAGENT_WINDOW_MS) || 24 * 60 * 60 * 1000;
const SUBAGENT_LIMIT = Number(process.env.COCKPIT_SUBAGENT_LIMIT) || 12;
const SUBAGENT_RUNNING_MS = Number(process.env.COCKPIT_SUBAGENT_RUNNING_MS) || 5 * 60 * 1000;

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function buildSubagents(cfg) {
  // config.js normally supplies this; fall back to the same rule if it is absent.
  const projectDir = cfg.claudeProjectDir || path.join(
    os.homedir(), '.claude', 'projects', String(cfg.root || '').replace(/[^A-Za-z0-9]/g, '-')
  );
  const now = Date.now();
  let found = false;
  const recent = [];
  for (const sess of safeReaddir(projectDir)) {
    if (!sess.isDirectory()) continue;
    const subDir = path.join(projectDir, sess.name, 'subagents');
    if (!exists(subDir)) continue;
    found = true;
    for (const f of safeReaddir(subDir)) {
      if (!f.isFile() || !/^agent-.+\.meta\.json$/.test(f.name)) continue;
      const jsonl = path.join(subDir, f.name.replace(/\.meta\.json$/, '.jsonl'));
      let mtime;
      try {
        mtime = fs.statSync(jsonl).mtimeMs;
      } catch (_) {
        continue;
      }
      if (now - mtime > SUBAGENT_WINDOW_MS) continue;
      const meta = readJSON(path.join(subDir, f.name), null);
      if (!meta || typeof meta !== 'object') continue;
      // status: 'done' only when the record says finished; an unfinished record
      // that stopped updating is 'stale' (unknown), never reported as done.
      const finished = meta.finished === true;
      const fresh = now - mtime <= SUBAGENT_RUNNING_MS;
      const status = finished ? 'done' : (fresh ? 'running' : 'stale');
      recent.push({
        description: typeof meta.description === 'string' ? meta.description : '',
        agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
        running: status === 'running',
        finished,
        status,
        updatedAt: new Date(mtime).toISOString(),
      });
    }
  }
  recent.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return {
    source: { path: projectDir, exists: found },
    total: recent.length,
    running: recent.filter((x) => x.running).length, // counted before the display cap
    list: recent.slice(0, SUBAGENT_LIMIT),
  };
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
    // The root `git status` (above) already lists a submodule by its path when its working tree
    // is dirty / has untracked content — so we get the in-submodule "dirty" signal for FREE,
    // with NO per-submodule git calls. `git submodule status` only flags gitlink commit-
    // divergence ('+'), init ('-'), conflict ('U'); the two sources combine into one state:
    //   drift    — checked-out commit != recorded gitlink (committed but not synced)
    //   dirty    — HEAD matches gitlink but the working tree has uncommitted/untracked changes
    //   uninit   — submodule not initialized
    //   conflict — merge conflicts
    //   clean    — at the recorded commit, nothing changed
    const rootDirty = new Set(result.dirty.map((d) => d.file));
    const out = git(root, ['submodule', 'status']);
    result.submodules = out.split(/\r?\n/).filter(Boolean).map((line) => {
      const m = line.match(/^([ +\-U])([0-9a-fA-F]+)\s+(\S+)(?:\s+\((.+)\))?/);
      if (!m) return null;
      const flag = m[1], pth = m[3];
      let state;
      if (flag === '+') state = 'drift';
      else if (flag === '-') state = 'uninit';
      else if (flag === 'U') state = 'conflict';
      else if (rootDirty.has(pth)) state = 'dirty';
      else state = 'clean';
      return {
        path: pth,
        sha: m[2].slice(0, 7),
        branch: (m[4] || '').replace(/^heads\//, ''),
        dirty: state !== 'clean',
        state: state,
      };
    }).filter(Boolean);
  } catch (_) { /* leave empty */ }

  return result;
}

// ---------- assembly ----------

function buildState(cfg) {
  const sessionEntries = readJSONL(cfg.sessionLog);
  const auditEntries = readJSONL(cfg.auditLog);

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

  const workspaces = buildWorkspaces(cfg, sessionEntries);
  const subagents = buildSubagents(cfg);
  let lastWorkspace = null;
  for (let i = sessionEntries.length - 1; i >= 0; i -= 1) {
    const ws = sessionEntries[i] && sessionEntries[i].workspace;
    if (ws) { lastWorkspace = ws; break; }
  }
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
      claudeSubagents: subagents.source,
      registry: {
        path: cfg.registry || cfg.registryPath,
        exists: exists(cfg.registry || cfg.registryPath),
      },
    },
    kpis: {
      lastWorkspace: { name: lastWorkspace },
      workspaceCount: workspaces.length,
      recentSubagentCalls: subagents.total,
      runningSubagents: subagents.running,
      actionsToday,
      harness,
      submodules: { total: gitInfo.submodules.length, dirty: submoduleDirty },
      gitDirty: gitInfo.dirty.length,
    },
    workspaces,
    subagents: subagents.list,
    skills: buildSkills(cfg),
    git: gitInfo,
    sessionFeed,
    auditFeed,
    handoffs: buildHandoffs(cfg),
  };
}

module.exports = { buildState };
