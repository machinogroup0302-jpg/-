// サイトの不具合の見張り（GitHub Actions で動く）
//   errors：画面で起きたエラー（サイトに記録されたもの）を確かめて、あれば持ち主にメールと通知で知らせる（毎時）
//   smoke ：本物のサイトを実際に動かして、主な画面とデータの読み込みがちゃんと動くか確かめる（毎朝）
// ※ ログは公開されるので、エラーの「数」だけを出す（メールアドレス・持っている株・金額などは出さない）
import { sendPush } from '../lib/pushsend.js';

const SITE = process.env.HEALTH_SITE || 'https://wataru-lupe.onrender.com';
const KEY = process.env.SITE_PASSWORD || '';
const MODE = process.argv[2] || 'errors';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, opt = {}) {
  const res = await fetch(SITE + path, { ...opt, signal: AbortSignal.timeout(90000) });
  let body = null;
  try { body = await res.json(); } catch { /* json でないもの */ }
  return { status: res.status, body, headers: res.headers };
}

// 持ち主の届け先（サイトの設定のメールアドレス・通知の端末）
async function owner() {
  const r = await get('/api/alerts/profile', { headers: { 'x-site-key': KEY } });
  const admin = r.body?.users?.find((u) => u.uid === 'admin') || r.body || {};
  return { to: admin.profile?.email || process.env.MAIL_TO || '', push: admin.push || [] };
}

async function notify(subject, lines) {
  const o = await owner().catch(() => ({ to: process.env.MAIL_TO || '', push: [] }));
  const text = [subject, '', ...lines, '', `サイト：${SITE}`, '（このメールは、サイトの不具合の見張りから自動で送っています）'].join('\n');
  const { MAIL_USER, MAIL_PASS } = process.env;
  if (process.env.DRY_RUN) { console.log(text); return; }
  if (o.to && MAIL_USER && MAIL_PASS) {
    const nodemailer = (await import('nodemailer')).default;
    const tr = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS.replace(/\s/g, '') } });
    await tr.sendMail({ from: `サイトの見張り <${MAIL_USER}>`, to: o.to, subject, text });
    console.log('持ち主にメールで知らせました');
  }
  if (o.push.length) { const r = await sendPush(o.push, { title: subject, body: lines.slice(0, 3).join('\n').slice(0, 200), url: SITE, tag: 'health' }).catch(() => ({ sent: 0 })); console.log(`通知：${r.sent}台`); }
}

