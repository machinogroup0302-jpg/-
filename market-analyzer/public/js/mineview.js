// 「あなた専用」タブ：あなたのプラン・持っている株・今のサイン・売買の一覧
// スイング（日足・数日〜数週間）とデイトレ（15分足・その日のうちに決済）を切り替えられる
import { api, $, esc, store, fmtPrice, fmtYen } from './util.js';
import { runStrategy, signalOdds, oddsLabel, oddsText } from './strategies.js';
import { pagedList } from './stockscreener.js';
import { getProfile, setProfile, getHoldings, setHoldings } from './favorites.js';
import { sizePosition, replayWithBudget, levFor, MAINT } from './plan.js';
import { loadRegime, loadCandles, universe, kindOf } from './labview.js';
import { adviseHolding, exitTiming, longTermView } from './holdingadvice.js';
import { searchFx } from './fxpairs.js';
import { fmtTime, judgedText, execText } from './sessiontime.js';

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
// 銘柄名を押すと、その銘柄のチャートを開く
const symLink = (symbol, name) => `<a href="#" class="sym-link" data-symbol="${esc(symbol)}" data-name="${esc(name)}">${esc(name)}</a>`;
// 「いつ判断して、いつ売買するか」
const timeLine = (mode, t, extra = '') => `<div class="small time-line">🕒 判断した時刻：${esc(judgedText(mode, t, style === 'day'))}<br>　 売買する時刻：${esc(execText(mode, style === 'day'))}${extra}</div>`;
let style = store.get('mine_style', 'swing');
let mineSub = store.get('mine_sub', 'plan');
let getModeFn = () => 'fx';

