/**
 * 相場分析サイトの控えを、自分の Google ドライブに自動で取っておく（Google Apps Script）
 *
 * 1時間ごとに GitHub からサイト一式（ZIP）を取ってきて、中身が変わっていたら
 * ドライブの「相場分析サイト_控え」フォルダに保存する。新しい方から3つだけ残す。
 * パソコンに「Google ドライブ（パソコン版）」を入れておけば、パソコンにも自動で入る。
 *
 * 使い方：script.google.com →「新しいプロジェクト」→ これを全部貼る →
 *   上の関数の選択で「setup」を選んで ▶実行 → 許可する。これで終わり。
 */
const ZIP_URL = 'https://codeload.github.com/machinogroup0302-jpg/-/zip/refs/heads/claude/trusting-planck-dsasvf';
const FOLDER_NAME = '相場分析サイト_控え';
const KEEP = 3;

function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backup').timeBased().everyHours(1).create();
  backup();
}

function backup() {
  const res = UrlFetchApp.fetch(ZIP_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('GitHub から取れませんでした: ' + res.getResponseCode());
  const bytes = res.getBlob().getBytes();
  const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('hash') === hash) return; // 変わっていない

  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd_HHmm');
  folder.createFile(Utilities.newBlob(bytes, 'application/zip', `相場分析サイト_${stamp}.zip`));
  props.setProperty('hash', hash);

  // 古いものは3つを超えたらゴミ箱へ
  const files = [];
  const it = folder.getFilesByType('application/zip');
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(KEEP).forEach((f) => f.setTrashed(true));
}
