// お気に入り・あなたの設定・持っている株・取引履歴を、パソコンとスマホで共有するための保存場所
// ・使う人（アカウント）ごとに別々に保存する（持ち主＝admin と、持ち主が追加した人）
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
export const SYNC_KEY = /^(favs_(fx|stock|us)|holdings_(fx|stock|us)|trades_(fx|stock|us)|profile)$/;
const USERS = '__users';
const MAX_SIZE = 200 * 1024;
const MAX_TRADES_SIZE = 4 * 1024 * 1024;
export const ADMIN = 'admin';

// { 保存キー: { value, ts } }  保存キーは admin なら "profile"、ほかの人は "taro|profile"
let data = {};
let ready = null;
let restoredFrom = '';
let lastBackupAt = 0;
let lastAlertAt = 0;

const KEY = crypto.createHash('sha256').update('ma-prefs-v1:' + SECRET).digest();
const bad = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });

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

const storeKey = (uid, key) => (uid === ADMIN ? key : `${uid}|${key}`);
const splitKey = (k) => (k.includes('|') ? k.split('|') : [ADMIN, k]);
const validKey = (k) => k === USERS || SYNC_KEY.test(splitKey(k)[1].replace(/~prev$/, ''));

function merge(other) {
  for (const [k, v] of Object.entries(other || {})) {
    if (validKey(k) && v && (!data[k] || v.ts > data[k].ts)) data[k] = v;
  }
}

const maxTs = () => Math.max(0, ...Object.values(data).map((v) => v.ts || 0));
const saveLocal = () => (process.env.NODE_ENV === 'test' && !process.env.PREFS_LOCAL ? Promise.resolve() : fs.writeFile(LOCAL, JSON.stringify(data)).catch(() => {}));

// GitHub に保存されている暗号化コピーを読む（認証なしで読める公開の場所）
// ・まず raw.githubusercontent.com（回数の制限がない）、だめなら GitHub API（1時間60回まで）
async function readBackup() {
  const urls = [
    [`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(BRANCH)}/${BACKUP_PATH}?t=${Date.now()}`, {}],
    [`https://api.github.com/repos/${REPO}/contents/${BACKUP_PATH}?ref=${encodeURIComponent(BRANCH)}`, { Accept: 'application/vnd.github.raw+json' }],
  ];
  let lastErr;
  for (const [url, headers] of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'market-analyzer', ...headers }, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return j.blob ? decrypt(j.blob) : null;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// バックアップを読めたか：読めるまでは、サーバーの中身でバックアップを上書きしない（空っぽで上書きして消えるのを防ぐ）
let restoreOk = false;
let retryTimer = null;
async function tryRestore() {
  try {
    const b = await readBackup();
    if (b) { merge(b); restoredFrom = 'backup'; }
    restoreOk = true;
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    saveLocal();
    return true;
  } catch (e) {
    console.error('お気に入りのコピーを読めませんでした（あとでもう一度読みます）:', e.message);
    // 1分ごとに読み直す（読めたら、そのときの内容と合わせる。新しい方が残る）
    retryTimer ||= setInterval(tryRestore, 60 * 1000);
    return false;
  }
}
export const restoreState = () => ({ ok: restoreOk, from: restoredFrom });

export function loadPrefs() {
  ready ||= (async () => {
    if (process.env.NODE_ENV === 'test' && !process.env.PREFS_LOCAL) { restoreOk = true; return; } // テストでは前の保存を読まない
    try { merge(JSON.parse(await fs.readFile(LOCAL, 'utf8'))); restoredFrom = 'local'; } catch { /* まだない */ }
    if (process.env.NODE_ENV === 'test') { restoreOk = true; return; }
    await tryRestore();
  })();
  return ready;
}

function itemsOf(uid) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === USERS) continue;
    const [u, key] = splitKey(k);
    if (u === uid) out[key] = v;
  }
  return out;
}

export async function getPrefs(uid = ADMIN) {
  await loadPrefs();
  // 10分ごとの保存が最近あれば「ずっと共有できている」
  const durable = Date.now() - lastBackupAt < 40 * 60 * 1000;
  return { items: itemsOf(uid), durable, restoredFrom, lastBackupAt, lastAlertAt };
}

