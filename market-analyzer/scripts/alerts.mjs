// 売買サインをメールで知らせる（GitHub Actions で毎日実行）
// 使い方: node scripts/alerts.mjs stock     … 日本株
//         node scripts/alerts.mjs fx,us     … 為替と米国株
// 必要な GitHub Secrets: MAIL_USER（送るGmail）・MAIL_PASS（Gmailのアプリパスワード）・MAIL_TO（届け先）
import fs from 'node:fs/promises';
import { getChart } from '../lib/market.js';
import { runStrategy, regimeLookup, signalOdds, oddsLabel } from '../public/js/strategies.js';
import { baseUniverse } from '../public/js/universe.js';

const SITE = 'https://wataru-lupe.onrender.com';
const STATE = new URL('../../alerts/state.json', import.meta.url);
const MODES = (process.argv[2] || 'stock,fx,us').split(',');
const NAMES = { fx: '為替', stock: '日本株', us: '米国株' };
const dayKey = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const price = (v, mode) => Number(v).toLocaleString('ja-JP', { maximumFractionDigits: mode === 'stock' ? 1 : mode === 'us' ? 2 : 3, minimumFractionDigits: mode === 'stock' ? 0 : 2 });

async function candles(code) {
  try { return (await getChart(code, '1d')).candles; } catch (e) { console.log(`  ${code}: 取得できません（${e.message}）`); return null; }
}

async function collect(mode, regime) {
  const syms = baseUniverse(mode);
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
    if (r.next) signals.push({ ...r.next, mode, name: x.name, symbol: x.symbol, open: r.open, last: last.close, date: dayKey(last.time) });
  }
  for (const s of signals) if (s.type === 'open') s.odds = signalOdds(trades, { symbol: s.symbol, side: s.side, strength: s.strength });
  console.log(`${NAMES[mode]}: ${list.length}/${syms.length}銘柄を計算、サイン${signals.length}件`);
  return signals;
}

function describe(s) {
  if (s.type === 'open') {
    const p = s.odds ? `${Math.round(s.odds.p * 100)}%（${oddsLabel(s.odds)}）` : 'まだ出せません';
    return {
      title: `🟢【${s.side > 0 ? '買い' : '売り'}】${s.name}`,
      lines: [
        `次の取引日の始まりに${s.side > 0 ? '買う' : '売る'}サイン（今 ${price(s.last, s.mode)}）`,
        `勝つ確率の目安：${p}`,
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

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function main() {
  let state = { sent: {} };
  try { state = JSON.parse(await fs.readFile(STATE, 'utf8')); } catch { /* 初回 */ }
  const get = async (s) => (await candles(s)) || [];
  const [vix, tnx, nikkei] = await Promise.all([get('^VIX'), get('^TNX'), get('^N225')]);
  const regime = regimeLookup({ vix, tnx, nikkei });

  const all = [];
  for (const mode of MODES) all.push(...await collect(mode, regime));
  const today = dayKey(Date.now() / 1000);
  const fresh = all.filter((s) => {
    const age = (Date.parse(today) - Date.parse(s.date)) / 86400000;
    return age <= 4 && !state.sent[`${s.symbol}|${s.type}|${s.side || 0}|${s.date}`];
  }).sort((a, b) => (a.type === b.type ? (b.odds?.p || 0) - (a.odds?.p || 0) : a.type === 'open' ? -1 : 1));

  if (!fresh.length) { console.log('新しいサインはありません'); return; }
  const buys = fresh.filter((s) => s.type === 'open').length, closes = fresh.length - buys;
  const subject = `【売買サイン】${MODES.map((m) => NAMES[m]).join('・')}：新しく入る${buys}件・決済${closes}件（${md(today)}）`;
  const blocks = fresh.map(describe);
  const note = '※ 過去の値動きから計算した練習用のサインです。勝つ確率は目安で、当たる保証はありません。売買はご自身の判断で行ってください。';
  const text = [subject, '', ...blocks.flatMap((b) => [b.title, ...b.lines, '']), `くわしくはサイトの「成績」→「今のサイン」：${SITE}`, '', note].join('\n');
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">
    <h2 style="font-size:16px">${esc(subject)}</h2>
    ${blocks.map((b) => `<div style="border:1px solid #ddd;border-radius:10px;padding:10px 12px;margin:10px 0"><b style="font-size:15px">${esc(b.title)}</b><br>${b.lines.map(esc).join('<br>')}</div>`).join('')}
    <p><a href="${SITE}">サイトで見る（成績 → 今のサイン）</a></p><p style="color:#888;font-size:12px">${esc(note)}</p></div>`;

  const { MAIL_USER, MAIL_PASS, MAIL_TO } = process.env;
  if (!MAIL_USER || !MAIL_PASS || !MAIL_TO) {
    console.log('メールの設定（MAIL_USER・MAIL_PASS・MAIL_TO）がないため、送らずに内容だけ表示します。\n');
    console.log(text);
    return;
  }
  const nodemailer = (await import('nodemailer')).default;
  const tr = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS.replace(/\s/g, '') } });
  await tr.sendMail({ from: `売買サイン <${MAIL_USER}>`, to: MAIL_TO, subject, text, html });
  console.log(`メールを送りました（${fresh.length}件）`);

  const now = new Date().toISOString();
  for (const s of fresh) state.sent[`${s.symbol}|${s.type}|${s.side || 0}|${s.date}`] = now;
  // 30日より前の記録は消す
  for (const [k, v] of Object.entries(state.sent)) if (Date.now() - Date.parse(v) > 30 * 86400000) delete state.sent[k];
  await fs.mkdir(new URL('.', STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(state, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
