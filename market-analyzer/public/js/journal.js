// あなたのプランの記録
// ・「あなた専用」で出た「買うもの」を毎日記録する
// ・あなたが「買った」「見送り」「売った」を付ける（🛒 のチェックや「決済した」ボタンと連動）
// ・「プランどおりに全部やっていたら」と「実際にやった分」の損益を、今日・1週間・1か月で比べる
import { api, esc, store, fmtYen } from './util.js';
import { saveSynced } from './favorites.js';
import { runStrategy } from './strategies.js';

const KEY = (m) => `journal_${m}`;
export const getJournal = (m) => store.get(KEY(m), []) || [];
const setJournal = (m, list) => saveSynced(KEY(m), list.slice(-300));
const DAY = 86400;
export const jstDay = (sec) => new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 10);
const daySec = (d) => Date.parse(`${d}T15:00:00+09:00`) / 1000; // その日の大引け
const sameSym = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();

// プランの「買うもの」を記録する（同じサインは1回だけ。同じ銘柄・向きを3日以内にもう記録していれば足さない）
export function recordPicks(mode, picks, maxHold) {
  const list = getJournal(mode);
  let added = 0;
  for (const x of picks) {
    if (!x.size?.qty || !x.t) continue;
    const id = `${jstDay(x.t)}|${x.symbol}|${x.side}`;
    if (list.some((e) => e.id === id || (sameSym(e.symbol, x.symbol) && e.side === x.side && x.t - e.t < 3 * DAY))) continue;
    list.push({ id, date: jstDay(x.t), t: x.t, symbol: x.symbol, code: String(x.symbol).replace(/\.T$|=X$/i, ''), name: x.name, side: x.side,
      acct: x.size.acct || '', qty: x.size.qty, price: x.last, perPrice: x.size.perPrice || 0, maxHold, status: 'open' });
    added++;
  }
  if (added) setJournal(mode, list);
}

// 🛒 で「買った」にしたとき：いちばん新しい、まだ記入していない同じ銘柄・向きの記録に付ける
export function markBought(mode, symbol, side, { price, qty, date }) {
  const list = getJournal(mode);
  const e = [...list].reverse().find((x) => sameSym(x.symbol, symbol) && x.side === side && x.status !== 'bought');
  if (!e) return;
  e.status = 'bought';
  e.a = { price, qty, date: date || jstDay(Date.now() / 1000), exitPrice: null, exitDate: '' };
  setJournal(mode, list);
}

// 決済した（売った・買い戻した）とき：その銘柄・向きで、まだ売っていない「買った」記録に、売った値段を付ける
export function markSold(mode, codeOrSymbol, side, exitPrice, date) {
  const list = getJournal(mode);
  const key = String(codeOrSymbol).replace(/\.T$|=X$/i, '').toUpperCase();
  let n = 0;
  for (const e of list) {
    if (e.status === 'bought' && e.side === side && String(e.code).toUpperCase() === key && e.a && e.a.exitPrice == null) {
      e.a.exitPrice = exitPrice; e.a.exitDate = date || jstDay(Date.now() / 1000); n++;
    }
  }
  if (n) setJournal(mode, list);
  return n;
}

export function setStatus(mode, id, status, a = null) {
  const list = getJournal(mode);
  const e = list.find((x) => x.id === id);
  if (!e) return;
  e.status = status;
  if (a) e.a = { ...(e.a || {}), ...a };
  if (status !== 'bought') delete e.a;
  setJournal(mode, list);
}

// ---------------- 損益の計算 ----------------
// 期間の初め（ws）から今まで、または決済までに、その取引でいくら増えた（減った）か
//   期間より前に入っていたら、期間の初めの値段から数える。期間より前に決済していたら 0
function pnlIn(pos, ws, candles, nowPrice) {
  const end = pos.exitTime ?? Infinity;
  if (end < ws) return 0;
  let start = pos.entry;
  if (pos.entryTime < ws) {
    const before = candles.filter((c) => c.time < ws);
    start = before.length ? before[before.length - 1].close : pos.entry;
  }
  const last = pos.exitTime != null ? pos.exit : nowPrice;
  return pos.side * (last - start) * pos.per;
}

