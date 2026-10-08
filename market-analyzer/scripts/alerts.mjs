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
import { sizeFor, orderText, waySides, wayProfile, compareWays, budgets } from '../public/js/plan.js';
import { adviseHolding, exitTiming, longTermView, addOnAdvice } from '../public/js/holdingadvice.js';
import { US_LIST } from '../lib/usstocks.js';
import { startScan, scanStatus } from '../lib/scanner.js';
import { openMarkets } from '../lib/markethours.js';
import { fmtTime, judgedText, execText } from '../public/js/sessiontime.js';

const SITE = 'https://wataru-lupe.onrender.com';
const STATE = new URL('../../alerts/state.json', import.meta.url);
let MODES = (process.argv[2] || 'stock,fx,us').split(',');
// "day" のときは、取引時間中の市場をデイトレの足（15分足）で見る
const DAY = MODES.includes('day');
// "morning" のときは、朝8:30の「今日のプラン」（その日の予定のまとめ）を送る
const MORNING = MODES.includes('morning');
const OPEN = DAY ? openMarkets() : [];
if (DAY || MORNING) MODES = ['stock', 'fx', 'us'];
const NAMES = { fx: '為替', stock: '日本株', us: '米国株' };
const dayKey = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const price = (v, mode) => Number(v).toLocaleString('ja-JP', { maximumFractionDigits: mode === 'stock' ? 1 : mode === 'us' ? 2 : 3, minimumFractionDigits: mode === 'stock' ? 0 : 2 });