// ---------------- 画面で起きたエラー ----------------
async function checkErrors() {
  const r = await get('/api/errors', { headers: { 'x-site-key': KEY } });
  if (r.status !== 200) { console.log(`エラーの一覧を読めませんでした（${r.status}）`); return []; }
  const items = r.body.items || [];
  console.log(`画面で起きたエラー：${items.length}種類`);
  if (!items.length) return [];
  const fmt = (t) => new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const lines = items.map((x) => `・[${x.where}] ${x.message}（${x.count}回・最後 ${fmt(x.last)}・版 ${x.version || '—'}・画面 ${x.page || '—'}）${x.stack ? `\n    ${x.stack.split('\n').slice(0, 3).join('\n    ')}` : ''}`);
  await notify(`【サイトの見張り】画面でエラーが起きています（${items.length}種類）`, ['サイトを使っているときに、次のエラーが起きました。直すときの手がかりになるので、Claude に「見張りのメールが来た」と伝えてください。', '', ...lines]);
  await get('/api/errors/ack', { method: 'POST', headers: { 'x-site-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ upTo: Math.max(...items.map((x) => x.last)) }) });
  return items;
}

// ---------------- 本物のサイトを動かして確かめる ----------------
async function smoke() {
  const problems = [];
  // 1) サイトが起きているか（無料プランは寝ていることがあるので、起きるまで待つ）
  let st = null;
  for (let i = 0; i < 6 && !st; i++) { try { const r = await get('/api/status'); if (r.status === 200) st = r.body; } catch { await sleep(15000); } }
  if (!st) { problems.push('サイトが開けません（/api/status が返ってこない）'); return problems; }
  console.log(`サイトの版：${st.version}`);
  // 2) ログイン
  const login = await get('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '', password: KEY }) });
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0].trim()).join('; ');
  if (login.status !== 200 || !cookie) { problems.push(`ログインできません（${login.status}）`); return problems; }
  const H = { headers: { cookie } };
  // 3) データの読み込み
  const checks = [
    ['チャート（ドル円）', '/api/chart?symbol=USDJPY&tf=1d', (b) => b?.candles?.length > 100],
    ['チャート（トヨタ）', '/api/chart?symbol=7203&tf=1d', (b) => b?.candles?.length > 100],
    ['チャート（アップル）', '/api/chart?symbol=AAPL&tf=1d', (b) => b?.candles?.length > 100],
    ['チャート（15分足）', '/api/chart?symbol=USDJPY&tf=15m', (b) => b?.candles?.length > 50],
    ['ニュース', '/api/news?q=%E3%83%89%E3%83%AB%E5%86%86', (b) => Array.isArray(b?.items)],
    ['テーマ', '/api/themes', (b) => Array.isArray(b?.themes)],
    ['経済指標', '/api/econ', (b) => Array.isArray(b?.items)],
    ['米国株の一覧', '/api/us/list', (b) => b?.items?.length > 100],
    ['保存したデータ', '/api/prefs', (b) => b && typeof b.items === 'object'],
    ['決算の予定', '/api/stocks/earnings?codes=7203', (b) => Array.isArray(b?.items)],
  ];
  for (const [name, path, ok] of checks) {
    try {
      const r = await get(path, H);
      if (r.status !== 200 || !ok(r.body)) problems.push(`${name}：うまく読めません（${r.status}${r.body?.error ? `・${r.body.error}` : ''}）`);
    } catch (e) { problems.push(`${name}：返ってきません（${e.message}）`); }
  }
  console.log(`データの読み込み：${checks.length}項目を確認`);
  // 4) 画面を実際に動かす（Playwright があるとき）
  let pw = null;
  try { pw = await import('playwright'); } catch { console.log('Playwright がないので、画面の確認はしません'); }
  if (pw) {
    const browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 site-health-check' });
    await ctx.addCookies(cookie.split('; ').map((c) => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: SITE }; }));
    const page = await ctx.newPage();
    const errs = new Set();
    page.on('pageerror', (e) => errs.add(`画面のエラー：${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::|favicon/.test(m.text())) errs.add(`画面のエラー表示：${m.text().slice(0, 200)}`); });
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('#tabbar button', { timeout: 60000 });
    const errorText = async (where) => {
      const t = await page.$$eval('.error', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()).filter(Boolean)).catch(() => []);
      for (const x of t) errs.add(`${where}：「${x.slice(0, 120)}」と表示`);
    };
    for (const mode of ['fx', 'stock', 'us']) {
      await page.click(`#mode-seg [data-mode="${mode}"]`);
      for (const tab of ['chart', 'news', 'lab', 'screener', 'trades']) {
        await page.click(`#tabbar [data-tab="${tab}"]`);
        await page.waitForTimeout(6000);
        await errorText(`${mode}・${tab}`);
      }
      await page.click('#tabbar [data-tab="mine"]');
      for (const sub of ['hold', 'plan', 'now', 'list']) {
        await page.click(`#mine-sub [data-sub="${sub}"]`);
        if (sub === 'hold') {
          await page.waitForTimeout(25000);
          if (await page.$('#hold-list .spinner')) errs.add(`${mode}・持っている株：25秒たっても読み込み中のまま`);
        } else {
          await page.waitForFunction((id) => !document.querySelector(`#${id} .spinner`), sub === 'plan' ? 'lab-plan' : sub === 'now' ? 'lab-now' : 'lab-log', { timeout: 240000 }).catch(() => errs.add(`${mode}・あなた専用（${sub}）：4分たっても計算が終わらない`));
        }
        await errorText(`${mode}・あなた専用（${sub}）`);
      }
    }
    await page.click('#open-settings').catch(() => {});
    await page.waitForTimeout(2000);
    await errorText('設定');
    await browser.close();
    console.log(`画面の確認：${errs.size}件の問題`);
    problems.push(...errs);
  }
  return problems;
}

async function main() {
  if (!KEY) { console.log('SITE_PASSWORD が登録されていないので見張れません'); return; }
  if (MODE === 'smoke') {
    const problems = await smoke();
    console.log(`見つかった問題：${problems.length}件`);
    if (problems.length) await notify(`【サイトの見張り】毎朝の確認で問題が見つかりました（${problems.length}件）`, ['本物のサイトを自動で動かして確かめたところ、次の問題がありました。Claude に「見張りのメールが来た」と伝えてください。', '', ...problems.map((p) => `・${p}`)]);
  }
  await checkErrors();
}
main().catch((e) => { console.log('見張りが途中で止まりました:', e.message); process.exitCode = 0; });
