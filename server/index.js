'use strict';

// Hames Cockpit — HTTP server (CONTRACT section 5).
// Zero npm deps. Built-ins only. Bound to 127.0.0.1.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { loadConfig } = require('./config');
const { buildState } = require('./state');
const { handleAction } = require('./actions');
const { createOrchestrator } = require('./orchestrator');
const { runDoctor } = require('./doctor');

const cfg = loadConfig();
const orchestrator = createOrchestrator(cfg);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  // Map URL path into web/, rejecting traversal.
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = path.resolve(cfg.webDir, rel);
  if (abs !== cfg.webDir && !abs.startsWith(cfg.webDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type = CONTENT_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
    fs.createReadStream(abs).on('error', () => {
      try { res.destroy(); } catch (_) { /* noop */ }
    }).pipe(res);
  });
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);   // true => parsed.query object
  const pathname = parsed.pathname || '/';
  const refresh = parsed.query && parsed.query.refresh === '1';

  // --- API: state ---
  if (pathname === '/api/state' && req.method === 'GET') {
    try {
      sendJSON(res, 200, buildState(cfg));
    } catch (err) {
      sendJSON(res, 500, { error: String((err && err.message) || err) });
    }
    return;
  }

  // --- API: doctor (system health MRI) ---
  if (pathname === '/api/doctor' && req.method === 'GET') {
    try {
      sendJSON(res, 200, runDoctor(cfg, { refresh: refresh }));
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  // --- API: action ---
  if (pathname === '/api/action' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (_) {
          sendJSON(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
      }
      sendJSON(res, 200, handleAction(cfg, body));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  // --- API: spawn agent (read-only claude run) ---
  if (pathname === '/api/spawn' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (_) {
          sendJSON(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
      }
      sendJSON(res, 200, orchestrator.spawnAgent({ agent: body.agent, prompt: body.prompt }));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  // --- API: jobs list ---
  if (pathname === '/api/jobs' && req.method === 'GET') {
    sendJSON(res, 200, { jobs: orchestrator.getJobs() });
    return;
  }

  // --- API: single job / stop (parse :id manually, no framework) ---
  if (pathname.startsWith('/api/jobs/')) {
    const rest = pathname.slice('/api/jobs/'.length);
    if (rest.endsWith('/stop') && req.method === 'POST') {
      const id = decodeURIComponent(rest.slice(0, -'/stop'.length));
      sendJSON(res, 200, { ok: orchestrator.stopJob(id) });
      return;
    }
    if (req.method === 'GET' && rest && !rest.includes('/')) {
      const job = orchestrator.getJob(decodeURIComponent(rest));
      if (!job) {
        sendJSON(res, 404, { error: 'job not found' });
        return;
      }
      sendJSON(res, 200, job);
      return;
    }
  }

  // --- static (GET only) ---
  if (req.method === 'GET') {
    serveStatic(res, pathname);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
});

server.listen(cfg.port, cfg.host, () => {
  process.stdout.write(
    `Hames Cockpit → http://${cfg.host}:${cfg.port}  (root: ${cfg.root})\n`
  );
});

server.on('error', (err) => {
  process.stderr.write(`Cockpit server error: ${(err && err.message) || err}\n`);
  process.exit(1);
});
