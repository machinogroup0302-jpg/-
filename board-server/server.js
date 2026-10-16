// やることボード（Render 用のサーバー）
// ・画面は ../todo/index.html を読み込んで出す（画面の元は1つだけ）
// ・BOARD_PASSWORD でログイン。データはサーバーのファイルに保存し、
//   GITHUB_TOKEN があれば暗号化したコピーを GitHub の非公開 Gist にも置く
//   （Render の無料プランは再起動でファイルが消えるため、起動時にそこから戻す）
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.BOARD_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('board-session:' + PASSWORD).digest('hex');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GIST_FILE = 'yarukoto-board.enc.json';
const LOCAL = process.env.DATA_FILE || path.join(os.tmpdir(), 'yarukoto-board.json');
const DOCS = ['tasks', 'schedule', 'fixed', 'checks'];
const MAX_DOC = 1024 * 1024;

// ---------------- 画面 ----------------
let page = '';
async function loadPage() {
  const body = await fs.readFile(path.join(here, '..', 'todo', 'index.html'), 'utf8');
  page = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1b2a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="やることボード">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<script>window.BOARD_SERVER = true;</script>
<style>:root{padding-top:env(safe-area-inset-top,0px)}</style>
</head>
<body>
${body}
</body>
</html>`;
}
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1b2a"/><rect x="14" y="16" width="36" height="34" rx="5" fill="#fff"/><rect x="14" y="16" width="36" height="9" rx="4" fill="#f5c518"/><path d="M22 37l5 5 11-12" stroke="#0d1b2a" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------- データ ----------------
// data = { tasks: { value, ts }, ... }
let data = {};
const KEY = crypto.createHash('sha256').update('yarukoto-board-v1:' + (process.env.BACKUP_KEY || PASSWORD)).digest();
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
function merge(other) {
  for (const n of DOCS) {
    const v = other?.[n];
    if (v && typeof v.ts === 'number' && (!data[n] || v.ts > data[n].ts)) data[n] = v;
  }
}
const saveLocal = () => fs.writeFile(LOCAL, JSON.stringify(data)).catch((e) => console.error('ファイルに保存できませんでした:', e.message));

// ---- GitHub の非公開 Gist に暗号化コピーを置く ----
let gistId = process.env.GIST_ID || '';
let backupTimer = null;
let restored = !GITHUB_TOKEN; // コピーを読めるまでは上書きしない（空っぽで上書きして消えるのを防ぐ）
async function gh(url, opts = {}) {
  const res = await fetch((process.env.GITHUB_API || 'https://api.github.com') + url, {
    ...opts,
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'yarukoto-board', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}
async function findGist() {
  if (gistId) return gistId;
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files && g.files[GIST_FILE]);
    if (hit) return (gistId = hit.id);
    if (list.length < 100) break;
  }
  return '';
}
async function restoreFromGist() {
  if (!GITHUB_TOKEN) return;
  try {
    const id = await findGist();
    if (id) {
      const g = await gh(`/gists/${id}`);
      const f = g.files[GIST_FILE];
      const text = f.truncated ? await (await fetch(f.raw_url, { signal: AbortSignal.timeout(20000) })).text() : f.content;
      merge(decrypt(JSON.parse(text).blob));
      saveLocal();
      console.log('GitHub のコピーから戻しました');
    }
    restored = true;
  } catch (e) {
    console.error('GitHub のコピーを読めませんでした（1分後にもう一度）:', e.message);
    setTimeout(restoreFromGist, 60 * 1000);
  }
}
function scheduleBackup() {
  if (!GITHUB_TOKEN) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(backup, Number(process.env.BACKUP_DELAY_MS) || 20 * 1000);
}
async function backup() {
  if (!restored) return scheduleBackup();
  const content = JSON.stringify({ app: 'yarukoto-board', savedAt: new Date().toISOString(), blob: encrypt(data) });
  try {
    const id = await findGist();
    if (id) await gh(`/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content } } }) });
    else gistId = (await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'やることボードのデータ（暗号化）', public: false, files: { [GIST_FILE]: { content } } }) })).id;
  } catch (e) {
    console.error('GitHub にコピーを置けませんでした（あとでもう一度）:', e.message);
    backupTimer = setTimeout(backup, 5 * 60 * 1000);
  }
}

// ---------------- ログイン ----------------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function makeToken() {
  const exp = String(Date.now() + 90 * 24 * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}
function loggedIn(req) {
  if (!PASSWORD) return true;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)yb_session=([^;]+)/);
  const [exp, mac] = String(m ? decodeURIComponent(m[1]) : '').split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}
function samePassword(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------- HTTP ----------------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_DOC + 1024) { reject(Object.assign(new Error('データが大きすぎます'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('JSON が正しくありません'), { status: 400 })); } });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/status') return json(res, 200, { ok: true, loginRequired: !!PASSWORD, loggedIn: loggedIn(req), backup: !!GITHUB_TOKEN, restored });
  if (route === 'POST /api/login') {
    const body = await readBody(req);
    if (!PASSWORD || samePassword(body.password || '')) {
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `yb_session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${90 * 24 * 3600}${secure}`);
      return json(res, 200, { ok: true });
    }
    await new Promise((r) => setTimeout(r, 800));
    return json(res, 401, { error: 'パスワードが違います' });
  }
  if (route === 'POST /api/logout') {
    res.setHeader('Set-Cookie', 'yb_session=; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (!loggedIn(req)) return json(res, 401, { error: 'ログインしてください' });

  if (route === 'GET /api/board') {
    return json(res, 200, { docs: Object.fromEntries(DOCS.map((n) => [n, data[n]?.value ?? null])) });
  }
  const m = url.pathname.match(/^\/api\/board\/([a-z]+)$/);
  if (m && req.method === 'PUT') {
    if (!DOCS.includes(m[1])) return json(res, 404, { error: 'not found' });
    const value = await readBody(req);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return json(res, 400, { error: '保存する内容が正しくありません' });
    const ts = Math.max(Date.now(), (data[m[1]]?.ts || 0) + 1);
    data[m[1]] = { value, ts };
    saveLocal(); scheduleBackup();
    return json(res, 200, { ts });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (url.pathname === '/icon.svg') return send(res, 200, ICON, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return send(res, 404, 'not found');
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'サーバーエラー' });
    if (!e.status) console.error(e);
  }
});

await loadPage();
try { merge(JSON.parse(await fs.readFile(LOCAL, 'utf8'))); } catch { /* まだない */ }
restoreFromGist();
// 止まる前に、まだ送っていないコピーを送る
process.on('SIGTERM', async () => { if (backupTimer) { clearTimeout(backupTimer); await backup(); } process.exit(0); });

server.listen(PORT, () => {
  console.log(`やることボードを起動しました: http://localhost:${PORT}`);
  if (!PASSWORD) console.log('注意: BOARD_PASSWORD が未設定のため、URLを知っている人は誰でも開けます。');
  if (!GITHUB_TOKEN) console.log('注意: GITHUB_TOKEN が未設定のため、再起動するとデータが消えます。');
});