// ---------------- 全銘柄の売買一覧（理由つき） ----------------
// 計算する銘柄：為替は全部・米国株は一覧の全部・日本株は全上場企業をチェックして上位をくわしく計算
async function ensureScan(out) {
  let started = false;
  for (let i = 0; i < 120; i++) {
    let st;
    try { st = await api('/api/stocks/scan?view=buy&limit=1'); } catch { return false; }
    if (st.status === 'done' && Date.now() - (st.finishedAt || 0) < 6 * 3600 * 1000) return true;
    if (st.status !== 'running') {
      if (started) return st.status === 'done'; // 一度始めて失敗したら、代表銘柄だけで計算する
      started = true;
      try { await api('/api/stocks/scan', { method: 'POST', body: { markets: ['プライム', 'スタンダード', 'グロース'] } }); } catch { return false; }
    }
    out.innerHTML = `<p class="small muted"><span class="spinner"></span> 東証の全上場企業をチェックしています… ${st.total ? `${(st.done || 0).toLocaleString()} / ${st.total.toLocaleString()}社` : ''}</p>`;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function logUniverse(mode, out) {
  const syms = universe(mode);
  const seen = new Set(syms.map(([c]) => c.toUpperCase()));
  const add = (code, name) => { const k = String(code).toUpperCase(); if (!seen.has(k)) { seen.add(k); syms.push([code, name]); } };
  for (const h of getHoldings(mode)) add(h.code, h.name);
  if (mode === 'us' && style === 'swing') {
    try { (await api('/api/us/list')).items.forEach((x) => add(x.symbol, x.name)); } catch { /* 一覧が取れなければ代表銘柄だけ */ }
  }
  if (mode === 'stock') {
    const scanned = await ensureScan(out);
    scanInfo = '';
    if (scanned) {
      const views = style === 'day' ? [['up', 15], ['buy', 15]] : [['buy', 40], ['sell', 10]];
      for (const [view, n] of views) {
        try {
          const r = await api(`/api/stocks/scan?view=${view}&limit=${n}`);
          if (view === 'buy') scanInfo = `東証の全${(r.total || 0).toLocaleString()}社をチェックし、そのうち買いのサインが強い上位の会社などをくわしく計算しています。`;
          for (const x of r.results || []) add(x.code, x.name);
        } catch { /* 取れなければ代表銘柄だけ */ }
      }
    }
  }
  return syms;
}
let scanInfo = '';

const whyList = (arr) => (arr?.length ? `<ul class="why">${arr.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
const sideBadge = (s) => `<span class="badge ${s > 0 ? 'buy' : 'sell'}">${s > 0 ? '買い' : '売り'}</span>`;
const digitsOf = (mode) => (mode === 'stock' ? 1 : mode === 'us' ? 2 : 3);
const ymd = (x) => esc(`${Number(String(x).slice(5, 7))}/${Number(String(x).slice(8, 10))}`);
const hm = (t) => new Date(t * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
const when = (date, time) => (time ? esc(fmtTime(time)) : ymd(date));
const heldText = (t) => (style === 'day' ? `${Math.max(15, Math.round((t.exitTime - t.entryTime) / 60))}分間` : `${t.days}日間`);
const nextText = () => (style === 'day' ? '次の15分足の始まりに' : '次の取引日の始まりに');

// 勝つ確率の目安を、色つきのメーターで見せる
function oddsHtml(o, { compact = false } = {}) {
  if (!o) return '<div class="odds muted small">勝つ確率：過去の取引が少なく、まだ出せません</div>';
  const v = Math.round(o.p * 100);
  const cls = o.p >= 0.6 ? 'hi' : o.p >= 0.5 ? 'mid' : 'lo';
  return `<div class="odds ${cls}"><div class="odds-head"><span>勝つ確率の目安</span><b>${v}%</b><span class="badge ${cls === 'hi' ? 'ok' : cls === 'mid' ? 'warn' : 'danger'}">${oddsLabel(o)}</span></div>
    <div class="odds-bar"><i style="width:${v}%"></i></div>${compact ? '' : `<div class="small muted" style="margin-top:4px">${esc(oddsText(o))}</div>`}</div>`;
}

const logCache = {};
let logRunning = null;

// 全銘柄を「総合判断」で計算する（「今のサイン」と「売買の一覧」で共通）
async function computeLog(mode, out, force = false) {
  const swingDays = getProfile().swingDays || 30;
  const ck = `${mode}|${style}|${style === 'swing' ? swingDays : ''}`;
  const hit = logCache[ck];
  if (hit && !force && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  if (logRunning?.ck === ck) return logRunning.p;
  const p = (async () => {
    const regime = await loadRegime();
    const day = style === 'day';
    const list = await loadCandles(await logUniverse(mode, out), out, day ? '15m' : '1d', day ? 150 : 200);
    out.innerHTML = '<p class="small muted"><span class="spinner"></span> 計算しています…</p>';
    await new Promise((r) => setTimeout(r, 30));
    const kind = kindOf(mode);
    const trades = [], holding = [], next = [];
    const prices = {};
    for (const x of list) {
      prices[x.symbol] = x.candles[x.candles.length - 1].close;
      const r = runStrategy(x.candles, 'combo', { kind, pair: x.symbol.replace(/=X$/, ''), regime, intraday: day, days: day ? (kind === 'fx' ? 1000 : 600) : 250, maxHold: day ? null : swingDays });
      const last = x.candles[x.candles.length - 1];
      for (const t of r.trades) trades.push({ ...t, name: x.name, symbol: x.symbol });
      if (r.open) holding.push({ ...r.open, name: x.name, symbol: x.symbol, last: last.close });
      if (r.next) next.push({ ...r.next, name: x.name, symbol: x.symbol, open: r.open, last: last.close, date: dayKeyOf(last.time), t: last.time });
    }
    // 確率：これからの売買は全部の取引から、過去の売買は「その日より前に終わった取引」だけから計算する
    for (const x of next) if (x.type === 'open') x.odds = signalOdds(trades, { symbol: x.symbol, side: x.side, strength: x.strength });
    for (const x of holding) x.odds = signalOdds(trades, { symbol: x.symbol, side: x.side, strength: x.strength, before: x.entryDate });
    for (const t of trades) t.odds = signalOdds(trades, { symbol: t.symbol, side: t.side, strength: t.strength, before: t.entryDate });
    let usdjpy = prices['USDJPY=X'] || null;
    if (!usdjpy) { try { const u = await api('/api/chart?symbol=USDJPY&tf=1d'); usdjpy = u.candles[u.candles.length - 1].close; } catch { /* 取れなければ米国株の量は出さない */ } }
    const data = { trades, holding, next, prices, usdjpy, count: list.length, at: Date.now(), style, scanInfo };
    logCache[ck] = { at: Date.now(), data };
    return data;
  })();
  logRunning = { ck, p };
  try { return await p; } finally { logRunning = null; }
}

const dayKeyOf = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);

// 自動で最新にしているので「最新にする」ボタンは置かず、いつの計算かだけ出す
function updatedNote(r) {
  const t = new Date(r.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return `<p class="small muted" style="margin-top:10px">${t}時点の計算・この画面を開いている間は15分ごとに自動で最新にします。${r.count}銘柄を計算${r.scanInfo ? `（${esc(r.scanInfo)}）` : ''}</p>`;
}

async function showPlan(mode, force = false) {
  const out = $('lab-plan');
  try {
    const r = await computeLog(mode, out, force);
    if (getModeFn() !== mode) return;
    renderPlan(r, mode);
  } catch (e) { out.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

const yen0 = (v) => `${Math.round(v).toLocaleString()}円`;

function renderPlan(r, mode) {
  const pf = getProfile();
  const budget = pf.budget || 1_000_000;
  const d = digitsOf(mode);
  const rule = { budget, riskPct: pf.riskPct, maxPos: pf.maxPos };
  // 過去1年をあなたのルールでやり直す：全部やった場合と、確率の目安が高いものだけやった場合
  const all = replayWithBudget(r.trades, rule);
  const picky = replayWithBudget(r.trades, { ...rule, minOdds: 0.55 });
  const usePicky = picky.trades >= 5 && picky.total > all.total;
  const minOdds = usePicky ? 0.55 : 0.5;
  const lev = levFor(pf, mode);
  const sz = (x, stop) => sizePosition({ mode, symbol: x.symbol, price: x.last, stop, budget, riskPct: pf.riskPct, maxPos: pf.maxPos, prices: r.prices, usdjpy: r.usdjpy, leverage: lev });
  // レバレッジをかけて「1銘柄に 予算÷数×倍率 の金額」で入っていたら（損切りの幅で量を減らさない）
  const levRows = [1, lev].filter((v, i, a) => a.indexOf(v) === i).map((L) => ({ L, r: replayWithBudget(r.trades, { ...rule, minOdds: usePicky ? 0.55 : 0, leverage: L, maint: MAINT[mode] }) }));
  const opens = r.next.filter((x) => x.type === 'open').map((x) => ({ ...x, size: sz(x, x.stopEst) }))
    .sort((a, b) => (b.odds?.p || 0) - (a.odds?.p || 0));
  const good = opens.filter((x) => x.odds && x.odds.p >= minOdds && x.odds.expect > 0);
  const picks = good.filter((x) => x.size?.qty > 0).slice(0, pf.maxPos);
  const rest = opens.filter((x) => !picks.includes(x));
  const closes = r.next.filter((x) => x.type === 'close');
  const replayCard = (t, x) => `<div class="stat"><div class="label">${t}</div><div class="value ${x.total >= 0 ? 'plus' : 'minus'}">${fmtYen(x.total)}</div><div class="small muted">${x.trades}回・勝率${pct(x.winRate)}・一番減ったとき ${fmtYen(-x.maxDD)}${x.losscuts ? `・<b class="minus">ロスカット${x.losscuts}回</b>` : ''}${x.broke ? '・<b class="minus">途中で資金がなくなった</b>' : ''}</div></div>`;
  $('lab-plan').innerHTML = `
    ${pf.budget ? '' : '<p class="notice" style="margin:0 0 8px">予算がまだ入っていないので、100万円で計算しています。右上の⚙（設定）の「あなたの設定」で入れてください。</p>'}
    <div class="plan-rule small">予算 <b>${yen0(budget)}</b>　／　1回で減ってもいい額 <b>${yen0(budget * pf.riskPct / 100)}</b>（${pf.riskPct}%）　／　同時に <b>${pf.maxPos}銘柄</b>まで（1銘柄 ${yen0(budget / pf.maxPos)}まで）　／　レバレッジ <b>${lev}倍</b></div>
    <button class="btn block" id="plan-settings" style="margin:8px 0 4px">予算・ルールを変える</button>

    <h3>✅ 今やるといいこと<span class="sub">${nextText()}</span></h3>
    ${picks.length ? `<ul class="list">${picks.map((x) => {
      const s = x.size;
      const gain = x.takeEst ? Math.abs(x.takeEst - x.last) * s.perPrice : null;
      return `<li class="plan-pick">
        <div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${sideBadge(x.side)}</div>
        ${timeLine(mode, x.t)}
        <div class="plan-order"><b>${x.side > 0 ? '買う' : '売る'}：${s.qty.toLocaleString()}${s.unitLabel}</b>（今 ${fmtPrice(x.last, d)}・${s.kindLabel} 約${yen0(s.cost)}）</div>
        <div class="grid2 plan-grid">
          <div class="stat"><div class="label">損切りの値段</div><div class="value minus" style="font-size:16px">${fmtPrice(x.stopEst, d)}</div><div class="small muted">ここまで来たら決済：約−${yen0(s.maxLoss)}</div></div>
          <div class="stat"><div class="label">利益確定の目標</div><div class="value plus" style="font-size:16px">${x.takeEst ? fmtPrice(x.takeEst, d) : '—'}</div><div class="small muted">${gain ? `届いたら決済：約+${yen0(gain)}` : '判定が変わるまで持つ'}</div></div>
        </div>
        ${oddsHtml(x.odds, { compact: true })}
        <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details></li>`;
    }).join('')}</ul>` : `<p class="small muted">今は、あなたのルールに合うサインがありません（勝つ確率の目安${Math.round(minOdds * 100)}%以上・予算内で買える量があるもの）。お休みも大事なトレードです。</p>`}

    <h3>🔴 持っていたら決済した方がいいもの</h3>
    ${closes.length ? `<ul class="list">${closes.map((x) => `<li><div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${x.open ? sideBadge(x.open.side) : ''}</div>
      <div class="small"><b>${nextText()}決済</b>：${esc(x.reason)}</div>${timeLine(mode, x.t)}</li>`).join('')}</ul>` : '<p class="small muted">今はありません。</p>'}

    ${rest.length ? `<details class="why-box" style="margin-top:10px"><summary>見送ったサイン（${rest.length}件）</summary><ul class="list">${rest.map((x) => `<li class="small"><b>${esc(x.name)}</b> ${sideBadge(x.side)} 確率${x.odds ? Math.round(x.odds.p * 100) + '%' : '—'}　<span class="muted">${
      !x.odds || x.odds.p < minOdds ? `勝つ確率の目安が${Math.round(minOdds * 100)}%未満` : x.odds.expect <= 0 ? '勝っても負けても平均するとマイナス' : x.size && x.size.qty === 0 ? esc(x.size.why) : !x.size ? '量を計算できませんでした' : `同時に持つ数（${pf.maxPos}つ）を超えるため`}</span></li>`).join('')}</ul></details>` : ''}

    <h3>📊 あなたの予算で、このやり方を1年続けていたら</h3>
    <div class="grid2">${replayCard('サインが出たら全部やる', all)}${replayCard('確率の目安55%以上だけやる', picky)}</div>
    <h3>レバレッジで比べると<span class="sub">1銘柄 ${yen0(budget / pf.maxPos)} × 倍率の金額で入った場合</span></h3>
    <div class="grid2">${levRows.map(({ L, r: x }) => replayCard(L === 1 ? 'レバレッジなし（1倍）' : `あなたの設定 ${L}倍`, x)).join('')}</div>
    <p class="small muted" style="margin:4px 0 0">レバレッジの比べ方は、損切りの幅で量を減らさずに「予算÷同時に持つ数×倍率」の金額で入った計算です。持っている間に一番不利になったところで、${mode === 'fx' ? '証拠金維持率が100%' : mode === 'us' ? '保証金が取引金額の25%' : '保証金維持率が20%'}を割ったら「ロスカット（強制決済）」としています。${lev === 1 ? '設定（⚙）でレバレッジを上げると、その倍率でも比べられます。' : ''}</p>
    <p class="small" style="margin:6px 0 0"><b>おすすめ：</b>${usePicky ? '確率の目安が55%以上のサインだけに絞る方が成績が良かったので、上の「今やるといいこと」も55%以上に絞っています。' : '絞らずにサインどおりにやる方が成績が良かったので、50%以上のサインを出しています。'}</p>
    <p class="notice" style="margin-top:8px">過去の値動きでの計算です。日本株は100株単位、為替は1,000通貨単位で、レバレッジは設定の${lev}倍で計算しています（為替の証拠金は国内の決まりの25倍で計算）。手数料などは差し引いていますが、実際の値段（次の日の始まりの値段）は少しずれます。最終的な判断はご自身で行ってください。</p>
    ${updatedNote(r)}`;
  $('plan-settings').onclick = () => $('open-settings').click();
}

async function showNow(mode, force = false) {
  const out = $('lab-now');
  try {
    const r = await computeLog(mode, out, force);
    if (getModeFn() !== mode) return;
    renderNow(r, mode);
  } catch (e) { out.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function showList(mode, force = false) {
  const out = $('lab-log');
  try {
    const r = await computeLog(mode, out, force);
    if (getModeFn() !== mode) return;
    renderLog(r, mode);
  } catch (e) { out.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function renderNow(r, mode) {
  const d = digitsOf(mode);
  const opens = r.next.filter((x) => x.type === 'open').sort((a, b) => (b.odds?.p || 0) - (a.odds?.p || 0));
  const closes = r.next.filter((x) => x.type === 'close');
  const judged = style === 'day' ? '最新の15分足で判断' : r.next[0]?.date ? `${ymd(r.next[0].date)}の終わりの値段で判断` : '';
  $('lab-now').innerHTML = `
    <h3>🟢 新しく入るサイン<span class="sub">${opens.length}件・${judged}</span></h3>
    ${opens.length ? `<ul class="list">${opens.map((x) => `<li>
      <div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${sideBadge(x.side)}</div>
      <div class="small"><b>${nextText()}${x.side > 0 ? '買う' : '売る'}</b>（今 ${fmtPrice(x.last, d)}）</div>
      ${timeLine(mode, x.t)}
      ${oddsHtml(x.odds)}
      <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details></li>`).join('')}</ul>` : '<p class="small muted">今は新しく入るサインはありません。</p>'}
    <h3>🔴 決済するサイン<span class="sub">${closes.length}件</span></h3>
    ${closes.length ? `<ul class="list">${closes.map((x) => {
      const g = x.open ? x.open.side * (x.last / x.open.entryPrice - 1) : 0;
      return `<li><div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${x.open ? sideBadge(x.open.side) : ''}<b class="${g >= 0 ? 'plus' : 'minus'}">${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%</b></div>
      <div class="small"><b>${nextText()}決済</b>：${esc(x.reason)}</div>${timeLine(mode, x.t)}
      ${x.open ? `<div class="small muted">${when(x.open.entryDate, x.open.entryTime)}に${fmtPrice(x.open.entryPrice, d)}で${x.open.side > 0 ? '買い' : '売り'} → 今 ${fmtPrice(x.last, d)}</div>` : ''}
      <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details></li>`;
    }).join('')}</ul>` : '<p class="small muted">今は決済するサインはありません。</p>'}
    <h3>📦 計算の上で持っている銘柄<span class="sub">${r.holding.length}件</span></h3>
    <p class="small muted" style="margin:-4px 0 6px">このやり方が仮想のお金で持っているものです。あなたが実際に持っている株は「持っている株」のタブにあります。</p>
    ${r.holding.length ? `<ul class="list">${r.holding.map((x) => {
      const g = x.side * (x.last / x.entryPrice - 1);
      return `<li><div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${sideBadge(x.side)}<b class="${g >= 0 ? 'plus' : 'minus'}">${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%</b></div>
      <div class="small">${when(x.entryDate, x.entryTime)}に ${fmtPrice(x.entryPrice, d)} で${x.side > 0 ? '買い' : '売り'} → 今 ${fmtPrice(x.last, d)}</div>
      <div class="small muted">損切りの線 ${fmtPrice(x.stop, d)}${x.take ? `・利益確定の目標 ${fmtPrice(x.take, d)}` : ''}</div>
      ${oddsHtml(x.odds, { compact: true })}
      <details class="why-box"><summary>入った理由を見る</summary>${whyList(x.why)}</details></li>`;
    }).join('')}</ul>` : '<p class="small muted">計算の上で持っている銘柄はありません。</p>'}
    <p class="notice" style="margin-top:8px">「勝つ確率の目安」は過去の成績からの見積もりで、当たる保証はありません。${r.count}銘柄を計算・${new Date(r.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}時点。</p>
    ${updatedNote(r)}`;
}

let logFilter = 'all';
function renderLog(r, mode) {
  const d = digitsOf(mode);
  const wins = r.trades.filter((t) => t.pnl > 0);
  const total = r.trades.reduce((a, t) => a + t.pnl, 0);
  const sorted = r.trades.slice().sort((a, b) => b.entryDate.localeCompare(a.entryDate));
  // 確率の目安ごとに、実際どれくらい勝てたか（目安が当てになるかの確認）
  const band = (lo, hi) => { const g = r.trades.filter((t) => t.odds && t.odds.p >= lo && t.odds.p < hi); return { n: g.length, w: g.filter((t) => t.pnl > 0).length }; };
  const bands = [['60%以上', band(0.6, 2)], ['50〜60%', band(0.5, 0.6)], ['50%未満', band(0, 0.5)]];
  $('lab-log').innerHTML = `
    <div class="grid2">
      <div class="stat"><div class="label">取引の回数（${r.count}銘柄）</div><div class="value">${r.trades.length}回</div></div>
      <div class="stat"><div class="label">勝率</div><div class="value">${pct(r.trades.length ? wins.length / r.trades.length : null)}</div></div>
      <div class="stat"><div class="label">合計の損益（決済した分）</div><div class="value ${total >= 0 ? 'plus' : 'minus'}">${fmtYen(total)}</div></div>
      <div class="stat"><div class="label">1回あたりの平均</div><div class="value ${total >= 0 ? 'plus' : 'minus'}">${fmtYen(r.trades.length ? total / r.trades.length : 0)}</div></div>
    </div>
    <h3>確率の目安は当たっていた？</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>入ったときの目安</th><th class="r">回数</th><th class="r">実際の勝率</th></tr></thead><tbody>
      ${bands.map(([k, b]) => `<tr><td class="small">${k}</td><td class="r">${b.n}</td><td class="r">${b.n ? pct(b.w / b.n) : '—'}</td></tr>`).join('')}</tbody></table></div>
    <h3>売買の一覧<span class="sub">新しい順・10件ずつ</span></h3>
    <div class="seg" id="lab-log-seg" style="margin-bottom:8px">${[['all', 'すべて'], ['win', '勝ち'], ['loss', '負け'], ['buy', '買い'], ['sell', '売り']].map(([k, v]) => `<button data-f="${k}" aria-pressed="${k === logFilter}">${v}</button>`).join('')}</div>
    <div id="lab-log-list"></div>
    ${updatedNote(r)}`;
  const draw = () => {
    const f = { all: () => true, win: (t) => t.pnl > 0, loss: (t) => t.pnl <= 0, buy: (t) => t.side > 0, sell: (t) => t.side < 0 }[logFilter];
    pagedList($('lab-log-list'), sorted.filter(f), (t) => `<li class="log-item">
      <div class="li-head"><span class="name">${symLink(t.symbol, t.name)}</span>${sideBadge(t.side)}<b class="${t.pnl >= 0 ? 'plus' : 'minus'}" style="font-size:16px">${t.pnl >= 0 ? '勝ち ' : '負け '}${fmtYen(t.pnl)}</b></div>
      <div class="timeline">
        <div class="tl-step"><span class="tl-dot in"></span><div><b>${when(t.entryDate, t.entryTime)} ${t.side > 0 ? '買った' : '売った'}</b>　<span class="num">${fmtPrice(t.entryPrice, d)}</span><div class="small muted">${esc(t.reasonIn)}</div></div></div>
        <div class="tl-step"><span class="tl-dot out"></span><div><b>${when(t.exitDate, t.exitTime)} 決済</b>　<span class="num">${fmtPrice(t.exitPrice, d)}</span>（${heldText(t)}・<span class="${t.ret >= 0 ? 'plus' : 'minus'}">${t.ret >= 0 ? '+' : ''}${(t.ret * 100).toFixed(1)}%</span>）<div class="small muted">${esc(t.reasonOut)}</div></div></div>
      </div>
      ${oddsHtml(t.odds, { compact: true })}
      <details class="why-box"><summary>くわしい理由を見る</summary><div class="small"><b>入った理由</b></div>${whyList(t.whyIn)}<div class="small" style="margin-top:4px"><b>決済した理由</b></div>${whyList(t.whyOut)}</details></li>`,
    { empty: '該当する取引はありません', tag: 'div', wrap: (b) => `<ul class="list">${b}</ul>` });
  };
  draw();
  $('lab-log-seg').onclick = (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    logFilter = b.dataset.f;
    $('lab-log-seg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
  };
}

// ---------------- 持っている株 ----------------
const STYLE_NOTE = {
  swing: '日足で判断します。サインが出たら次の取引日の始まりに売買し、数日〜数週間持つやり方です。',
  day: '15分足で判断します。その日のうちに必ず決済し、次の日に持ち越さないやり方です（データは最近約1か月分）。',
};
let holdPick = null; // 候補から選んだ銘柄 { code, symbol, name }
const symbolOf = (mode, code) => (mode === 'fx' ? `${code.replace(/=X$/i, '')}=X` : mode === 'stock' ? `${code.replace(/\.T$/i, '')}.T` : code);

async function holdSuggest(mode, q) {
  if (!q) return [];
  if (mode === 'fx') return searchFx(q).slice(0, 8).map((p) => ({ code: p.code, name: p.name }));
  if (mode === 'us') return (await api(`/api/us/search?q=${encodeURIComponent(q)}`)).items.slice(0, 8).map((x) => ({ code: x.symbol, name: x.name }));
  return (await api(`/api/stocks/search?q=${encodeURIComponent(q)}`)).items.slice(0, 8).map((x) => ({ code: x.code, name: x.name }));
}

const holdCache = {};
const openHolds = new Set();
async function adviceFor(mode, list) {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const need = new Set(list.map((h) => symbolOf(mode, h.code)));
  // 円に直すための値段（米国株はドル円・為替は決済通貨の円の値段）
  if (mode === 'us') need.add('USDJPY=X');
  if (mode === 'fx') list.forEach((h) => { const q = h.code.replace(/=X$/i, '').slice(3, 6).toUpperCase(); if (q !== 'JPY') need.add(`${q}JPY=X`); });
  const prices = {}, candles = {};
  await Promise.all([...need].map(async (s) => {
    try {
      const hit = holdCache[s];
      const d = hit && Date.now() - hit.at < 5 * 60 * 1000 ? hit.d : await api(`/api/chart?symbol=${encodeURIComponent(s)}&tf=1d`);
      holdCache[s] = { at: Date.now(), d };
      candles[s] = d.candles;
      prices[s] = d.candles[d.candles.length - 1]?.close;
    } catch { /* 取れない銘柄は「取得できません」と出す */ }
  }));
  let earnings = {};
  if (mode === 'stock') {
    try {
      const codes = list.map((h) => h.code).filter((c) => /^[0-9][0-9A-Z]{3}$/.test(c));
      if (codes.length) (await api(`/api/stocks/earnings?codes=${codes.join(',')}&from=${today}`)).items.forEach((x) => { earnings[x.code] ||= x.date; });
    } catch { /* 決算の予定がなくても続ける */ }
  }
  const profile = getProfile();
  return list.map((h) => {
    const sym = symbolOf(mode, h.code);
    const hh = { ...h, symbol: sym };
    const adv = adviseHolding(hh, candles[sym], { mode, prices, usdjpy: prices['USDJPY=X'], profile, earningsDate: earnings[h.code], today });
    const timing = adv ? exitTiming(hh, candles[sym], adv, { mode, prices, usdjpy: prices['USDJPY=X'] }) : null;
    const longView = adv ? longTermView(hh, candles[sym], adv, { mode, prices, usdjpy: prices['USDJPY=X'] }) : null;
    return { h, adv, timing, longView };
  });
}

// いつ決済するのが一番いいか（日数ごとの見込み）
function timingHtml(t, d) {
  const y = (v) => `<span class="${v >= 0 ? 'plus' : 'minus'}">${fmtYen(v)}</span>`;
  return `<div class="timing">
    <div class="timing-head">⏱ <b>いつ決済するのが一番${t.losing ? '損が小さい' : 'いい'}？</b></div>
    <p class="small" style="margin:4px 0 6px">${esc(t.text)}</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>決済する時期</th><th class="r">平均の損益</th><th class="r">悪いとき<br><span class="muted" style="font-weight:400">（10回に1回）</span></th><th class="r">${fmtPrice(t.escape, d)}に<br>届く</th><th class="r">${fmtPrice(t.line, d)}に<br>触れる</th></tr></thead><tbody>
      <tr${!t.wait ? ' class="best"' : ''}><td class="small">今すぐ</td><td class="r small">${y(t.now)}</td><td class="r small">${y(t.now)}</td><td class="r small">—</td><td class="r small">—</td></tr>
      ${t.rows.map((r) => `<tr${t.wait && r.d === t.best.d ? ' class="best"' : ''}><td class="small">最大${r.d}日待つ</td><td class="r small">${y(r.mean)}</td><td class="r small">${y(r.p10)}</td><td class="r small">${Math.round(r.pEscape * 100)}%</td><td class="r small">${Math.round(r.pLine * 100)}%</td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted" style="margin:4px 0 0">「最大○日待つ」は、${fmtPrice(t.line, d)}（最終ライン）に触れたらすぐ決済、${fmtPrice(t.escape, d)}（${t.losing ? '戻りの目標' : '利益確定の目標'}）に届いたら決済、どちらもなければその日に決済、というやり方です。過去の値動きのくせから何千通りも試した平均で、当たる保証はありません。</p>
  </div>`;
}

// 長い目で見ると（1か月〜半年）
function longHtml(t, d) {
  const y = (v) => `<span class="${v >= 0 ? 'plus' : 'minus'}">${fmtYen(v)}</span>`;
  return `<div class="timing">
    <div class="timing-head">📅 <b>長い目で見ると（1か月〜半年）</b></div>
    <p class="small" style="margin:4px 0 6px">${esc(t.text)}</p>
    <ul class="why" style="font-size:13px;color:var(--text)">${t.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>持つ期間</th><th class="r">平均の損益</th><th class="r">悪いとき<br><span class="muted" style="font-weight:400">（10回に1回）</span></th><th class="r">良いとき<br><span class="muted" style="font-weight:400">（10回に1回）</span></th><th class="r">${fmtPrice(t.escape, d)}に<br>届く</th><th class="r">${fmtPrice(t.line, d)}に<br>触れる</th></tr></thead><tbody>
      <tr><td class="small">今すぐ決済</td><td class="r small">${y(t.now)}</td><td class="r small">${y(t.now)}</td><td class="r small">${y(t.now)}</td><td class="r small">—</td><td class="r small">—</td></tr>
      ${t.rows.map((r) => `<tr><td class="small">最大${r.label}</td><td class="r small">${y(r.mean)}</td><td class="r small">${y(r.p10)}</td><td class="r small">${y(r.p90)}</td><td class="r small">${Math.round(r.pEscape * 100)}%</td><td class="r small">${Math.round(r.pLine * 100)}%</td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted" style="margin:4px 0 0">長く持つときは、損切りの線を広め（${fmtPrice(t.line, d)}＝大きな流れが壊れたところ）に置いて試しています。期間が長いほど、結果のばらつき（悪いとき・良いときの差）が大きくなります。</p>
  </div>`;
}

let addFormTouched = false;
async function showHoldings(mode) {
  const box = $('hold-list');
  const list = getHoldings(mode);
  // 銘柄が入っていれば、追加の入力欄はたたんでおく（押せば開く）
  if (!addFormTouched) $('hold-add').open = !list.length;
  if (!list.length) {
    box.innerHTML = '<div class="card"><p class="small muted">まだ入力されていません。上の欄に、持っている銘柄・買った値段・数量を入れて「追加する」を押してください。</p></div>';
    return;
  }
  if (!box.querySelector('.hold-item')) box.innerHTML = '<div class="card"><p class="small muted"><span class="spinner"></span> 今の値段を調べています…</p></div>';
  const rows = await adviceFor(mode, list);
  if (getModeFn() !== mode) return;
  const d = mode === 'stock' ? 1 : mode === 'us' ? 2 : 3;
  const totalYen = rows.reduce((a, r) => a + (r.adv?.plYen || 0), 0);
  const unit = mode === 'fx' ? '通貨' : '株';
  box.innerHTML = `
    <div class="card"><div class="li-head"><span class="name">${list.length}銘柄の合計の損益（今の値段で）</span><b class="${totalYen >= 0 ? 'plus' : 'minus'}" style="font-size:18px">${fmtYen(totalYen)}</b></div></div>
    ${rows.map(({ h, adv, timing, longView }) => {
      if (!adv) return `<div class="card hold-item"><div class="li-head"><span class="name">${symLink(symbolOf(mode, h.code), h.name)}</span><button class="icon-btn hold-del" data-id="${esc(h.id)}" aria-label="消す">✕</button></div><p class="small error">値段を取得できませんでした。</p></div>`;
      const v = adv.verdict;
      return `<div class="card hold-item">
        <div class="li-head"><span class="name">${symLink(symbolOf(mode, h.code), h.name)}<span class="small muted">（押すとチャート）</span></span><span class="badge ${h.side > 0 ? 'buy' : 'sell'}">${h.side > 0 ? '買い' : '売り'}</span><button class="icon-btn hold-del" data-id="${esc(h.id)}" aria-label="消す">✕</button></div>
        <div class="verdict ${v.cls}">${v.icon} <b>${v.label}</b></div>
        <div class="small">${fmtPrice(h.price, d)} で ${Number(h.qty).toLocaleString()}${unit}${h.date ? `（${esc(h.date.slice(5).replace('-', '/'))}）` : ''} → 今 <b>${fmtPrice(adv.now, d)}</b>　<b class="${adv.plPct >= 0 ? 'plus' : 'minus'}">${adv.plYen != null ? fmtYen(adv.plYen) : ''}（${adv.plPct >= 0 ? '+' : ''}${(adv.plPct * 100).toFixed(1)}%）</b></div>
        <div class="grid2 plan-grid" style="margin-top:6px">
          <div class="stat"><div class="label">${adv.protects ? '利益を守る線' : '損切りの線'}</div><div class="value minus" style="font-size:16px">${fmtPrice(adv.stop, d)}</div><div class="small muted">逆指値の注文を入れておく</div></div>
          <div class="stat"><div class="label">利益確定の目標</div><div class="value plus" style="font-size:16px">${fmtPrice(adv.target, d)}</div><div class="small muted">${adv.wall ? `${esc(adv.wall.label)}（${esc(adv.wall.strength)}）` : '値動きの大きさから'}</div></div>
        </div>
        <p class="small" style="margin:6px 0 0">${esc(adv.reasons[0] || '')}</p>
        ${timing ? `<p class="small" style="margin:4px 0 0">⏱ ${timing.wait ? `最大${timing.best.d}日待つのが平均で一番${timing.losing ? '損が小さい' : 'いい'}見込み` : timing.losing ? '今すぐ決済が一番損が小さい見込み' : '今のうちに利益確定が無難'}</p>` : ''}
        <details class="more-box" data-hold="${esc(h.id)}"${openHolds.has(h.id) ? ' open' : ''}><summary>くわしく見る（理由・いつ決済するか・長い目で見ると）</summary>
          <ul class="why" style="font-size:13px;color:var(--text)">${adv.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          ${timing ? timingHtml(timing, d) : ''}
          ${longView ? longHtml(longView, d) : ''}
        </details>
      </div>`;
    }).join('')}
    <p class="small muted">日足で計算しています。この画面を開いている間は5分ごとに自動で最新にします。損切りの線は、値段が有利に動くと自動で引き上げています（利益を守るため）。</p>`;
  // 自動で最新にしても、開いていた「くわしく見る」は開いたままにする
  box.querySelectorAll('details[data-hold]').forEach((el) => el.addEventListener('toggle', () => { if (el.open) openHolds.add(el.dataset.hold); else openHolds.delete(el.dataset.hold); }));
  box.querySelectorAll('.hold-del').forEach((b) => { b.onclick = () => {
    if (!confirm('この銘柄を消しますか？')) return;
    setHoldings(mode, getHoldings(mode).filter((x) => x.id !== b.dataset.id));
    showHoldings(mode);
  }; });
}

function initHoldForm() {
  const input = $('hold-sym'), sug = $('hold-suggest');
  let timer;
  input.addEventListener('input', () => {
    holdPick = null;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const items = await holdSuggest(getModeFn(), input.value.trim()).catch(() => []);
      sug.innerHTML = items.map((x) => `<li tabindex="0" data-code="${esc(x.code)}" data-name="${esc(x.name)}"><span class="code">${esc(x.code)}</span><b>${esc(x.name)}</b></li>`).join('');
      sug.hidden = !items.length;
    }, 200);
  });
  sug.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-code]');
    if (!li) return;
    holdPick = { code: li.dataset.code, name: li.dataset.name };
    input.value = `${li.dataset.name}（${li.dataset.code}）`;
    sug.hidden = true;
  });
  $('hold-side').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) $('hold-side').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
  const n = (v) => Number(String(v).normalize('NFKC').replace(/[,，円\s]/g, ''));
  $('hold-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = getModeFn();
    $('hold-err').textContent = '';
    let pick = holdPick;
    if (!pick) {
      const items = await holdSuggest(mode, input.value.trim()).catch(() => []);
      pick = items[0];
    }
    if (!pick) { $('hold-err').textContent = '銘柄が見つかりませんでした。候補から選んでください。'; return; }
    const price = n($('hold-price').value);
    if (!(price > 0)) { $('hold-err').textContent = '買った値段を入れてください。'; return; }
    let qty = n($('hold-qty').value);
    const amount = n($('hold-amount').value);
    if (!(qty > 0) && amount > 0) {
      // 金額から数量を出す（米国株はドル円で円に直す）
      let ypu = 1;
      if (mode === 'us') { try { const u = await api('/api/chart?symbol=USDJPY&tf=1d'); ypu = u.candles[u.candles.length - 1].close; } catch { ypu = 150; } }
      qty = mode === 'fx' ? Math.round(amount / price) : Math.floor(amount / (price * ypu));
    }
    if (!(qty > 0)) { $('hold-err').textContent = '数量か金額を入れてください。'; return; }
    const side = Number($('hold-side').querySelector('[aria-pressed="true"]')?.dataset.v || 1);
    const list = getHoldings(mode);
    list.push({ id: Date.now().toString(36), code: pick.code, name: pick.name, side, price, qty, date: $('hold-date').value || '' });
    setHoldings(mode, list);
    ['hold-sym', 'hold-price', 'hold-qty', 'hold-amount', 'hold-date'].forEach((id) => { $(id).value = ''; });
    holdPick = null;
    sug.hidden = true;
    showHoldings(mode);
  });
  $('hold-add').addEventListener('click', (e) => { if (e.target.closest('summary')) addFormTouched = true; });
}

// ---------------- 切り替え ----------------
function applyMineSub() {
  document.querySelectorAll('#mine-sub button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sub === mineSub)));
  document.querySelectorAll('[data-minepanel]').forEach((el) => { el.hidden = el.dataset.minepanel !== mineSub; });
  document.querySelectorAll('#style-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.style === style)));
  const showStyle = mineSub !== 'hold';
  $('style-seg').hidden = !showStyle;
  $('style-note').hidden = !showStyle;
  $('style-note').textContent = STYLE_NOTE[style];
  $('swing-days').hidden = !showStyle || style !== 'swing';
  const sd = getProfile().swingDays || 30;
  if (document.activeElement !== $('swing-days-input')) $('swing-days-input').value = sd;
  $('swing-days-chips').innerHTML = [3, 5, 10, 20, 30, 60].map((d) => `<button type="button" class="chip" data-d="${d}" aria-pressed="${d === sd}">${d}日</button>`).join('');
}

export function updateMine(mode, { force = false } = {}) {
  if ($('view-mine').hidden) return;
  applyMineSub();
  if (mineSub === 'hold') return showHoldings(mode);
  if (mineSub === 'plan') return showPlan(mode, force);
  if (mineSub === 'now') return showNow(mode, force);
  if (mineSub === 'list') return showList(mode, force);
}

export function initMine(getMode, openChart = () => {}) {
  getModeFn = getMode;
  $('view-mine').addEventListener('click', (e) => {
    const a = e.target.closest('.sym-link');
    if (!a) return;
    e.preventDefault();
    openChart(a.dataset.symbol, a.dataset.name);
  });
  $('mine-sub').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (!b) return;
    mineSub = b.dataset.sub;
    store.set('mine_sub', mineSub);
    updateMine(getMode());
  });
  $('style-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-style]');
    if (!b) return;
    style = b.dataset.style;
    store.set('mine_style', style);
    updateMine(getMode());
  });
  initHoldForm();
  // スイングで持つ日数（あなたの設定に保存して、パソコンとスマホで共有）
  const setDays = (d) => {
    d = Math.max(1, Math.min(120, Math.round(Number(d) || 30)));
    if (d === (getProfile().swingDays || 30)) return;
    setProfile({ ...getProfile(), swingDays: d });
    updateMine(getMode());
  };
  $('swing-days-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) setDays(b.dataset.d); });
  $('swing-days-input').addEventListener('change', (e) => setDays(e.target.value));
}
