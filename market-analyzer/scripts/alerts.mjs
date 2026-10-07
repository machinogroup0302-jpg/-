// 売買サインをメールで知らせる（GitHub Actions で毎日実行）
// 使い方: node scripts/alerts.mjs stock     … 日本株
//         node scripts/alerts.mjs fx,us     … 為替と米国株
// 必要な GitHub Secrets: MAIL_USER（送るGmail）・MAIL_PASS（Gmailのアプリパスワード）
//   SITE_PASSWORD（サイトのパスワード）… サイトの設定に入れたメールアドレス・予算・お気に入りを読むため
//   MAIL_TO（届け先・なくてもよい）… サイトの設定にメールアドレスがないときに使う
import fs from 'node:fs/promises';
import { getChart } from '../lib/market.js';
import { runStrategy, regimeLookup, signalOdds, oddsLabel } from '../public/js/strategies.js';
import { baseUniverse } from '../public/js/universe.js';
import { sizePosition } from '../public/js/plan.js';
import { adviseHolding } from '../public/js/holdingadvice.js';
import { US_LIST } from '../lib/usstocks.js';
import { startScan, scanStatus } from '../lib/scanner.js';

const SITE = 'https://wataru-lupe.onrender.com';
const STATE = new URL('../../alerts/state.json', import.meta.url);
let MODES = (process.argv[2] || 'stock,fx,us').split(',');
const NAMES = { fx: '為替', stock: '日本株', us: '米国株' };
const dayKey = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const price = (v, mode) => Number(v).toLocaleString('ja-JP', { maximumFractionDigits: mode === 'stock' ? 1 : mode === 'us' ? 2 : 3, minimumFractionDigits: mode === 'stock' ? 0 : 2 });

async function candles(code) {
  try { return (await getChart(code, '1d')).candles; } catch (e) { console.log(`  ${code}: 取得できません（${e.message}）`); return null; }
}

