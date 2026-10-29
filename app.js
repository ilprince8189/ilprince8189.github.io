/* SEGARA PMO — installable app (Dashboard, Input, Admin).
 * Talks to the Apps Script back end with a Google ID token. No framework: render functions build HTML from state. */
(function () {
  'use strict';
  var CFG = window.SEGARA_CONFIG || {};
  var DEMO = !!CFG.DEMO || /[?&]demo\b/.test(location.search);
  var STATUSES = ['Not Started', 'In Progress', 'Completed', 'On Hold', 'Blocked'];
  var PRIOS = ['High', 'Medium', 'Low'];
  var HEALTH = ['Overdue', 'Blocked', 'At Risk', 'Late Start', 'On Track', 'On Hold', 'Done'];
  var PALETTE = ['#BF8F00', '#2E75B6', '#548235', '#D6337D', '#008080', '#7F7F7F', '#4472C4', '#ED7D31', '#70AD47', '#7030A0', '#0E7FA8', '#C00000'];
  var DAY = 86400000;
  var ROLE_HINT = { Viewer: 'Sees the dashboard only.', Editor: 'Updates, adds and deletes sub-activities and risks in the streams ticked below.', Admin: 'Changes everything, including streams and access.' };
  var LS = { token: 'segara.idtoken.v1', cache: 'segara.cache.v1', filters: 'segara.filters.v1' };

  var MODES = {
    dashboard: { label: 'Dashboard', tabs: [['overview', 'Overview'], ['list', 'Sub-activities'], ['timeline', 'Timeline'], ['risks', 'Risks and issues']] },
    input: { label: 'Input', roles: ['Admin', 'Editor'], tabs: [['update', 'Weekly update'], ['activity', 'Add or edit sub-activity'], ['streams', 'Streams'], ['riskform', 'Risks and issues'], ['mylog', 'Change log', ['Editor']]] },
    admin: { label: 'Admin', roles: ['Admin'], tabs: [['users', 'Users'], ['log', 'Change log'], ['deleted', 'Deleted items'], ['settings', 'Settings']] }
  };

  var S = {
    auth: null, me: null, settings: { threshold: 0.2, appName: 'SEGARA PMO' }, streams: [], acts: [], risks: [], users: [],
    loaded: false, offline: false, busy: false, lastSync: null, err: null, signinMsg: '',
    mode: 'dashboard', tab: 'overview',
    f: { stream: '', status: '', health: '', owner: '', q: '', done: false },
    edits: {}, saved: {}, sel: { act: null, stream: null, risk: null, user: null }, preset: { stream: null },
    msgs: {}, log: null, logQ: '', deleted: null, detail: null, confirm: null, draft: {}
  };

  /* ---------------- helpers ---------------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : ''; }
  function todayIso() { return iso(new Date()); }
  function addDays(s, n) { var d = new Date(Date.parse(s) + n * DAY); return d.toISOString().slice(0, 10); }
  function shortD(s) {
    if (!s) return '—';
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(s.slice(8, 10)) + ' ' + m[Number(s.slice(5, 7)) - 1] + ' ' + s.slice(2, 4);
  }
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[%,]/g, '')); return isNaN(n) ? 0 : n; }
  function clampPct(v) { return Math.max(0, Math.min(100, Math.round(num(v)))); }
  function streamOf(no) { for (var i = 0; i < S.streams.length; i++) if (S.streams[i].no === String(no)) return S.streams[i]; return null; }
  function colorOf(no) { var s = streamOf(no); return s ? s.color : '#7A8A90'; }
  function initials(s) { return (String(s || '?').trim()[0] || '?').toUpperCase(); }
  function val(id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function toast(m) { var t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3600); }

  /* Same rules as the back end and the sheet formulas. */
  function health(a) {
    if (!a.name) return '';
    if (a.status === 'Completed') return 'Done';
    if (a.status === 'Blocked') return 'Blocked';
    if (a.status === 'On Hold') return 'On Hold';
    var t = todayIso();
    if (a.end && a.end < t) return 'Overdue';
    if (a.status === 'Not Started' && a.start && a.start < t) return 'Late Start';
    if (a.start && a.end) {
      var plan = Math.max(0, Math.min(1, (Date.parse(t) - Date.parse(a.start) + DAY) / (Date.parse(a.end) - Date.parse(a.start) + DAY)));
      if ((a.pct || 0) / 100 < plan - S.settings.threshold) return 'At Risk';
    }
    return 'On Track';
  }
  function severity(i, l) {
    if (!i || !l) return '';
    if ((i === 'High' && l !== 'Low') || (l === 'High' && i !== 'Low')) return 'Critical';
    if (i === 'High' || l === 'High' || (i === 'Medium' && l === 'Medium')) return 'Elevated';
    return 'Low';
  }
  function hPill(h) { var c = { Overdue: 'solidbad', Blocked: 'bad', 'At Risk': 'warn', 'Late Start': 'warn', 'On Track': 'good', Done: 'good' }[h] || ''; return h ? '<span class="pill ' + c + '">' + esc(h) + '</span>' : ''; }
  function sPill(s) { var c = { Completed: 'good', 'In Progress': 'info', Blocked: 'bad' }[s] || ''; return '<span class="pill ' + c + '">' + esc(s || '—') + '</span>'; }
  function sevPill(s) { var c = { Critical: 'solidbad', Elevated: 'warn', Low: 'good' }[s] || ''; return s ? '<span class="pill ' + c + '">' + esc(s) + '</span>' : ''; }
  function sel(id, list, v, extra) {
    return '<select id="' + id + '" ' + (extra || '') + '>' + list.map(function (o) {
      var ov = o && o.v !== undefined ? o.v : o, ol = o && o.l !== undefined ? o.l : o;
      return '<option value="' + esc(ov) + '"' + (String(ov) === String(v == null ? '' : v) ? ' selected' : '') + '>' + esc(ol) + '</option>';
    }).join('') + '</select>';
  }
  function field(id, label, html, cls) { return '<div class="field ' + (cls || '') + '"><label for="' + id + '">' + label + '</label>' + html + '</div>'; }
  function role() { return S.me ? S.me.role : 'Viewer'; }
  function isAdmin() { return role() === 'Admin'; }
  function canEdit(no) { return isAdmin() || (role() === 'Editor' && S.me.streams.indexOf(String(no)) > -1); }
  function editableStreams() { return S.streams.filter(function (s) { return canEdit(s.no); }); }
  function streamOpts(list) { return (list || S.streams).map(function (s) { return { v: s.no, l: s.no + '. ' + s.name }; }); }
  function stats(list) {
    var o = { total: list.length, done: 0, prog: 0, blocked: 0, hold: 0, ns: 0, overdue: 0, risk: 0, sum: 0 };
    list.forEach(function (a) {
      if (a.status === 'Completed') o.done++; else if (a.status === 'In Progress') o.prog++; else if (a.status === 'Blocked') o.blocked++; else if (a.status === 'On Hold') o.hold++; else o.ns++;
      if (a.health === 'Overdue') o.overdue++;
      if (a.health === 'At Risk' || a.health === 'Late Start') o.risk++;
      o.sum += a.pct || 0;
    });
    o.avg = o.total ? o.sum / o.total : 0;
    return o;
  }
  function nextActId(no) {
    var max = 0;
    S.acts.forEach(function (a) { var p = a.id.split('.'); if (p[0] === String(no)) max = Math.max(max, parseInt(p[1], 10) || 0); });
    return no + '.' + (max + 1);
  }

  /* ---------------- auth ---------------- */
  function decodeJwt(t) {
    try { var p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(p)))); } catch (e) { return null; }
  }
  function tokenValid(a) { return a && a.token && a.exp * 1000 > Date.now() + 60000; }
  function onCredential(resp) {
    var c = decodeJwt(resp.credential);
    if (!c) { S.signinMsg = 'Google sign-in did not return a valid answer. Try again.'; render(); return; }
    S.auth = { token: resp.credential, exp: c.exp, email: String(c.email || '').toLowerCase(), name: c.name || c.email, picture: c.picture || '' };
    store(LS.token, S.auth);
    S.signinMsg = '';
    start();
  }
  function whenGis(cb, tries) {
    tries = tries || 0;
    if (window.google && google.accounts && google.accounts.id) return cb();
    if (tries > 100) { S.signinMsg = "Google sign-in didn't load. Check your internet connection and reopen the app."; return render(); }
    setTimeout(function () { whenGis(cb, tries + 1); }, 100);
  }
  var gisReady = false;
  function initGis() {
    if (gisReady) return;
    google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: onCredential, auto_select: true, cancel_on_tap_outside: false, itp_support: true, use_fedcm_for_prompt: true });
    gisReady = true;
  }
  function signOut() {
    store(LS.token, null);
    store(LS.cache, null);
    S.auth = null; S.me = null; S.loaded = false; S.edits = {};
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    render();
  }

  /* ---------------- API ---------------- */
  function api(action, payload) {
    if (DEMO) return window.SEGARA_DEMO.call(action, payload || {}, S.auth);
    if (!tokenValid(S.auth)) return Promise.reject({ code: 'auth', message: 'Your sign-in has expired. Sign in again.' });
    return fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: S.auth.token, action: action, payload: payload || {} }), redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw { code: 'server', message: 'The server answered with an error (' + r.status + ').' }; return r.json(); }, function () { throw { code: 'offline', message: "You're offline or the server can't be reached." }; })
      .then(function (j) { if (!j || j.ok === false) throw j || { code: 'server', message: 'No answer from the server.' }; return j; });
  }
  function handleErr(e, where) {
    if (e && e.code === 'auth') { S.auth = null; store(LS.token, null); S.signinMsg = e.message; render(); return true; }
    if (e && e.code === 'no_access') { S.me = null; S.loaded = false; S.signinMsg = e.message; store(LS.cache, null); render(); return true; }
    if (e && e.code === 'offline') { S.offline = true; }
    if (where) S.msgs[where] = { text: (e && e.message) || 'Something went wrong.' };
    return false;
  }

  function applyData(d) {
    S.me = d.me;
    S.settings = d.settings || S.settings;
    S.streams = (d.streams || []).slice().sort(function (a, b) { return Number(a.no) - Number(b.no); });
    S.acts = (d.activities || []).map(function (a) { a.health = health(a); return a; });
    S.risks = (d.risks || []).map(function (r) { r.sev = severity(r.impact, r.like); return r; });
    S.users = d.users || [];
    S.loaded = true;
  }
  function refresh(quiet) {
    if (!quiet) { S.busy = true; render(); }
    return api('bootstrap').then(function (d) {
      applyData(d);
      S.offline = false; S.err = null; S.lastSync = Date.now(); S.busy = false;
      store(LS.cache, { email: S.auth.email, at: S.lastSync, data: d });
      render();
    }).catch(function (e) {
      S.busy = false;
      if (handleErr(e)) return;
      S.err = e; render();
    });
  }
  function start() {
    var c = load(LS.cache);
    if (c && S.auth && c.email === S.auth.email && c.data) { applyData(c.data); S.lastSync = c.at; }
    readRoute();
    render();
    refresh(S.loaded);
  }
  function write(action, payload, msgKey) {
    if (S.offline && !DEMO) { S.msgs[msgKey] = { text: "You're offline. Changes can't be saved until you're back online." }; render(); return Promise.resolve(null); }
    S.busy = true; S.msgs[msgKey] = null; render();
    return api(action, payload).then(function (r) { S.busy = false; return r; }).catch(function (e) {
      S.busy = false;
      if (handleErr(e, msgKey)) return null;
      if (e && e.code === 'conflict') refresh(true);
      render(); return null;
    });
  }

  /* ---------------- routing ---------------- */
  function allowedMode(m) { var md = MODES[m]; return md && (!md.roles || md.roles.indexOf(role()) > -1); }
  function tabsFor(m) { return MODES[m].tabs.filter(function (t) { return !t[2] || t[2].indexOf(role()) > -1; }); }
  function readRoute() {
    var h = location.hash.replace(/^#\/?/, '').split('/');
    if (h[0] === 'more') { S.mode = 'more'; S.tab = ''; return; }
    var m = MODES[h[0]] ? h[0] : 'dashboard';
    if (S.me && !allowedMode(m)) m = 'dashboard';
    S.mode = m;
    var tabs = tabsFor(m).map(function (t) { return t[0]; });
    S.tab = tabs.indexOf(h[1]) > -1 ? h[1] : tabs[0];
  }
  function go(m, t) { location.hash = '#/' + m + (t ? '/' + t : ''); }
  window.addEventListener('hashchange', function () { readRoute(); S.detail = null; render(); window.scrollTo(0, 0); });

  /* ---------------- shell ---------------- */
  var ICON = {
    dash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    upd: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>',
    risk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z M12 10v4 M12 17v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>'
  };
  function syncText() {
    if (DEMO) return ['busy', 'Demo data'];
    if (S.err && !S.offline) return ['err', 'Not synced'];
    if (S.offline) return ['err', 'Offline' + (S.lastSync ? ', data from ' + hm(S.lastSync) : '')];
    if (S.busy) return ['busy', 'Syncing…'];
    if (S.lastSync) return ['ok', 'Synced ' + hm(S.lastSync)];
    return ['', 'Connecting…'];
  }
  function hm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function render() {
    var app = $('#app');
    if (!S.auth && !DEMO) return renderSignIn(app);
    if (!S.loaded) return renderLoading(app);
    var keep = document.activeElement && document.activeElement.id, pos = null;
    try { pos = document.activeElement && document.activeElement.selectionStart; } catch (e) { pos = null; }
    var st = syncText();
    var modes = Object.keys(MODES).filter(allowedMode);
    var editor = role() !== 'Viewer';
    var nav = [['dashboard/overview', 'Dashboard', ICON.dash, S.mode === 'dashboard']];
    if (editor) { nav.push(['input/update', 'Update', ICON.upd, S.mode === 'input' && S.tab === 'update']); nav.push(['input/activity', 'Add', ICON.add, S.mode === 'input' && S.tab === 'activity']); }
    else nav.push(['dashboard/risks', 'Risks', ICON.risk, false]);
    nav.push(['more', 'More', ICON.more, S.mode === 'more' || S.mode === 'admin' || (S.mode === 'input' && ['update', 'activity'].indexOf(S.tab) < 0)]);
    var tabs = S.mode === 'more' ? [] : tabsFor(S.mode);
    app.innerHTML =
      '<header class="bar"><div class="wrap">' +
        '<div class="bar-row">' +
          '<div class="brand"><div class="logo">S</div><div><b>' + esc(S.settings.appName || 'SEGARA PMO') + '</b><span>' + esc(S.me.role) + (S.me.role === 'Editor' ? ' · streams ' + esc(S.me.streams.join(', ') || 'none') : '') + '</span></div></div>' +
          '<nav class="modes" aria-label="Modes">' + modes.map(function (m) { return '<a href="#/' + m + '"' + (S.mode === m ? ' aria-current="page"' : '') + '>' + MODES[m].label + '</a>'; }).join('') + '</nav>' +
          '<div class="sync sync-wide"><i class="dot ' + st[0] + '"></i><span>' + esc(st[1]) + '</span></div>' +
          '<button class="btn sm" type="button" data-act="refresh" aria-label="Refresh data">Refresh</button>' +
          '<a class="acct acct-wide" href="#/more"><span class="avatar">' + esc(initials(S.me.name || S.me.email)) + '</span><span>' + esc(S.me.name || S.me.email) + '</span></a>' +
        '</div>' +
        (tabs.length ? '<nav class="tabs desk" aria-label="Sections">' + tabs.map(function (t) { return '<a href="#/' + S.mode + '/' + t[0] + '"' + (S.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</a>'; }).join('') + '</nav>' : '') +
      '</div></header>' +
      '<main class="wrap" id="main">' + banner() +
        (tabs.length > 1 ? '<nav class="phone-tabs" aria-label="Sections">' + tabs.map(function (t) { return '<a href="#/' + S.mode + '/' + t[0] + '"' + (S.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</a>'; }).join('') + '</nav>' : '') +
        view() + '</main>' +
      savebar() +
      '<nav class="bottom" aria-label="Main" style="--n:' + nav.length + '">' + nav.map(function (n) { return '<a href="#/' + n[0] + '"' + (n[3] ? ' aria-current="page"' : '') + '>' + n[2] + n[1] + '</a>'; }).join('') + '</nav>' +
      (S.detail ? detailSheet() : '');
    var el = keep ? document.getElementById(keep) : null;
    if (el) { el.focus(); if (pos != null && el.setSelectionRange) { try { el.setSelectionRange(pos, pos); } catch (e) { /* not a text field */ } } }
  }
  function banner() {
    if (DEMO) return '<div class="banner warn"><p><b>Demo mode.</b> Sample data stored only on this device. Nothing is saved to Google Sheets.</p></div>';
    if (S.offline) return '<div class="banner warn"><p>You\'re offline. Showing data from ' + (S.lastSync ? new Date(S.lastSync).toLocaleString() : 'the last visit') + '. Saving is paused until you\'re back online.</p><button class="btn sm" type="button" data-act="refresh">Try again</button></div>';
    if (S.err) return '<div class="banner bad"><p>' + esc(S.err.message || 'Could not load the latest data.') + '</p><button class="btn sm" type="button" data-act="refresh">Try again</button></div>';
    return '';
  }
  function renderLoading(app) {
    if (S.signinMsg) return renderSignIn(app);
    app.innerHTML = '<div class="boot"><div class="logo">S</div><p>Loading the programme…</p></div>';
  }
  function renderSignIn(app) {
    app.innerHTML = '<div class="signin"><div class="signin-card">' +
      '<div class="logo">S</div><h1>SEGARA PMO</h1>' +
      '<p>Track the pawnshop launch: every stream, sub-activity, risk and date in one place.</p>' +
      (S.signinMsg ? '<div class="err" role="alert">' + esc(S.signinMsg) + '</div>' : '') +
      '<div id="gbtn" class="gbtn"></div>' +
      '<div class="note"><b>Invite only.</b> Use the Google account your SEGARA PMO admin added. Company Google and personal Gmail both work.</div>' +
      '</div></div>';
    if (!CFG.CLIENT_ID || /PASTE/.test(CFG.CLIENT_ID)) { $('#gbtn').innerHTML = '<div class="err">The app is not set up yet: add the Google client ID to config.js.</div>'; return; }
    whenGis(function () {
      initGis();
      var w = Math.min(320, $('#gbtn').clientWidth || 300);
      google.accounts.id.renderButton($('#gbtn'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: w });
      if (!S.signinMsg) google.accounts.id.prompt();
    });
  }
  function view() {
    var fn = {
      overview: vOverview, list: vList, timeline: vTimeline, risks: vRisks,
      update: vUpdate, activity: vActivity, streams: vStreams, riskform: vRiskForm, mylog: vLog,
      users: vUsers, log: vLog, deleted: vDeleted, settings: vSettings
    }[S.tab];
    if (S.mode === 'more') return vMore();
    return fn ? fn() : vOverview();
  }

  /* ---------------- Dashboard ---------------- */
  function vOverview() {
    var all = stats(S.acts), t = todayIso(), in14 = addDays(t, 14);
    var attention = S.acts.filter(function (a) { return ['Overdue', 'Blocked', 'At Risk', 'Late Start'].indexOf(a.health) > -1; })
      .sort(function (x, y) { return HEALTH.indexOf(x.health) - HEALTH.indexOf(y.health) || String(x.end).localeCompare(String(y.end)); }).slice(0, 8);
    var due = S.acts.filter(function (a) { return a.status !== 'Completed' && a.end && a.end >= t && a.end <= in14; }).sort(function (x, y) { return x.end.localeCompare(y.end); });
    var starting = S.acts.filter(function (a) { return a.status === 'Not Started' && a.start && a.start >= t && a.start <= in14; }).sort(function (x, y) { return x.start.localeCompare(y.start); });
    var openRisks = S.risks.filter(function (r) { return r.status !== 'Closed'; }).sort(function (a, b) { return ['Critical', 'Elevated', 'Low', ''].indexOf(a.sev) - ['Critical', 'Elevated', 'Low', ''].indexOf(b.sev); });
    var starts = S.acts.map(function (a) { return a.start; }).filter(Boolean).sort(), ends = S.acts.map(function (a) { return a.end; }).filter(Boolean).sort();
    function li(a, right) { return '<button type="button" class="li" data-detail="' + esc(a.id) + '"><span class="swatch" style="background:' + esc(colorOf(a.stream)) + '"></span><span class="t"><div><span class="mono muted">' + esc(a.id) + '</span> ' + esc(a.name) + '</div><div>' + esc(a.owner || 'No owner') + ' · ends ' + shortD(a.end) + '</div></span>' + right + '</button>'; }
    return '<div class="page-head"><h1>Programme overview</h1><span class="hint">' + (starts.length ? shortD(starts[0]) + ' to ' + shortD(ends[ends.length - 1]) : '') + '</span></div>' +
      '<div class="kpis">' +
        kpi('Sub-activities', all.total, '') + kpi('Completed', all.done, 'good') + kpi('In progress', all.prog, '') +
        kpi('Overdue', all.overdue, all.overdue ? 'bad' : '') + kpi('At risk / late', all.risk, all.risk ? 'warn' : '') + kpi('Blocked', all.blocked, all.blocked ? 'bad' : '') +
        kpi('Complete', Math.round(all.avg) + '%', '') +
      '</div>' +
      '<div class="panel-head"><h2>Streams</h2><span class="hint">Tap a stream to see its sub-activities</span></div>' +
      '<div class="streams">' + S.streams.map(function (s) {
        var list = S.acts.filter(function (a) { return a.stream === s.no; }), st = stats(list);
        var sd = list.map(function (a) { return a.start; }).filter(Boolean).sort(), ed = list.map(function (a) { return a.end; }).filter(Boolean).sort();
        return '<a class="scard" href="#/dashboard/list" data-stream="' + esc(s.no) + '"><div class="top"><span class="swatch" style="background:' + esc(s.color) + '"></span>' + esc(s.no) + '. ' + esc(s.name) + '</div>' +
          '<div class="meta"><span>' + st.total + ' sub-activities · ' + esc(s.lead || 'Lead TBD') + '</span><span class="mono">' + Math.round(st.avg) + '%</span></div>' +
          '<div class="track"><i style="width:' + st.avg + '%;background:' + esc(s.color) + '"></i></div>' +
          '<div class="chips">' + (st.done ? '<span class="pill good">' + st.done + ' done</span>' : '') + (st.prog ? '<span class="pill info">' + st.prog + ' in progress</span>' : '') +
          (st.ns ? '<span class="pill">' + st.ns + ' not started</span>' : '') + (st.overdue ? '<span class="pill solidbad">' + st.overdue + ' overdue</span>' : '') +
          (st.risk ? '<span class="pill warn">' + st.risk + ' at risk</span>' : '') + (st.blocked ? '<span class="pill bad">' + st.blocked + ' blocked</span>' : '') + '</div>' +
          '<div class="meta"><span class="mono">' + (sd.length ? shortD(sd[0]) : '—') + ' → ' + (ed.length ? shortD(ed[ed.length - 1]) : '—') + '</span></div></a>';
      }).join('') + '</div>' +
      '<div class="two">' +
        '<section class="panel"><div class="panel-head"><h2>Needs attention</h2><span class="hint">Overdue, blocked, at risk or late to start</span></div><div class="list">' +
          (attention.length ? attention.map(function (a) { return li(a, hPill(a.health)); }).join('') : '<div class="empty">Nothing is overdue, blocked or behind plan.</div>') + '</div></section>' +
        '<section class="panel"><div class="panel-head"><h2>Next 14 days</h2><span class="hint">Due or starting by ' + shortD(in14) + '</span></div><div class="list">' +
          (due.length || starting.length ? due.map(function (a) { return li(a, '<span class="pill info">due ' + shortD(a.end) + '</span>'); }).join('') + starting.map(function (a) { return li(a, '<span class="pill">starts ' + shortD(a.start) + '</span>'); }).join('') : '<div class="empty">Nothing due or starting in the next two weeks.</div>') + '</div></section>' +
      '</div>' +
      '<section class="panel"><div class="panel-head"><h2>Open risks and issues</h2><a href="#/dashboard/risks" class="hint">See all</a></div><div class="list">' +
        (openRisks.length ? openRisks.slice(0, 6).map(function (r) { return '<button type="button" class="li" data-risk="' + esc(r.id) + '"><span class="swatch" style="background:' + esc(colorOf(r.stream)) + '"></span><span class="t"><div><span class="mono muted">' + esc(r.id) + '</span> ' + esc(r.desc) + '</div><div>' + esc(r.type) + ' · ' + esc(r.owner || 'No owner') + ' · due ' + shortD(r.due) + '</div></span>' + sevPill(r.sev) + '</button>'; }).join('') : '<div class="empty">No open risks or issues.</div>') +
      '</div></section>';
  }
  function kpi(l, v, c) { return '<div class="kpi ' + c + '"><span class="eyebrow">' + l + '</span><span class="v">' + v + '</span></div>'; }

  function filtered() {
    var f = S.f, q = f.q.trim().toLowerCase();
    return S.acts.filter(function (a) {
      return (!f.stream || a.stream === f.stream) && (!f.status || a.status === f.status) && (!f.health || a.health === f.health) && (!f.owner || a.owner === f.owner) &&
        (!q || [a.id, a.name, a.desc, a.owner, a.notes].join(' ').toLowerCase().indexOf(q) > -1);
    });
  }
  function filterBar(withDone) {
    var owners = S.acts.map(function (a) { return a.owner; }).filter(Boolean).filter(function (v, i, arr) { return arr.indexOf(v) === i; }).sort();
    return '<div class="filters">' +
      '<label class="sr" for="fStream">Stream</label>' + sel('fStream', [{ v: '', l: 'All streams' }].concat(streamOpts()), S.f.stream) +
      (withDone ? '' : '<label class="sr" for="fStatus">Status</label>' + sel('fStatus', [{ v: '', l: 'Any status' }].concat(STATUSES), S.f.status) +
      '<label class="sr" for="fHealth">Health</label>' + sel('fHealth', [{ v: '', l: 'Any health' }].concat(HEALTH), S.f.health)) +
      '<label class="sr" for="fOwner">Owner</label>' + sel('fOwner', [{ v: '', l: 'Any owner' }].concat(owners), S.f.owner) +
      '<label class="sr" for="fQ">Search</label><input id="fQ" type="search" placeholder="Search sub-activities" value="' + esc(S.f.q) + '">' +
      (withDone ? '<label class="chk"><input id="fDone" type="checkbox"' + (S.f.done ? ' checked' : '') + '> Show completed</label>' : '') +
      '</div>';
  }
  function groups(list) {
    var g = S.streams.map(function (s) { return { s: s, items: list.filter(function (a) { return a.stream === s.no; }) }; }).filter(function (x) { return x.items.length; });
    return g;
  }
  function vList() {
    var list = filtered();
    var g = groups(list);
    return '<div class="page-head"><h1>Sub-activities</h1><span class="hint">' + list.length + ' of ' + S.acts.length + '</span></div>' + filterBar(false) +
      '<div class="scroll"><table style="min-width:860px"><thead><tr><th>ID</th><th>Sub-activity</th><th>Owner</th><th>Priority</th><th>Status</th><th>Start</th><th>Target end</th><th>Complete</th><th>Health</th></tr></thead><tbody>' +
      (g.length ? g.map(function (x) {
        return '<tr class="grp"><td colspan="9"><span class="swatch" style="background:' + esc(x.s.color) + '"></span> ' + esc(x.s.no) + '. ' + esc(x.s.name) + ' <span class="hint">· ' + x.items.length + '</span></td></tr>' +
          x.items.map(function (a) {
            return '<tr class="row" tabindex="0" data-detail="' + esc(a.id) + '"><td class="d">' + esc(a.id) + '</td><td><div>' + esc(a.name) + '</div>' + (a.desc ? '<div class="sub">' + esc(a.desc) + '</div>' : '') + '</td>' +
              '<td>' + esc(a.owner || '—') + '</td><td>' + esc(a.prio) + '</td><td>' + sPill(a.status) + '</td><td class="d">' + esc(a.start) + '</td><td class="d">' + esc(a.end) + '</td>' +
              '<td><div class="pct"><div class="track"><i style="width:' + a.pct + '%;background:' + esc(colorOf(a.stream)) + '"></i></div><span class="mono">' + a.pct + '%</span></div></td><td>' + hPill(a.health) + '</td></tr>';
          }).join('');
      }).join('') : '<tr><td colspan="9" class="empty">No sub-activities match these filters.</td></tr>') + '</tbody></table></div>';
  }
  function vTimeline() {
    var list = filtered().filter(function (a) { return a.start && a.end; });
    if (!list.length) return '<h1>Timeline</h1>' + filterBar(false) + '<p class="empty">No sub-activities with both a start and target end date match these filters.</p>';
    var t = Date.parse(todayIso());
    var lo = Math.min.apply(null, list.map(function (a) { return Date.parse(a.start); }).concat([t]));
    var hi = Math.max.apply(null, list.map(function (a) { return Date.parse(a.end); }).concat([t]));
    var min = new Date(lo), max = new Date(hi);
    min = new Date(min.getFullYear(), min.getMonth(), 1); max = new Date(max.getFullYear(), max.getMonth() + 1, 1);
    var span = max - min;
    function X(ms) { return (ms - min) / span * 100; }
    var months = []; for (var d = new Date(min); d < max; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(new Date(d));
    var grid = '<div class="g-grid">' + months.map(function (m) { return '<i style="left:' + X(+m) + '%"></i>'; }).join('') + '</div>';
    var todayLine = '<div class="g-today" style="left:' + X(t) + '%" title="Today"></div>';
    return '<div class="page-head"><h1>Timeline</h1><div class="legend"><span><i class="swatch" style="background:var(--muted);opacity:.35"></i>Planned</span><span><i class="swatch" style="background:var(--muted)"></i>Completed share</span><span><i class="swatch" style="outline:2px solid var(--bad)"></i>Overdue</span><span><i style="display:inline-block;width:2px;height:12px;background:var(--today)"></i>Today</span></div></div>' + filterBar(false) +
      '<div class="scroll"><div class="gantt"><div class="g-head"><div class="g-label eyebrow" style="padding-top:8px">Sub-activity</div><div class="g-months">' +
      months.map(function (m) { return '<span style="left:' + X(+m) + '%">' + m.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) + '</span>'; }).join('') + '</div></div>' +
      groups(list).map(function (g) {
        return '<div class="g-row grp"><div class="g-label"><span class="swatch" style="background:' + esc(g.s.color) + '"></span> ' + esc(g.s.no) + '. ' + esc(g.s.name) + '</div><div class="g-lane">' + grid + todayLine + '</div></div>' +
          g.items.slice().sort(function (a, b) { return a.start.localeCompare(b.start); }).map(function (a) {
            var l = X(Date.parse(a.start)), w = Math.max(0.4, X(Date.parse(a.end) + DAY) - l), c = esc(g.s.color);
            return '<div class="g-row" tabindex="0" data-detail="' + esc(a.id) + '" title="' + esc(a.id + ' ' + a.name + ': ' + a.start + ' to ' + a.end + ', ' + a.pct + '%') + '"><div class="g-label"><span class="mono">' + esc(a.id) + '</span> ' + esc(a.name) + '</div>' +
              '<div class="g-lane">' + grid + '<div class="g-bar' + (a.health === 'Overdue' ? ' over' : '') + '" style="left:' + l + '%;width:' + w + '%;background:' + c + '"></div><div class="g-fill" style="left:' + l + '%;width:' + (w * a.pct / 100) + '%;background:' + c + '"></div>' + todayLine + '</div></div>';
          }).join('');
      }).join('') + '</div></div>';
  }
  function vRisks() {
    var order = ['Critical', 'Elevated', 'Low', ''];
    var list = S.risks.slice().sort(function (a, b) { return (a.status === 'Closed') - (b.status === 'Closed') || order.indexOf(a.sev) - order.indexOf(b.sev); });
    return '<div class="page-head"><h1>Risks and issues</h1><span class="hint">' + S.risks.filter(function (r) { return r.status !== 'Closed'; }).length + ' open</span></div>' +
      '<div class="scroll"><table style="min-width:860px"><thead><tr><th>ID</th><th>Stream</th><th>Type</th><th>Description</th><th>Severity</th><th>Owner</th><th>Mitigation</th><th>Due</th><th>Status</th></tr></thead><tbody>' +
      (list.length ? list.map(function (r) {
        return '<tr class="row" tabindex="0" data-risk="' + esc(r.id) + '"><td class="d">' + esc(r.id) + '</td><td><span class="swatch" style="background:' + esc(colorOf(r.stream)) + '"></span> ' + esc(r.stream) + '</td><td>' + esc(r.type) + '</td>' +
          '<td>' + esc(r.desc) + (r.link ? '<div class="sub">Linked to ' + esc(r.link) + '</div>' : '') + '</td><td>' + sevPill(r.sev) + '</td><td>' + esc(r.owner || '—') + '</td><td>' + esc(r.mit) + '</td><td class="d">' + esc(r.due) + '</td>' +
          '<td><span class="pill ' + (r.status === 'Closed' ? 'good' : r.status === 'Open' ? 'info' : '') + '">' + esc(r.status) + '</span></td></tr>';
      }).join('') : '<tr><td colspan="9" class="empty">No risks or issues logged yet.</td></tr>') + '</tbody></table></div>';
  }

  /* Detail sheet (read view for anyone; Edit button when allowed) */
  function detailSheet() {
    var d = S.detail, rows = [], title = '', edit = '';
    if (d.kind === 'act') {
      var a = S.acts.filter(function (x) { return x.id === d.id; })[0]; if (!a) return '';
      var s = streamOf(a.stream);
      title = a.id + ' · ' + a.name;
      rows = [['Stream', s ? s.no + '. ' + s.name : a.stream], ['Status', sPill(a.status) + ' ' + hPill(a.health)], ['Owner', esc(a.owner || '—')], ['Priority', esc(a.prio)],
        ['Start', esc(a.start || '—')], ['Target end', esc(a.end || '—')], ['Complete', a.pct + '%'], ['Depends on', esc(a.dep || '—')], ['Description', esc(a.desc || '—')], ['Notes', esc(a.notes || '—')],
        ['Last updated', esc((a.updated || '—') + (a.updatedBy ? ' by ' + a.updatedBy : ''))]];
      if (canEdit(a.stream)) edit = '<button class="btn primary" type="button" data-edit-act="' + esc(a.id) + '">Edit</button>';
    } else {
      var r = S.risks.filter(function (x) { return x.id === d.id; })[0]; if (!r) return '';
      title = r.id + ' · ' + r.type;
      rows = [['Stream', esc(r.stream)], ['Description', esc(r.desc)], ['Severity', sevPill(r.sev) + ' <span class="hint">' + esc(r.impact) + ' impact, ' + esc(r.like) + ' likelihood</span>'],
        ['Owner', esc(r.owner || '—')], ['Mitigation', esc(r.mit || '—')], ['Due', esc(r.due || '—')], ['Status', esc(r.status)], ['Linked to', esc(r.link || '—')]];
      if (canEdit(r.stream)) edit = '<button class="btn primary" type="button" data-edit-risk="' + esc(r.id) + '">Edit</button>';
    }
    return '<div class="overlay" data-act="closeDetail"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<div class="panel-head"><h2>' + esc(title) + '</h2><button class="btn sm" type="button" data-act="closeDetail">Close</button></div>' +
      '<dl>' + rows.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + (x[0] === 'Stream' && d.kind === 'act' ? esc(x[1]) : x[1]) + '</dd>'; }).join('') + '</dl>' +
      (edit ? '<div class="actions">' + edit + '</div>' : '') + '</div></div>';
  }

  /* ---------------- Input: weekly update ---------------- */
  function cur(a, k) { var e = S.edits[a.id]; return e && e[k] !== undefined ? e[k] : a[k]; }
  function vUpdate() {
    var f = S.f, q = f.q.trim().toLowerCase();
    var list = S.acts.filter(function (a) {
      return (!f.stream || a.stream === f.stream) && (!f.owner || a.owner === f.owner) && (f.done || a.status !== 'Completed' || S.edits[a.id]) &&
        (!q || [a.id, a.name, a.owner, a.notes].join(' ').toLowerCase().indexOf(q) > -1);
    });
    if (!f.stream && role() === 'Editor') list = list.filter(function (a) { return canEdit(a.stream); }).concat(list.filter(function (a) { return !canEdit(a.stream); }));
    var g = groups(list);
    if (role() === 'Editor') g.sort(function (a, b) { return canEdit(b.s.no) - canEdit(a.s.no); });
    return '<div class="page-head"><h1>Weekly update</h1><span class="hint">Change owner, status, % done, target end or notes, then Save all.' + (role() === 'Editor' ? " Streams you can't edit are read only." : '') + '</span></div>' +
      filterBar(true) +
      '<div class="scroll upd-scroll"><table class="upd" style="min-width:980px"><thead><tr><th style="width:56px">ID</th><th>Sub-activity</th><th style="width:140px">Owner</th><th style="width:140px">Status</th><th style="width:84px">% done</th><th style="width:150px">Target end</th><th>Notes / next step</th><th style="width:100px">Health</th></tr></thead><tbody>' +
      (g.length ? g.map(function (x) {
        var ok = canEdit(x.s.no);
        return '<tr class="grp"><td colspan="8"><span class="swatch" style="background:' + esc(x.s.color) + '"></span> ' + esc(x.s.no) + '. ' + esc(x.s.name) + (ok ? '' : ' <span class="hint">· read only for you</span>') + '</td></tr>' +
          x.items.map(function (a) {
            var k = esc(a.id), e = S.edits[a.id] || {}, dis = ok ? '' : ' disabled';
            function ch(f) { return e[f] !== undefined ? ' class="ch"' : ''; }
            return '<tr class="r' + (S.edits[a.id] ? ' dirty' : S.saved[a.id] ? ' saved' : '') + '">' +
              '<td class="d idc">' + k + '</td>' +
              '<td class="name"><div style="font-weight:500"><span class="mono muted">' + k + '</span> ' + esc(a.name) + '</div><div class="sub">Start ' + esc(a.start || '—') + ' · ' + esc(a.prio) + ' priority</div></td>' +
              '<td data-l="Owner"><input id="e-owner-' + k + '"' + ch('owner') + ' data-id="' + k + '" data-k="owner" value="' + esc(cur(a, 'owner')) + '" aria-label="Owner for ' + k + '"' + dis + '></td>' +
              '<td data-l="Status">' + sel('e-status-' + k, STATUSES, cur(a, 'status'), 'data-id="' + k + '" data-k="status" aria-label="Status for ' + k + '"' + (e.status !== undefined ? ' class="ch"' : '') + dis) + '</td>' +
              '<td data-l="% done"><input id="e-pct-' + k + '"' + ch('pct') + ' type="number" inputmode="numeric" min="0" max="100" step="5" data-id="' + k + '" data-k="pct" value="' + esc(cur(a, 'pct')) + '" aria-label="% done for ' + k + '"' + dis + '></td>' +
              '<td data-l="Target end"><input id="e-end-' + k + '"' + ch('end') + ' type="date" data-id="' + k + '" data-k="end" value="' + esc(cur(a, 'end')) + '" aria-label="Target end for ' + k + '"' + dis + '></td>' +
              '<td class="notes" data-l="Notes / next step"><input id="e-notes-' + k + '"' + ch('notes') + ' data-id="' + k + '" data-k="notes" value="' + esc(cur(a, 'notes')) + '" aria-label="Notes for ' + k + '"' + dis + '></td>' +
              '<td data-l="Health">' + hPill(a.health) + '</td></tr>';
          }).join('');
      }).join('') : '<tr><td colspan="8" class="empty">No sub-activities match. Tick Show completed or clear the filters.</td></tr>') + '</tbody></table></div>';
  }
  function setEdit(id, k, v) {
    var a = S.acts.filter(function (x) { return x.id === id; })[0]; if (!a || !canEdit(a.stream)) return;
    if (k === 'pct') v = clampPct(v);
    var e = S.edits[id] || {}; e[k] = v;
    if (k === 'status' && v === 'Completed') e.pct = 100;
    Object.keys(e).forEach(function (f) { if (String(e[f]) === String(a[f])) delete e[f]; });
    if (Object.keys(e).length) S.edits[id] = e; else delete S.edits[id];
    delete S.saved[id];
  }
  function savebar() {
    var ids = Object.keys(S.edits);
    if (!(S.mode === 'input' && S.tab === 'update' && ids.length)) return '';
    var n = ids.reduce(function (m, id) { return m + Object.keys(S.edits[id]).length; }, 0);
    return '<div class="savebar"><div class="wrap"><span><b>' + n + ' change' + (n === 1 ? '' : 's') + '</b> in ' + ids.length + ' sub-activit' + (ids.length === 1 ? 'y' : 'ies') + ', not saved yet</span>' +
      (S.msgs.update ? '<span class="msg err">' + esc(S.msgs.update.text) + '</span>' : '') +
      '<span style="margin-left:auto;display:flex;gap:8px"><button class="btn" type="button" data-act="discard">Discard</button><button class="btn primary" type="button" data-act="saveAll"' + (S.busy ? ' disabled' : '') + '>Save all</button></span></div></div>';
  }
  function saveAll() {
    var ids = Object.keys(S.edits); if (!ids.length) return;
    var items = ids.map(function (id) { var a = S.acts.filter(function (x) { return x.id === id; })[0]; return { id: id, version: a ? a.version : 0, data: S.edits[id] }; });
    write('saveActivities', { items: items }, 'update').then(function (r) {
      if (!r) return;
      var ok = 0, fails = [];
      r.results.forEach(function (x, i) { if (x.ok) { ok++; delete S.edits[ids[i]]; S.saved[x.id] = true; } else fails.push(ids[i] + ': ' + x.message); });
      toast(fails.length ? 'Saved ' + ok + '. Not saved: ' + fails.join(' ') : 'Saved ' + ok + ' update' + (ok === 1 ? '' : 's'));
      if (fails.length) S.msgs.update = { text: fails.join(' ') };
      refresh(true);
    });
  }

  /* ---------------- Input: add / edit sub-activity ---------------- */
  function vActivity() {
    var mine = editableStreams();
    if (!mine.length) return '<div class="panel"><h2>No streams to edit</h2><p class="hint">' + (isAdmin() ? 'Add a stream first in Input › Streams.' : 'Ask an Admin to give you access to a stream.') + '</p></div>';
    var a = S.sel.act ? S.acts.filter(function (x) { return x.id === S.sel.act; })[0] : null;
    if (S.sel.act && !a) S.sel.act = null;
    var d = a || S.draft.act || { stream: S.preset.stream && canEdit(S.preset.stream) ? S.preset.stream : mine[0].no, prio: 'Medium', status: 'Not Started', pct: 0 };
    var listStream = d.stream, others = S.acts.filter(function (x) { return x.stream === listStream; });
    var owners = S.acts.map(function (x) { return x.owner; }).filter(Boolean).filter(function (v, i, arr) { return arr.indexOf(v) === i; }).sort();
    var m = S.msgs.act, bad = m && m.field;
    var streamChoices = mine;
    return '<div class="split"><div class="side panel">' +
      '<div class="panel-head"><h2>' + (a ? 'Edit ' + esc(a.id) : 'New sub-activity') + '</h2>' + (a ? '<button class="btn sm" type="button" data-act="newAct">+ New instead</button>' : '<span class="mono muted">ID ' + esc(nextActId(d.stream)) + '</span>') + '</div>' +
      '<form class="form" id="actForm" novalidate>' +
        field('aStream', 'Stream', sel('aStream', streamOpts(streamChoices), d.stream), 'full') +
        field('aName', 'Sub-activity', '<input id="aName" required maxlength="300" value="' + esc(d.name) + '" placeholder="Shortlist core-system vendors"' + (bad === 'name' ? ' aria-invalid="true"' : '') + '>', 'full') +
        field('aDesc', 'Description / deliverable', '<textarea id="aDesc">' + esc(d.desc) + '</textarea>', 'full') +
        field('aOwner', 'Owner / PIC', '<input id="aOwner" list="ownerList" value="' + esc(d.owner) + '"><datalist id="ownerList">' + owners.map(function (o) { return '<option value="' + esc(o) + '">'; }).join('') + '</datalist>') +
        field('aPrio', 'Priority', sel('aPrio', PRIOS, d.prio)) +
        field('aStatus', 'Status', sel('aStatus', STATUSES, d.status)) +
        field('aPct', '% complete', '<input id="aPct" type="number" inputmode="numeric" min="0" max="100" step="5" value="' + esc(d.pct) + '">') +
        field('aStart', 'Start date', '<input id="aStart" type="date" value="' + esc(d.start) + '">') +
        field('aEnd', 'Target end', '<input id="aEnd" type="date" value="' + esc(d.end) + '"' + (bad === 'end' ? ' aria-invalid="true"' : '') + '>') +
        field('aDep', 'Depends on (ID)', '<input id="aDep" placeholder="1.6" value="' + esc(d.dep) + '">') +
        field('aNotes', 'Notes / next step', '<textarea id="aNotes">' + esc(d.notes) + '</textarea>', 'full') +
        (a ? '<div class="hint field full">Last updated ' + esc(a.updated || '—') + (a.updatedBy ? ' by ' + esc(a.updatedBy) : '') + '. Changing the stream gives it a new ID.</div>' : '') +
        (m ? '<div class="msg ' + (m.ok ? 'ok' : 'err') + '" role="' + (m.ok ? 'status' : 'alert') + '">' + esc(m.text) + '</div>' : '') +
        '<div class="actions"><button class="btn primary" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (a ? 'Save changes' : 'Add to plan') + '</button>' +
          (a ? '<span class="right" id="delWrap">' + (S.confirm === 'act' ? '<span class="hint">Delete for everyone?</span><button class="btn danger" type="button" data-act="delActYes">Yes, delete</button><button class="btn" type="button" data-act="cancelDel">Keep</button>' : '<button class="btn danger" type="button" data-act="delAct">Delete</button>') + '</span>' : '') +
        '</div></form></div>' +
      '<div class="main panel"><div class="panel-head"><h2>' + esc(listStream) + '. ' + esc((streamOf(listStream) || {}).name || '') + '</h2><span class="hint">' + others.length + ' sub-activities · pick one to edit</span></div>' +
        '<div class="scroll"><table style="min-width:480px"><thead><tr><th>ID</th><th>Sub-activity</th><th>Owner</th><th>Dates</th><th>Status</th></tr></thead><tbody>' +
        (others.length ? others.map(function (x) { return '<tr class="row" tabindex="0" data-pick="' + esc(x.id) + '"' + (x.id === S.sel.act ? ' style="outline:2px solid var(--accent)"' : '') + '><td class="d">' + esc(x.id) + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.owner || '—') + '</td><td class="d">' + esc(x.start || '—') + ' → ' + esc(x.end || '—') + '</td><td>' + sPill(x.status) + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="empty">No sub-activities in this stream yet.</td></tr>') +
        '</tbody></table></div></div></div>';
  }
  function readActForm() {
    return { stream: val('aStream'), name: val('aName'), desc: val('aDesc'), owner: val('aOwner'), prio: val('aPrio'), status: val('aStatus'), pct: clampPct(val('aPct')), start: val('aStart'), end: val('aEnd'), dep: val('aDep'), notes: val('aNotes') };
  }
  function saveActivity() {
    var a = S.sel.act ? S.acts.filter(function (x) { return x.id === S.sel.act; })[0] : null;
    var d = readActForm();
    if (d.status === 'Completed') d.pct = 100;
    S.draft.act = d;
    if (!d.name) { S.msgs.act = { text: 'Give the sub-activity a name.', field: 'name' }; return render(); }
    if (d.start && d.end && d.end < d.start) { S.msgs.act = { text: 'Target end is before the start date.', field: 'end' }; return render(); }
    write('saveActivities', { items: [{ id: a ? a.id : null, version: a ? a.version : 0, data: d }] }, 'act').then(function (r) {
      if (!r) return;
      var x = r.results[0];
      if (!x.ok) { S.msgs.act = { text: x.message }; if (x.code === 'conflict') refresh(true); return render(); }
      S.draft.act = null;
      S.msgs.act = { ok: true, text: a ? 'Saved ' + x.id + (x.oldId ? ' (was ' + x.oldId + ')' : '') + '.' : 'Added ' + x.id + '. The form is ready for the next one.' };
      S.sel.act = a ? x.id : null; S.preset.stream = d.stream;
      toast(a ? 'Saved ' + x.id : 'Added ' + x.id);
      refresh(true);
    });
  }

  /* ---------------- Input: streams ---------------- */
  function vStreams() {
    var s = S.sel.stream ? streamOf(S.sel.stream) : null;
    var nextNo = String(S.streams.reduce(function (m, x) { return Math.max(m, parseInt(x.no, 10) || 0); }, 0) + 1);
    var used = s ? S.acts.filter(function (a) { return a.stream === s.no; }).length : 0;
    var openR = s ? S.risks.filter(function (r) { return r.stream === s.no && r.status !== 'Closed'; }).length : 0;
    var d = s || S.draft.stream || { no: nextNo, color: PALETTE[(Number(nextNo) - 7 + PALETTE.length * 4) % PALETTE.length], name: '', lead: '', scope: '' };
    var m = S.msgs.stream;
    var form = isAdmin() ? '<div class="side panel" style="border:2px solid var(--accent)">' +
      '<div class="panel-head"><h2>' + (s ? 'Edit stream ' + esc(s.no) : 'New stream') + '</h2>' + (s ? '<button class="btn sm" type="button" data-act="newStream">+ New instead</button>' : '<span class="pill accent">Stream # ' + esc(nextNo) + '</span>') + '</div>' +
      '<form class="form" id="streamForm" novalidate>' +
        field('sName', 'Stream name', '<input id="sName" required value="' + esc(d.name) + '" placeholder="Marketing &amp; Branding">', 'full') +
        field('sLead', 'Stream lead', '<input id="sLead" value="' + esc(d.lead) + '">', 'full') +
        '<div class="field full"><span class="lbl" id="sColorL">Colour on dashboard and timeline</span><div class="swatches" role="group" aria-labelledby="sColorL">' +
          PALETTE.map(function (c) { return '<button type="button" data-color="' + c + '" aria-label="Colour ' + c + '" aria-pressed="' + (String(d.color).toUpperCase() === c ? 'true' : 'false') + '" style="background:' + c + '"></button>'; }).join('') +
          '<input type="hidden" id="sColor" value="' + esc(d.color) + '"></div></div>' +
        field('sScope', 'Scope', '<textarea id="sScope">' + esc(d.scope) + '</textarea>', 'full') +
        '<div class="infobox">' + (s ? used + ' sub-activities and ' + openR + ' open risks use this stream.' + (used || openR ? ' Move or delete them before deleting the stream.' : '') : 'Its sub-activities will be numbered <b>' + esc(nextNo) + '.1, ' + esc(nextNo) + '.2…</b> It appears in every list, the dashboard and the timeline as soon as you save. Then grant Editors access in Admin › Users.') + '</div>' +
        (m ? '<div class="msg ' + (m.ok ? 'ok' : 'err') + '">' + esc(m.text) + '</div>' : '') +
        '<div class="actions"><button class="btn primary" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (s ? 'Save changes' : 'Add stream') + '</button>' +
          (s && !used && !openR ? '<span class="right">' + (S.confirm === 'stream' ? '<span class="hint">Delete stream ' + esc(s.no) + '?</span><button class="btn danger" type="button" data-act="delStreamYes">Yes, delete</button><button class="btn" type="button" data-act="cancelDel">Keep</button>' : '<button class="btn danger" type="button" data-act="delStream">Delete</button>') + '</span>' : '') +
        '</div></form></div>' : '';
    return '<div class="page-head"><h1>Streams</h1><span class="hint">' + (isAdmin() ? 'Only Admins can add, rename or delete streams.' : 'Read only. Ask an Admin to add or change a stream.') + '</span></div>' +
      '<div class="split">' + form + '<div class="main"><div class="scroll"><table style="min-width:560px"><thead><tr><th>#</th><th>Stream</th><th>Lead</th><th>Sub-activities</th><th>Open risks</th></tr></thead><tbody>' +
      S.streams.map(function (x) {
        var n = S.acts.filter(function (a) { return a.stream === x.no; }).length, r = S.risks.filter(function (k) { return k.stream === x.no && k.status !== 'Closed'; }).length;
        return '<tr class="' + (isAdmin() ? 'row' : '') + '" tabindex="0" data-pick-stream="' + esc(x.no) + '"' + (x.no === S.sel.stream ? ' style="outline:2px solid var(--accent)"' : '') + '><td class="d">' + esc(x.no) + '</td><td><span class="swatch" style="background:' + esc(x.color) + '"></span> <b>' + esc(x.name) + '</b>' + (x.scope ? '<div class="sub">' + esc(x.scope) + '</div>' : '') + '</td><td>' + esc(x.lead || '—') + '</td><td class="d">' + n + '</td><td class="d">' + r + '</td></tr>';
      }).join('') + '</tbody></table></div></div></div>';
  }
  function saveStream() {
    var s = S.sel.stream ? streamOf(S.sel.stream) : null;
    var d = { name: val('sName'), lead: val('sLead'), color: val('sColor'), scope: val('sScope') };
    S.draft.stream = d;
    if (!d.name) { S.msgs.stream = { text: 'Give the stream a name.' }; return render(); }
    write('saveStream', { no: s ? s.no : null, data: d }, 'stream').then(function (r) {
      if (!r) return;
      S.draft.stream = null; S.sel.stream = r.stream.no;
      S.msgs.stream = { ok: true, text: s ? 'Saved stream ' + r.stream.no + '.' : 'Added stream ' + r.stream.no + '. ' + r.stream.name + '. You can now add its sub-activities.' };
      toast(s ? 'Stream saved' : 'Stream ' + r.stream.no + ' added');
      refresh(true);
    });
  }

  /* ---------------- Input: risks ---------------- */
  function vRiskForm() {
    var mine = editableStreams();
    var r = S.sel.risk ? S.risks.filter(function (x) { return x.id === S.sel.risk; })[0] : null;
    var d = r || S.draft.risk || { stream: mine.length ? mine[0].no : '', type: 'Risk', impact: 'Medium', like: 'Medium', status: 'Open' };
    var m = S.msgs.risk;
    var canWrite = r ? canEdit(r.stream) : mine.length > 0;
    return '<div class="split"><div class="side panel">' +
      '<div class="panel-head"><h2>' + (r ? 'Edit ' + esc(r.id) : 'New risk or issue') + '</h2>' + (r ? '<button class="btn sm" type="button" data-act="newRisk">+ New instead</button>' : '') + '</div>' +
      (canWrite ? '<form class="form" id="riskForm" novalidate>' +
        field('rStream', 'Stream', sel('rStream', streamOpts(r && !canEdit(r.stream) ? [streamOf(r.stream)].filter(Boolean) : mine), d.stream)) +
        field('rType', 'Type', sel('rType', ['Risk', 'Issue', 'Decision', 'Dependency'], d.type)) +
        field('rDesc', 'Description', '<textarea id="rDesc" required>' + esc(d.desc) + '</textarea>', 'full') +
        field('rImpact', 'Impact', sel('rImpact', PRIOS, d.impact)) + field('rLike', 'Likelihood', sel('rLike', PRIOS, d.like)) +
        field('rOwner', 'Owner', '<input id="rOwner" value="' + esc(d.owner) + '">') + field('rDue', 'Due date', '<input id="rDue" type="date" value="' + esc(d.due) + '">') +
        field('rMit', 'Mitigation / action', '<textarea id="rMit">' + esc(d.mit) + '</textarea>', 'full') +
        field('rStatus', 'Status', sel('rStatus', ['Open', 'Monitoring', 'Closed'], d.status)) + field('rLink', 'Linked sub-activity ID', '<input id="rLink" placeholder="3.2" value="' + esc(d.link) + '">') +
        '<div class="infobox">Severity is worked out from impact and likelihood: ' + sevPill(severity(d.impact, d.like)) + '</div>' +
        (m ? '<div class="msg ' + (m.ok ? 'ok' : 'err') + '">' + esc(m.text) + '</div>' : '') +
        '<div class="actions"><button class="btn primary" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (r ? 'Save changes' : 'Add to log') + '</button>' +
          (r ? '<span class="right">' + (S.confirm === 'risk' ? '<span class="hint">Delete ' + esc(r.id) + '?</span><button class="btn danger" type="button" data-act="delRiskYes">Yes, delete</button><button class="btn" type="button" data-act="cancelDel">Keep</button>' : '<button class="btn danger" type="button" data-act="delRisk">Delete</button>') + '</span>' : '') +
        '</div></form>' : '<p class="hint">You can view this risk but not change it.</p>') +
      '</div><div class="main panel"><div class="panel-head"><h2>Risks and issues</h2><span class="hint">' + S.risks.filter(function (x) { return x.status !== 'Closed'; }).length + ' open · pick one to edit</span></div>' +
      '<div class="scroll"><table style="min-width:520px"><thead><tr><th>ID</th><th>Description</th><th>Severity</th><th>Owner</th><th>Status</th></tr></thead><tbody>' +
      (S.risks.length ? S.risks.map(function (x) { return '<tr class="row" tabindex="0" data-pick-risk="' + esc(x.id) + '"' + (x.id === S.sel.risk ? ' style="outline:2px solid var(--accent)"' : '') + '><td class="d">' + esc(x.id) + '</td><td><span class="swatch" style="background:' + esc(colorOf(x.stream)) + '"></span> ' + esc(x.desc) + '</td><td>' + sevPill(x.sev) + '</td><td>' + esc(x.owner || '—') + '</td><td>' + esc(x.status) + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="empty">No risks or issues logged yet.</td></tr>') +
      '</tbody></table></div></div></div>';
  }
  function saveRisk() {
    var r = S.sel.risk ? S.risks.filter(function (x) { return x.id === S.sel.risk; })[0] : null;
    var d = { stream: val('rStream'), type: val('rType'), desc: val('rDesc'), impact: val('rImpact'), like: val('rLike'), owner: val('rOwner'), due: val('rDue'), mit: val('rMit'), status: val('rStatus'), link: val('rLink') };
    S.draft.risk = d;
    if (!d.desc) { S.msgs.risk = { text: 'Describe the risk or issue.' }; return render(); }
    write('saveRisk', { id: r ? r.id : null, version: r ? r.version : 0, data: d }, 'risk').then(function (x) {
      if (!x) return;
      S.draft.risk = null; S.sel.risk = r ? x.risk.id : null;
      S.msgs.risk = { ok: true, text: (r ? 'Saved ' : 'Added ') + x.risk.id + '.' };
      toast((r ? 'Saved ' : 'Added ') + x.risk.id);
      refresh(true);
    });
  }

  /* ---------------- Admin ---------------- */
  function vUsers() {
    var u = S.sel.user ? S.users.filter(function (x) { return x.email === S.sel.user; })[0] : null;
    var d = u || S.draft.user || { email: '', name: '', role: 'Viewer', streams: [], active: true };
    var m = S.msgs.user;
    var roleCls = { Admin: 'accent', Editor: 'info', Viewer: '' };
    return '<div class="page-head"><h1>Users and access</h1><span class="hint">Only people listed here can open the app. There must always be at least one active Admin.</span></div>' +
      '<div class="split"><div class="side panel" style="border:2px solid var(--accent)">' +
      '<div class="panel-head"><h2>' + (u ? 'Edit ' + esc(u.name || u.email) : 'Invite user') + '</h2>' + (u ? '<button class="btn sm" type="button" data-act="newUser">+ Invite instead</button>' : '') + '</div>' +
      '<form class="form" id="userForm" novalidate>' +
        field('uEmail', 'Google email', '<input id="uEmail" type="email" autocomplete="off" value="' + esc(d.email) + '" placeholder="name@gmail.com"' + (u ? ' readonly' : '') + '>', 'full') +
        field('uName', 'Name and role in the team', '<input id="uName" value="' + esc(d.name) + '" placeholder="Rizky, Tech lead">', 'full') +
        '<div class="field full"><span class="lbl" id="uRoleL">Access</span><div class="seg" role="group" aria-labelledby="uRoleL">' +
          ['Viewer', 'Editor', 'Admin'].map(function (r) { return '<button type="button" data-role="' + r + '" aria-pressed="' + (d.role === r ? 'true' : 'false') + '">' + r + '</button>'; }).join('') +
          '<input type="hidden" id="uRole" value="' + esc(d.role) + '"></div><span class="hint" id="uRoleHint">' + ROLE_HINT[d.role] + '</span></div>' +
        '<fieldset id="uGrants" class="field full checks" style="border:0;padding:0;margin:0"' + (d.role === 'Editor' ? '' : ' hidden') + '><legend class="lbl" style="margin-bottom:4px">Can edit these streams</legend>' +
          S.streams.map(function (s) { return '<label><input type="checkbox" data-grant="' + esc(s.no) + '"' + (d.streams.indexOf(s.no) > -1 ? ' checked' : '') + '><span class="swatch" style="background:' + esc(s.color) + '"></span>' + esc(s.no) + '. ' + esc(s.name) + '</label>'; }).join('') + '</fieldset>' +
        '<div class="field full checks"><label><input type="checkbox" id="uActive"' + (d.active ? ' checked' : '') + '> Active (can sign in)</label></div>' +
        (m ? '<div class="msg ' + (m.ok ? 'ok' : 'err') + '">' + esc(m.text) + '</div>' : '') +
        '<div class="actions"><button class="btn primary" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (u ? 'Save access' : 'Add user') + '</button></div>' +
      '</form></div><div class="main"><div class="scroll"><table style="min-width:520px"><thead><tr><th>User</th><th>Access</th><th>Streams</th><th>Status</th></tr></thead><tbody>' +
      S.users.map(function (x) {
        return '<tr class="row" tabindex="0" data-pick-user="' + esc(x.email) + '"' + (x.email === S.sel.user ? ' style="outline:2px solid var(--accent)"' : '') + '><td><b>' + esc(x.name || x.email) + '</b><div class="sub">' + esc(x.email) + '</div></td><td><span class="pill ' + roleCls[x.role] + '">' + esc(x.role) + '</span></td>' +
          '<td>' + (x.role === 'Editor' ? esc(x.streams.join(', ') || 'none') : x.role === 'Admin' ? 'All' : 'View only') + '</td><td>' + (x.active ? 'Active' : '<span class="pill">Inactive</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div></div></div>';
  }
  function readUserForm() {
    var grants = []; document.querySelectorAll('[data-grant]').forEach(function (c) { if (c.checked) grants.push(c.getAttribute('data-grant')); });
    return { email: val('uEmail').toLowerCase(), name: val('uName'), role: val('uRole') || 'Viewer', streams: grants, active: !!($('#uActive') || {}).checked };
  }
  function saveUser() {
    var d = readUserForm(); S.draft.user = d;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) { S.msgs.user = { text: 'Enter the Google email address they sign in with.' }; return render(); }
    write('saveUser', d, 'user').then(function (r) {
      if (!r) return;
      S.users = r.users; S.draft.user = null; S.sel.user = d.email;
      S.msgs.user = { ok: true, text: 'Saved. ' + d.email + ' is ' + (d.active ? 'an active ' + d.role : 'inactive') + '.' };
      toast('Access saved'); refresh(true);
    });
  }
  function vLog() {
    if (!S.log) {
      if (!S.logLoading) {
        S.logLoading = true;
        api('changeLog', { limit: 1000 }).then(function (r) { S.log = r.entries; S.logLoading = false; render(); }).catch(function (e) { S.logLoading = false; S.log = []; handleErr(e, 'log'); render(); });
      }
      return '<h1>Change log</h1><div class="panel"><div class="skel" style="width:70%"></div><div class="skel" style="width:50%"></div></div>';
    }
    var q = S.logQ.trim().toLowerCase();
    var list = S.log.filter(function (e) { return !q || [e.user, e.type, e.id, e.field, e.old, e.next].join(' ').toLowerCase().indexOf(q) > -1; });
    return '<div class="page-head"><h1>Change log</h1><span class="hint">' + (role() === 'Editor' ? 'Changes in your streams. ' : '') + 'Newest first. Never edited or deleted.</span></div>' +
      '<div class="filters"><label class="sr" for="logQ">Search the log</label><input id="logQ" type="search" placeholder="Search by person, ID or field" value="' + esc(S.logQ) + '"><button class="btn" type="button" data-act="reloadLog">Reload</button></div>' +
      (S.msgs.log ? '<p class="msg err">' + esc(S.msgs.log.text) + '</p>' : '') +
      '<div class="scroll"><table style="min-width:820px"><thead><tr><th>When</th><th>Who</th><th>Record</th><th>Field</th><th>Old value</th><th>New value</th></tr></thead><tbody>' +
      (list.length ? list.slice(0, 500).map(function (e) { return '<tr><td class="d">' + esc(e.time) + '</td><td>' + esc(e.user) + '</td><td>' + esc(e.type) + ' <span class="mono">' + esc(e.id) + '</span></td><td>' + esc(e.field) + '</td><td class="muted">' + esc(e.old) + '</td><td>' + esc(e.next) + '</td></tr>'; }).join('') : '<tr><td colspan="6" class="empty">No changes recorded yet.</td></tr>') +
      '</tbody></table></div>';
  }
  function vDeleted() {
    if (!S.deleted) {
      if (!S.delLoading) { S.delLoading = true; api('listDeleted').then(function (r) { S.deleted = r; S.delLoading = false; render(); }).catch(function (e) { S.delLoading = false; S.deleted = { streams: [], activities: [], risks: [] }; handleErr(e, 'deleted'); render(); }); }
      return '<h1>Deleted items</h1><div class="panel"><div class="skel" style="width:60%"></div></div>';
    }
    function rows(list, type, key, label) {
      return list.length ? list.map(function (x) { return '<div class="li" style="cursor:default"><span class="swatch" style="background:' + esc(colorOf(x.stream || x.no)) + '"></span><span class="t"><div><span class="mono muted">' + esc(x[key]) + '</span> ' + esc(label(x)) + '</div><div>' + type + '</div></span><button class="btn sm" type="button" data-restore="' + type.toLowerCase() + ':' + esc(x[key]) + '">Restore</button></div>'; }).join('') : '<div class="empty">None.</div>';
    }
    var D = S.deleted;
    return '<div class="page-head"><h1>Deleted items</h1><span class="hint">Deleted items are kept in the sheet. Restoring brings them back with the same ID.</span></div>' +
      (S.msgs.deleted ? '<p class="msg ' + (S.msgs.deleted.ok ? 'ok' : 'err') + '">' + esc(S.msgs.deleted.text) + '</p>' : '') +
      '<div class="two"><section class="panel"><h2>Streams</h2><div class="list">' + rows(D.streams, 'Stream', 'no', function (x) { return x.name; }) + '</div></section>' +
      '<section class="panel"><h2>Risks and issues</h2><div class="list">' + rows(D.risks, 'Risk', 'id', function (x) { return x.desc; }) + '</div></section></div>' +
      '<section class="panel"><h2>Sub-activities</h2><div class="list">' + rows(D.activities, 'Activity', 'id', function (x) { return x.name; }) + '</div></section>';
  }
  function vSettings() {
    var m = S.msgs.settings;
    return '<h1>Settings</h1><div class="panel" style="max-width:560px"><form class="form" id="setForm" novalidate>' +
      field('stThr', 'At-risk threshold (points behind plan)', '<input id="stThr" type="number" min="0" max="100" step="5" value="' + Math.round(S.settings.threshold * 100) + '">', 'full') +
      '<div class="infobox">A sub-activity is At Risk when its % complete is more than this many points behind the time elapsed between its start and target end.</div>' +
      field('stName', 'App name', '<input id="stName" value="' + esc(S.settings.appName) + '">', 'full') +
      (m ? '<div class="msg ' + (m.ok ? 'ok' : 'err') + '">' + esc(m.text) + '</div>' : '') +
      '<div class="actions"><button class="btn primary" type="submit"' + (S.busy ? ' disabled' : '') + '>Save settings</button></div></form></div>';
  }
  function vMore() {
    var items = [];
    Object.keys(MODES).filter(allowedMode).forEach(function (m) { tabsFor(m).forEach(function (t) { items.push(['#/' + m + '/' + t[0], MODES[m].label + ' › ' + t[1]]); }); });
    var st = syncText();
    return '<h1>More</h1><div class="panel"><div style="display:flex;gap:12px;align-items:center"><span class="avatar" style="width:40px;height:40px;font-size:16px">' + esc(initials(S.me.name || S.me.email)) + '</span><div><b>' + esc(S.me.name || S.me.email) + '</b><div class="hint">' + esc(S.me.email) + ' · ' + esc(S.me.role) + '</div></div></div>' +
      '<div class="sync"><i class="dot ' + st[0] + '"></i><span>' + esc(st[1]) + '</span></div></div>' +
      '<div class="panel"><div class="more-list">' + items.map(function (i) { return '<a href="' + i[0] + '">' + esc(i[1]) + '<span aria-hidden="true">›</span></a>'; }).join('') + '</div></div>' +
      '<div class="panel"><div class="more-list"><button type="button" data-act="refresh">Refresh data</button>' + (DEMO ? '<button type="button" data-act="resetDemo">Reset demo data</button>' : '<button type="button" data-act="signOut">Sign out</button>') + '</div></div>';
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-detail],[data-risk],[data-stream],[data-pick],[data-pick-stream],[data-pick-risk],[data-pick-user],[data-edit-act],[data-edit-risk],[data-color],[data-role],[data-restore]');
    if (!t) return;
    var a = t.getAttribute('data-act');
    if (a === 'closeDetail') { if (e.target === t || t.tagName === 'BUTTON') { S.detail = null; render(); } return; }
    if (a === 'refresh') { S.log = null; S.deleted = null; return refresh(); }
    if (a === 'signOut') return signOut();
    if (a === 'resetDemo') { window.SEGARA_DEMO.reset(); return refresh(); }
    if (a === 'discard') { S.edits = {}; S.msgs.update = null; return render(); }
    if (a === 'saveAll') return saveAll();
    if (a === 'newAct') { S.sel.act = null; S.draft.act = null; S.msgs.act = null; S.confirm = null; return render(); }
    if (a === 'newStream') { S.sel.stream = null; S.draft.stream = null; S.msgs.stream = null; S.confirm = null; return render(); }
    if (a === 'newRisk') { S.sel.risk = null; S.draft.risk = null; S.msgs.risk = null; S.confirm = null; return render(); }
    if (a === 'newUser') { S.sel.user = null; S.draft.user = null; S.msgs.user = null; return render(); }
    if (a === 'cancelDel') { S.confirm = null; return render(); }
    if (a === 'delAct') { S.confirm = 'act'; return render(); }
    if (a === 'delStream') { S.confirm = 'stream'; return render(); }
    if (a === 'delRisk') { S.confirm = 'risk'; return render(); }
    if (a === 'reloadLog') { S.log = null; return render(); }
    if (a === 'delActYes') {
      var act = S.acts.filter(function (x) { return x.id === S.sel.act; })[0];
      S.confirm = null;
      return write('deleteActivity', { id: act.id, version: act.version }, 'act').then(function (r) { if (r) { S.sel.act = null; S.msgs.act = { ok: true, text: 'Deleted ' + act.id + '. An Admin can restore it.' }; refresh(true); } });
    }
    if (a === 'delStreamYes') {
      var no = S.sel.stream; S.confirm = null;
      return write('deleteStream', { no: no }, 'stream').then(function (r) { if (r) { S.sel.stream = null; S.msgs.stream = { ok: true, text: 'Deleted stream ' + no + '.' }; refresh(true); } });
    }
    if (a === 'delRiskYes') {
      var rk = S.risks.filter(function (x) { return x.id === S.sel.risk; })[0]; S.confirm = null;
      return write('deleteRisk', { id: rk.id, version: rk.version }, 'risk').then(function (r) { if (r) { S.sel.risk = null; S.msgs.risk = { ok: true, text: 'Deleted ' + rk.id + '.' }; refresh(true); } });
    }
    if (t.hasAttribute('data-detail')) { S.detail = { kind: 'act', id: t.getAttribute('data-detail') }; return render(); }
    if (t.hasAttribute('data-risk')) { S.detail = { kind: 'risk', id: t.getAttribute('data-risk') }; return render(); }
    if (t.hasAttribute('data-stream')) { e.preventDefault(); S.f = { stream: t.getAttribute('data-stream'), status: '', health: '', owner: '', q: '', done: false }; return go('dashboard', 'list'); }
    if (t.hasAttribute('data-edit-act')) { S.sel.act = t.getAttribute('data-edit-act'); S.msgs.act = null; S.detail = null; return go('input', 'activity'); }
    if (t.hasAttribute('data-edit-risk')) { S.sel.risk = t.getAttribute('data-edit-risk'); S.msgs.risk = null; S.detail = null; return go('input', 'riskform'); }
    if (t.hasAttribute('data-pick')) { S.sel.act = t.getAttribute('data-pick'); S.msgs.act = null; S.confirm = null; S.draft.act = null; render(); return window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (t.hasAttribute('data-pick-stream')) { if (!isAdmin()) return; S.sel.stream = t.getAttribute('data-pick-stream'); S.msgs.stream = null; S.confirm = null; render(); return window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (t.hasAttribute('data-pick-risk')) { S.sel.risk = t.getAttribute('data-pick-risk'); S.msgs.risk = null; S.confirm = null; S.draft.risk = null; render(); return window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (t.hasAttribute('data-pick-user')) { S.sel.user = t.getAttribute('data-pick-user'); S.draft.user = null; S.msgs.user = null; render(); return window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (t.hasAttribute('data-color')) {
      $('#sColor').value = t.getAttribute('data-color');
      document.querySelectorAll('[data-color]').forEach(function (b) { b.setAttribute('aria-pressed', b === t ? 'true' : 'false'); });
      return;
    }
    if (t.hasAttribute('data-role')) {
      var r0 = t.getAttribute('data-role');
      $('#uRole').value = r0;
      document.querySelectorAll('[data-role]').forEach(function (b) { b.setAttribute('aria-pressed', b === t ? 'true' : 'false'); });
      $('#uGrants').hidden = r0 !== 'Editor';
      $('#uRoleHint').textContent = ROLE_HINT[r0];
      return;
    }
    if (t.hasAttribute('data-restore')) {
      var p = t.getAttribute('data-restore').split(':');
      return write('restore', { type: p[0], id: p.slice(1).join(':') }, 'deleted').then(function (r) { if (r) { S.deleted = null; S.msgs.deleted = { ok: true, text: 'Restored ' + r.restored + '.' }; refresh(true); } });
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches && e.target.matches('tr.row, .g-row[data-detail]')) e.target.click();
    if (e.key === 'Escape' && S.detail) { S.detail = null; render(); }
  });
  document.addEventListener('input', function (e) {
    var t = e.target, id = t.getAttribute('data-id'), k = t.getAttribute('data-k');
    if (id && k) {
      setEdit(id, k, t.value);
      t.classList.toggle('ch', !!(S.edits[id] && S.edits[id][k] !== undefined));
      var tr = t.closest('tr'); if (tr) { tr.classList.toggle('dirty', !!S.edits[id]); tr.classList.remove('saved'); }
      if (k === 'status' && S.edits[id] && S.edits[id].pct === 100) { var p = document.getElementById('e-pct-' + id); if (p) p.value = 100; }
      var sb = document.querySelector('.savebar'); var html = savebar();
      if (sb && html) sb.outerHTML = html; else if (!sb && html) $('#main').insertAdjacentHTML('afterend', html); else if (sb && !html) sb.remove();
      return;
    }
    var map = { fStream: 'stream', fStatus: 'status', fHealth: 'health', fOwner: 'owner', fQ: 'q' };
    if (map[t.id]) { S.f[map[t.id]] = t.value; store(LS.filters, S.f); return render(); }
    if (t.id === 'fDone') { S.f.done = t.checked; store(LS.filters, S.f); return render(); }
    if (t.id === 'logQ') { S.logQ = t.value; return render(); }
    if (t.id === 'aStream' && !S.sel.act) { S.draft.act = readActForm(); return render(); }
    if (t.id === 'aStatus' && t.value === 'Completed') { var pc = $('#aPct'); if (pc) pc.value = 100; }
    if ((t.id === 'rImpact' || t.id === 'rLike')) { S.draft.risk = { stream: val('rStream'), type: val('rType'), desc: val('rDesc'), impact: val('rImpact'), like: val('rLike'), owner: val('rOwner'), due: val('rDue'), mit: val('rMit'), status: val('rStatus'), link: val('rLink') }; if (!S.sel.risk) return render(); }
  });
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = e.target.id;
    if (id === 'actForm') return saveActivity();
    if (id === 'streamForm') return saveStream();
    if (id === 'riskForm') return saveRisk();
    if (id === 'userForm') return saveUser();
    if (id === 'setForm') {
      var thr = num(val('stThr'));
      if (thr < 0 || thr > 100) { S.msgs.settings = { text: 'Enter a number from 0 to 100.' }; return render(); }
      return write('saveSettings', { threshold: thr / 100, appName: val('stName') }, 'settings').then(function (r) { if (r) { S.settings = r.settings; S.msgs.settings = { ok: true, text: 'Settings saved.' }; refresh(true); } });
    }
  });
  window.addEventListener('beforeunload', function (e) { if (Object.keys(S.edits).length) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('online', function () { if (S.offline) refresh(true); });
  window.addEventListener('offline', function () { S.offline = true; render(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.loaded && S.lastSync && Date.now() - S.lastSync > 60000 && !Object.keys(S.edits).length) refresh(true);
  });

  /* ---------------- boot ---------------- */
  var f0 = load(LS.filters); if (f0) S.f = Object.assign(S.f, f0, { q: '' });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () { /* app still works without offline cache */ });
  if (DEMO) { S.auth = { token: 'demo', exp: 9e9, email: window.SEGARA_DEMO.email(), name: 'Demo' }; start(); }
  else {
    var a0 = load(LS.token);
    if (tokenValid(a0)) { S.auth = a0; start(); }
    else render();
  }
})();