// プランどおりなら：記録した日のサインから、プランと同じ計算（同じルール）で入って、決済のサインで出る
export function planPosition(e, candles, regime) {
  const r = runStrategy(candles, 'combo', { kind: e.mode, pair: e.symbol.replace(/=X$/, ''), regime, maxHold: e.maxHold || 30, sides: e.side > 0 ? 'long' : 'short' });
  const per = e.perPrice || 0;
  // サインの次の取引日（休みをはさんでも4日以内）に入ったものだけが、そのサインの取引
  const mine = (x) => x && x.side === e.side && (x.entryTime ?? 0) > e.t && x.entryTime <= e.t + 5 * DAY;
  const t = r.trades.find(mine);
  if (t) return { side: e.side, per, entry: t.entryPrice, entryTime: t.entryTime, exit: t.exitPrice, exitTime: t.exitTime, reason: t.reasonOut };
  if (mine(r.open)) return { side: e.side, per, entry: r.open.entryPrice, entryTime: r.open.entryTime };
  // サインの次の足がまだない（明日の朝に入る）
  const next = candles.find((c) => c.time > e.t);
  if (!next) return { side: e.side, per, wait: true };
  // 計算し直すと入らなかった（その日のうちにサインが消えた）ものは、次の日の始まりで入ったとして、今まで持っている扱い
  return { side: e.side, per, entry: next.open, entryTime: next.time, approx: true };
}

// 実際にやった分：「買った」の値段・数量と、「売った」の値段
export function actualPosition(e) {
  if (e.status !== 'bought' || !e.a?.price) return null;
  const per = e.qty ? (e.perPrice || 0) * ((e.a.qty || e.qty) / e.qty) : 0;
  return { side: e.side, per, entry: e.a.price, entryTime: daySec(e.a.date) - 6 * 3600, ...(e.a.exitPrice != null ? { exit: e.a.exitPrice, exitTime: daySec(e.a.exitDate || e.a.date) } : {}) };
}

export const WINDOWS = [['today', '今日'], ['week', '1週間'], ['month', '1か月']];
function windowStart(key, now) {
  const today = daySec(jstDay(now)) - 6.5 * 3600; // 今日の朝（日本時間 8:30）
  return key === 'today' ? today : key === 'week' ? today - 6 * DAY : today - 29 * DAY;
}