// サイトの「あなたの設定」を読む（サーバーが寝ていると起きるまで1分ほどかかる）
async function siteProfile() {
  const key = process.env.SITE_PASSWORD;
  if (!key) return null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${SITE}/api/alerts/profile`, { headers: { 'x-site-key': key }, signal: AbortSignal.timeout(90000) });
      if (res.ok) return await res.json();
      console.log(`サイトの設定を読めません（HTTP ${res.status}）`);
      if (res.status === 401) return null;
    } catch (e) { console.log('サイトの設定を読めません:', e.message); }
  }
  return null;
}

let site = null;
const prices = {};

async function collect(mode, regime) {
  const syms = baseUniverse(mode);
  const add = (code, name) => { if (!syms.some(([c]) => c.toUpperCase() === String(code).toUpperCase())) syms.push([String(code).toUpperCase(), name]); };
  // 米国株は一覧の全部、日本株は東証の全上場企業をチェックして、買いのサインが強い上位をくわしく計算する
  if (mode === 'us') US_LIST.filter((x) => !x.symbol.startsWith('^')).forEach((x) => add(x.symbol, x.name));
  if (mode === 'stock') {
    try {
      startScan({ markets: ['グロース', 'スタンダード', 'プライム'] });
      for (let i = 0; i < 200 && scanStatus().status === 'running'; i++) await new Promise((r) => setTimeout(r, 3000));
      const buy = scanStatus({ view: 'buy', limit: 40 });
      console.log(`日本株：全${buy.total || 0}社をチェック`);
      for (const x of buy.results || []) add(x.code, x.name);
    } catch (e) { console.log('全銘柄チェックに失敗:', e.message); }
  }
  for (const h of site?.holdings?.[mode] || []) add(h.code, h.name);
  // お気に入りも入れる（指数は除く）
  for (const f of site?.favs?.[mode] || []) {
    if (!/^\^/.test(f.code) && !syms.some(([c]) => c.toUpperCase() === f.code.toUpperCase())) syms.push([f.code.toUpperCase(), f.name]);
  }
  const list = [];
  const queue = [...syms];
  await Promise.all([1, 2, 3].map(async () => {
    while (queue.length) {
      const [code, name] = queue.shift();
      const cs = await candles(code);
      if (cs && cs.length >= 200) list.push({ code, name, symbol: mode === 'fx' ? `${code}=X` : mode === 'stock' ? `${code}.T` : code, candles: cs });
    }
  }));
  const kind = mode;
  const trades = [], signals = [];
  for (const x of list) {
    const r = runStrategy(x.candles, 'combo', { kind, pair: x.code, regime });
    for (const t of r.trades) trades.push({ ...t, symbol: x.symbol });
    const last = x.candles[x.candles.length - 1];
    prices[x.symbol] = last.close;
    if (r.next) signals.push({ ...r.next, mode, name: x.name, symbol: x.symbol, open: r.open, last: last.close, date: dayKey(last.time) });
  }
  for (const s of signals) if (s.type === 'open') s.odds = signalOdds(trades, { symbol: s.symbol, side: s.side, strength: s.strength });
  // 自分で持っている株：損切り・決済・利益確定のタイミングを知らせる
  const byCode = new Map(list.map((x) => [x.code.toUpperCase(), x]));
  for (const h of site?.holdings?.[mode] || []) {
    const x = byCode.get(String(h.code).toUpperCase());
    if (!x) continue;
    const adv = adviseHolding({ ...h, symbol: x.symbol }, x.candles, { mode, prices, usdjpy: prices['USDJPY=X'], profile: site?.profile });
    if (adv && adv.key !== 'hold') signals.push({ type: 'hold', mode, name: h.name, symbol: x.symbol, side: h.side, key: adv.key, adv, date: adv.date, h });
  }
  console.log(`${NAMES[mode]}: ${list.length}/${syms.length}銘柄を計算、サイン${signals.length}件`);
  return signals;
}

function describe(s, pf) {
  if (s.type === 'hold') {
    const a = s.adv;
    return {
      title: `📦【持っている株】${s.name}：${a.verdict.icon}${a.verdict.label}`,
      lines: [
        `${price(s.h.price, s.mode)}で${s.h.side > 0 ? '買い' : '売り'} → 今 ${price(a.now, s.mode)}（${a.plPct >= 0 ? '+' : ''}${(a.plPct * 100).toFixed(1)}%${a.plYen != null ? `・${a.plYen >= 0 ? '+' : '−'}${Math.abs(Math.round(a.plYen)).toLocaleString()}円` : ''}）`,
        ...a.reasons.map((w) => `・${w}`),
      ],
    };
  }
  if (s.type === 'open') {
    const p = s.odds ? `${Math.round(s.odds.p * 100)}%（${oddsLabel(s.odds)}）` : 'まだ出せません';
    let plan = [];
    if (pf?.budget) {
      const z = sizePosition({ mode: s.mode, symbol: s.symbol, price: s.last, stop: s.stopEst, budget: pf.budget, riskPct: pf.riskPct || 2, maxPos: pf.maxPos || 3, prices, usdjpy: prices['USDJPY=X'] });
      if (z?.qty > 0) plan = [`あなたの予算なら：${z.qty.toLocaleString()}${z.unitLabel}（${z.kindLabel} 約${Math.round(z.cost).toLocaleString()}円）`, `損切りの値段：${price(s.stopEst, s.mode)}（約−${Math.round(z.maxLoss).toLocaleString()}円）${s.takeEst ? `／目標：${price(s.takeEst, s.mode)}` : ''}`];
      else if (z) plan = [`あなたの予算では見送り：${z.why}`];
    }
    return {
      title: `🟢【${s.side > 0 ? '買い' : '売り'}】${s.name}`,
      lines: [
        `次の取引日の始まりに${s.side > 0 ? '買う' : '売る'}サイン（今 ${price(s.last, s.mode)}）`,
        `勝つ確率の目安：${p}`,
        ...plan,
        ...(s.why || []).map((w) => `・${w}`),
      ],
    };
  }
  const g = s.open ? s.open.side * (s.last / s.open.entryPrice - 1) : 0;
  return {
    title: `🔴【決済】${s.name}（${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%）`,
    lines: [
      `次の取引日の始まりに決済するサイン：${s.reason}`,
      ...(s.open ? [`${md(s.open.entryDate)}に ${price(s.open.entryPrice, s.mode)} で${s.open.side > 0 ? '買い' : '売り'} → 今 ${price(s.last, s.mode)}`] : []),
      ...(s.why || []).map((w) => `・${w}`),
    ],
  };
}

const ORDER = { hold: 0, open: 1, close: 2 };
const keyOf = (s) => `${s.symbol}|${s.type}|${s.type === 'hold' ? s.key : s.side || 0}|${s.date}`;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function main() {
  let state = { sent: {} };
  try { state = JSON.parse(await fs.readFile(STATE, 'utf8')); } catch { /* 初回 */ }
  site = await siteProfile();
  const pf = site?.profile;
  if (pf?.notify) MODES = MODES.filter((m) => pf.notify[m]);
  if (!MODES.length) { console.log('設定で通知がオフになっています'); return; }
  const to = pf?.email || process.env.MAIL_TO;
  // ログは公開されるので、メールアドレスや予算は出さない
  console.log(`届け先: ${to ? '設定あり' : '（なし）'}・予算: ${pf?.budget ? '設定あり' : '（なし）'}`);
  const get = async (s) => (await candles(s)) || [];
  const [vix, tnx, nikkei] = await Promise.all([get('^VIX'), get('^TNX'), get('^N225')]);
  const regime = regimeLookup({ vix, tnx, nikkei });

  const all = [];
  { const u = await candles('USDJPY=X'); if (u) prices['USDJPY=X'] = u[u.length - 1].close; }
  for (const mode of MODES) all.push(...await collect(mode, regime));
  const today = dayKey(Date.now() / 1000);
  const fresh = all.filter((s) => {
    const age = (Date.parse(today) - Date.parse(s.date)) / 86400000;
    return age <= 4 && !state.sent[keyOf(s)];
  }).sort((a, b) => ORDER[a.type] - ORDER[b.type] || (b.odds?.p || 0) - (a.odds?.p || 0));

  if (!fresh.length) { console.log('新しいサインはありません'); return; }
  const buys = fresh.filter((s) => s.type === 'open').length, closes = fresh.filter((s) => s.type === 'close').length, holds = fresh.filter((s) => s.type === 'hold').length;
  const subject = `【売買サイン】${MODES.map((m) => NAMES[m]).join('・')}：${holds ? `持っている株${holds}件・` : ''}新しく入る${buys}件・決済${closes}件（${md(today)}）`;
  const blocks = fresh.map((s) => describe(s, pf));
  const note = '※ 過去の値動きから計算した練習用のサインです。勝つ確率は目安で、当たる保証はありません。売買はご自身の判断で行ってください。';
  const text = [subject, '', ...blocks.flatMap((b) => [b.title, ...b.lines, '']), `くわしくはサイトの「成績」→「今のサイン」：${SITE}`, '', note].join('\n');
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">
    <h2 style="font-size:16px">${esc(subject)}</h2>
    ${blocks.map((b) => `<div style="border:1px solid #ddd;border-radius:10px;padding:10px 12px;margin:10px 0"><b style="font-size:15px">${esc(b.title)}</b><br>${b.lines.map(esc).join('<br>')}</div>`).join('')}
    <p><a href="${SITE}">サイトで見る（成績 → 今のサイン）</a></p><p style="color:#888;font-size:12px">${esc(note)}</p></div>`;

  const { MAIL_USER, MAIL_PASS } = process.env;
  if (!MAIL_USER || !MAIL_PASS || !to) {
    console.log('メールの設定（MAIL_USER・MAIL_PASS と届け先）がないため、送らずに内容だけ表示します。\n');
    if (!pf || process.env.SHOW_TEXT) console.log(text);
    return;
  }
  const nodemailer = (await import('nodemailer')).default;
  const tr = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS.replace(/\s/g, '') } });
  await tr.sendMail({ from: `売買サイン <${MAIL_USER}>`, to, subject, text, html });
  console.log(`メールを送りました（${fresh.length}件）`);

  const now = new Date().toISOString();
  for (const s of fresh) state.sent[keyOf(s)] = now;
  // 30日より前の記録は消す
  for (const [k, v] of Object.entries(state.sent)) if (Date.now() - Date.parse(v) > 30 * 86400000) delete state.sent[k];
  await fs.mkdir(new URL('.', STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(state, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
