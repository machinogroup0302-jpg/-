// お気に入り・あなたの設定（メール・予算など）を、パソコンとスマホで共有するための保存場所
// ・サーバーのメモリに置き、GitHub Actions（10分ごと）が暗号化したコピーをリポジトリに保存する
//   → サーバーが再起動しても、起動時にそのコピーを読み込んで元に戻す
// ・コピーはサイトのパスワード（SITE_PASSWORD）から作った鍵で暗号化するので、公開リポジトリでも中身は読めない
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.PREFS_REPO || 'machinogroup0302-jpg/-';
const BRANCH = process.env.PREFS_BRANCH || 'claude/trusting-planck-dsasvf';
const BACKUP_PATH = 'alerts/prefs.json';
const LOCAL = path.join(os.tmpdir(), 'ma-prefs.json');
const SECRET = process.env.PREFS_KEY || process.env.SITE_PASSWORD || '';
export const SYNC_KEY = /^(favs_(fx|stock|us)|profile)$/;
const MAX_SIZE = 200 * 1024;

let data = {}; // { key: { value, ts } }
let ready = null;
let restoredFrom = '';
let lastBackupAt = 0;

const KEY = crypto.createHash('sha256').update('ma-prefs-v1:' + SECRET).digest();

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

function merge(other) {
  for (const [k, v] of Object.entries(other || {})) {
    if (SYNC_KEY.test(k) && v && (!data[k] || v.ts > data[k].ts)) data[k] = v;
  }
}

const maxTs = () => Math.max(0, ...Object.values(data).map((v) => v.ts || 0));

// GitHub に保存されている暗号化コピーを読む（認証なしで読める公開の場所）
async function readBackup() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${BACKUP_PATH}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'market-analyzer' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j.blob ? decrypt(j.blob) : null;
}

export function loadPrefs() {
  ready ||= (async () => {
    try { merge(JSON.parse(await fs.readFile(LOCAL, 'utf8'))); restoredFrom = 'local'; } catch { /* まだない */ }
    if (process.env.NODE_ENV === 'test') return;
    try {
      const b = await readBackup();
      if (b) { merge(b); restoredFrom = 'backup'; }
    } catch (e) {
      console.error('お気に入りのコピーを読めませんでした:', e.message);
    }
  })();
  return ready;
}

export async function getPrefs() {
  await loadPrefs();
  // 10分ごとの保存が最近あれば「ずっと共有できている」
  const durable = Date.now() - lastBackupAt < 40 * 60 * 1000;
  return { items: data, durable, restoredFrom, lastBackupAt };
}

function cleanProfile(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('保存する内容が正しくありません'), { status: 400, expose: true });
  const email = String(v.email || '').trim().slice(0, 120);
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw Object.assign(new Error('メールアドレスの形が正しくありません'), { status: 400, expose: true });
  const num = (x, lo, hi, def) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  return {
    email,
    budget: Math.round(num(v.budget, 0, 1e10, 0)),
    riskPct: num(v.riskPct, 0.5, 10, 2),
    maxPos: Math.round(num(v.maxPos, 1, 10, 3)),
    notify: { fx: !!v.notify?.fx, stock: !!v.notify?.stock, us: !!v.notify?.us },
  };
}

// 新しい値を保存して、サーバーが付けた時刻を返す
export async function putPref(key, value) {
  if (!SYNC_KEY.test(key)) throw Object.assign(new Error('保存できない項目です'), { status: 400, expose: true });
  let clean;
  if (key === 'profile') clean = cleanProfile(value);
  else {
    if (!Array.isArray(value) || JSON.stringify(value).length > MAX_SIZE) throw Object.assign(new Error('保存する内容が正しくありません'), { status: 400, expose: true });
    clean = value.slice(0, 500).map((x) => ({ code: String(x?.code ?? '').slice(0, 20), name: String(x?.name ?? '').slice(0, 60) })).filter((x) => x.code);
  }
  await loadPrefs();
  const ts = Math.max(Date.now(), (data[key]?.ts || 0) + 1);
  data[key] = { value: clean, ts };
  fs.writeFile(LOCAL, JSON.stringify(data)).catch(() => {});
  return { ts };
}

// GitHub Actions が取りに来る：暗号化したコピー
export async function backupBlob() {
  await loadPrefs();
  lastBackupAt = Date.now();
  return { maxTs: maxTs(), blob: encrypt(data) };
}

// GitHub Actions のメール送信用：あなたの設定とお気に入り
export async function alertProfile() {
  await loadPrefs();
  return {
    profile: data.profile?.value || null,
    favs: { fx: data.favs_fx?.value || null, stock: data.favs_stock?.value || null, us: data.favs_us?.value || null },
  };
}

// テスト用
export function _reset() { data = {}; ready = null; }