// 記録した全部について、プランどおりと実際の損益を、今日・1週間・1か月で出す
export async function journalStats(mode, regime, now = Date.now() / 1000) {
  const list = getJournal(mode).filter((e) => e.t > now - 120 * DAY).map((e) => ({ ...e, mode }));
  const syms = [...new Set(list.map((e) => e.symbol))];
  const data = {};
  await Promise.all(syms.map(async (s) => {
    try { data[s] = (await api(`/api/chart?symbol=${encodeURIComponent(s.replace(/=X$/, ''))}&tf=1d`)).candles; } catch { data[s] = null; }
  }));
  const sum = { plan: {}, real: {} };
  for (const [k] of WINDOWS) { sum.plan[k] = 0; sum.real[k] = 0; }
  sum.planOpen = 0; sum.realOpen = 0;
  const rows = [];
  for (const e of list) {
    const cs = data[e.symbol];
    if (!cs?.length) { rows.push({ e, missing: true }); continue; }
    const nowP = cs[cs.length - 1].close;
    const plan = planPosition(e, cs, regime);
    const real = actualPosition(e);
    const row = { e, plan, real, now: nowP };
    if (!plan.wait && plan.entry != null) {
      for (const [k] of WINDOWS) sum.plan[k] += pnlIn(plan, windowStart(k, now), cs, nowP);
      row.planPnl = plan.side * ((plan.exitTime != null ? plan.exit : nowP) - plan.entry) * plan.per;
      if (plan.exitTime == null) sum.planOpen += row.planPnl;
    }
    if (real) {
      for (const [k] of WINDOWS) sum.real[k] += pnlIn(real, windowStart(k, now), cs, nowP);
      row.realPnl = real.side * ((real.exitTime != null ? real.exit : nowP) - real.entry) * real.per;
      if (real.exitTime == null) sum.realOpen += row.realPnl;
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.e.t - a.e.t);
  return { sum, rows, count: list.length, bought: list.filter((e) => e.status === 'bought').length, skipped: list.filter((e) => e.status === 'skipped').length, open: list.filter((e) => e.status === 'open').length };
}

// ---------------- 画面 ----------------
const cls = (v) => (v > 0 ? 'plus' : v < 0 ? 'minus' : '');
const yenCell = (v) => `<b class="${cls(v)}" style="white-space:nowrap">${fmtYen(Math.round(v))}</b>`;

export function summaryHtml(st) {
  const { sum } = st;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th>${WINDOWS.map(([, l]) => `<th class="r">${l}</th>`).join('')}</tr></thead><tbody>
    <tr><td class="small">📋 プランどおりなら</td>${WINDOWS.map(([k]) => `<td class="r">${yenCell(sum.plan[k])}</td>`).join('')}</tr>
    <tr><td class="small">🙋 実際にやった分</td>${WINDOWS.map(([k]) => `<td class="r">${yenCell(sum.real[k])}</td>`).join('')}</tr>
    </tbody></table></div>
    <p class="small muted" style="margin:4px 0 0">「プランどおりなら」はプランで出たものを全部やっていた場合、「実際」は「買った」にしたものだけです。決済したものは決済した値段、まだ持っているものは今の値段で計算しています（まだ持っている分の含み損益：プラン ${fmtYen(Math.round(sum.planOpen))}・実際 ${fmtYen(Math.round(sum.realOpen))}）。「今日」は今朝から、「1週間」「1か月」はその期間の初めから増えた・減った分です。</p>`;
}

const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
function rowHtml(x, fmtPrice) {
  const e = x.e;
  const side = e.side > 0 ? '買い' : '売り';
  const badge = e.status === 'bought' ? (e.a?.exitPrice != null ? '<span class="badge">売った</span>' : '<span class="badge buy">買った</span>') : e.status === 'skipped' ? '<span class="badge">見送り</span>' : '<span class="badge sell">まだ記入していない</span>';
  if (x.missing) return `<li class="small"><b>${esc(e.name)}</b> ${badge}<br><span class="muted">値段を取得できませんでした</span></li>`;
  const p = x.plan;
  const planTxt = p.wait ? 'これから入る（次の取引日の始まり）'
    : `${md(jstDay(p.entryTime))} ${fmtPrice(p.entry)}で${side}${p.exitTime != null ? ` → ${md(jstDay(p.exitTime))} ${fmtPrice(p.exit)}で決済` : ' → 今も持っている'}${p.approx ? '（サインがその日のうちに消えたので、次の日の始まりに入った計算）' : ''}：${yenCell(x.planPnl || 0)}`;
  const realTxt = x.real ? `${md(e.a.date)} ${fmtPrice(e.a.price)}で${side}${e.a.exitPrice != null ? ` → ${md(e.a.exitDate)} ${fmtPrice(e.a.exitPrice)}で決済` : ' → 今も持っている'}：${yenCell(x.realPnl || 0)}` : e.status === 'skipped' ? 'やらなかった（0円）' : '—';
  const btns = e.status === 'open'
    ? `<div class="row" style="gap:6px;margin-top:4px"><button class="btn small jr-buy" data-id="${esc(e.id)}">✔ 買った</button><button class="btn small jr-skip" data-id="${esc(e.id)}">見送った</button></div>`
    : e.status === 'bought' && e.a?.exitPrice == null ? `<div class="row" style="gap:6px;margin-top:4px"><button class="btn small jr-sell" data-id="${esc(e.id)}">✔ 決済した（売った値段を入れる）</button><button class="btn small jr-undo" data-id="${esc(e.id)}">記入を取り消す</button></div>`
    : `<div class="row" style="gap:6px;margin-top:4px"><button class="btn small jr-undo" data-id="${esc(e.id)}">記入を取り消す</button></div>`;
  return `<li><div class="row" style="flex-wrap:wrap;gap:6px"><b>${md(e.date)} ${esc(e.name)}</b><span class="small">${side}</span>${badge}</div>
    <div class="small">📋 プランどおりなら：${planTxt}</div>
    <div class="small">🙋 実際：${realTxt}</div>${btns}</li>`;
}

export function listHtml(st, fmtPrice) {
  if (!st.rows.length) return '<p class="small muted">まだ記録がありません。「あなたのプラン」で「これを買ってください」と出たものを、自動でここに記録していきます。</p>';
  return `<p class="small" style="margin:0 0 6px">記録 ${st.count}件（買った ${st.bought}・見送り ${st.skipped}・まだ記入していない ${st.open}）</p>
    <ul class="list">${st.rows.slice(0, 60).map((x) => rowHtml(x, fmtPrice)).join('')}</ul>`;
}