async function candles(code, tf = '1d') {
  try { return (await getChart(code, tf)).candles; } catch (e) { console.log(`  ${code}: 取得できません（${e.message}）`); return null; }
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

// 銘柄の日足を集める（使う人全員のお気に入り・持っている株も入れる）
async function loadMode(mode, users, { holdingsOnly = false } = {}) {
  const syms = holdingsOnly ? [] : baseUniverse(mode);
  const add = (code, name) => { if (!/^\^/.test(code) && !syms.some(([c]) => c.toUpperCase() === String(code).toUpperCase())) syms.push([String(code).toUpperCase(), name]); };
  // 米国株は一覧の全部、日本株は東証の全上場企業をチェックして、買いのサインが強い上位をくわしく計算する
  if (holdingsOnly) {
    for (const u of users) for (const h of u.holdings?.[mode] || []) add(h.code, h.name);
  } else if (mode === 'us') US_LIST.filter((x) => !x.symbol.startsWith('^')).forEach((x) => add(x.symbol, x.name));
  if (mode === 'stock' && !holdingsOnly) {
    try {
      startScan({ markets: ['グロース', 'スタンダード', 'プライム'] });
      for (let i = 0; i < 200 && scanStatus().status === 'running'; i++) await new Promise((r) => setTimeout(r, 3000));
      const buy = scanStatus({ view: 'buy', limit: 40 });
      console.log(`日本株：全${buy.total || 0}社をチェック`);
      for (const x of buy.results || []) add(x.code, x.name);
    } catch (e) { console.log('全銘柄チェックに失敗:', e.message); }
  }
  if (!holdingsOnly) {
    for (const u of users) {
      for (const h of u.holdings?.[mode] || []) add(h.code, h.name);
      for (const f of u.favs?.[mode] || []) add(f.code, f.name);
    }
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
  for (const x of list) prices[x.symbol] = x.candles[x.candles.length - 1].close;
  console.log(`${NAMES[mode]}: ${list.length}/${syms.length}銘柄の値動きを取得`);
  return list;
}

// サインを計算する（持つ日数の上限ごとに結果が変わるので、日数ごとに計算する）
const signalCache = new Map();
function signalsFor(mode, list, regime, swingDays, sides = null) {
  const ck = `${mode}|${swingDays}|${sides}`;
  if (signalCache.has(ck)) return signalCache.get(ck);
  const trades = [], signals = [], results = new Map();
  for (const x of list) {
    const r = runStrategy(x.candles, 'combo', { kind: mode, pair: x.code, regime, maxHold: swingDays, sides });
    for (const t of r.trades) trades.push({ ...t, symbol: x.symbol });
    const last = x.candles[x.candles.length - 1];
    results.set(x.symbol, { r, x, last });
    if (r.next) signals.push({ ...r.next, mode, name: x.name, symbol: x.symbol, open: r.open, last: last.close, date: dayKey(last.time), t: last.time });
  }
  for (const s of signals) if (s.type === 'open') s.odds = signalOdds(trades, { symbol: s.symbol, side: s.side, strength: s.strength });
  const out = { signals, results, trades };
  signalCache.set(ck, out);
  return out;
}

// その人が持っている株：損切り・決済・利益確定のタイミング
function holdingSignals(mode, list, u) {
  const byCode = new Map(list.map((x) => [x.code.toUpperCase(), x]));
  const out = [];
  for (const h of u.holdings?.[mode] || []) {
    const x = byCode.get(String(h.code).toUpperCase());
    if (!x) continue;
    const hh = { ...h, symbol: x.symbol };
    const adv = adviseHolding(hh, x.candles, { mode, prices, usdjpy: prices['USDJPY=X'], profile: u.profile });
    if (!adv || adv.key === 'hold') continue;
    const timing = exitTiming(hh, x.candles, adv, { mode, prices, usdjpy: prices['USDJPY=X'] });
    const longView = longTermView(hh, x.candles, adv, { mode, prices, usdjpy: prices['USDJPY=X'] });
    const addOn = addOnAdvice(hh, x.candles, adv, { mode });
    out.push({ type: 'hold', mode, name: h.name, symbol: x.symbol, side: h.side, key: adv.key, adv, timing, longView, addOn, date: adv.date, h });
  }
  return out;
}

// ---------------- デイトレ（取引時間中、15分ごと） ----------------
async function daySignals(mode, users, regime) {
  const syms = baseUniverse(mode);
  const add = (code, name) => { if (!/^\^/.test(code) && !syms.some(([c]) => c.toUpperCase() === String(code).toUpperCase())) syms.push([String(code).toUpperCase(), name]); };
  for (const u of users) { for (const h of u.holdings?.[mode] || []) add(h.code, h.name); for (const f of u.favs?.[mode] || []) add(f.code, f.name); }
  const list = [];
  const queue = [...syms];
  await Promise.all([1, 2, 3, 4].map(async () => {
    while (queue.length) {
      const [code, name] = queue.shift();
      const cs = await candles(code, '15m');
      if (cs && cs.length >= 150) list.push({ code, name, symbol: mode === 'fx' ? `${code}=X` : mode === 'stock' ? `${code}.T` : code, candles: cs });
    }
  }));
  // 人によって向き（買いだけ・売りも）が違うので、必要な向きごとに計算する
  const bySides = {};
  for (const sides of waySides(mode)) bySides[sides] = dayCompute(mode, list, regime, sides);
  return bySides;
}

function dayCompute(mode, list, regime, sides) {
  const trades = [], signals = [], results = new Map();
  const nowSec = Date.now() / 1000;
  for (const x of list) {
    const last = x.candles[x.candles.length - 1];
    prices[x.symbol] = last.close;
    const r = runStrategy(x.candles, 'combo', { kind: mode, pair: x.code, regime, intraday: true, days: mode === 'fx' ? 1000 : 600, sides });
    for (const t of r.trades) trades.push({ ...t, symbol: x.symbol });
    results.set(x.symbol, { r, x, last });
    // 最新の足が古い（取引が止まっている）ときは知らせない
    if (r.next && nowSec - last.time < 45 * 60) signals.push({ ...r.next, mode, day: true, name: x.name, symbol: x.symbol, open: r.open, last: last.close, date: dayKey(last.time), bar: last.time, t: last.time });
  }
  for (const s of signals) if (s.type === 'open') s.odds = signalOdds(trades, { symbol: s.symbol, side: s.side, strength: s.strength });
  console.log(`${NAMES[mode]}（デイトレ・${sides}）: ${list.length}銘柄を計算、サイン${signals.length}件`);
  return { list, signals, results, trades };
}

const hm = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(11, 16);

function describe(s, pf) {
  if (s.type === 'hold') {
    const a = s.adv;
    return {
      title: `📦【持っている株】${s.name}：${a.verdict.icon}${a.verdict.label}`,
      lines: [
        `${price(s.h.price, s.mode)}で${s.h.side > 0 ? '買い' : '売り'} → 今 ${price(a.now, s.mode)}（${a.plPct >= 0 ? '+' : ''}${(a.plPct * 100).toFixed(1)}%${a.plYen != null ? `・${a.plYen >= 0 ? '+' : '−'}${Math.abs(Math.round(a.plYen)).toLocaleString()}円` : ''}）`,
        ...a.reasons.map((w) => `・${w}`),
        ...(s.addOn ? [`${s.addOn.icon} ${s.addOn.title}：${s.addOn.text}`] : []),
        ...(s.timing ? [`⏱ 10日以内で見ると：${s.timing.text}`] : []),
        ...(s.longView ? [`📅 長い目で見ると：${s.longView.text}`, ...s.longView.reasons.map((w) => `　・${w}`)] : []),
      ],
    };
  }
  if (s.type === 'open') {
    const p = s.odds ? `${Math.round(s.odds.p * 100)}%（${oddsLabel(s.odds)}）` : 'まだ出せません';
    let plan = [];
    if (pf?.budget) {
      const z = sizeFor(s.wayPf || pf, s.mode, s.side, { symbol: s.symbol, price: s.last, stop: s.stopEst, budget: pf.budget, riskPct: pf.riskPct || 2, maxPos: pf.maxPos || 3, prices, usdjpy: prices['USDJPY=X'] });
      if (z?.qty > 0) plan = [`あなたの予算なら：${orderText(s.side, z)}（${z.kindLabel} 約${Math.round(z.cost).toLocaleString()}円）`, `損切りの値段：${price(s.stopEst, s.mode)}（約−${Math.round(z.maxLoss).toLocaleString()}円）${s.takeEst ? `／目標：${price(s.takeEst, s.mode)}` : ''}`];
      else if (z) plan = [`あなたの予算では見送り：${z.why}`];
    }
    return {
      title: `🟢【${s.day ? 'デイトレ・' : ''}${s.side > 0 ? '買い' : '売り'}】${s.name}${s.day ? `（${hm(s.bar)}の足で判断）` : ''}`,
      lines: [
        s.day ? `今から${s.side > 0 ? '買う' : '売る'}タイミング（今 ${price(s.last, s.mode)}）。その日のうちに必ず決済するやり方です` : `次の取引日の始まりに${s.side > 0 ? '買う' : '売る'}サイン（今 ${price(s.last, s.mode)}）`,
        `🕒 判断した時刻：${judgedText(s.mode, s.t, !!s.day)}／売買する時刻：${execText(s.mode, !!s.day)}`,
        `勝つ確率の目安：${p}`,
        ...(s.wayLabel ? [`やり方：${s.wayLabel}（全部のやり方で過去をやり直して、一番良かったものを自動で選んでいます）`] : []),
        ...plan,
        ...(s.why || []).map((w) => `・${w}`),
      ],
    };
  }
  if (s.done) {
    return {
      title: `🔴【${s.day ? 'デイトレ・' : ''}決済しました】${s.name}（${s.ret >= 0 ? '+' : ''}${(s.ret * 100).toFixed(1)}%）`,
      lines: [
        `前にお知らせした${s.side > 0 ? '買い' : '売り'}は、${s.reason}で決済のタイミングになりました（前回の確認から今回までの間に起きました）`,
        `${s.entryTime ? fmtTime(s.entryTime) + ' に ' : ''}${price(s.entryPrice, s.mode)} で${s.side > 0 ? '買い' : '売り'} → ${s.exitTime ? fmtTime(s.exitTime) + ' に ' : ''}${price(s.exitPrice, s.mode)} で決済`,
        ...(s.why || []).map((w) => `・${w}`),
      ],
    };
  }
  const g = s.open ? s.open.side * (s.last / s.open.entryPrice - 1) : 0;
  return {
    title: `🔴【${s.day ? 'デイトレ・' : ''}決済】${s.name}（${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%）`,
    lines: [
      s.day ? `今決済するタイミング：${s.reason}` : `次の取引日の始まりに決済するサイン：${s.reason}`,
      ...(s.t || s.bar ? [`🕒 判断した時刻：${judgedText(s.mode, s.t || s.bar, !!s.day)}／売買する時刻：${execText(s.mode, !!s.day)}`] : []),
      ...(s.open ? [`${s.open.entryTime ? fmtTime(s.open.entryTime) : md(s.open.entryDate)} に ${price(s.open.entryPrice, s.mode)} で${s.open.side > 0 ? '買い' : '売り'} → 今 ${price(s.last, s.mode)}`] : []),
      ...(s.why || []).map((w) => `・${w}`),
    ],
  };
}

// ---------------- あなたのプランに合わせて選び、お知らせした売買を記録する ----------------
// ・「入る」は、勝つ確率の目安50%以上・平均で得・予算内で買えるものを、同時に持つ数まで（あなたのプランと同じ考え方）
// ・「決済」は、メールで「入る」をお知らせしたものだけ（知らない取引の決済は送らない）
// ・お知らせした売買は、入った値段・決済した値段・損益を記録していく
function planForUser(u, kind, groups, book, nowSec) {
  const mine = (book[u.uid] ||= { open: {}, log: [] });
  const pf = u.profile || {};
  const maxPos = pf.maxPos || 3;
  const out = [];
  const isDay = kind === 'day';
  // 1) お知らせ済みの取引を確かめる
  for (const [k, tr] of Object.entries(mine.open)) {
    if (tr.kind !== kind || !groups[tr.mode]) continue;
    const res = groups[tr.mode].results.get(tr.symbol);
    if (!res) continue;
    const { r, last } = res;
    const t = r.trades.find((x) => x.side === tr.side && x.entryTime > tr.signalTime);
    if (t) {
      mine.log.push({ kind, mode: tr.mode, symbol: tr.symbol, name: tr.name, side: tr.side, notifiedAt: tr.sentAt, closeNotifiedAt: tr.closeSentAt || new Date().toISOString(), entryTime: t.entryTime, entryPrice: t.entryPrice, exitTime: t.exitTime, exitPrice: t.exitPrice, ret: t.ret, reasonOut: t.reasonOut });
      if (!tr.closeSent) out.push({ type: 'close', done: true, mode: tr.mode, day: isDay, name: tr.name, symbol: tr.symbol, side: tr.side, reason: t.reasonOut, why: t.whyOut, entryPrice: t.entryPrice, exitPrice: t.exitPrice, entryTime: t.entryTime, exitTime: t.exitTime, ret: t.ret, date: dayKey(last.time) });
      delete mine.open[k];
      continue;
    }
    if (r.open && r.open.side === tr.side && r.open.entryTime > tr.signalTime) {
      tr.entryPrice = r.open.entryPrice; tr.entryTime = r.open.entryTime;
      if (r.next?.type === 'close' && !tr.closeSent) {
        out.push({ ...r.next, mode: tr.mode, day: isDay, name: tr.name, symbol: tr.symbol, open: r.open, last: last.close, date: dayKey(last.time), bar: last.time, t: last.time });
        tr.closeSent = true;
        tr.closeSentAt = new Date().toISOString();
      }
      continue;
    }
    // 入る前に条件が変わって入らなかったもの（デイトレは4時間、スイングは5日で忘れる）
    if (nowSec - tr.signalTime > (isDay ? 4 * 3600 : 5 * 86400)) delete mine.open[k];
  }
  // 2) 新しく入る
  let slots = maxPos - Object.values(mine.open).filter((x) => x.kind === kind).length;
  const tracked = new Set(Object.values(mine.open).map((x) => x.symbol));
  const cands = Object.values(groups).flatMap((g) => g.signals)
    .filter((x) => x.type === 'open' && u.modes.includes(x.mode) && !tracked.has(x.symbol) && x.odds && x.odds.p >= 0.5 && x.odds.expect > 0)
    .map((x) => ({ ...x, wayPf: u.wayPf?.[x.mode] || pf, wayLabel: u.wayLabel?.[x.mode] || '', size: pf.budget ? sizeFor(u.wayPf?.[x.mode] || pf, x.mode, x.side, { symbol: x.symbol, price: x.last, stop: x.stopEst, budget: pf.budget, riskPct: pf.riskPct || 2, maxPos, prices, usdjpy: prices['USDJPY=X'] }) : null }))
    .filter((x) => !pf.budget || x.size?.qty > 0)
    .sort((a, b) => b.odds.p - a.odds.p);
  for (const x of cands) {
    if (slots <= 0) break;
    out.push(x);
    mine.open[`${kind}|${x.symbol}`] = { kind, mode: x.mode, symbol: x.symbol, name: x.name, side: x.side, signalTime: x.t, signalPrice: x.last, sentAt: new Date().toISOString(), how: x.size?.qty > 0 ? orderText(x.side, x.size) : '' };
    slots--;
  }
  if (mine.log.length > 500) mine.log = mine.log.slice(-500);
  return out;
}

// これまでにメールでお知らせした売買の成績
function recordLine(book, uid, pf) {
  const log = book[uid]?.log || [];
  if (!log.length) return 'メールでお知らせした売買の記録：まだ決済まで終わった取引はありません（入った値段・決済した値段・損益を自動で記録していきます）';
  const wins = log.filter((t) => t.ret > 0).length;
  const total = log.reduce((a, t) => a + t.ret, 0);
  const yen = pf?.budget ? log.reduce((a, t) => a + t.ret * (pf.budget / (pf.maxPos || 3)), 0) : null;
  return `メールでお知らせした売買の記録：これまで${log.length}回・勝率${Math.round((wins / log.length) * 100)}%・1回平均${((total / log.length) * 100).toFixed(2)}%${yen != null ? `（あなたの予算で1銘柄${Math.round(pf.budget / (pf.maxPos || 3)).toLocaleString()}円ずつなら合計 ${yen >= 0 ? '+' : '−'}${Math.abs(Math.round(yen)).toLocaleString()}円）` : ''}`;
}

const ORDER = { hold: 0, open: 1, close: 2 };
const keyOf = (s) => `${s.day ? 'day|' : ''}${s.symbol}|${s.type}|${s.type === 'hold' ? s.key : s.side || 0}|${s.day ? s.bar : s.date}`;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendMail(to, subject, text, html) {
  if (process.env.DRY_RUN) { console.log(text); return; } // 試すとき：送らずに中身を表示
  const { MAIL_USER, MAIL_PASS } = process.env;
  const nodemailer = (await import('nodemailer')).default;
  const tr = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS.replace(/\s/g, '') } });
  await tr.sendMail({ from: `売買サイン <${MAIL_USER}>`, to, subject, text, html });
}

