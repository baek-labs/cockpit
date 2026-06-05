/* ============================================================
   HAMES COCKPIT — frontend controller
   Vanilla JS, no dependencies, no build step.
   Consumes GET /api/state ; acts via POST /api/action.
   ============================================================ */
(function () {
  "use strict";

  // ----------------------------------------------------------------
  // State
  // ----------------------------------------------------------------
  var POLL_MS = 5000;
  var SECTIONS = [
    { id: "overview",   label: "Overview",   icon: "▣" },
    { id: "workspaces", label: "Workspaces", icon: "▤" },
    { id: "agents",     label: "Agents",     icon: "◈" },
    { id: "skills",     label: "Skills",     icon: "⚙" },
    { id: "harness",    label: "Harness",    icon: "⛨" },
    { id: "git",        label: "Git",        icon: "⎇" }
  ];

  var current = "overview";
  var live = false;
  var pollTimer = null;
  var lastState = null;
  var inFlight = false;

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------
  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function num(v) {
    if (typeof v !== "number" || !isFinite(v)) return "0";
    return v.toLocaleString("en-US");
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  function byId(id) { return document.getElementById(id); }

  // Parse both "YYYY-MM-DD HH:MM:SS" (local) and ISO. Returns Date or null.
  function parseTs(ts) {
    if (!ts) return null;
    var s = String(ts);
    var d;
    if (s.indexOf("T") === -1 && s.indexOf(" ") !== -1) {
      d = new Date(s.replace(" ", "T")); // local-time session log
    } else {
      d = new Date(s);
    }
    return isNaN(d.getTime()) ? null : d;
  }

  function relTime(ts) {
    var d = parseTs(ts);
    if (!d) return esc(ts);
    var sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 0) sec = 0;
    if (sec < 60) return sec + "s ago";
    var min = Math.round(sec / 60);
    if (min < 60) return min + "m ago";
    var hr = Math.round(min / 60);
    if (hr < 24) return hr + "h ago";
    return Math.round(hr / 24) + "d ago";
  }

  function toolClass(tool) {
    var t = String(tool || "").toLowerCase();
    if (t.indexOf("write") !== -1) return "t-write";
    if (t.indexOf("edit") !== -1) return "t-edit";
    if (t.indexOf("bash") !== -1) return "t-bash";
    if (t.indexOf("read") !== -1 || t.indexOf("glob") !== -1 || t.indexOf("grep") !== -1) return "t-read";
    if (t.indexOf("task") !== -1 || t.indexOf("agent") !== -1) return "t-task";
    return "";
  }

  function resultClass(result) {
    var r = String(result || "").toUpperCase();
    if (r === "PASS" || r === "ALLOWED" || r === "ALLOWED_SYSADMIN") return "r-pass";
    if (r === "BLOCKED") return "r-blocked";
    if (r === "BYPASS") return "r-bypass";
    if (r.indexOf("SKIPPED") === 0) return "r-skip";
    return "r-other";
  }

  function gstClass(status) {
    var s = String(status || "").trim();
    if (s.indexOf("?") !== -1) return "untracked";
    if (s.indexOf("D") !== -1) return "deleted";
    if (s.indexOf("A") !== -1) return "added";
    if (s.indexOf("M") !== -1 || s.indexOf("R") !== -1) return "modified";
    return "";
  }

  // ----------------------------------------------------------------
  // KPI bar
  // ----------------------------------------------------------------
  function chip(label, valueHtml, cls) {
    return '<div class="chip ' + (cls || "") + '">' +
      '<span class="chip-label">' + esc(label) + '</span>' +
      '<span class="chip-value">' + valueHtml + '</span></div>';
  }

  function renderKpis(s) {
    var k = (s && s.kpis) || {};
    var aw = k.activeWorkspace || {};
    var h = k.harness || {};
    var sm = k.submodules || {};
    var out = [];

    var awName = aw.name ? esc(aw.name) : "—";
    var awHtml = '<span class="' + (aw.locked ? "v-warn" : "") + '">' + awName + "</span>" +
      (aw.locked ? ' <span class="unit">🔒 locked</span>' : "");
    out.push(chip("Active Workspace", awHtml, aw.locked ? "warn" : "accent"));

    out.push(chip("Workspaces", '<span class="v-cyan">' + num(k.workspaceCount || 0) + "</span>"));
    out.push(chip("Locked Sessions", num(k.lockedSessions || 0)));
    out.push(chip("Actions Today", '<span class="v-good">' + num(k.actionsToday || 0) + "</span>", "good"));

    var blocked = h.BLOCKED || 0, bypass = h.BYPASS || 0;
    var hHtml = '<span class="v-good">' + num(h.PASS || 0) + "</span>" +
      ' <span class="unit">/</span> <span class="' + (blocked ? "v-alert" : "muted") + '">' + num(blocked) + "</span>" +
      ' <span class="unit">/</span> <span class="' + (bypass ? "v-warn" : "muted") + '">' + num(bypass) + "</span>";
    out.push(chip("Harness P/B/Y", hHtml, blocked ? "alert" : "good"));

    var smHtml = num(sm.total || 0) +
      (sm.dirty ? ' <span class="unit v-warn">' + num(sm.dirty) + " dirty</span>" : ' <span class="unit">clean</span>');
    out.push(chip("Submodules", smHtml, sm.dirty ? "warn" : ""));

    var gd = k.gitDirty || 0;
    out.push(chip("Git Dirty", '<span class="' + (gd ? "v-warn" : "v-good") + '">' + num(gd) + "</span>", gd ? "warn" : "good"));

    byId("kpiBar").innerHTML = out.join("");
  }

  // ----------------------------------------------------------------
  // Left nav
  // ----------------------------------------------------------------
  function navCount(s, id) {
    if (!s) return null;
    switch (id) {
      case "workspaces": return arr(s.workspaces).length;
      case "agents":     return arr(s.agents && s.agents.level1).length + arr(s.agents && s.agents.level2).length;
      case "skills":     return arr(s.skills).length;
      case "git":        return arr(s.git && s.git.dirty).length;
      default:           return null;
    }
  }

  function renderNav(s) {
    var html = '<div class="nav-section-label">Sections</div>';
    SECTIONS.forEach(function (sec) {
      var c = navCount(s, sec.id);
      var badge = (c !== null) ? '<span class="nav-badge">' + num(c) + "</span>" : "";
      html += '<div class="nav-item' + (sec.id === current ? " active" : "") + '" data-nav="' + esc(sec.id) + '">' +
        '<span class="nav-icon">' + sec.icon + "</span>" +
        "<span>" + esc(sec.label) + "</span>" + badge + "</div>";
    });
    html += '<div class="nav-spacer"></div>';
    var ds = (s && s.dataSources) || {};
    html += '<div class="nav-foot">' +
      "session log " + dot(ds.sessionLog) + "<br>" +
      "audit log " + dot(ds.auditLog) + "<br>" +
      "lock file " + dot(ds.lock) + "<br>" +
      "registry " + dot(ds.registry) + "</div>";
    byId("leftnav").innerHTML = html;
  }

  function dot(src) {
    var ok = src && src.exists;
    return '<span style="color:' + (ok ? "var(--teal)" : "var(--muted)") + '">' + (ok ? "● online" : "○ absent") + "</span>";
  }

  // ----------------------------------------------------------------
  // Right rail — Live Operations (sessionFeed)
  // ----------------------------------------------------------------
  function renderRail(s) {
    var feed = arr(s && s.sessionFeed);
    byId("railCount").textContent = num(feed.length);
    if (!feed.length) {
      byId("railFeed").innerHTML = emptyBox("◌", "No operations yet", "Tool activity will stream here as the session log fills.");
      return;
    }
    var html = feed.map(function (op) {
      op = op || {};
      var tc = toolClass(op.tool);
      var ws = op.workspace ? '<span class="tag ws">' + esc(op.workspace) + "</span>" : "";
      var file = op.file ? '<div class="op-file">' + esc(op.file) + "</div>" : "";
      return '<div class="op">' +
        '<div class="op-row1"><span class="tag ' + tc + '">' + esc(op.tool || "?") + "</span>" + ws + "</div>" +
        file +
        '<div class="op-ts">' + relTime(op.ts) + " · " + esc(op.ts || "") + "</div>" +
        "</div>";
    }).join("");
    byId("railFeed").innerHTML = html;
  }

  // ----------------------------------------------------------------
  // Shared partials
  // ----------------------------------------------------------------
  function emptyBox(mark, title, hint) {
    return '<div class="empty"><span class="em-mark">' + esc(mark) + "</span>" +
      '<div class="em-title">' + esc(title) + "</div>" +
      '<div class="em-hint">' + (hint || "") + "</div></div>";
  }

  function lockBadge(locked) {
    return locked
      ? '<span class="badge lock">🔒 LOCKED</span>'
      : '<span class="badge unlock">UNLOCKED</span>';
  }

  function existsBadge(exists) {
    return exists
      ? '<span class="badge ok">EXISTS</span>'
      : '<span class="badge miss">MISSING</span>';
  }

  function openBtn(path) {
    if (!path) return "";
    return '<button class="btn btn-open" data-action="open" data-arg="' + esc(path) + '">⇱ open</button>';
  }

  function viewHead(title, sub, toolsHtml) {
    return '<div class="view-head"><span class="view-title">' + esc(title) + "</span>" +
      '<span class="view-sub">' + (sub || "") + "</span>" +
      '<span class="view-tools">' + (toolsHtml || "") + "</span></div>";
  }

  // ----------------------------------------------------------------
  // Section: Overview
  // ----------------------------------------------------------------
  function renderOverview(s) {
    var ws = arr(s.workspaces);
    var k = s.kpis || {};
    var h = '';

    h += viewHead("Command Overview", "operational snapshot of the Hames system",
      '<button class="btn" data-action="git.fetch">⟱ git fetch</button>');

    // KPI summary panel
    var aw = k.activeWorkspace || {};
    h += '<div class="grid cols-3">';
    h += summaryCard("Active Workspace", aw.name ? esc(aw.name) : "—", aw.locked ? "🔒 locked" : "unlocked", aw.locked ? "warn" : "");
    h += summaryCard("Actions Today", num(k.actionsToday || 0), "session-log events", "");
    h += summaryCard("Locked Sessions", num(k.lockedSessions || 0), "across workspaces", "");
    h += "</div>";

    // Programs (workspaces as ShipOS programs)
    h += '<div class="panel-title section-gap">Programs · Workspace Activity</div>';
    if (!ws.length) {
      h += emptyBox("◇", "No workspaces yet",
        "This looks like a fresh public install. Add a <code>workspace_paths.json</code> registry or " +
        "<code>workspaces/*/CLAUDE.md</code> folders and they'll appear here automatically.");
    } else {
      var maxA = ws.reduce(function (m, w) { return Math.max(m, (w && w.actions) || 0); }, 0) || 1;
      h += '<div class="grid cols-auto">';
      ws.forEach(function (w) {
        w = w || {};
        var pct = Math.round(((w.actions || 0) / maxA) * 100);
        h += '<div class="prog">' +
          '<div class="prog-head"><span class="prog-name">' + esc(w.name || "?") + "</span>" +
            lockBadge(w.locked) + (w.exists === false ? " " + existsBadge(false) : "") + "</div>" +
          '<div class="prog-path">' + esc(w.path || "") + "</div>" +
          '<div class="bar"><span style="width:' + pct + '%"></span></div>' +
          '<div class="prog-meta"><span><span class="n">' + num(w.actions || 0) + "</span> actions</span>" +
            '<span>· ' + (w.lastActivity ? relTime(w.lastActivity) : "no activity") + "</span>" +
            '<span style="margin-left:auto">' + openBtn(w.path) + "</span></div>" +
          "</div>";
      });
      h += "</div>";
    }

    // Recent activity (compact, from sessionFeed)
    var feed = arr(s.sessionFeed).slice(0, 8);
    h += '<div class="panel section-gap"><div class="panel-title">Recent Activity</div>';
    if (!feed.length) {
      h += '<div class="muted">No recent activity recorded.</div>';
    } else {
      h += '<table class="tbl"><thead><tr><th>Tool</th><th>Workspace</th><th>File</th><th>When</th></tr></thead><tbody>';
      feed.forEach(function (op) {
        op = op || {};
        h += "<tr><td><span class='tag " + toolClass(op.tool) + "'>" + esc(op.tool || "?") + "</span></td>" +
          "<td>" + (op.workspace ? "<span class='tag ws'>" + esc(op.workspace) + "</span>" : "<span class='muted'>—</span>") + "</td>" +
          "<td class='mono'>" + esc(op.file || "") + "</td>" +
          "<td class='mono nowrap'>" + relTime(op.ts) + "</td></tr>";
      });
      h += "</tbody></table>";
    }
    h += "</div>";

    return h;
  }

  function summaryCard(label, value, sub, cls) {
    return '<div class="panel"><div class="panel-title">' + esc(label) + "</div>" +
      '<div class="chip-value ' + (cls ? "v-" + (cls === "warn" ? "warn" : cls) : "") + '" style="font-size:24px">' + value + "</div>" +
      '<div class="muted" style="margin-top:4px">' + esc(sub) + "</div></div>";
  }

  // ----------------------------------------------------------------
  // Section: Workspaces
  // ----------------------------------------------------------------
  function renderWorkspaces(s) {
    var ws = arr(s.workspaces);
    var h = viewHead("Workspaces", num(ws.length) + " registered");
    if (!ws.length) {
      h += emptyBox("◇", "No workspaces yet",
        "No registry and no <code>workspaces/*/CLAUDE.md</code> were discovered. Nothing to show — this is expected on a fresh public install.");
      return h;
    }
    h += '<div class="panel" style="padding:4px 0">';
    h += '<table class="tbl"><thead><tr>' +
      "<th>Name</th><th>Path</th><th class='right'>Actions</th><th>Last Activity</th><th>Lock</th><th>State</th><th></th>" +
      "</tr></thead><tbody>";
    ws.forEach(function (w) {
      w = w || {};
      h += "<tr>" +
        "<td><strong>" + esc(w.name || "?") + "</strong></td>" +
        "<td class='mono'>" + esc(w.path || "") + "</td>" +
        "<td class='num'>" + num(w.actions || 0) + "</td>" +
        "<td class='mono nowrap'>" + (w.lastActivity ? esc(w.lastActivity) : "<span class='muted'>—</span>") + "</td>" +
        "<td>" + lockBadge(w.locked) + "</td>" +
        "<td>" + existsBadge(w.exists !== false) + "</td>" +
        "<td class='right'>" + openBtn(w.path) + "</td>" +
        "</tr>";
    });
    h += "</tbody></table></div>";
    return h;
  }

  // ----------------------------------------------------------------
  // Section: Agents
  // ----------------------------------------------------------------
  function renderAgents(s) {
    var a = s.agents || {};
    var l1 = arr(a.level1), l2 = arr(a.level2);
    var h = viewHead("Agents", num(l1.length) + " level-1 · " + num(l2.length) + " level-2");

    if (!l1.length && !l2.length) {
      h += emptyBox("◈", "No agents discovered",
        "No <code>.claude/agents/*.md</code> files were found. Drop agent definitions there and they'll be grouped here.");
      return h;
    }

    h += '<div class="panel-title">Level 1 · Domain Agents</div>';
    h += l1.length ? agentGrid(l1, false) : '<div class="muted" style="margin-bottom:8px">none</div>';

    h += '<div class="panel-title section-gap">Level 2 · Specialist Sub-agents</div>';
    h += l2.length ? agentGrid(l2, true) : '<div class="muted">none</div>';
    return h;
  }

  function agentGrid(list, lvl2) {
    var h = '<div class="grid cols-auto">';
    list.forEach(function (ag) {
      ag = ag || {};
      h += '<div class="agent-card' + (lvl2 ? " lvl2" : "") + '">' +
        '<div class="agent-name">' + esc(ag.name || "?") +
          '<span class="agent-file">' + esc(ag.file || "") + "</span></div>" +
        '<div class="agent-desc">' + esc(ag.description || "—") + "</div></div>";
    });
    return h + "</div>";
  }

  // ----------------------------------------------------------------
  // Section: Skills
  // ----------------------------------------------------------------
  function renderSkills(s) {
    var sk = arr(s.skills);
    var h = viewHead("Skills", num(sk.length) + " commands");
    if (!sk.length) {
      h += emptyBox("⚙", "No skills discovered",
        "No <code>.claude/commands/*.md</code> files were found.");
      return h;
    }
    h += '<div class="panel" style="padding:0">';
    sk.forEach(function (k) {
      k = k || {};
      h += '<div class="skill-row"><div class="skill-name">/' + esc(k.name || "?") + "</div>" +
        '<div class="skill-desc">' + esc(k.description || "—") + "</div></div>";
    });
    h += "</div>";
    return h;
  }

  // ----------------------------------------------------------------
  // Section: Harness
  // ----------------------------------------------------------------
  function renderHarness(s) {
    var k = s.kpis || {};
    var hd = k.harness || {};
    var feed = arr(s.auditFeed);
    var win = hd.window || 0;
    var h = viewHead("Harness", "compliance over last " + num(win) + " audit entries");

    // bars
    var pass = hd.PASS || 0, blocked = hd.BLOCKED || 0, bypass = hd.BYPASS || 0;
    var maxV = Math.max(pass, blocked, bypass, 1);
    h += '<div class="panel"><div class="panel-title">Result Distribution</div>';
    h += hRow("PASS", pass, maxV, "pass");
    h += hRow("BLOCKED", blocked, maxV, "blocked");
    h += hRow("BYPASS", bypass, maxV, "bypass");
    h += "</div>";

    // audit feed
    h += '<div class="panel section-gap"><div class="panel-title">Audit Feed</div>';
    if (!feed.length) {
      h += '<div class="muted">No audit entries.</div>';
    } else {
      h += '<table class="tbl"><thead><tr><th>Result</th><th>Hook</th><th>Tool</th><th>When</th></tr></thead><tbody>';
      feed.forEach(function (e) {
        e = e || {};
        h += "<tr><td><span class='tag " + resultClass(e.result) + "'>" + esc(e.result || "?") + "</span></td>" +
          "<td class='mono'>" + esc(e.hook || "—") + "</td>" +
          "<td class='mono'>" + esc(e.tool || "—") + "</td>" +
          "<td class='mono nowrap'>" + relTime(e.ts) + "</td></tr>";
      });
      h += "</tbody></table>";
    }
    h += "</div>";
    return h;
  }

  function hRow(label, val, maxV, cls) {
    var pct = Math.round((val / maxV) * 100);
    return '<div class="hbar-row"><div class="hbar-label">' + esc(label) + "</div>" +
      '<div class="hbar ' + cls + '"><span style="width:' + pct + '%"></span></div>' +
      '<div class="hbar-val">' + num(val) + "</div></div>";
  }

  // ----------------------------------------------------------------
  // Section: Git
  // ----------------------------------------------------------------
  function renderGit(s) {
    var g = s.git || {};
    var dirty = arr(g.dirty);
    var subs = arr(g.submodules);
    var h = viewHead("Git", esc(g.branch || "—") + " · " + dirty.length + " dirty",
      '<button class="btn" data-action="git.fetch">⟱ git fetch</button>');

    // branch stats
    h += '<div class="panel"><div class="panel-title">Branch</div><div class="git-stat">';
    h += gitKv("Branch", esc(g.branch || "—"));
    h += gitKv("Ahead", num(g.ahead || 0));
    h += gitKv("Behind", num(g.behind || 0));
    h += gitKv("Dirty Files", num(dirty.length));
    h += gitKv("Submodules", num(subs.length));
    h += "</div></div>";

    // dirty files
    h += '<div class="panel section-gap"><div class="panel-title">Working Tree</div>';
    if (!dirty.length) {
      h += '<div class="muted">Clean — no uncommitted changes.</div>';
    } else {
      h += '<table class="tbl"><thead><tr><th style="width:60px">Status</th><th>File</th></tr></thead><tbody>';
      dirty.forEach(function (d) {
        d = d || {};
        h += "<tr><td><span class='gst " + gstClass(d.status) + "'>" + esc((d.status || "").trim() || "?") + "</span></td>" +
          "<td class='mono'>" + esc(d.file || "") + "</td></tr>";
      });
      h += "</tbody></table>";
    }
    h += "</div>";

    // submodules
    h += '<div class="panel section-gap"><div class="panel-title">Submodules</div>';
    if (!subs.length) {
      h += '<div class="muted">No submodules.</div>';
    } else {
      h += '<table class="tbl"><thead><tr><th>Path</th><th>SHA</th><th>Branch</th><th>State</th></tr></thead><tbody>';
      subs.forEach(function (m) {
        m = m || {};
        h += "<tr><td class='mono'>" + esc(m.path || "") + "</td>" +
          "<td class='mono'>" + esc(m.sha || "") + "</td>" +
          "<td class='mono'>" + esc(m.branch || "—") + "</td>" +
          "<td>" + (m.dirty ? "<span class='badge miss'>DIRTY</span>" : "<span class='badge ok'>CLEAN</span>") + "</td></tr>";
      });
      h += "</tbody></table>";
    }
    h += "</div>";

    // Phase-2 gated actions
    h += '<div class="panel section-gap"><div class="panel-title">Routed Actions</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      gatedBtn("lock") + gatedBtn("unlock") + gatedBtn("save") + gatedBtn("pull") + gatedBtn("spawn") +
      "</div>" +
      '<div class="muted" style="margin-top:10px">Phase-2 actions are routed through Claude/Agent SDK so harness hooks fire. Disabled in this read-only cockpit.</div>' +
      "</div>";
    return h;
  }

  function gitKv(k, v) {
    return '<div class="git-kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
  }

  function gatedBtn(type) {
    return '<button class="btn" disabled>' + esc(type) + ' <span class="phase2">Phase 2</span></button>';
  }

  // ----------------------------------------------------------------
  // Master render
  // ----------------------------------------------------------------
  var RENDERERS = {
    overview: renderOverview,
    workspaces: renderWorkspaces,
    agents: renderAgents,
    skills: renderSkills,
    harness: renderHarness,
    git: renderGit
  };

  function render() {
    var s = lastState || {};
    // preserve scroll positions across re-render
    var mainEl = byId("main"), railEl = byId("railFeed");
    var mainScroll = mainEl ? mainEl.scrollTop : 0;
    var railScroll = railEl ? railEl.scrollTop : 0;

    renderKpis(s);
    renderNav(s);
    renderRail(s);

    var fn = RENDERERS[current] || renderOverview;
    try {
      mainEl.innerHTML = fn(s);
    } catch (e) {
      mainEl.innerHTML = emptyBox("⚠", "Render error", esc(String(e && e.message || e)));
    }

    // restore scroll
    if (mainEl) mainEl.scrollTop = mainScroll;
    if (railEl) byId("railFeed").scrollTop = railScroll;

    renderStatus(s);
  }

  function renderStatus(s) {
    byId("stRoot").textContent = "root: " + (s.root || "—");
    byId("stPlatform").textContent = "platform: " + (s.platform || "—");
    byId("stGen").textContent = "snapshot: " + (s.generatedAt ? relTime(s.generatedAt) : "—");
  }

  // ----------------------------------------------------------------
  // Data fetch
  // ----------------------------------------------------------------
  function setConn(cls) {
    var d = byId("connDot");
    d.className = "brand-status " + cls;
  }

  function setMsg(text, cls) {
    var el = byId("stMsg");
    el.textContent = text || "";
    el.className = "st-item" + (cls ? " " + cls : "");
  }

  function fetchState(manual) {
    if (inFlight) return;
    inFlight = true;
    fetch("/api/state", { headers: { "Accept": "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        lastState = data || {};
        setConn("ok");
        setMsg(manual ? "refreshed" : "", manual ? "ok" : "");
        render();
      })
      .catch(function (err) {
        setConn("down");
        setMsg("state fetch failed: " + (err && err.message || err), "err");
        // keep last good state visible; only show empty if we never loaded
        if (!lastState) {
          byId("main").innerHTML = emptyBox("⚠", "Cannot reach cockpit server",
            "GET <code>/api/state</code> failed. Is the server running on this port?");
        }
      })
      .then(function () { inFlight = false; });
  }

  // ----------------------------------------------------------------
  // LIVE polling
  // ----------------------------------------------------------------
  function setLive(on) {
    live = on;
    var btn = byId("liveToggle");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (on) {
      pollTimer = setInterval(function () { fetchState(false); }, POLL_MS);
      fetchState(false);
    }
  }

  // ----------------------------------------------------------------
  // Actions (POST /api/action)
  // ----------------------------------------------------------------
  function doAction(type, arg, btn) {
    if (btn) btn.classList.add("btn-busy");
    setMsg("action: " + type + (arg ? " " + arg : "") + " …", "");
    fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: type, arg: arg })
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false, message: "bad response" }; }); })
      .then(function (res) {
        res = res || {};
        if (res.gated) {
          setMsg("⛔ " + (res.message || "gated (Phase 2)"), "warn");
        } else if (res.ok) {
          setMsg("✓ " + type + " ok" + (res.output ? "" : ""), "ok");
          // refresh state after a successful mutation-ish action
          fetchState(false);
        } else {
          setMsg("✗ " + type + " failed: " + (res.message || res.error || "unknown"), "err");
        }
      })
      .catch(function (err) {
        setMsg("✗ " + type + " error: " + (err && err.message || err), "err");
      })
      .then(function () { if (btn) btn.classList.remove("btn-busy"); });
  }

  // ----------------------------------------------------------------
  // Clock
  // ----------------------------------------------------------------
  function tickClock() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    byId("clock").textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // ----------------------------------------------------------------
  // Wiring
  // ----------------------------------------------------------------
  function init() {
    // nav clicks (delegated)
    byId("leftnav").addEventListener("click", function (e) {
      var item = e.target.closest("[data-nav]");
      if (!item) return;
      current = item.getAttribute("data-nav");
      render();
    });

    // action clicks in main (delegated)
    byId("main").addEventListener("click", function (e) {
      var b = e.target.closest("[data-action]");
      if (!b || b.disabled) return;
      doAction(b.getAttribute("data-action"), b.getAttribute("data-arg") || undefined, b);
    });

    byId("liveToggle").addEventListener("click", function () { setLive(!live); });
    byId("refreshBtn").addEventListener("click", function () { fetchState(true); });

    tickClock();
    setInterval(tickClock, 1000);

    // initial load
    fetchState(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