function cleanProfile(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('保存する内容が正しくありません');
  const email = String(v.email || '').trim().slice(0, 120);
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw bad('メールアドレスの形が正しくありません');
  const num = (x, lo, hi, def) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  return {
    email,
    budget: Math.round(num(v.budget, 0, 1e10, 0)),
    marginBudget: Math.round(num(v.marginBudget, 0, 1e10, 0)),
    riskPct: num(v.riskPct, 0.5, 10, 2),
    maxPos: Math.round(num(v.maxPos, 1, 10, 3)),
    swingDays: Math.round(num(v.swingDays, 1, 120, 30)),
    notify: { fx: !!v.notify?.fx, stock: !!v.notify?.stock, us: !!v.notify?.us },
    notifyDay: v.notifyDay !== false,
    levStock: num(v.levStock, 1, 3.3, 1),
    levUs: num(v.levUs, 1, 2, 1),
    fxLots: Math.round(num(v.fxLots, 0, 1000, 0) * 10) / 10,
    fxLotSize: [1000, 10000, 100000].includes(Number(v.fxLotSize)) ? Number(v.fxLotSize) : 10000,
    stockAcct: ['cash', 'margin', 'both'].includes(v.stockAcct) ? v.stockAcct : (Number(v.levStock) > 1 ? 'margin' : 'cash'),
    stockMarginBudget: Math.round(num(v.stockMarginBudget, 0, 1e10, 0)),
    stockShort: !!v.stockShort,
    fxSides: ['both', 'long', 'short'].includes(v.fxSides) ? v.fxSides : 'both',
    // 自動で選んだ一番いいやり方と、見ているやり方（パソコンとスマホで共有）
    bestWay: wayMap(v.bestWay),
    wayView: wayMap(v.wayView),
  };
}

const str = (x, n) => String(x ?? '').slice(0, n);
const wayMap = (o) => Object.fromEntries(['fx', 'stock', 'us'].filter((k) => /^[a-zA-Z]{1,12}$/.test(o?.[k] || '')).map((k) => [k, o[k]]));
const numOrNull = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

function cleanValue(key, value) {
  if (key === 'profile') return cleanProfile(value);
  if (!Array.isArray(value)) throw bad('保存する内容が正しくありません');
  const size = JSON.stringify(value).length;
  if (key.startsWith('trades_')) {
    if (size > MAX_TRADES_SIZE) throw bad('取引履歴が多すぎて保存できません');
    return value.slice(0, 20000).map((t) => ({
      date: str(t?.date, 30), symbol: str(t?.symbol, 60), side: str(t?.side, 4), qty: numOrNull(t?.qty) ?? 0, price: numOrNull(t?.price) ?? 0,
      entry: numOrNull(t?.entry), pnl: numOrNull(t?.pnl), openDate: t?.openDate ? str(t.openDate, 30) : null, code: str(t?.code, 20), file: str(t?.file, 20), kind: ['cash', 'margin', 'short'].includes(t?.kind) ? t.kind : '',
    }));
  }
  if (size > MAX_SIZE) throw bad('保存する内容が正しくありません');
  if (key.startsWith('holdings_')) {
    return value.slice(0, 100).map((x) => ({
      code: str(x?.code, 20), name: str(x?.name, 60), side: Number(x?.side) < 0 ? -1 : 1,
      price: Number(x?.price) || 0, qty: Number(x?.qty) || 0, date: /^\d{4}-\d{2}-\d{2}$/.test(x?.date || '') ? x.date : '', id: str(x?.id, 20), acct: x?.acct === 'margin' ? 'margin' : 'cash',
      buys: Array.isArray(x?.buys) ? x.buys.slice(0, 50).map((b) => ({ price: Number(b?.price) || 0, qty: Number(b?.qty) || 0, date: /^\d{4}-\d{2}-\d{2}$/.test(b?.date || '') ? b.date : '' })).filter((b) => b.price > 0 && b.qty > 0) : [],
    })).filter((x) => x.code && x.price > 0);
  }
  return value.slice(0, 500).map((x) => ({ code: str(x?.code, 20), name: str(x?.name, 60) })).filter((x) => x.code);
}

