/**
 * SEGARA PMO: chat. Comments on each sub-activity, team chat rooms, and an AI assistant.
 *
 * Add this as a new file in the same Apps Script project as Code.gs
 * (Files + > Script, name it "Chat"). It must be listed BELOW Code.gs.
 * Messages are kept in a "Messages" tab that this file creates the first time it runs.
 *
 * AI assistant (optional): in Apps Script open Project Settings > Script properties,
 * add ANTHROPIC_API_KEY with your key from console.anthropic.com. Without it, comments
 * and team chat work and the assistant says it is not set up.
 */

var CHAT = {
  TAB: 'Messages',
  HEADERS: ['ID', 'Time', 'Thread', 'Email', 'Name', 'Text', 'Deleted'],
  MAX_LEN: 2000,
  PAGE: 200,
  AI_MODEL: 'claude-haiku-5-5',
  AI_MAX_TOKENS: 900,
  AI_LIMIT_PER_USER: 40 // questions per person per 6 hours
};

ACTIONS.chatSummary = function (user) { return chatSummary_(user); };
ACTIONS.chatList = function (user, p) { return chatList_(user, p.thread, p.after); };
ACTIONS.chatPost = function (user, p) { return withLock_(function () { return chatPost_(user, p.thread, p.text); }); };
ACTIONS.chatDelete = function (user, p) { return withLock_(function () { return chatDelete_(user, p.id); }); };
ACTIONS.askAI = function (user, p) { return askAI_(user, p.question, p.history); };

function chatSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(CHAT.TAB);
  if (!sh) {
    sh = ss.insertSheet(CHAT.TAB);
    sh.getRange(1, 1, 1, CHAT.HEADERS.length).setValues([CHAT.HEADERS]);
    sh.getRange(1, 1, 1, CHAT.HEADERS.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1f3864');
    sh.setFrozenRows(1);
  }
  return sh;
}

function chatRows_() {
  var sh = chatSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, CHAT.HEADERS.length).getValues().map(function (r, i) {
    return { _row: i + 2, id: str_(r[0]), time: stampStr_(r[1]), thread: str_(r[2]), email: str_(r[3]).toLowerCase(), name: str_(r[4]), text: String(r[5] == null ? '' : r[5]), deleted: isTrue_(r[6]) };
  }).filter(function (m) { return m.id && m.thread; });
}

function cleanMsg_(m) {
  return { id: m.id, time: m.time, thread: m.thread, email: m.email, name: m.name, text: m.deleted ? '' : m.text, deleted: m.deleted };
}

/** Thread names: act:<activity id>, room:all, room:s<stream no>. */
function checkThread_(thread) {
  thread = str_(thread);
  if (thread === 'room:all') return thread;
  var m = thread.match(/^room:s(\d+)$/);
  if (m) {
    var ok = readTable_('Streams').filter(notDeleted_).some(function (s) { return str_(s.no) === m[1]; });
    if (ok) return thread;
  }
  m = thread.match(/^act:(\d+\.\d+)$/);
  if (m) {
    var found = readTable_('Activities').filter(notDeleted_).some(function (a) { return str_(a.id) === m[1]; });
    if (found) return thread;
  }
  throw err_('invalid', 'That conversation no longer exists.');
}

function chatSummary_(user) {
  var threads = {};
  chatRows_().forEach(function (m) {
    if (m.deleted) return;
    var t = threads[m.thread] || (threads[m.thread] = { n: 0, last: '', at: '', by: '' });
    t.n++;
    if (m.id > t.last) { t.last = m.id; t.at = m.time; t.by = m.email === user.email ? 'you' : (m.name || m.email); }
  });
  return { threads: threads, ai: !!aiKey_() };
}

function chatList_(user, thread, after) {
  thread = checkThread_(thread);
  after = str_(after);
  var list = chatRows_().filter(function (m) { return m.thread === thread; });
  list.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  if (after) list = list.filter(function (m) { return m.id > after; });
  else list = list.slice(-CHAT.PAGE);
  return { thread: thread, messages: list.map(cleanMsg_) };
}

function chatPost_(user, thread, text) {
  thread = checkThread_(thread);
  text = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!text) throw err_('invalid', 'Write a message first.');
  if (text.length > CHAT.MAX_LEN) throw err_('invalid', 'Messages can be up to ' + CHAT.MAX_LEN + ' characters.');
  var id = String(Date.now()) + String(Math.floor(Math.random() * 1000) + 1000).slice(1);
  var safe = /^[=+\-@]/.test(text) ? "'" + text : text; // stop the sheet treating a message as a formula
  var sh = chatSheet_();
  var row = Math.max(2, sh.getLastRow() + 1);
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);
  sh.getRange(row, 1, 1, CHAT.HEADERS.length).setValues([[id, nowStamp_(), thread, user.email, user.name || user.email, safe, false]]);
  return { message: { id: id, time: nowStamp_(), thread: thread, email: user.email, name: user.name || user.email, text: text, deleted: false } };
}

