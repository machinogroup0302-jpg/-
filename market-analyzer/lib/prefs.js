// お気に入りなどを、パソコンとスマホで共有するための保存場所
// ・GITHUB_TOKEN（GitHub の「Contents 読み書き」ができるトークン）を Render に登録すると、
//   GitHub のリポジトリの user-prefs ブランチに保存され、サーバーが再起動しても消えない
// ・登録していないときは、サーバーが動いている間だけ覚えている（Render の無料プランは、しばらく使わないと消える）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.PREFS_REPO || 'machinogroup0302-jpg/-';
const BRANCH = process.env.PREFS_BRANCH || 'user-prefs';
const FILE = 'prefs.json';
const LOCAL = path.join(os.tmpdir(), 'ma-prefs.json');
export const SYNC_KEY = /^favs_(fx|stock|us)$/;
const MAX_SIZE = 200 * 1024;

let data = {}; // { key: { value, ts } }
let sha = null;
let lastError = '';
let ready = null;
let failedAt = 0;
let saveTimer = null;
let saving = Promise.resolve();

const gh = (p, opt = {}) => fetch(`https://api.github.com/repos/${REPO}${p}`, {
  ...opt,
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'market-analyzer', ...(opt.headers || {}) },
  signal: AbortSignal.timeout(15000),
});

async function readGithub() {
  const res = await gh(`/contents/${FILE}?ref=${encodeURIComponent(BRANCH)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub から読めません（HTTP ${res.status}）`);
  const j = await res.json();
  sha = j.sha;
  return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
}

// 保存用のブランチがなければ作る（いつものブランチに入れると、そのたびにサイトの更新が走ってしまうため）
async function ensureBranch() {
  const res = await gh(`/git/ref/heads/${encodeURIComponent(BRANCH)}`);
  if (res.ok) return;
  if (res.status !== 404) throw new Error(`GitHub のブランチを確認できません（HTTP ${res.status}）`);
  const repo = await (await gh('')).json();
  const head = await (await gh(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`)).json();
  const made = await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: head.object.sha }) });
  if (!made.ok && made.status !== 422) throw new Error(`保存用のブランチを作れません（HTTP ${made.status}）`);
}

async function writeGithub(retry = true) {
  await ensureBranch();
  const body = { message: 'お気に入りを保存', content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'), branch: BRANCH };
  if (sha) body.sha = sha;
  const res = await gh(`/contents/${FILE}`, { method: 'PUT', body: JSON.stringify(body) });
  if ((res.status === 409 || res.status === 422) && retry) {
    // 別のところで書き換えられていた → 最新を読み直して、新しいほうを残してから保存し直す
    const remote = await readGithub().catch(() => null);
    if (remote) merge(remote);
    return writeGithub(false);
  }
  if (!res.ok) throw new Error(`GitHub に保存できません（HTTP ${res.status}）`);
  sha = (await res.json()).content.sha;
}

function merge(other) {
  for (const [k, v] of Object.entries(other || {})) {
    if (SYNC_KEY.test(k) && v && (!data[k] || v.ts > data[k].ts)) data[k] = v;
  }
}

export function loadPrefs() {
  if (!ready && failedAt && Date.now() - failedAt < 60e3) return Promise.resolve(); // 失敗したら1分は待つ
  ready ||= (async () => {
    try { merge(JSON.parse(await fs.readFile(LOCAL, 'utf8'))); } catch { /* まだない */ }
    if (!TOKEN) return;
    try {
      merge(await readGithub());
      lastError = '';
    } catch (e) {
      lastError = e.message;
      console.error('お気に入りの読み込みに失敗:', e.message);
      ready = null; // 少したってから、もう一度試す
      failedAt = Date.now();
    }
  })();
  return ready;
}

function scheduleSave() {
  fs.writeFile(LOCAL, JSON.stringify(data)).catch(() => {});
  if (!TOKEN) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saving = saving.then(() => writeGithub()).then(() => { lastError = ''; }).catch((e) => {
      lastError = e.message;
      console.error('お気に入りの保存に失敗:', e.message);
    });
  }, 2000);
}

export async function getPrefs() {
  await loadPrefs();
  return { items: data, durable: !!TOKEN, error: lastError };
}

// 新しい値を保存して、サーバーが付けた時刻を返す
export async function putPref(key, value) {
  if (!SYNC_KEY.test(key)) throw Object.assign(new Error('保存できない項目です'), { status: 400, expose: true });
  if (!Array.isArray(value) || JSON.stringify(value).length > MAX_SIZE) throw Object.assign(new Error('保存する内容が正しくありません'), { status: 400, expose: true });
  const clean = value.slice(0, 500).map((x) => ({ code: String(x?.code ?? '').slice(0, 20), name: String(x?.name ?? '').slice(0, 60) })).filter((x) => x.code);
  await loadPrefs();
  const ts = Math.max(Date.now(), (data[key]?.ts || 0) + 1);
  data[key] = { value: clean, ts };
  scheduleSave();
  return { ts, durable: !!TOKEN };
}

// テスト用
export function _reset() { data = {}; sha = null; ready = null; }