// 新しい値を保存して、サーバーが付けた時刻を返す
export async function putPref(uid, key, value) {
  if (!SYNC_KEY.test(key)) throw bad('保存できない項目です');
  const clean = cleanValue(key, value);
  await loadPrefs();
  const k = storeKey(uid, key);
  // 持っている株・取引履歴・お気に入りを、空っぽで上書きするときは、前の中身を1つとっておく（消えたときに戻せるように）
  if (Array.isArray(clean) && !clean.length && Array.isArray(data[k]?.value) && data[k].value.length) {
    data[`${k}~prev`] = { value: data[k].value, ts: data[k].ts };
  }
  const ts = Math.max(Date.now(), (data[k]?.ts || 0) + 1);
  data[k] = { value: clean, ts };
  saveLocal();
  return { ts };
}

// ---------------- 使う人（アカウント） ----------------
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const usersList = () => data[USERS]?.value || [];
function setUsers(list) {
  data[USERS] = { value: list, ts: Math.max(Date.now(), (data[USERS]?.ts || 0) + 1) };
  saveLocal();
}

export async function listUsers() {
  await loadPrefs();
  return usersList().map(({ id, name, createdAt }) => ({ id, name, createdAt, email: data[storeKey(id, 'profile')]?.value?.email ? '設定あり' : '' }));
}

export async function addUser({ id, name, password }) {
  await loadPrefs();
  id = String(id || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,20}$/.test(id)) throw bad('IDは半角の英数字（3〜20文字）にしてください');
  if (id === ADMIN) throw bad('admin は持ち主用のIDなので使えません');
  if (String(password || '').length < 6) throw bad('パスワードは6文字以上にしてください');
  if (usersList().some((u) => u.id === id)) throw bad('そのIDはもう使われています');
  const salt = crypto.randomBytes(16).toString('hex');
  setUsers([...usersList(), { id, name: str(name || id, 30), salt, hash: hashPass(password, salt), createdAt: Date.now() }]);
  return { id };
}

export async function setUserPassword(id, password) {
  await loadPrefs();
  if (String(password || '').length < 6) throw bad('パスワードは6文字以上にしてください');
  const list = usersList();
  const u = list.find((x) => x.id === id);
  if (!u) throw bad('その人は見つかりませんでした');
  const salt = crypto.randomBytes(16).toString('hex');
  setUsers(list.map((x) => (x.id === id ? { ...x, salt, hash: hashPass(password, salt) } : x)));
}

export async function removeUser(id) {
  await loadPrefs();
  setUsers(usersList().filter((u) => u.id !== id));
  for (const k of Object.keys(data)) if (k.startsWith(`${id}|`)) delete data[k];
  saveLocal();
}

// ID とパスワードが合っていれば、その人の情報を返す
export async function checkUser(id, password) {
  await loadPrefs();
  const u = usersList().find((x) => x.id === String(id || '').trim().toLowerCase());
  if (!u) return null;
  const h = hashPass(password, u.salt);
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash)) ? { id: u.id, name: u.name } : null;
}

export async function userExists(id) {
  await loadPrefs();
  return id === ADMIN || usersList().some((u) => u.id === id);
}

export async function userName(id) {
  await loadPrefs();
  return id === ADMIN ? '持ち主' : usersList().find((u) => u.id === id)?.name || id;
}

// ---------------- GitHub Actions 用 ----------------
// 暗号化したコピー
export async function backupBlob() {
  await loadPrefs();
  if (!restoreOk && !(await tryRestore())) throw Object.assign(new Error('バックアップをまだ読み込めていないので、上書きしません'), { status: 503, expose: true });
  lastBackupAt = Date.now();
  return { maxTs: maxTs(), blob: encrypt(data) };
}

// メール送信用：使う人ごとの設定・お気に入り・持っている株
export async function alertProfile() {
  await loadPrefs();
  lastAlertAt = Date.now();
  const one = (uid) => {
    const g = (k) => data[storeKey(uid, k)]?.value;
    return {
      uid,
      profile: g('profile') || null,
      favs: { fx: g('favs_fx') || null, stock: g('favs_stock') || null, us: g('favs_us') || null },
      holdings: { fx: g('holdings_fx') || [], stock: g('holdings_stock') || [], us: g('holdings_us') || [] },
    };
  };
  const users = [one(ADMIN), ...usersList().map((u) => one(u.id))];
  // 以前の形（持ち主だけ）も入れておく
  return { ...users[0], users };
}

// テスト用
export function _reset() { data = {}; ready = null; }