function chatDelete_(user, id) {
  id = str_(id);
  var m = chatRows_().filter(function (x) { return x.id === id; })[0];
  if (!m) throw err_('invalid', 'That message was not found.');
  if (m.email !== user.email && user.role !== 'Admin') throw err_('forbidden', 'You can only delete your own messages.');
  chatSheet_().getRange(m._row, 7, 1, 1).setValues([[true]]);
  return { deleted: id };
}

/* ------------------------------------------------------------------ */
/* AI assistant                                                        */
/* ------------------------------------------------------------------ */

function aiKey_() {
  try { return PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || ''; } catch (e) { return ''; }
}

function askAI_(user, question, history) {
  question = String(question == null ? '' : question).trim();
  if (!question) throw err_('invalid', 'Type a question first.');
  if (question.length > 1500) throw err_('invalid', 'Keep the question under 1,500 characters.');
  var key = aiKey_();
  if (!key) throw err_('ai_off', 'The AI assistant is not set up yet. An Admin adds the ANTHROPIC_API_KEY in Apps Script.');

  var cache = CacheService.getScriptCache();
  var ck = 'ai_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, user.email));
  var used = Number(cache.get(ck) || 0);
  if (used >= CHAT.AI_LIMIT_PER_USER) throw err_('busy', 'You have reached ' + CHAT.AI_LIMIT_PER_USER + ' questions for now. Try again in a few hours.');
  cache.put(ck, String(used + 1), 21600);

  var msgs = [];
  (Array.isArray(history) ? history : []).slice(-6).forEach(function (h) {
    if (!h || (h.role !== 'user' && h.role !== 'assistant')) return;
    var t = String(h.text || '').slice(0, 2000);
    if (!t) return;
    if (msgs.length && msgs[msgs.length - 1].role === h.role) return;
    msgs.push({ role: h.role, content: t });
  });
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
  msgs.push({ role: 'user', content: question });

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: CHAT.AI_MODEL, max_tokens: CHAT.AI_MAX_TOKENS, system: aiSystem_(user), messages: msgs }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 401 || code === 403) throw err_('ai_off', 'The AI key was refused. An Admin should check ANTHROPIC_API_KEY in Apps Script.');
  if (code === 429 || code >= 500) throw err_('busy', 'The AI assistant is busy. Try again in a minute.');
  if (code !== 200) { console.error('AI error ' + code + ': ' + res.getContentText()); throw err_('server', 'The AI assistant could not answer (' + code + ').'); }
  var body = JSON.parse(res.getContentText());
  var text = (body.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n').trim();
  return { answer: text || 'No answer came back. Try asking in a different way.' };
}

function aiSystem_(user) {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var th = readSettings_().threshold;
  var streams = readTable_('Streams').filter(notDeleted_).map(cleanStream_);
  var acts = readTable_('Activities').filter(notDeleted_).map(cleanActivity_);
  var risks = readTable_('Risks').filter(notDeleted_).map(cleanRisk_);
  var lines = [];
  lines.push('STREAMS (no | name | lead):');
  streams.forEach(function (s) { lines.push(s.no + ' | ' + s.name + ' | ' + (s.lead || 'TBD')); });
  lines.push('', 'SUB-ACTIVITIES (id | name | owner | status | start | target end | % complete | health | depends on | notes):');
  acts.forEach(function (a) {
    lines.push([a.id, a.name, a.owner || 'TBD', a.status, a.start || '-', a.end || '-', a.pct + '%', scheduleHealth(a, today, th), a.dep || '-', (a.notes || '').slice(0, 160) || '-'].join(' | '));
  });
  lines.push('', 'RISKS AND ISSUES (id | stream | type | description | severity | owner | due | status):');
  risks.forEach(function (r) { lines.push([r.id, r.stream, r.type, r.desc.slice(0, 200), r.sev, r.owner || '-', r.due || '-', r.status].join(' | ')); });
  return [
    'You are the assistant inside SEGARA PMO, the programme tracker for launching SEGARA, an Indonesian pawnshop (gadai) business: OJK licensing, branches, software, funding, sales and handphone sales.',
    'Today is ' + today + ' (Asia/Jakarta). You are talking to ' + (user.name || user.email) + ', whose role is ' + user.role + '.',
    'Answer from the programme data below. Be concise and practical: short paragraphs or short lists, IDs in front of sub-activities (for example "2.3 Lease negotiation"). Dates as "12 Dec 2026".',
    'Health rules: Overdue = target end passed and not completed; Late Start = not started after its start date; At Risk = % complete more than ' + Math.round(th * 100) + ' points behind plan.',
    'Reply in the language the person writes in (Bahasa Indonesia or English).',
    'You cannot change the data. If asked to update something, say what to change and where in the app (Input > Weekly update, or Input > Add or edit sub-activity).',
    'If the data does not answer the question, say so. General advice about OJK, pawnshop operations or project management is fine, but mark it as general guidance, not legal advice.',
    '',
    lines.join('\n')
  ].join('\n');
}
