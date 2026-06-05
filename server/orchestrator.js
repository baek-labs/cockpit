'use strict';

// Hames Cockpit — job orchestrator (CONTRACT_PHASE2, SAFE-MODE OVERRIDE).
//
// SAFE MODE (authoritative): agent spawns are READ-ONLY. We launch `claude -p`
// with the dangerous tools disallowed and NO permission bypass — the spawned
// agent can only Read/Grep/Glob/WebSearch and reason. It physically cannot
// Write/Edit/run Bash/spawn subagents. save/pull are NOT executed in this pass,
// so `runSlash` is intentionally absent (per override rule 2).
//
// In-memory only (jobs lost on restart). Prompt is passed as an argv element via
// child_process.spawn — never through a shell, so there is no shell injection.

const { spawn } = require('child_process');
const readline = require('readline');

const MAX_CONCURRENT = 3;
const MAX_EVENTS = 2000;
const ADVISORY_AGENTS = new Set(['CFO', 'CSO', 'CBO', 'CTO', 'Marketer']);

function nowISO() {
  return new Date().toISOString();
}

function composePrompt(agent, userPrompt) {
  const a = (agent || '').trim();
  if (ADVISORY_AGENTS.has(a)) {
    return (
      `You are acting as the Hames ${a}. Task: ${userPrompt}\n\n` +
      'Default to advisory mode — read what you need and return a clear, ' +
      'structured result. Make file changes only if the task explicitly requires it.'
    );
  }
  // COO or empty → pass through as-is.
  return userPrompt;
}

function briefForToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.file_path ||
    input.path ||
    input.command ||
    input.pattern ||
    input.query ||
    input.url ||
    '';
  const s = pick ? String(pick) : JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function createOrchestrator(cfg) {
  const jobs = new Map();   // id -> job (serializable)
  const procs = new Map();  // id -> child process (kept out of the job object)
  let counter = 0;

  function pushEvent(job, ev) {
    job.events.push(ev);
    if (job.events.length > MAX_EVENTS) {
      job.events.splice(0, job.events.length - MAX_EVENTS);
      job.events[0] = { t: 'system', text: '… older events truncated …' };
    }
  }

  function runningCount() {
    let n = 0;
    for (const j of jobs.values()) if (j.status === 'running') n += 1;
    return n;
  }

  function finalize(job, code) {
    if (job.status === 'running') {
      if (code === 0) {
        job.status = 'done';
      } else {
        job.status = 'error';
        pushEvent(job, { t: 'error', text: `exited with code ${code}` });
      }
    }
    if (job.exitCode === null) job.exitCode = code;
    if (!job.endedAt) job.endedAt = nowISO();
  }

  function handleLine(job, line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      return; // skip non-JSON / partial lines
    }
    if (!obj || typeof obj !== 'object') return;

    if (obj.type === 'system' && obj.subtype === 'init') {
      pushEvent(job, { t: 'system', text: 'session started' });
      return;
    }

    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const part of obj.message.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && part.text) {
          pushEvent(job, { t: 'text', text: String(part.text) });
        } else if (part.type === 'tool_use') {
          pushEvent(job, {
            t: 'tool',
            tool: part.name || 'tool',
            brief: briefForToolInput(part.input),
          });
        }
      }
      return;
    }

    if (obj.type === 'result') {
      const isError = !!obj.is_error;
      const text = obj.result != null ? String(obj.result) : '';
      job.result = obj.result != null ? text : null;
      pushEvent(job, { t: 'result', text, isError });
      job.status = isError ? 'error' : 'done';
      // endedAt is set on child close.
      return;
    }
    // hook_started / hook_response / rate_limit_event / etc. → noise, ignore.
  }

  // Launch the read-only claude run. Returns { ok:true, jobId } | { ok:false, reason }.
  function spawnAgent({ agent, prompt }) {
    if (runningCount() >= MAX_CONCURRENT) {
      return { ok: false, reason: 'max concurrent jobs' };
    }
    const userPrompt = typeof prompt === 'string' ? prompt : '';
    if (!userPrompt.trim()) {
      return { ok: false, reason: 'empty prompt' };
    }

    const id = 'job_' + Date.now().toString(36) + (counter++).toString(36);
    const composed = composePrompt(agent, userPrompt);

    const job = {
      id,
      kind: 'agent',
      agent: agent || null,
      prompt: userPrompt,
      status: 'running',
      startedAt: nowISO(),
      endedAt: null,
      exitCode: null,
      result: null,
      events: [],
    };
    jobs.set(id, job);

    // READ-ONLY spawn args (SAFE-MODE OVERRIDE — no permission bypass).
    const args = [
      '-p', composed,
      '--output-format', 'stream-json',
      '--verbose',
      '--disallowedTools', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'Task',
      '--model', 'claude-opus-4-8',
    ];

    let child;
    try {
      child = spawn('claude', args, {
        cwd: cfg.root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      pushEvent(job, { t: 'error', text: `spawn failed: ${(err && err.message) || err}` });
      job.status = 'error';
      job.endedAt = nowISO();
      return { ok: true, jobId: id }; // job exists (in error state) so UI can show it
    }

    procs.set(id, child);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => handleLine(job, line));

    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    child.on('error', (err) => {
      pushEvent(job, { t: 'error', text: `spawn error: ${(err && err.message) || err}` });
      job.status = 'error';
      if (!job.endedAt) job.endedAt = nowISO();
      procs.delete(id);
    });

    child.on('close', (code) => {
      procs.delete(id);
      try { rl.close(); } catch (_) { /* noop */ }
      if (code !== 0 && job.status === 'running' && stderrTail.trim()) {
        pushEvent(job, { t: 'error', text: stderrTail.trim().slice(-500) });
      }
      finalize(job, code);
    });

    return { ok: true, jobId: id };
  }

  function latestSummary(job) {
    for (let i = job.events.length - 1; i >= 0; i--) {
      const e = job.events[i];
      if ((e.t === 'text' || e.t === 'result') && e.text) {
        return e.text.slice(0, 80);
      }
    }
    return (job.result || '').slice(0, 80);
  }

  function getJobs() {
    return [...jobs.values()].reverse().map((j) => ({
      id: j.id,
      kind: j.kind,
      agent: j.agent,
      label: j.agent || j.kind,
      status: j.status,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      summary: latestSummary(j),
    }));
  }

  function getJob(id) {
    return jobs.get(id) || null;
  }

  function stopJob(id) {
    const job = jobs.get(id);
    if (!job) return false;
    const child = procs.get(id);
    if (child) {
      try { child.kill('SIGTERM'); } catch (_) { /* noop */ }
    }
    if (job.status === 'running') {
      job.status = 'error';
      job.endedAt = nowISO();
      pushEvent(job, { t: 'error', text: 'stopped by user' });
    }
    return true;
  }

  return { spawnAgent, getJobs, getJob, stopJob };
}

module.exports = { createOrchestrator };