function buildMail(fresh, modes, pf, today, TEST, day = false, record = '') {
  const buys = fresh.filter((s) => s.type === 'open').length, closes = fresh.filter((s) => s.type === 'close').length, holds = fresh.filter((s) => s.type === 'hold').length;
  const head = day ? `【今のタイミング ${hm(Date.now() / 1000)}】` : '【売買サイン】';
  const subject = TEST ? `【テスト】売買サインのメールが届くか確認しています（${md(today)}）` : `${head}${modes.map((m) => NAMES[m]).join('・')}：${holds ? `持っている株${holds}件・` : ''}新しく入る${buys}件・決済${closes}件（${md(today)}）`;
  const blocks = fresh.map((s) => describe(s, pf));
  const note = '※ 過去の値動きから計算した練習用のサインです。勝つ確率は目安で、当たる保証はありません。売買はご自身の判断で行ってください。';
  const testNote = TEST ? ['このメールが届いていれば設定は完了です。これからは新しいサインが出たときにお知らせします。', `今の新しいサイン：${fresh.length}件`, ''] : [];
  const text = [subject, '', ...testNote, ...blocks.flatMap((b) => [b.title, ...b.lines, '']), ...(record ? [`📒 ${record}`, ''] : []), `くわしくはサイトの「あなた専用」：${SITE}`, '', note].join('\n');
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">
    <h2 style="font-size:16px">${esc(subject)}</h2>${testNote.length ? `<p>${testNote.filter(Boolean).map(esc).join('<br>')}</p>` : ''}
    ${blocks.map((b) => `<div style="border:1px solid #ddd;border-radius:10px;padding:10px 12px;margin:10px 0"><b style="font-size:15px">${esc(b.title)}</b><br>${b.lines.map(esc).join('<br>')}</div>`).join('')}
    ${record ? `<p style="background:#f4f6f9;border-radius:8px;padding:8px 10px">📒 ${esc(record)}</p>` : ''}<p><a href="${SITE}">サイトで見る（あなた専用）</a></p><p style="color:#888;font-size:12px">${esc(note)}</p></div>`;
  return { subject, text, html };
}

// ---------------- 朝8:30「今日のプラン」 ----------------
// ・今日の寄り付き（朝9時）で買う・売る予定（きのうの夕方にお知らせしたもの）
// ・今日の寄り付きで決済する予定のもの、お知らせ済みで持っている途中のもの
// ・持っている株の今の状態と損切りの線
// ・決算発表が近い銘柄（持っている株・お気に入り）
async function earningsSoon(codes, today) {
  try {
    const d = JSON.parse(await fs.readFile(new URL('../data/earnings.json', import.meta.url), 'utf8'));
    const end = new Date(Date.parse(today) + 7 * 86400000).toISOString().slice(0, 10);
    return d.items.filter((x) => codes.has(x.code) && x.date >= today && x.date <= end);
  } catch { return []; }
}

const morningExec = (mode) => (mode === 'stock' ? '朝9:00の寄り付き' : mode === 'us' ? '今夜の米国の取引開始' : 'すでに朝7時ごろに入っている予定');

async function morning(users, state, TEST) {
  const today = dayKey(Date.now() / 1000);
  const book = state.book || {};
  const lists = {};
  for (const mode of MODES) if (users.some((u) => u.modes.includes(mode) && (u.holdings?.[mode] || []).length)) lists[mode] = await loadMode(mode, users, { holdingsOnly: true });
  for (const u of users) {
    const lines = [];
    const mine = book[u.uid]?.open || {};
    const tracked = Object.values(mine).filter((t) => t.kind === 'swing' && u.modes.includes(t.mode));
    const toOpen = tracked.filter((t) => !t.entryTime);
    const toClose = tracked.filter((t) => t.entryTime && t.closeSent);
    const holding = tracked.filter((t) => t.entryTime && !t.closeSent);
    lines.push(['🟢 今日の寄り付きで入る予定', toOpen.length ? toOpen.map((t) => `${t.name}：${t.how || (t.side > 0 ? '買う' : '売る')}（${morningExec(t.mode)}・${fmtTime(t.signalTime + 6.5 * 3600)}ごろにお知らせ）`) : ['なし']]);
    lines.push(['🔴 今日の寄り付きで決済する予定', toClose.length ? toClose.map((t) => `${t.name}：決済（${morningExec(t.mode)}）`) : ['なし']]);
    if (holding.length) lines.push(['📒 お知らせ済みで持っている途中', holding.map((t) => `${t.name}：${fmtTime(t.entryTime)} に ${price(t.entryPrice, t.mode)} で${t.side > 0 ? '買い' : '売り'}`)]);
    // 持っている株
    const holds = [];
    for (const m of u.modes) {
      for (const h of u.holdings?.[m] || []) {
        const x = lists[m]?.find((y) => y.code.toUpperCase() === String(h.code).toUpperCase());
        if (!x) continue;
        const adv = adviseHolding({ ...h, symbol: x.symbol }, x.candles, { mode: m, prices, usdjpy: prices['USDJPY=X'], profile: u.profile, today });
        if (!adv) continue;
        const ao = addOnAdvice({ ...h, symbol: x.symbol }, x.candles, adv, { mode: m });
        holds.push(`${h.name}：${adv.verdict.icon}${adv.verdict.label}（今 ${price(adv.now, m)}・${adv.plPct >= 0 ? '+' : ''}${(adv.plPct * 100).toFixed(1)}%）／${adv.protects ? '利益を守る線' : '損切りの線'} ${price(adv.stop, m)}${ao ? `／${ao.icon}${ao.title}` : ''}`);
      }
    }
    lines.push(['📦 持っている株', holds.length ? holds : ['入力されていません（サイトの「あなた専用」→「持っている株」で入れられます）']]);
    // 決算発表が近い銘柄
    const codes = new Set([...(u.holdings?.stock || []), ...(u.favs?.stock || [])].map((x) => String(x.code)));
    const soon = u.modes.includes('stock') ? await earningsSoon(codes, today) : [];
    if (soon.length) lines.push(['📅 1週間以内に決算発表', soon.map((x) => `${x.name}：${Number(x.date.slice(5, 7))}/${Number(x.date.slice(8, 10))}${x.date === today ? '（今日）' : ''}`)]);
    const subject = `【今日のプラン ${md(today)}】入る${toOpen.length}件・決済${toClose.length}件・持っている株${holds.length}件`;
    const record = recordLine(state.book || {}, u.uid, u.profile);
    const text = [subject, '', ...lines.flatMap(([h, ls]) => [h, ...ls.map((l) => `・${l}`), '']), `📒 ${record}`, '', `くわしくはサイトの「あなた専用」：${SITE}`, '', '※ 練習用のサインと目安です。売買はご自身の判断で行ってください。'].join('\n');
    const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6"><h2 style="font-size:16px">${esc(subject)}</h2>
      ${lines.map(([h, ls]) => `<div style="border:1px solid #ddd;border-radius:10px;padding:10px 12px;margin:10px 0"><b>${esc(h)}</b><br>${ls.map((l) => `・${esc(l)}`).join('<br>')}</div>`).join('')}
      <p style="background:#f4f6f9;border-radius:8px;padding:8px 10px">📒 ${esc(record)}</p><p><a href="${SITE}">サイトで見る（あなた専用）</a></p>
      <p style="color:#888;font-size:12px">※ 練習用のサインと目安です。売買はご自身の判断で行ってください。</p></div>`;
    try {
      await sendMail(u.to, subject, text, html);
      console.log('今日のプランを送りました');
    } catch (e) { console.log('メールを送れませんでした:', e.message); }
  }
}

