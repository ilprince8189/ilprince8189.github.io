/**
 * PMO SEGERA: file attachments for each sub-activity.
 *
 * Add this as a new file in the same Apps Script project as Code.gs, listed BELOW Code.gs.
 * Files are stored in the script owner's Google Drive, in a folder called "PMO SEGERA files"
 * with one sub-folder per sub-activity. They stay private: the app downloads them through
 * this script, so team members never need Drive access. A list of files is kept in an
 * "Attachments" tab that this file creates the first time it runs.
 *
 * Needs the Drive permission: add "https://www.googleapis.com/auth/drive" to oauthScopes in
 * appsscript.json, then run filesSetup() once from the editor and approve.
 */

var FILES = {
  TAB: 'Attachments',
  HEADERS: ['ID', 'Time', 'Activity', 'File name', 'Type', 'Size (bytes)', 'Drive file ID', 'Email', 'Name', 'Deleted'],
  FOLDER: 'PMO SEGERA files',
  MAX_BYTES: 10 * 1024 * 1024
};

ACTIONS.filesCounts = function () { return filesCounts_(); };
ACTIONS.filesList = function (user, p) { return filesList_(p.activity); };
ACTIONS.fileUpload = function (user, p) { return withLock_(function () { return fileUpload_(user, p); }); };
ACTIONS.fileDownload = function (user, p) { return fileDownload_(p.id); };
ACTIONS.fileDelete = function (user, p) { return withLock_(function () { return fileDelete_(user, p.id); }); };

/** Run once from the editor: asks for the Drive permission and creates the folder and tab. */
function filesSetup() {
  var f = filesRoot_();
  filesSheet_();
  Logger.log('Files are ready. Drive folder: %s', f.getUrl());
}

function filesSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(FILES.TAB);
  if (!sh) {
    sh = ss.insertSheet(FILES.TAB);
    sh.getRange(1, 1, 1, FILES.HEADERS.length).setValues([FILES.HEADERS]);
    sh.getRange(1, 1, 1, FILES.HEADERS.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1f3864');
    sh.setFrozenRows(1);
  }
  return sh;
}

function filesRoot_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FILES_FOLDER_ID');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* folder gone: make a new one */ } }
  var folder = DriveApp.createFolder(FILES.FOLDER);
  props.setProperty('FILES_FOLDER_ID', folder.getId());
  return folder;
}

function activityFolder_(actId) {
  var root = filesRoot_();
  var it = root.getFoldersByName(actId);
  return it.hasNext() ? it.next() : root.createFolder(actId);
}

function fileRows_() {
  var sh = filesSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, FILES.HEADERS.length).getValues().map(function (r, i) {
    return { _row: i + 2, id: str_(r[0]), time: stampStr_(r[1]), activity: str_(r[2]), name: str_(r[3]), type: str_(r[4]), size: Number(r[5]) || 0,
      driveId: str_(r[6]), email: str_(r[7]).toLowerCase(), by: str_(r[8]), deleted: isTrue_(r[9]) };
  }).filter(function (f) { return f.id && !f.deleted; });
}

function cleanFile_(f) { return { id: f.id, time: f.time, activity: f.activity, name: f.name, type: f.type, size: f.size, email: f.email, by: f.by }; }

function findActivity_(actId) {
  actId = str_(actId);
  var a = readTable_('Activities').filter(notDeleted_).filter(function (x) { return str_(x.id) === actId; })[0];
  if (!a) throw err_('invalid', 'That sub-activity no longer exists.');
  return cleanActivity_(a);
}

function filesCounts_() {
  var counts = {};
  fileRows_().forEach(function (f) { counts[f.activity] = (counts[f.activity] || 0) + 1; });
  return { counts: counts, maxBytes: FILES.MAX_BYTES };
}

function filesList_(actId) {
  var a = findActivity_(actId);
  var list = fileRows_().filter(function (f) { return f.activity === a.id; }).sort(function (x, y) { return x.id < y.id ? 1 : -1; });
  return { activity: a.id, files: list.map(cleanFile_) };
}

function safeFileName_(n) {
  n = String(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (n || 'file').slice(0, 150);
}

function fileUpload_(user, p) {
  var a = findActivity_(p.activity);
  if (!canEditStream_(user, a.stream)) throw err_('forbidden', 'You can attach files only in the streams you can edit.');
  var name = safeFileName_(p.name);
  var data = String(p.data || '');
  if (!data) throw err_('invalid', 'The file is empty.');
  var bytes = Utilities.base64Decode(data);
  if (!bytes.length) throw err_('invalid', 'The file is empty.');
  if (bytes.length > FILES.MAX_BYTES) throw err_('invalid', name + ' is larger than ' + Math.round(FILES.MAX_BYTES / 1048576) + ' MB.');
  var type = /^[\w.+-]+\/[\w.+-]+$/.test(String(p.type || '')) ? String(p.type) : 'application/octet-stream';
  var file = activityFolder_(a.id).createFile(Utilities.newBlob(bytes, type, name));
  file.setDescription('PMO SEGERA ' + a.id + ' · uploaded by ' + user.email);
  var id = 'f' + Date.now() + String(Math.floor(Math.random() * 1000) + 1000).slice(1);
  var sh = filesSheet_();
  var row = Math.max(2, sh.getLastRow() + 1);
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  var now = nowStamp_();
  sh.getRange(row, 1, 1, FILES.HEADERS.length).setValues([[id, now, a.id, name, type, bytes.length, file.getId(), user.email, user.name || user.email, false]]);
  appendLog_([[user.email, 'Activity', a.id, 'File added', '', name]]);
  return { file: { id: id, time: now, activity: a.id, name: name, type: type, size: bytes.length, email: user.email, by: user.name || user.email } };
}

function fileDownload_(id) {
  var f = fileRows_().filter(function (x) { return x.id === str_(id); })[0];
  if (!f) throw err_('invalid', 'That file was not found. It may have been deleted.');
  var blob;
  try { blob = DriveApp.getFileById(f.driveId).getBlob(); } catch (e) { throw err_('invalid', 'The file is missing from Google Drive.'); }
  return { name: f.name, type: f.type, data: Utilities.base64Encode(blob.getBytes()) };
}

function fileDelete_(user, id) {
  var f = fileRows_().filter(function (x) { return x.id === str_(id); })[0];
  if (!f) throw err_('invalid', 'That file was not found.');
  if (f.email !== user.email && user.role !== 'Admin') throw err_('forbidden', 'Only the person who added the file, or an Admin, can delete it.');
  try { DriveApp.getFileById(f.driveId).setTrashed(true); } catch (e) { /* already gone from Drive */ }
  filesSheet_().getRange(f._row, 10, 1, 1).setValues([[true]]);
  appendLog_([[user.email, 'Activity', f.activity, 'File deleted', f.name, '']]);
  return { deleted: f.id };
}
