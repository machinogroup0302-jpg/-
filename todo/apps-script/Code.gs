/**
 * やることボード（Google スプレッドシート版）
 *
 * このスクリプトを入れたスプレッドシートの「data」シートに、
 * ToDoリスト・スケジュール・支払い・チェックのデータを保存します。
 * 画面（HTML）は GitHub から読み込むので、画面の修正は自動で反映されます。
 */
const PAGE_URL = 'https://raw.githubusercontent.com/machinogroup0302-jpg/-/refs/heads/claude/jolly-goldberg-1a7dqb/todo/index.html';
const DOC_NAMES = ['tasks', 'schedule', 'fixed', 'checks'];
const CHUNK = 40000; // 1つのセルに入れる文字数（上限 50,000 より少なめ）

function doGet() {
  const cache = CacheService.getScriptCache();
  let html = cache.get('page');
  if (!html) {
    html = UrlFetchApp.fetch(PAGE_URL).getContentText('UTF-8');
    try { cache.put('page', html, 600); } catch (e) { /* 大きすぎて入らないときは毎回読む */ }
  }
  return HtmlService.createHtmlOutput(html)
    .setTitle('やることボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function dataSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName('data') || ss.insertSheet('data');
}

/** 全部のデータを { tasks: "JSON", ... } の形で返す */
function loadAll() {
  const sh = dataSheet_();
  if (sh.getLastRow() === 0) return {};
  const out = {};
  sh.getDataRange().getDisplayValues().forEach(row => {
    if (DOC_NAMES.indexOf(row[0]) >= 0) out[row[0]] = row.slice(1).join('');
  });
  return out;
}

/** 1つのデータ（JSON 文字列）を保存する。長いときは横のセルに分けて入れる */
function saveDoc(name, json) {
  if (DOC_NAMES.indexOf(name) < 0) throw new Error('unknown: ' + name);
  JSON.parse(json); // 壊れたデータは保存しない
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = dataSheet_();
    const chunks = [];
    for (let i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
    const width = chunks.length + 1;
    if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    const names = sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(r => r[0]) : [];
    let row = names.indexOf(name) + 1;
    if (!row) row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, sh.getMaxColumns()).clearContent();
    const range = sh.getRange(row, 1, 1, width);
    range.setNumberFormat('@'); // 数字や「=」で始まる部分を勝手に変換させない
    range.setValues([[name].concat(chunks)]);
  } finally {
    lock.releaseLock();
  }
  return true;
}