async function main() {
  let state = { sent: {} };
  try { state = JSON.parse(await fs.readFile(STATE, 'utf8')); } catch { /* 初回 */ }
  const TEST = !!process.env.TEST_MAIL;
  site = await siteProfile();
  // 使う人ごと（持ち主と、持ち主が追加した人）。メールアドレスがある人だけに送る
  let users = site?.users || (site ? [{ uid: 'admin', ...site }] : []);
  if (!users.length && process.env.MAIL_TO) users = [{ uid: 'admin', profile: null, favs: {}, holdings: {} }];
  users = users.map((u) => ({ ...u, to: u.profile?.email || (u.uid === 'admin' ? process.env.MAIL_TO : '') }))
    .filter((u) => u.to)
    .map((u) => ({ ...u, modes: MODES.filter((m) => TEST || !u.profile?.notify || u.profile.notify[m]) }))
    .filter((u) => u.modes.length);
  // ログは公開されるので、メールアドレスや予算は出さない
  console.log(`メールを送る人: ${users.length}人`);
  if (!users.length) { console.log('届け先がないか、通知がオフになっています'); return; }
  const { MAIL_USER, MAIL_PASS } = process.env;
  if ((!MAIL_USER || !MAIL_PASS) && !process.env.DRY_RUN) { console.log('MAIL_USER・MAIL_PASS が登録されていないため送れません'); return; }

  const get = async (s) => (await candles(s)) || [];
  const [vix, tnx, nikkei] = await Promise.all([get('^VIX'), get('^TNX'), get('^N225')]);
  const regime = regimeLookup({ vix, tnx, nikkei });
  { const u = await candles('USDJPY=X'); if (u) prices['USDJPY=X'] = u[u.length - 1].close; }
  const lists = {}, dayLists = {};
  if (MORNING) return morning(users, state, TEST);
  if (DAY) {
    // デイトレ：今開いている市場だけ。デイトレの通知をオンにしている人だけ
    for (const u of users) u.modes = u.modes.filter((m) => OPEN.includes(m) && u.profile?.notifyDay !== false);
    users = users.filter((u) => u.modes.length);
    if (!users.length) { console.log('今デイトレの通知を受け取る人はいません'); return; }
    for (const mode of OPEN) {
      if (!users.some((u) => u.modes.includes(mode))) continue;
      dayLists[mode] = await daySignals(mode, users, regime);
      lists[mode] = await loadMode(mode, users, { holdingsOnly: true }); // 持っている株は日足で見張る
    }
  } else {
    for (const mode of MODES) if (users.some((u) => u.modes.includes(mode))) lists[mode] = await loadMode(mode, users);
  }

  const today = dayKey(Date.now() / 1000);
  const now = new Date().toISOString();
  const nowSec = Date.now() / 1000;
  const book = TEST ? JSON.parse(JSON.stringify(state.book || {})) : (state.book ||= {});
  for (const u of users) {
    const days = u.profile?.swingDays || 30;
    const groups = {};
    // やり方（現物・信用・空売り、為替の向き）は、その人の予算で過去をやり直して一番良かったものを自動で使う
    u.wayPf = {}; u.wayLabel = {};
    for (const m of u.modes) {
      const by = Object.fromEntries(waySides(m).map((v) => [v, DAY ? dayLists[m][v] : signalsFor(m, lists[m], regime, days, v)]));
      const pf = u.profile || {};
      const bg = budgets(pf);
      const cmp = compareWays(Object.fromEntries(Object.entries(by).map(([k, g]) => [k, g.trades])), m, pf, m === 'fx' ? bg.cash : bg.total, prices);
      const best = cmp.best;
      groups[m] = by[best.sides];
      u.wayPf[m] = wayProfile(pf, m, best.key);
      u.wayLabel[m] = best.label;
      console.log(`${NAMES[m]}：一番良いやり方は「${best.label}」`);
    }
    const planned = planForUser(u, DAY ? 'day' : 'swing', groups, book, nowSec);
    const holds = u.modes.flatMap((m) => holdingSignals(m, lists[m], u));
    const keyU = (s) => `${u.uid}|${keyOf(s)}`;
    // 持っている株のお知らせは、同じ内容を1日1回まで
    const freshHolds = holds.filter((s) => !state.sent[keyU(s)]);
    const fresh = [...freshHolds, ...planned].sort((a, b) => ORDER[a.type] - ORDER[b.type] || (b.odds?.p || 0) - (a.odds?.p || 0));
    if (!fresh.length && !TEST) { console.log(`${u.uid === 'admin' ? '持ち主' : 'ほかの人'}：新しいお知らせはありません`); continue; }
    const m = buildMail(fresh, u.modes, u.profile, today, TEST, DAY, recordLine(book, u.uid, u.profile));
    try {
      await sendMail(u.to, m.subject, m.text, m.html);
      console.log(`メールを送りました（${fresh.length}件）`);
    } catch (e) { console.log('メールを送れませんでした:', e.message); continue; }
    if (TEST) continue; // テストのときは記録を残さない
    for (const s of freshHolds) state.sent[keyU(s)] = now;
  }
  if (TEST) return;
  // 30日より前の記録は消す
  for (const [k, v] of Object.entries(state.sent)) if (Date.now() - Date.parse(v) > 30 * 86400000) delete state.sent[k];
  await fs.mkdir(new URL('.', STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(state, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
