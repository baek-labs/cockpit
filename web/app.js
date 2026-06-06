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
    { id: "git",        label: "Git",        icon: "⎇" },
    { id: "operations", label: "Operations", icon: "⌁" }
  ];

  var current = "overview";
  var live = false;
  var pollTimer = null;
  var lastState = null;
  var inFlight = false;

  // Operations (Phase 2) state
  var opsMounted = false;     // is the Operations shell currently in #main?
  var jobsTimer = null;       // GET /api/jobs every 2s
  var consoleTimer = null;    // GET /api/jobs/:id every 1.5s while running
  var opsSelectedJob = null;  // currently focused job id
  var lockSelectValue = "";   // preserve lock-workspace <select> across re-render
  var runningJobs = 0;        // for nav badge

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
  // Visualization helpers (inline SVG, zero-dependency, zero-asset)
  // ----------------------------------------------------------------
  // Hex palette mirror of CSS vars — SVG presentation attributes can't
  // resolve var(), so charts use literals (HTML legend swatches use var()).
  var COL = {
    cyan: "#22d3ee", teal: "#34d399", amber: "#f59e0b", red: "#ef4444",
    violet: "#a78bfa", text: "#cbd5e1", muted: "#64748b",
    track: "#111a2e", read: "#475569", other: "#334155"
  };

  var _uid = 0;
  function uid(p) { return (p || "v") + "_" + (++_uid); }

  function hashStr(s) {
    var h = 0; s = String(s || "");
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  // Segmented donut. segments:[{value,color}]. opts:{size,stroke,center,centerSub,centerColor,centerSize}
  function svgDonut(segments, opts) {
    opts = opts || {};
    var size = opts.size || 132, sw = opts.stroke || 15;
    var r = (size - sw) / 2, cx = size / 2, cy = size / 2;
    var C = 2 * Math.PI * r, total = 0, i;
    for (i = 0; i < segments.length; i++) total += Math.max(0, segments[i].value || 0);
    var track = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + COL.track + '" stroke-width="' + sw + '"/>';
    var segs = "", off = 0;
    if (total > 0) {
      for (i = 0; i < segments.length; i++) {
        var v = Math.max(0, segments[i].value || 0);
        if (!v) continue;
        var len = (v / total) * C;
        segs += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + segments[i].color +
          '" stroke-width="' + sw + '" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) +
          '" stroke-dashoffset="' + (-off).toFixed(2) + '"/>';
        off += len;
      }
    }
    var ring = '<g transform="rotate(-90 ' + cx + ' ' + cy + ')">' + track + segs + '</g>';
    var center = "";
    if (opts.center != null) {
      center += '<text x="' + cx + '" y="' + (cy + (opts.centerSub ? -1 : 5)) + '" text-anchor="middle" class="svg-num" ' +
        'style="font-size:' + (opts.centerSize || 26) + 'px;font-weight:700" fill="' + (opts.centerColor || COL.text) + '">' + esc(opts.center) + '</text>';
      if (opts.centerSub)
        center += '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" ' +
          'style="font-size:8.5px;letter-spacing:1.5px" fill="' + COL.muted + '">' + esc(opts.centerSub) + '</text>';
    }
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' + ring + center + '</svg>';
  }

  // Filled area sparkline that stretches to its container width.
  function svgArea(values, opts) {
    opts = opts || {};
    var W = 560, H = opts.height || 96, pad = 8, n = values.length;
    if (!n) return '<div class="muted" style="padding:28px 0;text-align:center">no activity in range</div>';
    var maxV = 1, i;
    for (i = 0; i < n; i++) if (values[i] > maxV) maxV = values[i];
    var id = uid("area");
    function X(k) { return n === 1 ? W / 2 : (k / (n - 1)) * (W - 2 * pad) + pad; }
    function Y(v) { return H - pad - (v / maxV) * (H - 2 * pad); }
    var line = "", k;
    for (k = 0; k < n; k++) line += (k === 0 ? "M" : "L") + X(k).toFixed(1) + "," + Y(values[k]).toFixed(1) + " ";
    var area = line + "L" + X(n - 1).toFixed(1) + "," + (H - pad) + " L" + X(0).toFixed(1) + "," + (H - pad) + " Z";
    return '<svg class="areachart" width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="rgba(34,211,238,0.40)"/>' +
      '<stop offset="1" stop-color="rgba(34,211,238,0)"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + id + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + COL.cyan + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // Deterministic monogram avatar (gradient from name hash + role-colored ring).
  function svgAvatar(name, opts) {
    opts = opts || {};
    var size = opts.size || 46, h = hashStr(name), hue = h % 360, hue2 = (hue + 38) % 360;
    var id = uid("av"), ring = opts.ring || COL.cyan, txt = initials(name), r = size / 2;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="hsl(' + hue + ',52%,46%)"/>' +
      '<stop offset="1" stop-color="hsl(' + hue2 + ',58%,28%)"/></linearGradient></defs>' +
      '<circle cx="' + r + '" cy="' + r + '" r="' + (r - 1.5) + '" fill="url(#' + id + ')" stroke="' + ring + '" stroke-width="2"/>' +
      '<text x="' + r + '" y="' + r + '" text-anchor="middle" dominant-baseline="central" ' +
      'style="font-size:' + (size * 0.34) + 'px;font-weight:700" fill="#ffffff">' + esc(txt) + '</text></svg>';
  }

  function initials(name) {
    var p = String(name || "?").replace(/[_\-.]/g, " ").trim().split(/\s+/);
    if (p.length === 1) return (p[0] || "?").slice(0, 2).toUpperCase();
    return ((p[0][0] || "") + (p[p.length - 1][0] || "")).toUpperCase();
  }

  var ROLE_COLORS = {
    CFO: COL.teal, CSO: COL.cyan, CBO: COL.violet, CTO: COL.amber,
    MARKETER: COL.teal, COO: COL.cyan, HAMES: COL.cyan
  };
  function roleColor(name, lvl2) {
    var key = String(name || "").toUpperCase().split("_")[0];
    return ROLE_COLORS[key] || (lvl2 ? COL.teal : COL.cyan);
  }

  // Bucket the session feed into N bins, auto-spanning the window it covers.
  function activityBuckets(feed, nb) {
    nb = nb || 28;
    var f = arr(feed), times = [], i, d;
    for (i = 0; i < f.length; i++) { d = parseTs(f[i] && f[i].ts); if (d) times.push(d.getTime()); }
    var b = []; for (i = 0; i < nb; i++) b.push(0);
    if (!times.length) return { buckets: b, span: null };
    var now = Date.now(), minT = times[0];
    for (i = 1; i < times.length; i++) if (times[i] < minT) minT = times[i];
    var span = Math.max(now - minT, 60000);
    for (i = 0; i < times.length; i++) {
      var idx = Math.floor(((times[i] - minT) / span) * nb);
      if (idx < 0) idx = 0;
      if (idx >= nb) idx = nb - 1;
      b[idx]++;
    }
    return { buckets: b, span: humanSpan(span) };
  }

  function humanSpan(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + "m";
    var hr = Math.floor(m / 60), rm = m % 60;
    if (hr < 24) return hr + "h" + (rm ? " " + rm + "m" : "");
    return Math.round(hr / 24) + "d";
  }

  function toolMix(feed) {
    var m = { write: 0, edit: 0, bash: 0, read: 0, task: 0, other: 0 }, f = arr(feed), i, c;
    for (i = 0; i < f.length; i++) {
      c = toolClass(f[i] && f[i].tool);
      if (c === "t-write") m.write++;
      else if (c === "t-edit") m.edit++;
      else if (c === "t-bash") m.bash++;
      else if (c === "t-read") m.read++;
      else if (c === "t-task") m.task++;
      else m.other++;
    }
    return m;
  }

  function legRow(color, label, value) {
    return '<div class="leg-row"><span class="sw" style="background:' + color + '"></span>' +
      '<span class="ln">' + esc(label) + '</span><span class="lv">' + esc(value) + '</span></div>';
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
      case "operations": return runningJobs || null;
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
      return '<div class="op ' + tc + '">' +
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
    var feed = arr(s.sessionFeed);
    var h = "";

    h += viewHead("Command Overview", "operational snapshot of the Hames system",
      '<button class="btn" data-action="git.fetch">⟱ git fetch</button>');

    // ---- HERO: harness gauge · activity area · tool-mix donut ----
    var hd = k.harness || {};
    var pass = hd.PASS || 0, blocked = hd.BLOCKED || 0, bypass = hd.BYPASS || 0;
    var hTotal = pass + blocked + bypass;
    var passPct = hTotal ? Math.round((pass / hTotal) * 100) : 0;
    var gaugeColor = blocked ? COL.red : (bypass ? COL.amber : COL.teal);

    h += '<div class="hero">';

    // card 1 — harness health gauge
    h += '<div class="card"><div class="card-title">Harness Health' +
      '<span class="ct-aux">' + num(hTotal) + ' checks</span></div>' +
      '<div class="gauge">' +
        svgDonut(
          [{ value: pass, color: COL.teal }, { value: blocked, color: COL.red }, { value: bypass, color: COL.amber }],
          { center: passPct + "%", centerSub: "PASS RATE", centerColor: gaugeColor, size: 122, stroke: 14 }
        ) +
        '<div class="leg">' +
          legRow("var(--teal)", "Pass", num(pass)) +
          legRow("var(--red)", "Blocked", num(blocked)) +
          legRow("var(--amber)", "Bypass", num(bypass)) +
        '</div>' +
      '</div></div>';

    // card 2 — activity area chart + mini stats
    var ab = activityBuckets(feed, 28);
    h += '<div class="card"><div class="card-title">Activity' +
      '<span class="ct-aux">' + (ab.span ? "last " + esc(ab.span) : "no data") + '</span></div>' +
      svgArea(ab.buckets, { height: 92 }) +
      '<div class="minstat-row">' +
        '<div class="minstat"><span class="v good">' + num(k.actionsToday || 0) + '</span><span class="l">Actions Today</span></div>' +
        '<div class="minstat"><span class="v cyan">' + num(feed.length) + '</span><span class="l">Recent Ops</span></div>' +
        '<div class="minstat"><span class="v">' + num(k.lockedSessions || 0) + '</span><span class="l">Locked Sessions</span></div>' +
        '<div class="minstat"><span class="v">' + num(k.workspaceCount || 0) + '</span><span class="l">Workspaces</span></div>' +
      '</div></div>';

    // card 3 — tool-mix donut
    var tm = toolMix(feed);
    h += '<div class="card"><div class="card-title">Tool Mix</div>' +
      '<div class="donut">' +
        svgDonut(
          [
            { value: tm.write, color: COL.cyan }, { value: tm.edit, color: COL.teal },
            { value: tm.bash, color: COL.amber }, { value: tm.read, color: COL.read },
            { value: tm.task, color: COL.violet }, { value: tm.other, color: COL.other }
          ],
          { center: num(feed.length), centerSub: "OPS", size: 104, stroke: 13 }
        ) +
        '<div class="leg">' +
          legRow("var(--cyan)", "Write", num(tm.write)) +
          legRow("var(--teal)", "Edit", num(tm.edit)) +
          legRow("var(--amber)", "Bash", num(tm.bash)) +
          legRow("#475569", "Read", num(tm.read)) +
        '</div>' +
      '</div></div>';

    h += '</div>'; // .hero

    // ---- Workspace activity ranked bars ----
    h += '<div class="card"><div class="card-title">Workspace Activity' +
      '<span class="ct-aux">by session-log actions</span></div>';
    if (!ws.length) {
      h += emptyBox("◇", "No workspaces yet",
        "This looks like a fresh public install. Add a <code>workspace_paths.json</code> registry or " +
        "<code>workspaces/*/CLAUDE.md</code> folders and they'll appear here automatically.");
    } else {
      var sorted = ws.slice().sort(function (a, b) { return ((b && b.actions) || 0) - ((a && a.actions) || 0); });
      var top = sorted.slice(0, 8);
      var maxA = (top[0] && top[0].actions) || 1;
      h += '<div class="rbars">';
      top.forEach(function (w) {
        w = w || {};
        var pct = Math.round(((w.actions || 0) / maxA) * 100);
        var lk = w.locked ? ' <span class="lk" title="locked">🔒</span>' : "";
        h += '<div class="rbar">' +
          '<div class="rbar-label">' + esc(w.name || "?") + lk + '</div>' +
          '<div class="rbar-track"><div class="rbar-fill" style="width:' + Math.max(pct, 2) + '%"></div></div>' +
          '<div class="rbar-val">' + num(w.actions || 0) + '</div>' +
        '</div>';
      });
      h += '</div>';
      if (sorted.length > top.length)
        h += '<div class="rbar-more">+' + num(sorted.length - top.length) + ' more in <strong>Workspaces</strong></div>';
    }
    h += '</div>';

    // ---- Recent activity (compact) ----
    var recent = feed.slice(0, 6);
    h += '<div class="panel section-gap"><div class="panel-title">Recent Activity</div>';
    if (!recent.length) {
      h += '<div class="muted">No recent activity recorded.</div>';
    } else {
      h += '<table class="tbl"><thead><tr><th>Tool</th><th>Workspace</th><th>File</th><th>When</th></tr></thead><tbody>';
      recent.forEach(function (op) {
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

  // ----------------------------------------------------------------
  // Section: Workspaces
  // ----------------------------------------------------------------
  function lockControl(ws) {
    // workspace <select> + Lock/Unlock — un-gated direct safe writes (Phase 2)
    var opts = ws.map(function (w) {
      var name = (w && w.name) || "";
      var sel = (name === lockSelectValue) ? " selected" : "";
      return '<option value="' + esc(name) + '"' + sel + ">" + esc(name) + "</option>";
    }).join("");
    return '<span class="lockctl">' +
      '<select id="lockWsSelect" class="ipt-sel" aria-label="workspace to lock">' +
        '<option value="">— workspace —</option>' + opts +
      "</select>" +
      '<button class="btn" data-action="lock">🔒 Lock</button>' +
      '<button class="btn" data-action="unlock">Unlock</button>' +
      "</span>";
  }

  function renderWorkspaces(s) {
    var ws = arr(s.workspaces);
    var h = viewHead("Workspaces", num(ws.length) + " registered", ws.length ? lockControl(ws) : "");
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
      var nm = ag.name || "?";
      h += '<div class="agent-card' + (lvl2 ? " lvl2" : "") + '">' +
        '<span class="avatar">' + svgAvatar(nm, { ring: roleColor(nm, lvl2), size: 46 }) + "</span>" +
        '<div class="agent-body">' +
          '<div class="agent-name">' + esc(nm) +
            '<span class="agent-file">' + esc(ag.file || "") + "</span></div>" +
          '<div class="agent-desc">' + esc(ag.description || "—") + "</div>" +
          '<div class="agent-role">' + (lvl2 ? "Specialist" : "Domain Lead") + "</div>" +
        "</div></div>";
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

    var pass = hd.PASS || 0, blocked = hd.BLOCKED || 0, bypass = hd.BYPASS || 0;
    var total = pass + blocked + bypass;
    var passPct = total ? Math.round((pass / total) * 100) : 0;
    var gaugeColor = blocked ? COL.red : (bypass ? COL.amber : COL.teal);
    function pctOf(v) { return total ? Math.round((v / total) * 100) + "%" : "0%"; }

    h += '<div class="hero" style="grid-template-columns:minmax(250px,310px) 1fr">';
    // gauge
    h += '<div class="card"><div class="card-title">Result Distribution' +
      '<span class="ct-aux">' + num(total) + ' checks</span></div>' +
      '<div class="gauge">' +
        svgDonut(
          [{ value: pass, color: COL.teal }, { value: blocked, color: COL.red }, { value: bypass, color: COL.amber }],
          { center: passPct + "%", centerSub: "PASS RATE", centerColor: gaugeColor, size: 144, stroke: 16 }
        ) +
        '<div class="leg">' +
          legRow("var(--teal)", "Pass", num(pass) + " · " + pctOf(pass)) +
          legRow("var(--red)", "Blocked", num(blocked) + " · " + pctOf(blocked)) +
          legRow("var(--amber)", "Bypass", num(bypass) + " · " + pctOf(bypass)) +
        '</div>' +
      '</div></div>';
    // volume bars
    var maxV = Math.max(pass, blocked, bypass, 1);
    h += '<div class="card"><div class="card-title">Volume</div>';
    h += hRow("PASS", pass, maxV, "pass");
    h += hRow("BLOCKED", blocked, maxV, "blocked");
    h += hRow("BYPASS", bypass, maxV, "bypass");
    h += "</div></div>";

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

    // Routed Actions — save/pull remain gated under safe/advisory mode
    h += '<div class="panel section-gap"><div class="panel-title">Routed Actions</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      gatedBtn("save") + gatedBtn("pull") +
      "</div>" +
      '<div class="muted" style="margin-top:10px">' +
        "<code>save</code> / <code>pull</code> require full-autonomous mode (not enabled). " +
        "Lock / Unlock live in <strong>Workspaces</strong>; agent spawn lives in <strong>Operations</strong>." +
      "</div>" +
      "</div>";
    return h;
  }

  function gitKv(k, v) {
    return '<div class="git-kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
  }

  function gatedBtn(type) {
    return '<button class="btn" disabled title="requires full-autonomous mode (not enabled)">' +
      esc(type) + ' <span class="phase2">gated</span></button>';
  }

  // ----------------------------------------------------------------
  // Section: Operations (Phase 2) — spawn / jobs / live console
  // The shell is mounted ONCE on entry; sub-regions (#jobsList, #opsConsole)
  // are refreshed by their own pollers so the form/console survive state polls.
  // ----------------------------------------------------------------
  function mountOperations() {
    var s = lastState || {};
    var l1 = arr(s.agents && s.agents.level1);
    var agentOpts = '<option value="COO" selected>COO (default · prompt as-is)</option>';
    l1.forEach(function (ag) {
      var n = (ag && ag.name) || "";
      if (!n || n === "COO") return;
      agentOpts += '<option value="' + esc(n) + '">' + esc(n) + "</option>";
    });

    var html =
      '<div id="opsRoot">' +
      viewHead("Operations", "spawn read-only Hames agents · live job console",
        '<span class="badge ok" title="safe / advisory mode">SAFE MODE · read-only spawns</span>') +
      '<div class="ops-layout">' +
        // left column: spawn form + jobs list
        '<div class="ops-left">' +
          '<div class="panel"><div class="panel-title">Spawn Agent</div>' +
            '<label class="ipt-label">Agent</label>' +
            '<select id="spawnAgent" class="ipt-sel ipt-full">' + agentOpts + "</select>" +
            '<label class="ipt-label">Task / prompt</label>' +
            '<textarea id="spawnPrompt" class="ipt-area" rows="5" ' +
              'placeholder="Describe the analysis. The agent can only Read/Grep/Glob/WebSearch and reason — it cannot write, run shell, or spawn subagents."></textarea>' +
            '<div class="ops-form-foot">' +
              '<span class="muted">Runs under the Hames harness · read-only</span>' +
              '<button class="btn btn-open" data-ops="launch">▶ Launch</button>' +
            "</div>" +
          "</div>" +
          '<div class="panel section-gap" style="padding:0">' +
            '<div class="panel-title" style="padding:14px 14px 8px">Jobs</div>' +
            '<div id="jobsList"><div class="muted" style="padding:0 14px 14px">Loading…</div></div>' +
          "</div>" +
        "</div>" +
        // right column: live console
        '<div class="ops-right">' +
          '<div class="panel ops-console-panel">' +
            '<div class="panel-title">Job Console</div>' +
            '<div id="opsConsole" class="ops-console">' +
              '<div class="muted">Select a job or launch an agent to stream its output here.</div>' +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div></div>";

    byId("main").innerHTML = html;

    // single delegated handler for the (stable) ops shell
    var root = byId("opsRoot");
    root.addEventListener("click", function (e) {
      var launch = e.target.closest('[data-ops="launch"]');
      if (launch) { launchSpawn(); return; }
      var stop = e.target.closest('[data-ops="stop"]');
      if (stop) { stopJob(stop.getAttribute("data-job")); return; }
      var row = e.target.closest("[data-job]");
      if (row && !stop) { selectJob(row.getAttribute("data-job")); return; }
    });

    refreshJobs(); // immediate paint
    if (opsSelectedJob) { renderSelectedJobShell(); pollConsoleOnce(true); } // restore console on re-entry
  }

  function startOpsTimers() {
    stopOpsTimers();
    jobsTimer = setInterval(refreshJobs, 2000);
  }

  function stopOpsTimers() {
    if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = null; }
    stopConsoleTimer();
  }

  function stopConsoleTimer() {
    if (consoleTimer) { clearInterval(consoleTimer); consoleTimer = null; }
  }

  // -- jobs list -------------------------------------------------------------
  function refreshJobs() {
    fetch("/api/jobs", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : { jobs: [] }; })
      .then(function (d) { renderJobsList(arr(d && d.jobs)); })
      .catch(function () { /* leave previous list */ });
  }

  function statusBadge(st) {
    var s = String(st || "").toLowerCase();
    if (s === "running") return '<span class="badge run">● RUNNING</span>';
    if (s === "done") return '<span class="badge ok">✓ DONE</span>';
    if (s === "error") return '<span class="badge miss">✗ ERROR</span>';
    return '<span class="badge">' + esc(st || "?") + "</span>";
  }

  function renderJobsList(jobs) {
    var el = byId("jobsList");
    if (!el) return;
    runningJobs = jobs.filter(function (j) { return j && j.status === "running"; }).length;
    // refresh the Operations nav badge with the live running count
    var navBadge = document.querySelector('[data-nav="operations"] .nav-badge');
    if (navBadge) navBadge.textContent = num(runningJobs);

    if (!jobs.length) {
      el.innerHTML = '<div class="muted" style="padding:0 14px 14px">No jobs yet. Launch an agent to begin.</div>';
      return;
    }
    var html = jobs.map(function (j) {
      j = j || {};
      var active = (j.id === opsSelectedJob) ? " active" : "";
      var label = j.agent || j.label || j.kind || "job";
      return '<div class="job-row' + active + '" data-job="' + esc(j.id) + '">' +
        '<div class="job-row-top">' +
          '<span class="tag t-task">' + esc(label) + "</span>" +
          statusBadge(j.status) +
          '<span class="job-time mono">' + (j.startedAt ? relTime(j.startedAt) : "") + "</span>" +
        "</div>" +
        '<div class="job-summary">' + esc(j.summary || "—") + "</div>" +
      "</div>";
    }).join("");
    el.innerHTML = html;
  }

  // -- console ---------------------------------------------------------------
  function selectJob(id) {
    if (!id) return;
    opsSelectedJob = id;
    stopConsoleTimer();
    renderSelectedJobShell();
    refreshJobs();           // re-highlight active row
    pollConsoleOnce(true);   // immediate fetch; starts timer if still running
  }

  function renderSelectedJobShell() {
    var el = byId("opsConsole");
    if (el) el.innerHTML = '<div class="muted">Loading job ' + esc(opsSelectedJob) + " …</div>";
  }

  function pollConsoleOnce(startTimer) {
    var id = opsSelectedJob;
    if (!id) return;
    fetch("/api/jobs/" + encodeURIComponent(id), { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (r.status === 404) throw new Error("job not found");
        return r.json();
      })
      .then(function (job) {
        if (opsSelectedJob !== id) return; // selection changed mid-flight
        renderConsole(job || {});
        if (job && job.status === "running") {
          if (startTimer && !consoleTimer) {
            consoleTimer = setInterval(function () { pollConsoleOnce(false); }, 1500);
          }
        } else {
          stopConsoleTimer(); // terminal state → stop polling
        }
      })
      .catch(function (err) {
        if (opsSelectedJob !== id) return;
        stopConsoleTimer();
        var el = byId("opsConsole");
        if (el) el.innerHTML = emptyBox("⚠", "Console error", esc(String(err && err.message || err)));
      });
  }

  function renderConsole(job) {
    var el = byId("opsConsole");
    if (!el) return;
    var prevScroll = el.scrollTop;
    var atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;

    var events = arr(job.events);
    var running = job.status === "running";
    var label = job.agent || job.kind || "job";

    var head = '<div class="console-head">' +
      '<div class="console-head-l">' +
        '<span class="tag t-task">' + esc(label) + "</span>" +
        statusBadge(job.status) +
        (running ? '<span class="spinner" aria-hidden="true"></span>' : "") +
      "</div>" +
      '<div class="console-head-r">' +
        (job.startedAt ? '<span class="mono muted">' + esc(job.startedAt) + "</span>" : "") +
        (running ? '<button class="btn btn-stop" data-ops="stop" data-job="' + esc(job.id) + '">■ Stop</button>' : "") +
      "</div>" +
    "</div>";

    var prompt = job.prompt ? '<div class="console-prompt"><span class="cp-label">PROMPT</span>' + esc(job.prompt) + "</div>" : "";

    var body = "";
    if (!events.length) {
      body = '<div class="muted">' + (running ? "Awaiting first event…" : "No events.") + "</div>";
    } else {
      body = events.map(function (ev) { return renderEvent(ev || {}); }).join("");
    }

    el.innerHTML = head + prompt + '<div class="console-events">' + body + "</div>";

    // autoscroll to newest while running and user was at bottom; else preserve
    if (running && atBottom) el.scrollTop = el.scrollHeight;
    else el.scrollTop = prevScroll;
  }

  function renderEvent(ev) {
    var t = ev.t;
    if (t === "text") {
      return '<div class="ev ev-text">' + esc(ev.text || "") + "</div>";
    }
    if (t === "tool") {
      return '<div class="ev ev-tool"><span class="tag ' + toolClass(ev.tool) + '">⚙ ' + esc(ev.tool || "tool") + "</span>" +
        '<span class="ev-brief">' + esc(ev.brief || "") + "</span></div>";
    }
    if (t === "result") {
      return '<div class="ev ev-result ' + (ev.isError ? "err" : "ok") + '">' +
        '<span class="ev-rlabel">' + (ev.isError ? "RESULT · ERROR" : "RESULT") + "</span>" +
        esc(ev.text || "") + "</div>";
    }
    if (t === "error") {
      return '<div class="ev ev-err">' + esc(ev.text || "") + "</div>";
    }
    // system or unknown → muted
    return '<div class="ev ev-sys">' + esc(ev.text || (t ? ("[" + t + "]") : "")) + "</div>";
  }

  // -- launch / stop ---------------------------------------------------------
  function launchSpawn() {
    var agentEl = byId("spawnAgent"), promptEl = byId("spawnPrompt");
    var agent = agentEl ? agentEl.value : "COO";
    var prompt = promptEl ? promptEl.value.trim() : "";
    if (!prompt) { setMsg("enter a task prompt before launching", "warn"); if (promptEl) promptEl.focus(); return; }
    if (!window.confirm("Launch an autonomous Hames agent? It runs under the harness.")) return;

    setMsg("spawning " + agent + " …", "");
    fetch("/api/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent, prompt: prompt })
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false, reason: "bad response" }; }); })
      .then(function (res) {
        res = res || {};
        if (res.ok && res.jobId) {
          setMsg("✓ spawned " + agent + " → " + res.jobId, "ok");
          if (promptEl) promptEl.value = "";
          selectJob(res.jobId);
        } else {
          setMsg("✗ spawn rejected: " + (res.reason || res.message || "unknown"), "err");
        }
      })
      .catch(function (err) { setMsg("✗ spawn error: " + (err && err.message || err), "err"); });
  }

  function stopJob(id) {
    if (!id) return;
    if (!window.confirm("Stop this running job?")) return;
    setMsg("stopping " + id + " …", "");
    fetch("/api/jobs/" + encodeURIComponent(id) + "/stop", { method: "POST" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (res) {
        setMsg((res && res.ok) ? "✓ stop signalled" : "stop failed", (res && res.ok) ? "ok" : "err");
        pollConsoleOnce(false);
        refreshJobs();
      })
      .catch(function (err) { setMsg("✗ stop error: " + (err && err.message || err), "err"); });
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

    if (current === "operations") {
      // Operations owns its own DOM + pollers; mount the shell once and leave it
      // alone on subsequent state polls so the form/console aren't wiped.
      if (!opsMounted) {
        try { mountOperations(); opsMounted = true; startOpsTimers(); }
        catch (e) { mainEl.innerHTML = emptyBox("⚠", "Render error", esc(String(e && e.message || e))); }
      }
    } else {
      var fn = RENDERERS[current] || renderOverview;
      try {
        mainEl.innerHTML = fn(s);
      } catch (e) {
        mainEl.innerHTML = emptyBox("⚠", "Render error", esc(String(e && e.message || e)));
      }
      // restore scroll (operations manages its own)
      if (mainEl) mainEl.scrollTop = mainScroll;
    }

    if (railEl) byId("railFeed").scrollTop = railScroll;

    renderStatus(s);
  }

  function setSection(id) {
    if (id === current) return;
    if (current === "operations") { stopOpsTimers(); opsMounted = false; }
    current = id;
    render();
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
      setSection(item.getAttribute("data-nav"));
    });

    // action clicks in main (delegated). Operations uses data-ops, not data-action.
    byId("main").addEventListener("click", function (e) {
      var b = e.target.closest("[data-action]");
      if (!b || b.disabled) return;
      var action = b.getAttribute("data-action");
      if (action === "lock") {
        var sel = byId("lockWsSelect");
        var ws = sel ? sel.value : "";
        if (!ws) { setMsg("select a workspace to lock", "warn"); return; }
        lockSelectValue = ws;
        doAction("lock", ws, b);
        return;
      }
      if (action === "unlock") { doAction("unlock", undefined, b); return; }
      doAction(action, b.getAttribute("data-arg") || undefined, b);
    });

    // remember the lock-workspace selection across state-driven re-renders
    byId("main").addEventListener("change", function (e) {
      if (e.target && e.target.id === "lockWsSelect") lockSelectValue = e.target.value;
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
