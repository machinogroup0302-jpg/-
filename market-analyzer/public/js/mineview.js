// 「あなた専用」タブ：あなたのプラン・持っている株・今のサイン・売買の一覧
// スイング（日足・数日〜数週間）とデイトレ（15分足・その日のうちに決済）を切り替えられる
import { api, $, esc, store, fmtPrice, fmtYen } from './util.js';
import { runStrategy, signalOdds, oddsLabel, oddsText } from './strategies.js';
import { pagedList } from './stockscreener.js';
import { getProfile, setProfile, getHoldings, setHoldings, syncState } from './favorites.js';
import { replayWithBudget, kindText, sizeFor, orderText, WAYS, wayOf, waySides, wayProfile, compareWays, wayNotes, replayOpts, budgets, pipsOf, pipsText, CARRY, searchCustom, walkForward, afterTax, setupFromCsv, forMode, heldUse, leftBudget, marginHealth, marginBook, calibrateMargin, SUBST, keepWay, keepDays, monthKey } from './plan.js';
import { loadRegime, loadCandles, universe, kindOf } from './labview.js';
import { baseUniverse } from './universe.js';
import { adviseHolding, exitTiming, longTermView, addOnAdvice } from './holdingadvice.js';
import { searchFx } from './fxpairs.js';
import { fmtTime, judgedText, execText } from './sessiontime.js';
import { loadEcon, econWarnHtml } from './econview.js';
import { tradeSymbol } from './tradecoach.js';
import { parseHoldingsCsv } from './holdimport.js';
import { decodeFile } from './trades.js';
import { errText, report } from './report.js';

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
// 銘柄名を押すと、その銘柄のチャートを開く
const codeOf = (symbol) => (/=X$|^\^/.test(symbol) ? '' : String(symbol).replace(/\.T$/, ''));
const symLink = (symbol, name) => `<a href="#" class="sym-link" data-symbol="${esc(symbol)}" data-name="${esc(name)}">${esc(name)}</a>${codeOf(symbol) && codeOf(symbol) !== name ? ` <span class="small muted">${esc(codeOf(symbol))}</span>` : ''}`;
// 「いつ判断して、いつ売買するか」
const timeLine = (mode, t, extra = '') => `<div class="small time-line">🕒 判断した時刻：${esc(judgedText(mode, t, style === 'day'))}<br>　 売買する時刻：${esc(execText(mode, style === 'day'))}${extra}</div>`;
let style = store.get('mine_style', 'swing');
let mineSub = store.get('mine_sub', 'plan');
let getModeFn = () => 'fx';

// ---------------- 全銘柄の売買一覧（理由つき） ----------------
// 計算する銘柄：為替は全部・米国株は一覧の全部・日本株は全上場企業をチェックして上位をくわしく計算
// 全社チェックが終わるのを待たない：まだなら始めておいて、今は代表銘柄だけで先に計算する
// （チェックが終わったら、自動でもう一度計算して銘柄を増やす）
let scanWatch = null;
async function ensureScan() {
  let st;
  try { st = await api('/api/stocks/scan?view=buy&limit=1'); } catch { return false; }
  if (st.status === 'done' && Date.now() - (st.finishedAt || 0) < 6 * 3600 * 1000) return true;
  if (st.status !== 'running') {
    try { await api('/api/stocks/scan', { method: 'POST', body: { markets: ['プライム', 'スタンダード', 'グロース'] } }); } catch { return false; }
  }
  if (!scanWatch) {
    scanWatch = setInterval(async () => {
      let x;
      try { x = await api('/api/stocks/scan?view=buy&limit=1'); } catch { return; }
      if (x.status === 'running') return;
      clearInterval(scanWatch); scanWatch = null;
      if (x.status !== 'done') return;
      for (const k of Object.keys(logCache)) if (k.startsWith('stock|')) delete logCache[k];
      if (getModeFn() === 'stock' && !document.getElementById('view-mine').hidden) updateMine('stock');
    }, 10000);
  }
  return false;
}

async function logUniverse(mode, out, st = style) {
  const syms = universe(mode);
  const seen = new Set(syms.map(([c]) => c.toUpperCase()));
  const add = (code, name) => { const k = String(code).toUpperCase(); if (!seen.has(k)) { seen.add(k); syms.push([code, name]); } };
  for (const h of getHoldings(mode)) add(h.code, h.name);
  if (mode === 'us' && st === 'swing') {
    try { (await api('/api/us/list')).items.forEach((x) => add(x.symbol, x.name)); } catch { /* 一覧が取れなければ代表銘柄だけ */ }
  }
  if (mode === 'stock') {
    const scanned = await ensureScan();
    scanInfo = scanned ? '' : '東証の全社チェックの途中なので、今は代表的な銘柄で計算しています（終わったら自動で銘柄を増やします）。';
    if (scanned) {
      // 空売りも比べるので、下がりそうな会社も多めに入れる
      const views = st === 'day' ? [['up', 15], ['buy', 15], ['down', 10]] : [['buy', 40], ['sell', 25]];
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
// 計算をとっておく目印：市場・スイングかデイトレか・持つ日数・持っている銘柄（銘柄が変わったら計算し直す）
const ckOf = (mode, st = style) => `${mode}|${st}|${st === 'swing' ? getProfile().swingDays || 30 : ''}|${[...new Set(getHoldings(mode).map((h) => String(h.code).toUpperCase()))].sort().join(',')}`;
let logRunning = null;

// 全銘柄を「総合判断」で計算する（「今のサイン」と「売買の一覧」で共通）
async function computeLog(mode, out, force = false, st = style) {
  const swingDays = getProfile().swingDays || 30;
  const ck = ckOf(mode, st);
  const hit = logCache[ck];
  if (hit && !force && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  if (logRunning?.ck === ck) return logRunning.p;
  const p = (async () => {
    const regime = await loadRegime();
    const day = st === 'day';
    const list = await loadCandles(await logUniverse(mode, out, st), out, day ? '15m' : '1d', day ? 150 : 200);
    out.innerHTML = '<p class="small muted"><span class="spinner"></span> 計算しています…</p>';
    await new Promise((r) => setTimeout(r, 30));
    const kind = kindOf(mode);
    const prices = {};
    // やり方ごとに向き（買いだけ・売りだけ・両方）が違うので、向きごとに全部計算しておく
    const by = Object.fromEntries(waySides(mode).map((v) => [v, { trades: [], holding: [], next: [] }]));
    // 「1年前から先を知らずに」の練習用：最初から決まっている代表銘柄（為替は全部）で、1年より前から計算しておく
    const bare = (c) => String(c).replace(/\.T$|=X$/i, '').toUpperCase();
    const fixed = new Set(baseUniverse(mode).map(([c]) => bare(c)));
    const wf = !day ? Object.fromEntries(waySides(mode).map((v) => [v, []])) : null;
    let n = 0;
    for (const x of list) {
      prices[x.symbol] = x.candles[x.candles.length - 1].close;
      const opt = { kind, pair: x.symbol.replace(/=X$/, ''), regime, intraday: day, days: day ? (kind === 'fx' ? 1000 : 600) : 250, maxHold: day ? null : swingDays };
      const last = x.candles[x.candles.length - 1];
      for (const [v, g] of Object.entries(by)) {
        const r = runStrategy(x.candles, 'combo', { ...opt, sides: v });
        for (const t of r.trades) g.trades.push({ ...t, name: x.name, symbol: x.symbol });
        if (r.open) g.holding.push({ ...r.open, name: x.name, symbol: x.symbol, last: last.close });
        if (r.next) g.next.push({ ...r.next, name: x.name, symbol: x.symbol, open: r.open, last: last.close, date: dayKeyOf(last.time), t: last.time });
        if (wf && fixed.has(bare(x.symbol))) {
          const rl = runStrategy(x.candles, 'combo', { ...opt, sides: v, days: x.candles.length - 80 });
          for (const t of rl.trades) wf[v].push({ ...t, name: x.name, symbol: x.symbol });
        }
      }
      if (++n % 5 === 0) { out.innerHTML = `<p class="small muted"><span class="spinner"></span> 計算しています… ${n} / ${list.length}</p>`; await new Promise((res) => setTimeout(res, 0)); }
    }
    let usdjpy = prices['USDJPY=X'] || null;
    if (!usdjpy) { try { const u = await api('/api/chart?symbol=USDJPY&tf=1d'); usdjpy = u.candles[u.candles.length - 1].close; } catch { /* 取れなければ米国株の量は出さない */ } }
    // 練習用の取引にも、その時点までのことだけで「勝つ確率の目安」を付ける
    if (wf) for (const ts of Object.values(wf)) for (const t of ts) t.odds = signalOdds(ts, { symbol: t.symbol, side: t.side, strength: t.strength, before: t.entryDate });
    const data = { list: day ? null : list, regime, by, wf, wfCount: fixed.size, prices, usdjpy, count: list.length, at: Date.now(), style: st, scanInfo };
    logCache[ck] = { at: Date.now(), data };
    return data;
  })();
  logRunning = { ck, p };
  try { return await p; } finally { logRunning = null; }
}

const dayKeyOf = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);

// 確率：これからの売買は全部の取引から、過去の売買は「その日より前に終わった取引」だけから計算する（必要になったときに1回だけ）
function ensureOdds(g) {
  if (g.oddsDone) return g;
  for (const x of g.next) if (x.type === 'open') x.odds = signalOdds(g.trades, { symbol: x.symbol, side: x.side, strength: x.strength });
  for (const x of g.holding) x.odds = signalOdds(g.trades, { symbol: x.symbol, side: x.side, strength: x.strength, before: x.entryDate });
  for (const t of g.trades) t.odds = signalOdds(g.trades, { symbol: t.symbol, side: t.side, strength: t.strength, before: t.entryDate });
  g.oddsDone = true;
  return g;
}

// どのやり方で見せるか：ふだんは「おすすめ（自動）」＝過去1年で一番良かったやり方
// （どちらも「あなたの設定」に入れて、パソコンとスマホで共有する）
const wayViewOf = (mode) => getProfile().wayView?.[mode] || 'auto';
function setWayPref(field, mode, key) {
  const pf = getProfile();
  if ((pf[field] || {})[mode] === key) return;
  setProfile({ ...pf, [field]: { ...(pf[field] || {}), [mode]: key } });
}
function setLock(mode, patch) {
  const pf = getProfile();
  setProfile({ ...pf, planLock: { ...(pf.planLock || {}), [mode]: { ...(pf.planLock?.[mode] || {}), ...patch } } });
}
function viewOf(r, mode) {
  const pf = forMode(getProfile(), mode);
  // 比べる基準：株は現物と信用の予算の合計、為替は予算
  const bg = budgets(pf);
  const budget = mode === 'fx' ? bg.cash : bg.total;
  const ck = JSON.stringify([pf.budget, pf.marginBudget, pf.riskPct, pf.maxPos, pf.fxLots, pf.fxLotSize]);
  if (r.cmpKey !== ck) {
    const tb = Object.fromEntries(Object.entries(r.by).map(([k, g]) => [k, ensureOdds(g).trades]));
    r.cmp = compareWays(tb, mode, pf, budget, r.prices);
    // AIの特別ルール（勝つ確率の目安で絞る）：前半で見つけて、後半で確かめる
    r.custom = searchCustom(tb, mode, pf, budget, r.prices, r.cmp);
    // 1年前から先を知らずにやっていたら（月ごとに、その時点までのことだけでやり方を決める）
    r.wfRes = r.wf ? walkForward(r.wf, mode, pf, r.prices) : null;
    r.cmpKey = ck;
  }
  const std = r.cmp.best || wayOf(mode);
  // 特別ルールが後半でも通常のおすすめより良かったときだけ、自動で使う
  // おすすめは月の初めに決めて、その月は変えない（決めたやり方がマイナスになったときだけ見直す）
  const month = monthKey();
  const keep = keepWay(r.cmp, r.custom, pf.planLock?.[mode], month);
  const best = keep.best || std;
  if (r.style === 'swing') {
    setWayPref('bestWay', mode, (best.base || best).key);
    const lk = pf.planLock?.[mode] || {};
    if (lk.way !== best.key || lk.month !== month) setLock(mode, { way: best.key, month });
  }
  const sel = wayViewOf(mode);
  const way = sel === 'custom' && r.custom ? r.custom : sel === 'auto' || !WAYS[mode].some((w) => w.key === sel) ? best : wayOf(mode, sel);
  const g = ensureOdds(r.by[way.sides]);
  return { wfRes: r.wfRes, wfCount: r.wfCount, trades: g.trades, holding: g.holding, next: g.next, prices: r.prices, usdjpy: r.usdjpy, way, best, std, custom: r.custom, minOdds: way.minOdds || 0, cmp: r.cmp, keep, month, auto: way === best && sel === 'auto', pf: wayProfile(pf, mode, (way.base || way).key), budget };
}

// 「今月はこのやり方に決めています」の一言
function lockNote(v) {
  if (v.cmp.note === 'rest' || style !== 'swing') return '';
  const m = Number(v.month.slice(5, 7));
  const next = m === 12 ? 1 : m + 1;
  const diff = v.keep?.kept && v.keep.fresh && v.keep.fresh.key !== v.best.key;
  return `<p class="small" style="margin:0 0 4px">📌 <b>${m}月はこのやり方に決めています</b>。サインがころころ変わらないよう、見直すのは${next}月1日です（このやり方が過去1年でマイナスになったときだけ、すぐ見直します）。${diff ? `<br><span class="muted">今日計算し直すと「${esc(v.keep.fresh.label)}」の方が良い結果ですが、月の途中では変えません。</span>` : ''}</p>`;
}

// やり方を選ぶボタン（おすすめ＝自動・ほかのやり方も見られる）
function wayBar(v, mode) {
  const sel = wayViewOf(mode);
  const btn = (k, t) => `<button type="button" class="chip" data-way="${k}" aria-pressed="${k === sel}">${t}</button>`;
  return `<div class="way-bar">
    <div class="small" style="margin-bottom:4px">${v.auto || sel === 'auto' ? bestText(v, true) : `「${esc(v.way.label)}」でやった場合を表示中（おすすめは「${esc(v.best.label)}」）`}</div>
    ${lockNote(v)}
    ${v.cmp.note === 'rest' ? `<p class="notice" style="margin:4px 0">⚠ 過去1年は、どのやり方でもマイナスでした。今は<b>お休み（取引しない）</b>のがおすすめです。下のサインは「やるなら」の参考です。</p>` : ''}
    <div class="chips">${btn('auto', `おすすめ（${esc(v.best.label)}）`)}${WAYS[mode].map((w) => btn(w.key, `${esc(w.label)}の場合`)).join('')}${v.custom ? btn('custom', `🤖 AIの特別ルールの場合`) : ''}</div>
  </div>`;
}

// 自動で最新にしているので「最新にする」ボタンは置かず、いつの計算かだけ出す
function updatedNote(r) {
  const t = new Date(r.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return `<p class="small muted" style="margin-top:10px">${t}時点の計算・この画面を開いている間は15分ごとに自動で最新にします。${r.count}銘柄を計算${r.scanInfo ? `（${esc(r.scanInfo)}）` : ''}</p>`;
}

async function showPlan(mode, force = false) {
  const out = $('lab-plan');
  try {
    await loadEcon();
    const r = await computeLog(mode, out, force);
    if (getModeFn() !== mode) return;
    renderPlan(r, mode);
    updateHoldDays(mode, r);
  } catch (e) { out.innerHTML = `<p class="error">${esc(errText('あなた専用', e))}</p>`; }
}

const yen0 = (v) => `${Math.round(v).toLocaleString()}円`;

const replayCard = (t, x) => `<div class="stat"><div class="label">${t}</div><div class="value ${x.total >= 0 ? 'plus' : 'minus'}">${fmtYen(x.total)}</div><div class="small">税引き後 <b class="${x.total >= 0 ? 'plus' : 'minus'}">${fmtYen(afterTax(x.total))}</b></div><div class="small muted">${x.trades}回・勝率${pct(x.winRate)}・一番減ったとき ${fmtYen(-x.maxDD)}${x.losscuts ? `・<b class="minus">ロスカット${x.losscuts}回</b>` : ''}${x.broke ? '・<b class="minus">途中で資金がなくなった</b>' : ''}</div></div>`;

// 為替：何pips動いたか・何ロットで入るか（「${表示中のやり方}」の過去1年）
function fxPipNotes(v) {
  const ps = v.trades.map((t) => pipsOf(t.symbol, t.side, t.entryPrice, t.exitPrice));
  if (!ps.length) return [];
  const w = ps.filter((p) => p > 0), l = ps.filter((p) => p <= 0);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const pf = getProfile();
  return [`「${v.way.label}」の${ps.length}回の取引は、勝ったとき平均${pipsText(avg(w))}、負けたとき平均${pipsText(avg(l))}動きました（1回あたり平均${pipsText(avg(ps))}）。`,
    pf.fxLots > 0 ? `毎回${pf.fxLots}ロット（${(pf.fxLots * (pf.fxLotSize || 10000)).toLocaleString()}通貨）で入る計算です。ドル円なら1pipsで約${Math.round(pf.fxLots * (pf.fxLotSize || 10000) * 0.01).toLocaleString()}円動きます。` : 'ロット数はおまかせ（損切りまでで減る額が「1回で減ってもいい額」に収まる量）で入る計算です。量は「今のサイン」「売買の一覧」に、何ロット（何通貨）かを出しています。'];
}

// 1年前から、先を知らずにやっていたら（本当の練習）
function wfHtml(v, mode) {
  const w = v.wfRes;
  if (!w) return style === 'day' ? '<p class="small muted">「1年前から先を知らずに」の練習は、データが1年分あるスイング（日足）だけで計算しています。</p>' : '';
  const ym = (s) => `${s.slice(2, 4)}年${Number(s.slice(5, 7))}月`;
  const rest = w.months.filter((m) => m.rest).length;
  return `<h3>📅 1年前から、先を知らずにやっていたら<span class="sub">本当の練習・${ym(w.from)}〜${ym(w.to)}</span></h3>
    <div class="grid2">
      <div class="stat"><div class="label">1年の損益（あなたの予算）</div><div class="value ${w.total >= 0 ? 'plus' : 'minus'}">${fmtYen(w.total)}</div><div class="small">税引き後（手取り） <b class="${w.total >= 0 ? 'plus' : 'minus'}">${fmtYen(afterTax(w.total))}</b></div><div class="small muted">${w.budget ? `予算の${w.total >= 0 ? '+' : ''}${(afterTax(w.total) / w.budget * 100).toFixed(1)}%（税引き後）` : ''}</div></div>
      <div class="stat"><div class="label">取引・勝率・一番減ったとき</div><div class="value" style="font-size:16px">${w.trades}回・${pct(w.winRate)}</div><div class="small muted">一番減ったとき ${fmtYen(-w.maxDD)}${w.losscuts ? `・ロスカット${w.losscuts}回` : ''}</div></div>
    </div>
    <details class="more-box"><summary>月ごとに見る（その月に選んだやり方・損益・残高）</summary>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>月</th><th>その月の初めに選んだやり方</th><th class="r">回数</th><th class="r">損益</th><th class="r">月末の残高</th></tr></thead><tbody>
      ${w.months.map((m) => `<tr><td class="small">${ym(m.ym)}</td><td class="small">${esc(m.label)}</td><td class="r small">${m.n}</td><td class="r small ${m.pnl >= 0 ? 'plus' : 'minus'}">${m.n ? fmtYen(m.pnl) : '—'}</td><td class="r small">${yen0(m.balance)}</td></tr>`).join('')}
      </tbody></table></div></details>
    <p class="small muted" style="margin:4px 0 0">毎月の初めに、<b>その時点までに結果が出ていた取引（過去半年）だけ</b>を見て、その月のやり方（現物・信用・空売り${mode === 'fx' ? '・買い売りの向き' : ''}、勝つ確率で絞るか、お休みか）を決め、その月のサインどおりに売買した結果です。後から分かったことは使っていません。<br>現実に近づけるため、①手数料と値段のずれ（${mode === 'stock' ? '日本株は往復0.3%' : mode === 'us' ? '米国株は手数料・ドルへの両替を含め往復約1.4%' : '為替は往復0.04%'}）、${mode === 'stock' ? '②ストップ高・安に張り付いた日は売買できない、③信用の金利・貸株料、' : mode === 'fx' ? '②スワップポイント（金利差の目安。もらう側は6割）、' : '②信用の金利、'}④税金（利益の20.315%）を入れています。${rest ? `${rest}か月は、どのやり方も過去半年マイナスだったのでお休みしました。` : ''}銘柄は、今の人気で選ぶと後から見て強かったものばかりになるので、最初から決まっている${mode === 'fx' ? '全部の通貨ペア' : `代表${v.wfCount}銘柄`}で計算しています。</p>`;
}

// AIの特別ルール：どう見つけて、本当に良かったか（前半で見つけて後半で確かめた結果）
function customHtml(v) {
  const c = v.custom;
  if (!c) return '<p class="small muted" style="margin:6px 0 0">🤖 AIの特別ルール：前半の期間でプラスになる「勝つ確率○%以上だけ」の組み合わせが見つからなかったので、今回はありません。</p>';
  const mid = `${Number(c.mid.slice(5, 7))}/${Number(c.mid.slice(8, 10))}`;
  return `<div class="stat" style="margin-top:8px"><div class="label">🤖 AIが見つけた特別ルール${c.adopted ? '<span class="badge warn" style="margin-left:4px">採用</span>' : '<span class="badge neutral" style="margin-left:4px">参考</span>'}</div>
    <div style="font-weight:700;margin:2px 0">「${esc(c.label)}」</div>
    <div class="small">・${c.tried}通りの組み合わせを試して、<b>${mid}より前の期間</b>で一番良かったもの：${fmtYen(c.train.total)}（${c.train.trades}回・勝率${pct(c.train.winRate)}）</div>
    <div class="small">・それを<b>${mid}から後の期間</b>（選ぶときに見ていない期間）で試すと：<b class="${c.test.total >= 0 ? 'plus' : 'minus'}">${fmtYen(c.test.total)}</b>（${c.test.trades}回）${c.stdTest ? `／ふつうのおすすめ「${esc(v.std.label)}」は同じ期間で${fmtYen(c.stdTest.total)}` : ''}</div>
    <div class="small">・1年全体では ${fmtYen(c.full.total)}（一番減ったとき ${fmtYen(-c.full.maxDD)}）</div>
    <div class="small" style="margin-top:4px">${c.adopted ? '→ 見ていない期間でも、ふつうのおすすめより良かったので<b>採用</b>しました。「あなた専用」のプラン・サインはこのルールで出しています。' : '→ 見ていない期間では、ふつうのおすすめより良くなかった（たまたま前半だけ良かった可能性がある）ので、<b>参考</b>にとどめています。'}</div></div>`;
}

// おすすめの一言：プラスのものから選ぶ。どれもマイナスならお休みをすすめる
function bestText(v, short) {
  if (v.best?.key === 'custom' && v.cmp.note !== 'rest') return `🤖 <b>一番いいのは、AIが見つけた特別ルール「${esc(v.best.label)}」だと思います</b>（1年で${fmtYen(v.best.full.total)}）`;
  const b = v.best?.key === 'custom' ? v.cmp.best : v.best || v.cmp.best;
  if (v.cmp.note === 'rest') return `🛑 <b>今はお休みがおすすめです</b>（過去1年はどのやり方もマイナス。やるなら一番損が小さい「${esc(b.label)}」：${fmtYen(b.r.total)}）`;
  if (v.cmp.note === 'dd') return `🏆 <b>一番いいのは「${esc(b.label)}」だと思います</b>（${fmtYen(b.r.total)}）${short ? '' : '。ただし一番減ったときが予算の35%を超えるので、量（ロット数・株数）を減らすのがおすすめです'}`;
  return `🏆 <b>一番いいのは「${esc(b.label)}」だと思います</b>（${fmtYen(b.r.total)}${short ? '・過去1年で比べて自動で選んでいます' : ''}）`;
}

// やり方ごとの成績（過去1年をあなたの予算でやり直した結果）と説明
function waysHtml(v, mode) {
  const { rows } = v.cmp;
  const best = v.best?.key === 'custom' ? v.cmp.best : v.best;
  return `<h3>やり方で比べると<span class="sub">過去1年・サインどおりに全部やった場合</span></h3>
    <div class="grid2">${rows.map((x) => replayCard(`${esc(x.label)}${x === best ? `<span class="badge warn" style="margin-left:4px">${v.best?.key === 'custom' ? 'ふつうのおすすめ' : 'おすすめ'}</span>` : ''}${x.key === v.way.key && x !== best ? '<span class="badge ok" style="margin-left:4px">表示中</span>' : ''}`, x.r)).join('')}</div>
    <p class="small" style="margin:6px 0 0">${bestText(v, false)}</p>
    ${customHtml(v)}
    <ul class="why" style="font-size:13px;color:var(--text)">${[...wayNotes(v.cmp, mode, v.budget), ...(mode === 'fx' ? fxPipNotes(v) : [])].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="small muted" style="margin:4px 0 0">${mode === 'fx' ? `為替はスワップポイント（金利差の目安）と往復0.04%の費用を入れています。${getProfile().fxLots > 0 ? `毎回${getProfile().fxLots}ロットで計算しています。` : 'ロット数はおまかせ（損切りの幅から量を決める）で計算しています。'}` : `手数料と値段のずれ（${mode === 'us' ? '米国株は往復約1.4%' : '日本株は往復0.3%'}）${mode === 'stock' ? '・ストップ高・安で売買できない日' : ''}と、信用の金利（楽天証券の制度信用くらい：買い年2.8%・空売りの貸株料 年1.1%）を差し引いています。`}持っている間に一番不利になったところで、${mode === 'fx' ? '証拠金維持率が100%' : mode === 'us' ? '保証金が取引金額の25%' : '保証金維持率が20%'}を割ったら「ロスカット（強制決済）」としています。おすすめは、<b>プラスになったやり方だけ</b>から選びます（一番減ったときが予算の35%以内のものを優先し、簡単なやり方を優先して、はっきり成績が良いときだけ手間やリスクの多いやり方を選びます）。どれもマイナスなら「お休み」をすすめます。</p>`;
}

function renderPlan(r0, mode) {
  const r = viewOf(r0, mode);
  const pf = r.pf;
  const budget = r.budget;
  const d = digitsOf(mode);
  // 表示中のやり方（現物・信用・空売り、為替の向き）で過去をやり直す
  const rule = replayOpts(mode, r.way.base || r.way, pf, r.prices);
  // 過去1年をあなたのルールでやり直す：全部やった場合と、確率の目安が高いものだけやった場合
  // 特別ルールのときは、その「勝つ確率○%以上」で絞る
  const all = replayWithBudget(r.trades, { ...rule, minOdds: r.minOdds });
  const picky = r.minOdds ? all : replayWithBudget(r.trades, { ...rule, minOdds: 0.55 });
  const usePicky = !r.minOdds && picky.trades >= 5 && picky.total > all.total;
  const minOdds = r.minOdds || (usePicky ? 0.55 : 0.5);
  // 持っている株（「持っている株」のタブと同じもの）で使っているお金を引いて、残りの予算・残りの枠で量を決める
  const held = getHoldings(mode);
  const use = heldUse(held, mode, { prices: r.prices, usdjpy: r.usdjpy, nowOf: (h) => priceOf(r, mode, h) });
  const left = leftBudget(pf, use);
  // 信用が追証になっているときは、まず現物のお金から保証金に移す分を取っておく（その残りで買う）
  // 信用の保証金：持っている株の今の値段で、毎日自動で計算する（含み損・代用の株の値下がりも入る）
  const book = mode !== 'fx' ? marginBook(pf, held, mode, { usdjpy: r.usdjpy, nowOf: (h) => priceOf(r, mode, h) }) : null;
  const auto = book?.base != null;
  let topUp = 0;
  if (auto) {
    left.margin = book.room;
    topUp = budgets(pf).sep || book.cal ? book.topUp : 0;
  } else {
    const mh0 = mode !== 'fx' && budgets(pf).sep ? marginHealth(pf, use, mode) : null;
    topUp = mh0 && mh0.ratio < mh0.maint ? Math.ceil(mh0.maint * use.notional - mh0.equity) : 0;
  }
  if (topUp) left.cash = Math.max(0, left.cash - topUp);
  const bg = budgets(pf);
  const cashB = left.cash;
  const heldOf = (sym) => held.filter((h) => symbolOf(mode, h.code).toUpperCase() === String(sym).toUpperCase());
  const sz = (x, stop) => (left.slots > 0
    ? sizeFor(pf, mode, x.side, { symbol: x.symbol, price: x.last, stop, budget: left.cash, marginCap: left.margin, riskBase: bg.sep ? bg.total : bg.cash, riskPct: pf.riskPct, maxPos: left.slots, prices: r.prices, usdjpy: r.usdjpy })
    : { qty: 0, why: `同時に持つ数（${pf.maxPos}銘柄）まで、もう持っています` });
  const opens = r.next.filter((x) => x.type === 'open').map((x) => ({ ...x, size: sz(x, x.stopEst), mine: heldOf(x.symbol) }))
    .sort((a, b) => (b.odds?.p || 0) - (a.odds?.p || 0));
  const good = opens.filter((x) => x.odds && x.odds.p >= minOdds && x.odds.expect > 0);
  const picks = good.filter((x) => !x.mine.length && x.size?.qty > 0).slice(0, left.slots);
  const rest = opens.filter((x) => !picks.includes(x));
  const allCloses = r.next.filter((x) => x.type === 'close');
  // 決済のサインのうち、あなたが実際に持っているもの
  const closeOf = (h) => allCloses.find((c) => c.symbol.toUpperCase() === symbolOf(mode, h.code).toUpperCase() && (!c.open || c.open.side === h.side));
  $('lab-plan').innerHTML = `
    ${wayBar(r, mode)}
    ${pf.budget ? '' : '<p class="notice" style="margin:0 0 8px">予算がまだ入っていないので、100万円で計算しています。右上の⚙（設定）の「あなたの設定」で入れてください。</p>'}
    <div class="plan-rule small">${mode === 'fx' ? `予算 <b>${yen0(budget)}</b>` : budgets(pf).sep ? `現物の予算 <b>${yen0(budgets(pf).cash)}</b>・信用・空売りの予算 <b>${yen0(budgets(pf).margin)}</b>` : `予算 <b>${yen0(budget)}</b>（現物・信用で共通）`}　／　1回で減ってもいい額 <b>${yen0(budget * pf.riskPct / 100)}</b>（${pf.riskPct}%）　／　同時に <b>${pf.maxPos}銘柄</b>まで（1銘柄 ${mode === 'fx' ? '' : '現物で'}${yen0(cashB / pf.maxPos)}まで）　／　取引のしかた <b>${esc(kindText(pf, mode))}</b></div>
    <button class="btn block" id="plan-settings" style="margin:8px 0 4px">予算・ルールを変える</button>

    ${heldHtml(mode, r, held, closeOf, opens, d)}
    ${budgetHtml(mode, r, held, use, left, picks, d, topUp, auto ? book : null)}

    <h3>✅ 今やるといいこと<span class="sub">${nextText()}・残りの予算で</span></h3>
    ${picks.length ? `<p class="small muted" style="margin:-4px 0 6px">1件ずつのくわしい内容です。買ったら、上の「🛒 残りのお金で買うもの」でチェックして、持っている株に入れてください。</p><ul class="list">${picks.map((x) => {
      const s = x.size;
      const gain = x.takeEst ? Math.abs(x.takeEst - x.last) * s.perPrice : null;
      return `<li class="plan-pick">
        <div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${sideBadge(x.side)}</div>
        ${timeLine(mode, x.t)}
        ${econWarnHtml(x.symbol, mode)}
        <div class="plan-order"><b>${orderText(x.side, s)}</b>（今 ${fmtPrice(x.last, d)}・${s.kindLabel} 約${yen0(s.cost)}）</div>
        ${s.over ? `<p class="small" style="color:var(--warn);margin:2px 0">⚠ ${s.lots}ロットだと、損切りまでいくと約${yen0(s.maxLoss)}減ります（1回で減ってもいい${yen0(s.riskYen)}を超えています）。ロット数を減らすか、設定でおまかせにするのがおすすめです。</p>` : ''}
        <div class="grid2 plan-grid">
          <div class="stat"><div class="label">損切りの値段</div><div class="value minus" style="font-size:16px">${fmtPrice(x.stopEst, d)}</div><div class="small muted">ここまで来たら決済：約−${yen0(s.maxLoss)}</div></div>
          <div class="stat"><div class="label">利益確定の目標</div><div class="value plus" style="font-size:16px">${x.takeEst ? fmtPrice(x.takeEst, d) : '—'}</div><div class="small muted">${gain ? `届いたら決済：約+${yen0(gain)}` : '判定が変わるまで持つ'}</div></div>
        </div>
        ${oddsHtml(x.odds, { compact: true })}
        <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details>
        </li>`;
    }).join('')}</ul>` : left.slots <= 0 ? `<p class="small muted">同時に持つ数（${pf.maxPos}銘柄）まで、もう持っているので、新しくは入りません。上の「持っている株」の決済のサインを待ちましょう。</p>` : `<p class="small muted">今は、あなたのルールに合うサインがありません（勝つ確率の目安${Math.round(minOdds * 100)}%以上・残りの予算で買える量があるもの）。お休みも大事なトレードです。</p>`}

    ${rest.length ? `<details class="why-box" style="margin-top:10px"><summary>見送ったサイン（${rest.length}件）</summary><ul class="list">${rest.map((x) => `<li class="small"><b>${esc(x.name)}</b> ${sideBadge(x.side)} 確率${x.odds ? Math.round(x.odds.p * 100) + '%' : '—'}　<span class="muted">${
      !x.odds || x.odds.p < minOdds ? `勝つ確率の目安が${Math.round(minOdds * 100)}%未満` : x.odds.expect <= 0 ? '勝っても負けても平均するとマイナス' : x.mine.length ? 'もう持っています（上の「持っている株」で見ています）' : x.size && x.size.qty === 0 ? esc(x.size.why) : !x.size ? '量を計算できませんでした' : `同時に持つ数（${pf.maxPos}つ）を超えるため`}</span></li>`).join('')}</ul></details>` : ''}

    ${wfHtml(r, mode)}
    <details class="more-box"><summary>📊 後から見た計算（今のやり方を1年前から使っていたら）</summary>
    <p class="small muted" style="margin:4px 0">こちらは「今いちばん良かったやり方」を1年前から使っていた場合です。今の時点で分かったことを使っているので、上の「本当の練習」より良く見えやすいです。</p>
    <div class="grid2">${replayCard('サインが出たら全部やる', all)}${replayCard('確率の目安55%以上だけやる', picky)}</div></details>
    ${waysHtml(r, mode)}
    <p class="small" style="margin:6px 0 0"><b>サインの絞り方：</b>${usePicky ? '確率の目安が55%以上のサインだけに絞る方が成績が良かったので、上の「今やるといいこと」も55%以上に絞っています。' : '絞らずにサインどおりにやる方が成績が良かったので、50%以上のサインを出しています。'}</p>
    <p class="notice" style="margin-top:8px">過去の値動きでの計算です。日本株は100株単位、為替は1,000通貨単位で、取引のしかたは「${esc(kindText(pf, mode))}」で計算しています（為替の証拠金は国内の決まりの25倍で計算）。手数料・値段のずれ・金利（スワップ）は目安で差し引き、「税引き後」も出しています。それでも、計算どおりに毎回売買できるとは限らず、実際の結果は変わります。最終的な判断はご自身で行ってください。</p>
    ${updatedNote(r0)}`;
  $('plan-settings').onclick = () => $('open-settings').click();
  const box = $('lab-plan');
  // 🛒 チェックしたものだけ、持っている株に入れる
  const cbs = [...box.querySelectorAll('.plan-buy-cb')];
  const btn = box.querySelector('#plan-buy-save');
  const sync = () => {
    const n = cbs.filter((c) => c.checked).length;
    cbs.forEach((c) => { c.closest('.plan-buy-item').querySelector('.plan-bought').hidden = !c.checked; });
    if (btn) { btn.disabled = !n; btn.textContent = n ? `チェックした${n}件を持っている株に入れる` : '買ったものにチェックを入れてください'; }
  };
  cbs.forEach((c) => c.addEventListener('change', sync));
  sync();
  if (btn) btn.onclick = () => {
    const todo = [];
    for (const c of cbs.filter((x) => x.checked)) {
      const x = picks[Number(c.dataset.i)];
      const f = c.closest('.plan-buy-item');
      const v = (k) => Number(String(f.querySelector(`[data-f="${k}"]`)?.value ?? '').normalize('NFKC').replace(/[,，円\s]/g, ''));
      const price = v('price'), date = f.querySelector('[data-f="date"]').value || '';
      const parts = x.size.acct === 'mix' ? [['cash', v('cashQty')], ['margin', v('marginQty')]] : [[mode === 'fx' ? 'cash' : x.side < 0 || x.size.acct === 'margin' ? 'margin' : 'cash', v('qty')]];
      if (!(price > 0) || !parts.some(([, q]) => q > 0)) { box.querySelector('#plan-buy-err').textContent = `${x.name}：値段と数量を数字で入れてください`; return; }
      for (const [acct, qty] of parts) if (qty > 0) todo.push({ code: codeFor(mode, x.symbol), name: x.name, side: x.side, price, qty, date, acct });
    }
    for (const t of todo) addHolding(mode, t);
    renderPlan(r0, mode);
  };
  // 決済した → 持っている株から消す
  box.querySelectorAll('.plan-sold').forEach((b) => { b.onclick = () => {
    if (!confirm('決済した（売った・買い戻した）ので、持っている株から消しますか？')) return;
    setHoldings(mode, getHoldings(mode).filter((h) => h.id !== b.dataset.id));
    renderPlan(r0, mode);
  }; });
  const cs = $('cal-save');
  if (cs) cs.onclick = () => {
    const t = String($('cal-rate').value).normalize('NFKC').replace(/[%％\s]/g, '');
    const rate = Number(t);
    const base = t !== '' ? calibrateMargin(rate, marginBook({ ...pf, marginCal: {} }, held, mode, { usdjpy: r.usdjpy, nowOf: (h) => priceOf(r, mode, h) })) : null;
    if (base == null) { $('cal-err').textContent = '保証金率を数字で入れてください（例 26.44）'; return; }
    const p0 = getProfile();
    setProfile({ ...p0, marginCal: { ...(p0.marginCal || {}), [mode]: { date: todayJst(), base, rate } } });
    renderPlan(r0, mode);
  };
  const cc = $('cal-clear');
  if (cc) cc.onclick = () => { const p0 = getProfile(); const m = { ...(p0.marginCal || {}) }; delete m[mode]; setProfile({ ...p0, marginCal: m }); renderPlan(r0, mode); };
  box.querySelectorAll('.plan-go-hold').forEach((b) => { b.onclick = () => { mineSub = 'hold'; store.set('mine_sub', mineSub); updateMine(mode); }; });
}

// 持っている株：あなたのプランから見た今の判断（「持っている株」のタブと連動）
function heldHtml(mode, r, held, closeOf, opens, d) {
  const unit = mode === 'fx' ? '通貨' : '株';
  const head = `<h3>📦 あなたが持っている株<span class="sub">「持っている株」のタブと連動</span></h3>`;
  if (!held.length) return `${head}<p class="small muted" style="margin:0 0 6px">まだ入っていません。下の「今やるといいこと」で買ったら下の「🛒 残りのお金で買うもの」で買ったものにチェックを入れると、ここと「持っている株」に入ります（予算の残りも自動で計算し直します）。</p>`;
  const items = held.map((h) => {
    const sym = symbolOf(mode, h.code);
    const now = r.prices[sym];
    const c = closeOf(h);
    const sig = opens.find((x) => x.symbol.toUpperCase() === sym.toUpperCase());
    const pl = now ? h.side * (now - h.price) * h.qty * (mode === 'us' ? r.usdjpy || 0 : mode === 'fx' ? quoteYen(sym, r.prices) : 1) : null;
    const acct = mode === 'fx' ? '' : h.side < 0 ? '信用・空売り' : h.acct === 'margin' ? '信用買い' : '現物';
    let st;
    if (c) st = `<div class="verdict danger">🔴 <b>${nextText()}決済のサイン</b>：${esc(c.reason)}</div><button class="btn small plan-sold" data-id="${esc(h.id)}" style="margin-top:4px">✔ 決済した（持っている株から消す）</button>`;
    else if (sig && sig.side !== h.side) st = '<div class="verdict warn">⚠ <b>反対向きのサインが出ています</b>。決済を考えましょう（くわしくは「持っている株」のタブ）</div>';
    else if (sig) st = '<div class="verdict ok">🟢 <b>同じ向きのサインがまた出ています</b>。持ち続けてOK（買い増しするかは「持っている株」のタブで判断）</div>';
    else if (now) st = '<div class="verdict ok">✋ <b>今は持ち続けてOK</b>（プランの判断が変わったら、ここに決済のサインを出します）</div>';
    else st = '<div class="small muted">この銘柄は、まだプランの計算に入っていません（次に計算し直すときに入ります）。今は「持っている株」のタブの判断を見てください。</div>';
    return `<li><div class="li-head"><span class="name">${symLink(sym, h.name)}</span>${acct ? `<span class="badge ${h.side > 0 ? 'buy' : 'sell'}">${acct}</span>` : sideBadge(h.side)}${pl != null ? `<b class="${pl >= 0 ? 'plus' : 'minus'}">${fmtYen(pl)}</b>` : ''}</div>
      <div class="small">${fmtPrice(h.price, d)} で ${Number(h.qty).toLocaleString()}${unit}${now ? ` → 今 ${fmtPrice(now, d)}` : ''}</div>
      <div class="small muted">使っているお金：${useText(mode, h, r)}</div>${st}</li>`;
  }).join('');
  return `${head}<ul class="list">${items}</ul><button class="btn block plan-go-hold" style="margin:6px 0 4px">「持っている株」で損切りの線・くわしい判断を見る</button>`;
}
const quoteYen = (sym, prices) => { const c = sym.replace(/=X$/, ''); const q = c.slice(3, 6); return q === 'JPY' ? 1 : prices[`${q}JPY=X`] || 0; };
// 銘柄の記号から「持っている株」に入れるコードへ（7203.T → 7203、USDJPY=X → USDJPY）
const codeFor = (mode, symbol) => (mode === 'fx' ? symbol.replace(/=X$/i, '') : mode === 'stock' ? symbol.replace(/\.T$/i, '') : symbol);
const todayStr = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 持っている株1件で使っているお金（現物はその金額、信用・空売りは保証金、為替は証拠金）
// 持っている株の今の値段（計算に入っている銘柄なら）
function priceOf(r, mode, h) {
  const bare = (x) => String(x).toUpperCase().replace(/\.T$|=X$/, '');
  const sym = bare(symbolOf(mode, h.code));
  const k = Object.keys(r.prices).find((p) => bare(p) === sym);
  return k ? r.prices[k] : null;
}
function useOne(mode, h, r) { const u = heldUse([h], mode, { prices: r.prices, usdjpy: r.usdjpy }); return { yen: u.cash + u.margin, margin: u.margin > 0 }; }
function useText(mode, h, r) {
  const u = useOne(mode, h, r);
  return `約${yen0(u.yen)}（${mode === 'fx' ? '証拠金' : u.margin ? '信用の保証金' : '現物'}）`;
}

// 楽天証券の「余力・保証金率」の画面の数字（日本株）
const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 信用の保証金の状態（自動計算）
function bookHealthHtml(b, topUp) {
  if (!(b.N > 0)) return '';
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [];
  if (b.ratio < b.maint) lines.push(`🚨 <b>保証金率 約${pc(b.ratio)}</b>：追証のライン（${pc(b.maint)}）を下回っています。${topUp ? `約<b>${yen0(topUp)}</b>を信用の口座に入れると戻る見込みです（上の表で、現物のお金から先に取っておいています）。` : 'お金を入れるか、建玉を減らしてください。'}`);
  else lines.push(`${b.ratio < b.maint + 0.05 ? '⚠' : '🛡'} <b>保証金率 約${pc(b.ratio)}</b>：追証（${pc(b.maint)}）まで、あと約<b>${yen0(b.buffer)}</b>含み損が増えても大丈夫です${b.dropPct ? `（信用で買っている株と代用の株がそろって<b>約${(b.dropPct * 100).toFixed(1)}%</b>下がるくらい）` : ''}。`);
  lines.push(b.ratio < b.NEW ? `⛔ 30%より低いので、<b>信用で新しく買う・空売りはできません</b>（プランでも信用の分は0で計算しています）。現物なら買えます。` : `✅ 30%以上なので、信用で新しく建てられます（下の「残りのお金で買うもの」はこの範囲で計算しています）。`);
  return `<div class="small" style="margin:4px 0 0">${lines.map((l) => `<p style="margin:2px 0">${l}</p>`).join('')}<p class="muted" style="margin:2px 0">毎日の値動きで自動で計算し直しています。証券会社の数字は前の日の値段で計算していることがあるので、少しずれることがあります。</p></div>`;
}
// 保証金率を1回入れてもらい、入れている現金の保証金を逆算する
function calForm(mode, b) {
  if (!(b?.N > 0)) return '';
  const c = b.cal;
  return `<details class="more-box" id="cal-box"${c ? '' : ' open'}><summary>📲 ${c ? `${esc(c.date.slice(5).replace('-', '/'))}に入れた保証金率 ${c.rate}% に合わせて計算中（入金・出金したら入れ直す）` : '楽天証券の「保証金率」を1回だけ入れる（もっと正確になります）'}</summary>
    <p class="small muted" style="margin:4px 0">楽天証券アプリの「資産・照会 → 余力・保証金率」にある<b>保証金率</b>を1回入れてください。そこから「入れている現金の保証金」を逆算して、あとは毎日の値動きで、保証金率・追証までの余裕・信用で新しく使えるお金を自動で計算します。<b>入れ直すのは、お金を入れた・出したときと、持っている株を入れ忘れていたときだけ</b>でOKです。</p>
    <div class="row"><input class="input grow" id="cal-rate" inputmode="decimal" placeholder="保証金率（例 26.44）" value="${c?.rate ?? ''}"><span class="small muted">%</span><button type="button" class="btn primary" id="cal-save">これに合わせる</button>${c ? '<button type="button" class="btn" id="cal-clear">やめる</button>' : ''}</div>
    <p class="small error" id="cal-err"></p>
    <p class="small muted" style="margin:0">※ 信用で持っている株・現物の株が「持っている株」に全部入っていると、正確になります（NISAの株は担保にならないので入れなくてOK）。</p></details>`;
}

// 💰 今使えるお金：むずかしい計算は裏でやって、わかりやすい数字だけ出す
function moneySummary(mode, r, use, left, book, topUp) {
  const big = (label, value, note = '', cls = '') => `<div class="stat"><div class="label">${label}</div><div class="value ${cls}" style="font-size:18px;word-break:keep-all">${value}</div>${note ? `<div class="small muted">${note}</div>` : ''}</div>`;
  const cards = [];
  if (mode === 'fx') {
    cards.push(big('新しく使える証拠金', yen0(left.cash), '持っているポジションの証拠金と含み損益を引いた残り'));
    return `<div class="grid2">${cards.join('')}</div>`;
  }
  cards.push(big('現物で買えるお金', yen0(left.cash), topUp ? `追証のために約${yen0(topUp)}を先に取っておいた残り` : ''));
  const L = mode === 'us' ? 2 : 3.3;
  if (book && book.N > 0 && book.ratio < book.NEW) cards.push(big('信用で新しく買えるお金', '0円', '保証金が足りないので、今は信用で新しく買えません（持っている信用の株の損が減るか、決済すると使えるようになります）', 'minus'));
  else if (left.margin > 0 && (book || budgets(r.pf).sep)) cards.push(big('信用で新しく買えるお金', `約${yen0(left.margin * L)}`, `保証金 約${yen0(left.margin)} × ${L}倍まで`));
  // 追証まで：信用の株が1銘柄なら「○円まで下がると追証」、いくつかなら「そろって○%下がると」
  if (book && book.N > 0) {
    const ms = use.rows.filter((x) => x.h.side < 0 || x.h.acct === 'margin');
    const codes = [...new Set(ms.map((x) => x.h.code))];
    let line;
    if (book.buffer <= 0) line = big('追証', '🚨 追証になっています', `約${yen0(topUp || book.topUp)}を信用の口座に入れる必要があります`, 'minus');
    else if (codes.length === 1 && ms[0].now) {
      const qty = ms.reduce((a, x) => a + Number(x.h.qty), 0) * (mode === 'us' ? r.usdjpy || 150 : 1);
      const side = ms[0].h.side;
      const at = ms[0].now - side * (book.buffer / qty);
      line = big(`追証になる値段（${esc(ms[0].h.name)}）`, `約${fmtPrice(Math.max(0, at), mode === 'stock' ? 0 : digitsOf(mode))}円`, `${side > 0 ? 'ここまで下がる' : 'ここまで上がる'}と追証（今 ${fmtPrice(ms[0].now, mode === 'stock' ? 0 : digitsOf(mode))}円）`, at > 0 && Math.abs(ms[0].now - at) / ms[0].now < 0.1 ? 'minus' : '');
    } else line = big('追証まで', book.dropPct ? `そろって約${(book.dropPct * 100).toFixed(1)}%下がると` : `あと約${yen0(book.buffer)}`, '信用の株と担保の株が一緒に下がった場合');
    cards.push(line);
  }
  if (book) cards.push(big('全部のお金（信用を今ぜんぶ決済したら）', `約${yen0(book.total + left.cash + topUp)}`, '現金＋現物の株の今の値段'));
  return `<div class="grid2">${cards.join('')}</div>
    <p class="small muted" style="margin:4px 0 0">毎日の値段で、自動で計算し直しています。予算を入れ直したいときは、「持っている株」で証券会社のCSVを読み込むと、予算も自動で決まります。</p>`;
}

// 💰 予算から持っている株を引いた残りと、🛒 その残りで買うもの（チェックしたものを持っている株に入れる）
function budgetHtml(mode, r, held, use, left, picks, d, topUp = 0, book = null) {
  const pf = r.pf;
  const bg = budgets(pf);
  const unit = mode === 'fx' ? '通貨' : '株';
  const isMargin = (h) => mode !== 'fx' && (h.side < 0 || h.acct === 'margin');
  const row = (label, yen, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><td class="small">${label}</td><td class="r small">${yen}</td></tr>`;
  const block = (title, total, list, rest, withPl = false, extra = '') => {
    // 信用・為替：含み損（為替は含み益も）の分だけ、本当の保証金・証拠金が変わる
    const pls = withPl ? use.rows.filter((x) => list.includes(x.h) && x.now) : [];
    const plRows = pls.some((x) => x.pl) ? `${pls.filter((x) => x.pl).map((x) => row(`<span class="muted">${x.pl < 0 ? '含み損' : '含み益'}：${esc(x.h.name)}（今 ${fmtPrice(x.now, d)}）</span>`, `<span class="${x.pl < 0 ? 'minus' : 'plus'}">${fmtYen(x.pl)}</span>`)).join('')}
      ${row(mode === 'fx' ? '<b>＝ 本当の証拠金（有効証拠金）</b>' : `<b>＝ 本当の保証金</b>${use.pl > 0 ? '<span class="muted">（含み益は足されません）</span>' : ''}`, `<b>${yen0(total + use.plAdj)}</b>`)}` : '';
    return `<tr class="best"><td class="small"><b>${title}</b></td><td class="r small"><b>${yen0(total)}</b></td></tr>
    ${plRows}
    ${list.map((h) => row(`− ${esc(h.name)}（${mode === 'fx' ? '必要な証拠金 ' : isMargin(h) ? '信用・必要な保証金 ' : '現物 '}${Number(h.qty).toLocaleString()}${unit}）`, `−${yen0(useOne(mode, h, r).yen)}`)).join('')}
    ${extra}
    ${row('<b>＝ 残り（新しく使えるお金）</b>', `<b>${yen0(rest)}</b>`)}`;
  };
  // 信用の保証金（自動計算）：現金の保証金 ＋ 代用 ＋ 含み損 ＝ 本当の保証金 → 保証金率 → 新しく使える分
  const bookRows = () => {
    const pls = use.rows.filter((x) => x.now && x.pl);
    return `<tr class="best"><td class="small"><b>信用の保証金（毎日自動で計算）</b></td><td class="r small"></td></tr>
      ${row(`入れている現金の保証金<span class="muted">（${book.cal ? `${esc(book.cal.date.slice(5).replace('-', '/'))}の保証金率 ${book.cal.rate}%から逆算` : '設定の「信用・空売りの予算」'}）</span>`, yen0(book.base))}
      ${book.subst ? row(`＋ 代用（現物の株 ${yen0(book.V)} × ${Math.round((book.sr ?? SUBST) * 100)}%）`, `+${yen0(book.subst)}`) : ''}
      ${pls.map((x) => row(`<span class="muted">${x.pl < 0 ? '含み損' : '含み益'}：${esc(x.h.name)}（今 ${fmtPrice(x.now, d)}）</span>`, `<span class="${x.pl < 0 ? 'minus' : 'plus'}">${fmtYen(x.pl)}</span>`)).join('')}
      ${pls.length ? row(`含み損益の合計${book.pl > 0 ? '<span class="muted">（含み益は足されません）</span>' : ''}`, fmtYen(book.plAdj)) : ''}
      ${row('<b>＝ 本当の保証金</b>', `<b>${yen0(book.E)}</b>`)}
      ${book.N > 0 ? row(`÷ 信用で建てている金額 ${yen0(book.N)}`, `<b>保証金率 約${(book.ratio * 100).toFixed(1)}%</b>`) : ''}
      ${book.N > 0 ? row('− 新しく建てるのに残しておく分（建てている金額の30%）', `−${yen0(book.N * book.NEW)}`) : ''}
      ${row('<b>＝ 信用で新しく使える保証金</b>', `<b>${yen0(left.margin)}</b>`)}`;
  };
  const tables = mode === 'fx' ? block('予算（証拠金に入れたお金）', bg.cash, held, left.cash, true)
    : bg.sep ? block('現物の予算', bg.cash, held.filter((h) => !isMargin(h)), left.cash, false, topUp ? row('<b class="minus">− 追証を解消するため、信用の口座へ移すお金</b>', `<b class="minus">−${yen0(topUp)}</b>`) : '') + (book ? bookRows() : block('信用・空売りの予算（入れた保証金）', bg.margin, held.filter(isMargin), left.margin, true))
    : block('予算（現物・信用で共通）', bg.cash, held, left.cash, true);
  // 保証金維持率と、あといくら損が増えると追証（為替はロスカット）か
  const mh = marginHealth(pf, use, mode);
  const healthHtml = book ? bookHealthHtml(book, topUp) : !mh ? '' : (() => {
    const ratio = mode === 'fx' ? mh.equity / mh.need : mh.ratio;
    const line = mode === 'fx' ? 1 : mh.maint;
    const danger = ratio < line, near = !danger && mh.buffer < mh.equity * 0.3;
    return `<p class="small ${danger ? 'error' : ''}" style="margin:4px 0 0">${danger ? '🚨' : near ? '⚠' : '🛡'} <b>${mode === 'fx' ? '証拠金維持率' : '保証金維持率'} ${Math.round(ratio * 100)}%</b>（${Math.round(line * 100)}%を下回ると${mode === 'fx' ? 'ロスカット（強制決済）' : '追証（お金の追加が必要）'}）${danger ? `。<b>もう下回っています。</b>${topUp ? `${Math.round(line * 100)}%に戻すには、約<b>${yen0(topUp)}</b>を信用の口座（保証金）に入れる必要があります。上の表では、そのお金を現物の予算から先に取っておいています。` : 'すぐにお金を入れるか、建玉を減らしてください。'}` : `。あと約<b>${yen0(mh.buffer)}</b>含み損が増えると${mode === 'fx' ? 'ロスカット' : '追証'}になります。`}${mode !== 'fx' ? '<br><span class="muted">保証金維持率 ＝ 本当の保証金 ÷ 信用で建てている金額。新しく信用で建てるには、残りの保証金が建てる金額の約30%以上いります。</span>' : ''}</p>`;
  })();
  // 買うもののお金を、どちらの予算から出すか
  const bucket = (x) => (mode !== 'fx' && bg.sep && (x.side < 0 || x.size.acct === 'margin') ? 'margin' : 'cash');
  const spend = { cash: 0, margin: 0 };
  for (const x of picks) spend[bucket(x)] += x.size.cost || 0;
  const after = bg.sep && mode !== 'fx' ? `現物 残り ${yen0(left.cash - spend.cash)}・信用 残り ${yen0(left.margin - spend.margin)}` : `残り ${yen0(left.cash - spend.cash)}`;
  const leftNow = bg.sep && mode !== 'fx' ? `現物 ${yen0(left.cash)}・信用 ${yen0(left.margin)}` : yen0(left.cash);
  const items = picks.map((x, i) => {
    const s = x.size;
    const step = mode === 'stock' ? 1 : mode === 'us' ? 0.01 : 0.001;
    const price = fmtPrice(Math.round(x.last / step) * step, d).replace(/,/g, '');
    const qtyInputs = s.acct === 'mix'
      ? `<div class="row"><label class="small muted">現物</label><input class="input grow" data-f="cashQty" inputmode="numeric" value="${s.cashQty}"><label class="small muted">信用</label><input class="input grow" data-f="marginQty" inputmode="numeric" value="${s.marginQty}"><span class="small muted">${unit}</span></div>`
      : `<div class="row"><label class="small muted">数量</label><input class="input grow" data-f="qty" inputmode="numeric" value="${s.qty}"><span class="small muted">${unit}</span></div>`;
    return `<li class="plan-buy-item">
      <label class="plan-buy-check"><input type="checkbox" class="plan-buy-cb" data-i="${i}">
        <span><b>${esc(x.name)}</b>${codeOf(x.symbol) && codeOf(x.symbol) !== x.name ? ` <span class="small muted">${esc(codeOf(x.symbol))}</span>` : ''}<br><span class="small">${orderText(x.side, s)}</span><br><span class="small muted">${s.kindLabel} 約${yen0(s.cost)}</span></span></label>
      <div class="plan-bought stack" hidden>
        <div class="row"><label class="small muted">${x.side > 0 ? '買った' : '売った'}値段</label><input class="input grow" data-f="price" inputmode="decimal" value="${price}"></div>
        ${qtyInputs}
        <div class="row"><label class="small muted">日付</label><input class="input grow" data-f="date" type="date" value="${todayStr()}"></div>
      </div></li>`;
  }).join('');
  return `<h3>💰 今使えるお金<span class="sub">持っている株・含み損まで自動で計算</span></h3>
    ${moneySummary(mode, r, use, left, book, topUp)}
    <details class="more-box"><summary>くわしい計算を見る・保証金率を合わせる</summary>
    <div class="tbl-wrap"><table class="tbl"><tbody>${tables}</tbody></table></div>
    ${healthHtml}
    ${mode !== 'fx' ? calForm(mode, book || marginBook({ ...pf, marginBudget: pf.marginBudget || 1 }, held, mode, { usdjpy: r.usdjpy, nowOf: (h) => priceOf(r, mode, h) })) : ''}
    </details>
    <h3>🛒 残りのお金で買うもの<span class="sub">${nextText()}</span></h3>
    ${left.slots <= 0 ? `<p class="small">同時に持つ数（${pf.maxPos}銘柄）まで、もう持っています。今は新しく買わずに、持っている株の決済のサインを待ちましょう。</p>`
    : picks.length ? `<p class="small" style="margin:0 0 6px">残りの <b>${leftNow}</b> で、あと${left.slots}銘柄まで持てます。<b>これを買ってください</b>（${picks.length}件・合計 約${yen0(spend.cash + spend.margin)} → 買ったあと ${after}）。</p>
      <ul class="list plan-buy-list">${items}</ul>
      <p class="small muted" style="margin:4px 0">買ったものにチェックを入れると、値段・数量の欄が出ます。実際に注文が通った値段・数量に直してから入れてください。同じ銘柄がもうあれば、買い増しとしてまとめます。</p>
      <button type="button" class="btn primary block" id="plan-buy-save" disabled>買ったものにチェックを入れてください</button>
      <p class="small error" id="plan-buy-err"></p>`
    : `<p class="small">残りの <b>${leftNow}</b> で買えるものは、今はありません（あなたのルールに合うサインがない）。お金はそのまま置いておきましょう。</p>`}`;
}

async function showNow(mode, force = false) {
  const out = $('lab-now');
  try {
    await loadEcon();
    const r = await computeLog(mode, out, force);
    if (getModeFn() !== mode) return;
    renderNow(r, mode);
    updateHoldDays(mode, r);
  } catch (e) { out.innerHTML = `<p class="error">${esc(errText('あなた専用', e))}</p>`; }
}

async function showList(mode, force = false) {
  const out = $('lab-log');
  try {
    const r = await computeLog(mode, out, force);
    if (getModeFn() !== mode) return;
    renderLog(r, mode);
    updateHoldDays(mode, r);
  } catch (e) { out.innerHTML = `<p class="error">${esc(errText('あなた専用', e))}</p>`; }
}

// あなたの設定なら「どの口座で・どれだけ」入るか（今のサイン・売買の一覧で使う）
function sizeOf(r, mode, side, symbol, price, stop) {
  const pf = r.pf || getProfile();
  return sizeFor(pf, mode, side, { symbol, price, stop, budget: pf.budget || 1_000_000, riskPct: pf.riskPct, maxPos: pf.maxPos, prices: r.prices, usdjpy: r.usdjpy });
}
function sizeLine(r, mode, x) {
  const s = sizeOf(r, mode, x.side, x.symbol, x.last, x.stopEst);
  if (!s) return '';
  if (!(s.qty > 0)) return `<div class="small muted">あなたの設定では入れません：${esc(s.why || '')}</div>`;
  const pips = mode === 'fx' ? `（${Math.abs(pipsOf(x.symbol, 1, x.last, x.stopEst)).toFixed(1)}pips先）` : '';
  return `<div class="small plan-order"><b>${orderText(x.side, s)}</b>（${s.kindLabel} 約${yen0(s.cost)}・損切り ${fmtPrice(x.stopEst, digitsOf(mode))}${pips} まで来たら約−${yen0(s.maxLoss)}）</div>`;
}

function renderNow(r0, mode) {
  const r = viewOf(r0, mode);
  const d = digitsOf(mode);
  const opens = r.next.filter((x) => x.type === 'open').sort((a, b) => (b.odds?.p || 0) - (a.odds?.p || 0));
  // 決済のサインは、あなたが実際に持っている株のものだけ出す
  const held = getHoldings(mode);
  const closes = r.next.filter((x) => x.type === 'close' && held.some((h) => symbolOf(mode, h.code).toUpperCase() === x.symbol.toUpperCase() && (!x.open || x.open.side === h.side)));
  const judged = style === 'day' ? '最新の15分足で判断' : r.next[0]?.date ? `${ymd(r.next[0].date)}の終わりの値段で判断` : '';
  $('lab-now').innerHTML = `
    ${wayBar(r, mode)}
    <h3>🟢 新しく入るサイン<span class="sub">${opens.length}件・${judged}</span></h3>
    ${opens.length ? `<ul class="list">${opens.map((x) => `<li>
      <div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${sideBadge(x.side)}</div>
      <div class="small"><b>${nextText()}${x.side > 0 ? '買う' : '売る'}</b>（今 ${fmtPrice(x.last, d)}）</div>
      ${sizeLine(r, mode, x)}
      ${econWarnHtml(x.symbol, mode)}
      ${timeLine(mode, x.t)}
      ${oddsHtml(x.odds)}
      <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details></li>`).join('')}</ul>` : '<p class="small muted">今は新しく入るサインはありません。</p>'}
    <h3>🔴 決済するサイン<span class="sub">持っている株だけ・${closes.length}件</span></h3>
    ${closes.length ? `<ul class="list">${closes.map((x) => {
      const g = x.open ? x.open.side * (x.last / x.open.entryPrice - 1) : 0;
      return `<li><div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${x.open ? sideBadge(x.open.side) : ''}<b class="${g >= 0 ? 'plus' : 'minus'}">${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%</b></div>
      <div class="small"><b>${nextText()}決済</b>：${esc(x.reason)}</div>${timeLine(mode, x.t)}
      ${x.open ? `<div class="small muted">${when(x.open.entryDate, x.open.entryTime)}に${fmtPrice(x.open.entryPrice, d)}で${x.open.side > 0 ? '買い' : '売り'} → 今 ${fmtPrice(x.last, d)}</div>${moveLine(r, mode, x.open.side, x.symbol, x.open.entryPrice, x.last, Math.abs(x.open.entryPrice - (x.open.stop ?? x.open.entryPrice * 0.97)) / x.open.entryPrice, 'を決済（今の値段なら）')}` : ''}
      <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details></li>`;
    }).join('')}</ul>` : `<p class="small muted">${held.length ? '今は、持っている株に決済のサインは出ていません。' : '持っている株が入っていないので、決済のサインは出していません（「持っている株」のタブで入れると、ここに出ます）。'}</p>`}
    <details class="more-box"><summary>参考：計算の上で持っている銘柄（${r.holding.length}件・あなたの持ち株ではありません）</summary>
    <p class="small muted" style="margin:4px 0 6px">このやり方が仮想のお金で持っているものです。あなたが実際に持っている株は「持っている株」のタブにあります。</p>
    ${r.holding.length ? `<ul class="list">${r.holding.map((x) => {
      const g = x.side * (x.last / x.entryPrice - 1);
      return `<li><div class="li-head"><span class="name">${symLink(x.symbol, x.name)}</span>${sideBadge(x.side)}<b class="${g >= 0 ? 'plus' : 'minus'}">${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%</b></div>
      <div class="small">${when(x.entryDate, x.entryTime)}に ${fmtPrice(x.entryPrice, d)} で${x.side > 0 ? '買い' : '売り'} → 今 ${fmtPrice(x.last, d)}</div>
      ${moveLine(r, mode, x.side, x.symbol, x.entryPrice, x.last, Math.abs(x.entryPrice - x.stop) / x.entryPrice, 'で持っている（含み損益）')}
      <div class="small muted">損切りの線 ${fmtPrice(x.stop, d)}${x.take ? `・利益確定の目標 ${fmtPrice(x.take, d)}` : ''}</div>
      ${oddsHtml(x.odds, { compact: true })}
      <details class="why-box"><summary>入った理由を見る</summary>${whyList(x.why)}</details></li>`;
    }).join('')}</ul>` : '<p class="small muted">計算の上で持っている銘柄はありません。</p>'}</details>
    <p class="notice" style="margin-top:8px">「勝つ確率の目安」は過去の成績からの見積もりで、当たる保証はありません。</p>
    ${updatedNote(r0)}`;
}

// ---------------- 本番の記録と、計算の比べ ----------------
// メールでお知らせした売買（計算の結果）と、取引分析に読み込んだ実際の取引（CSV）を突き合わせる
const normName = (x) => String(x || '').normalize('NFKC').replace(/[\s・（）()株式会社]/g, '').toUpperCase();
async function fillRecord(mode) {
  const el = $('real-record');
  if (!el) return;
  let rec;
  try { rec = await api('/api/record'); } catch { el.innerHTML = ''; return; }
  if (!$('real-record')) return;
  const pf = forMode(getProfile(), mode);
  const b = budgets(pf);
  const per = (mode === 'fx' ? b.cash : b.cash) / (pf.maxPos || 3);
  const log = rec.log.filter((t) => t.mode === mode).sort((a, c) => (c.exitTime || 0) - (a.exitTime || 0));
  const head = '<h3>📒 本番の記録（メールでお知らせした売買）と、実際の取引の比べ</h3>';
  if (!log.length) {
    el.innerHTML = `${head}<p class="small muted">まだ決済まで終わった売買はありません。お知らせした売買が決済まで終わると、ここに「計算の結果」と「あなたが実際に取引した結果（取引分析に読み込んだCSV）」を月ごとに並べます。${rec.open.filter((t) => t.mode === mode).length ? `今、お知らせして持っている途中のものが${rec.open.filter((t) => t.mode === mode).length}件あります。` : ''}</p>`;
    return;
  }
  const actual = (store.get(`trades_${mode}`, []) || []).filter((a) => a.pnl != null && a.date);
  const used = new Set();
  const rows = log.map((t) => {
    const calc = t.ret * per;
    // 同じ銘柄で、決済した日が前後4日以内の実際の取引
    let best = null, bestGap = Infinity;
    for (const a of actual) {
      if (used.has(a)) continue;
      const sameSym = tradeSymbol(a, mode) === t.symbol || (normName(a.symbol) && (normName(a.symbol).includes(normName(t.name)) || normName(t.name).includes(normName(a.symbol))));
      if (!sameSym) continue;
      const gap = Math.abs(Date.parse(a.date) / 1000 - (t.exitTime || 0));
      if (gap <= 4 * 86400 && gap < bestGap) { best = a; bestGap = gap; }
    }
    if (best) used.add(best);
    return { t, calc, real: best ? best.pnl : null, ym: new Date(((t.exitTime || 0) + 9 * 3600) * 1000).toISOString().slice(0, 7) };
  });
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const found = rows.filter((x) => x.real != null);
  const months = [...new Set(rows.map((x) => x.ym))].sort().reverse();
  const diff = sum(found.map((x) => x.real)) - sum(found.map((x) => x.calc));
  el.innerHTML = `${head}
    <div class="grid2">
      <div class="stat"><div class="label">お知らせした売買（計算）</div><div class="value ${sum(rows.map((x) => x.calc)) >= 0 ? 'plus' : 'minus'}">${fmtYen(sum(rows.map((x) => x.calc)))}</div><div class="small muted">${rows.length}回・勝ち${rows.filter((x) => x.t.ret > 0).length}回（1銘柄${yen0(per)}ずつ）</div></div>
      <div class="stat"><div class="label">実際の取引（CSVで見つかった分）</div><div class="value ${sum(found.map((x) => x.real)) >= 0 ? 'plus' : 'minus'}">${found.length ? fmtYen(sum(found.map((x) => x.real))) : '—'}</div><div class="small muted">${found.length}回が見つかりました${found.length ? `・同じ回の計算は ${fmtYen(sum(found.map((x) => x.calc)))}` : ''}</div></div>
    </div>
    ${found.length ? `<p class="small" style="margin:6px 0 0">${diff >= 0 ? `実際の方が計算より <b class="plus">${fmtYen(diff)}</b> 良かったです。` : `実際の方が計算より <b class="minus">${fmtYen(diff)}</b> 悪かったです。入るのが遅れた・決済が遅れた・量が違った、などが考えられます（取引分析タブでくわしく見られます）。`}</p>` : '<p class="small muted" style="margin:6px 0 0">実際の取引は「取引分析」タブに証券会社のCSVを読み込むと、ここで自動で突き合わせます。</p>'}
    <details class="more-box"><summary>月ごと・1回ずつ見る</summary>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>月</th><th class="r">回数</th><th class="r">計算</th><th class="r">実際</th></tr></thead><tbody>
      ${months.map((m) => { const g = rows.filter((x) => x.ym === m), f = g.filter((x) => x.real != null); return `<tr><td class="small">${Number(m.slice(5))}月</td><td class="r small">${g.length}</td><td class="r small">${fmtYen(sum(g.map((x) => x.calc)))}</td><td class="r small">${f.length ? `${fmtYen(sum(f.map((x) => x.real)))}（${f.length}回）` : '—'}</td></tr>`; }).join('')}
      </tbody></table></div>
      <ul class="list">${rows.slice(0, 30).map((x) => `<li class="small"><b>${esc(x.t.name)}</b> ${x.t.side > 0 ? '買い' : '売り'}　${x.t.entryTime ? esc(fmtTime(x.t.entryTime)) : ''} → ${x.t.exitTime ? esc(fmtTime(x.t.exitTime)) : ''}<br>計算 <span class="${x.calc >= 0 ? 'plus' : 'minus'}">${fmtYen(x.calc)}</span>（${x.t.ret >= 0 ? '+' : ''}${(x.t.ret * 100).toFixed(1)}%）／実際 ${x.real != null ? `<span class="${x.real >= 0 ? 'plus' : 'minus'}">${fmtYen(x.real)}</span>` : '<span class="muted">CSVに見つからない（取引していない？）</span>'}</li>`).join('')}</ul>
    </details>`;
}

// 売買の一覧：あなたの設定なら、どれだけ入って、いくらの損益だったか
// 量の書き方：「0.2ロット（2,000通貨）」「現物1,500株＋信用1,500株」「信用300株」
function amountText(s) {
  if (!s || !(s.qty > 0)) return '';
  if (s.acct === 'mix') return `現物${s.cashQty.toLocaleString()}${s.unitLabel}＋信用${s.marginQty.toLocaleString()}${s.unitLabel}`;
  const n = s.lots ? `${s.lots}ロット（${s.qty.toLocaleString()}${s.unitLabel}）` : s.lotSize ? `${Math.round((s.qty / s.lotSize) * 10) / 10}ロット（${s.qty.toLocaleString()}${s.unitLabel}）` : `${s.qty.toLocaleString()}${s.unitLabel}`;
  return s.acct ? `${s.acctText}${n}` : n;
}
// 入った値段と損切りの幅から、そのとき入っていた量（あなたの予算・やり方で）
function posAt(r, mode, side, symbol, entryPrice, stopPct) {
  return sizeOf(r, mode, side, symbol, entryPrice, entryPrice * (1 - side * (stopPct || 0.03)));
}
// 決済・含み損益の1行：「0.2ロット（2,000通貨）を決済 → +566.5pips・+11,330円」
function moveLine(r, mode, side, symbol, entryPrice, nowPrice, stopPct, verb) {
  const s = posAt(r, mode, side, symbol, entryPrice, stopPct);
  if (!s || !(s.qty > 0)) return '';
  const y = side * (nowPrice - entryPrice) * s.perPrice;
  const pips = mode === 'fx' ? `${pipsText(pipsOf(symbol, side, entryPrice, nowPrice))}・` : '';
  return `<div class="small qty-line">📦 <b>${amountText(s)}</b>${verb} → ${pips}<b class="${y >= 0 ? 'plus' : 'minus'}">${fmtYen(y)}</b></div>`;
}

function logSize(r, mode, t, d) {
  const s = sizeOf(r, mode, t.side, t.symbol, t.entryPrice, t.entryPrice * (1 - t.side * (t.stopPct || 0.03)));
  if (!s || !(s.qty > 0)) return '';
  const y = t.side * (t.exitPrice - t.entryPrice) * s.perPrice;
  const pips = mode === 'fx' ? `（${pipsText(pipsOf(t.symbol, t.side, t.entryPrice, t.exitPrice))}動いた）` : '';
  return `<div class="small">あなたの設定なら：<b>${orderText(t.side, s)}</b>${pips} → <b class="${y >= 0 ? 'plus' : 'minus'}">${fmtYen(y)}</b></div>`;
}

let logFilter = 'all';
function renderLog(r0, mode) {
  const r = viewOf(r0, mode);
  const d = digitsOf(mode);
  // 1回ずつ、あなたの予算・やり方での量と損益（量が出せないときは100万円分で計算）
  const pos = new Map(r.trades.map((t) => {
    const s = posAt(r, mode, t.side, t.symbol, t.entryPrice, t.stopPct);
    return [t, s?.qty > 0 ? { s, yen: t.side * (t.exitPrice - t.entryPrice) * s.perPrice } : { s: null, yen: t.pnl }];
  }));
  const yenOf = (t) => pos.get(t).yen;
  const wins = r.trades.filter((t) => t.pnl > 0);
  const total = r.trades.reduce((a, t) => a + yenOf(t), 0);
  const sorted = r.trades.slice().sort((a, b) => b.entryDate.localeCompare(a.entryDate));
  // 確率の目安ごとに、実際どれくらい勝てたか（目安が当てになるかの確認）
  const band = (lo, hi) => { const g = r.trades.filter((t) => t.odds && t.odds.p >= lo && t.odds.p < hi); return { n: g.length, w: g.filter((t) => t.pnl > 0).length }; };
  const bands = [['60%以上', band(0.6, 2)], ['50〜60%', band(0.5, 0.6)], ['50%未満', band(0, 0.5)]];
  $('lab-log').innerHTML = `
    ${wayBar(r, mode)}
    <div id="real-record"></div>
    <div class="grid2">
      <div class="stat"><div class="label">取引の回数（${r0.count}銘柄）</div><div class="value">${r.trades.length}回</div></div>
      <div class="stat"><div class="label">勝率</div><div class="value">${pct(r.trades.length ? wins.length / r.trades.length : null)}</div></div>
      <div class="stat"><div class="label">合計の損益（あなたの予算・決済した分）</div><div class="value ${total >= 0 ? 'plus' : 'minus'}">${fmtYen(total)}</div></div>
      <div class="stat"><div class="label">1回あたりの平均</div><div class="value ${total >= 0 ? 'plus' : 'minus'}">${fmtYen(r.trades.length ? total / r.trades.length : 0)}</div></div>
    </div>
    <h3>確率の目安は当たっていた？</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>入ったときの目安</th><th class="r">回数</th><th class="r">実際の勝率</th></tr></thead><tbody>
      ${bands.map(([k, b]) => `<tr><td class="small">${k}</td><td class="r">${b.n}</td><td class="r">${b.n ? pct(b.w / b.n) : '—'}</td></tr>`).join('')}</tbody></table></div>
    <h3>売買の一覧<span class="sub">新しい順・10件ずつ</span></h3>
    <div class="seg" id="lab-log-seg" style="margin-bottom:8px">${[['all', 'すべて'], ['win', '勝ち'], ['loss', '負け'], ['buy', '買い'], ['sell', '売り']].map(([k, v]) => `<button data-f="${k}" aria-pressed="${k === logFilter}">${v}</button>`).join('')}</div>
    <div id="lab-log-list"></div>
    ${updatedNote(r0)}`;
  fillRecord(mode);
  const draw = () => {
    const f = { all: () => true, win: (t) => t.pnl > 0, loss: (t) => t.pnl <= 0, buy: (t) => t.side > 0, sell: (t) => t.side < 0 }[logFilter];
    pagedList($('lab-log-list'), sorted.filter(f), (t) => `<li class="log-item">
      <div class="li-head"><span class="name">${symLink(t.symbol, t.name)}</span>${sideBadge(t.side)}<b class="${yenOf(t) >= 0 ? 'plus' : 'minus'}" style="font-size:16px">${yenOf(t) >= 0 ? '勝ち ' : '負け '}${fmtYen(yenOf(t))}</b></div>
      <div class="timeline">
        <div class="tl-step"><span class="tl-dot in"></span><div><b>${when(t.entryDate, t.entryTime)} ${t.side > 0 ? '買った' : '売った'}</b>　<span class="num">${fmtPrice(t.entryPrice, d)}</span>${pos.get(t).s ? `　<b>${amountText(pos.get(t).s)}</b>` : ''}<div class="small muted">${esc(t.reasonIn)}</div></div></div>
        <div class="tl-step"><span class="tl-dot out"></span><div><b>${when(t.exitDate, t.exitTime)} 決済</b>　<span class="num">${fmtPrice(t.exitPrice, d)}</span>${pos.get(t).s ? `　<b>${amountText(pos.get(t).s)}を${t.side > 0 ? '売って' : '買い戻して'}決済</b>` : ''}（${heldText(t)}・${mode === 'fx' ? `${pipsText(pipsOf(t.symbol, t.side, t.entryPrice, t.exitPrice))}・` : ''}<span class="${t.ret >= 0 ? 'plus' : 'minus'}">${t.ret >= 0 ? '+' : ''}${(t.ret * 100).toFixed(1)}%</span>）<div class="small muted">${esc(t.reasonOut)}</div></div></div>
      </div>
      ${pos.get(t).s ? '' : '<div class="small muted">あなたの予算では入れない量だったので、損益は100万円分で計算しています</div>'}
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
      // 15秒で返ってこなければあきらめる（前に取れた値動きがあれば、それを使う）
      const d = hit && Date.now() - hit.at < 5 * 60 * 1000 ? hit.d
        : await Promise.race([api(`/api/chart?symbol=${encodeURIComponent(s)}&tf=1d`), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]).catch((e) => { if (hit) return hit.d; throw e; });
      holdCache[s] = { at: Date.now(), d };
      candles[s] = d.candles;
      prices[s] = d.candles[d.candles.length - 1]?.close;
    } catch { /* 取れない銘柄は「取得できません」と出す */ }
  }));
  let earnings = {};
  if (mode === 'stock') {
    try {
      const codes = list.map((h) => h.code).filter((c) => /^[0-9][0-9A-Z]{3}$/.test(c));
      // 決算の予定は、4秒で返ってこなければ待たない（持っている株の表示を遅らせないため）
      const ev = codes.length ? await Promise.race([api(`/api/stocks/earnings?codes=${codes.join(',')}&from=${today}`), new Promise((r) => setTimeout(() => r(null), 4000))]) : null;
      ev?.items?.forEach((x) => { earnings[x.code] ||= x.date; });
    } catch { /* 決算の予定がなくても続ける */ }
  }
  const profile = forMode(getProfile(), mode);
  return list.map((h) => {
    try { return adviceOne(h); } catch (e) { report('あなた専用・持っている株（1銘柄）', e); return { h, adv: null }; }
  });
  function adviceOne(h) {
    const sym = symbolOf(mode, h.code);
    const hh = { ...h, symbol: sym };
    const adv = adviseHolding(hh, candles[sym], { mode, prices, usdjpy: prices['USDJPY=X'], profile, earningsDate: earnings[h.code], today });
    const timing = adv ? exitTiming(hh, candles[sym], adv, { mode, prices, usdjpy: prices['USDJPY=X'] }) : null;
    const longView = adv ? longTermView(hh, candles[sym], adv, { mode, prices, usdjpy: prices['USDJPY=X'] }) : null;
    const addOn = adv ? addOnAdvice(hh, candles[sym], adv, { mode }) : null;
    return { h, adv, timing, longView, addOn, earningsDate: earnings[h.code] || null, today };
  }
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

// 決算発表が今日・明日・あさってのとき：持ち越すかどうかの目安
function earnSoonHtml(date, today, adv) {
  if (!date || !today) return '';
  const days = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
  if (days < 0 || days > 2) return '';
  const when = days === 0 ? '今日' : days === 1 ? '明日' : 'あさって';
  const tip = adv.plPct > 0.03 ? `今 +${(adv.plPct * 100).toFixed(1)}% の利益なので、半分くらい利益確定してから決算をまたぐと安心です。` : adv.plPct < 0 ? `今 ${(adv.plPct * 100).toFixed(1)}% の損です。決算で下がると、損切りの線より下から始まることもあるので、持ち越すか手前で売るか決めておきましょう。` : '発表の翌日は大きく動くことがあるので、持ち越すかどうか決めておきましょう。';
  return `<p class="small" style="margin:4px 0 0;color:var(--warn)">📅 <b>${when}（${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}）決算発表</b>：${tip}</p>`;
}

// 信用で持っているとき：金利（貸株料）と、決済の期限の目安
function marginNote(mode, h, adv) {
  if (mode === 'fx' || (h.acct !== 'margin' && h.side > 0)) return '';
  const rate = h.side < 0 ? CARRY.short : CARRY.long;
  const notional = adv.plYen != null && adv.plPct ? Math.abs(adv.plYen / adv.plPct) : null;
  const perDay = notional ? notional * rate / 365 : null;
  const days = h.date ? Math.floor((Date.now() - Date.parse(h.date)) / 86400000) : null;
  const left = days != null ? 182 - days : null;
  return `<p class="small" style="margin:4px 0 0;color:var(--warn)">${h.side < 0 ? '信用で空売りしている' : '信用で買っている'}ので、${perDay ? `1日あたり約${yen0(perDay)}の${h.side < 0 ? '貸株料' : '金利'}がかかっています（目安）。` : `${h.side < 0 ? '貸株料' : '金利'}がかかります。`}${left != null ? (left > 0 ? `制度信用なら、あと約${left}日で決済の期限（6か月）です。` : '制度信用なら、もう決済の期限（6か月）を過ぎています。') : '制度信用なら6か月以内に決済が必要です（一般信用は楽天証券の条件を確認してください）。'}長く持つほど${h.side < 0 ? '貸株料' : '金利'}が増えるので、待つかどうかはそれも考えて決めましょう。</p>`;
}

// 買い増し：平均の値段（数量で重みをつけた平均）・合計の数量・一番最初に買った日にまとめる
export function mergeBuy(h, buy) {
  const buys = [...(h.buys?.length ? h.buys : [{ price: Number(h.price), qty: Number(h.qty), date: h.date || '' }]), buy];
  const qty = buys.reduce((a, b) => a + b.qty, 0);
  const price = Math.round((buys.reduce((a, b) => a + b.price * b.qty, 0) / qty) * 10000) / 10000;
  const dates = buys.map((b) => b.date).filter(Boolean).sort();
  return { price, qty, date: dates[0] || '', buys };
}

// 持っている株に1件入れる（同じ銘柄・向き・口座があれば、買い増しとしてまとめる）
function addHolding(mode, x, { merge = true } = {}) {
  const list = getHoldings(mode);
  const buy = { price: x.price, qty: x.qty, date: x.date || '' };
  const same = merge && list.find((y) => String(y.code).toUpperCase() === String(x.code).toUpperCase() && y.side === x.side && (y.acct || 'cash') === x.acct);
  if (same) Object.assign(same, mergeBuy(same, buy));
  else list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), code: x.code, name: x.name, side: x.side, ...buy, acct: x.acct, buys: [] });
  setHoldings(mode, list);
  // プランの計算に入っていない銘柄なら、次に開いたときに計算し直す
  const sym = symbolOf(mode, x.code).toUpperCase();
  for (const [k, c] of Object.entries(logCache)) if (k.startsWith(`${mode}|`) && !Object.keys(c.data.prices).some((p) => p.toUpperCase() === sym)) delete logCache[k];
}

// 「持っている株」のタブにも、あなたのプランの判断を出す（プランの計算が済んでいれば。まだなら裏で計算しておく）
let planWarm = null;
function planLine(mode, h) {
  const ck = ckOf(mode);
  const hit = logCache[ck];
  if (!hit) {
    if (planWarm !== ck) {
      planWarm = ck;
      computeLog(mode, document.createElement('div')).then(() => { if (getModeFn() === mode && mineSub === 'hold' && !$('view-mine').hidden) showHoldings(mode); }).catch(() => {}).finally(() => { planWarm = null; });
    }
    return '<p class="small muted" style="margin:4px 0 0"><span class="spinner"></span> あなたのプランでの判断を計算しています…</p>';
  }
  const v = viewOf(hit.data, mode);
  const sym = symbolOf(mode, h.code).toUpperCase();
  const c = v.next.find((x) => x.type === 'close' && x.symbol.toUpperCase() === sym && (!x.open || x.open.side === h.side));
  const o = v.next.find((x) => x.type === 'open' && x.symbol.toUpperCase() === sym);
  const inPlan = Object.keys(v.prices).some((p) => p.toUpperCase() === sym);
  const t = c ? `🔴 <b>${nextText()}決済のサイン</b>：${esc(c.reason)}`
    : o && o.side !== h.side ? '⚠ <b>反対向きのサインが出ています</b>。決済を考えましょう'
    : o ? '🟢 同じ向きのサインがまた出ています。持ち続けてOK'
    : inPlan ? '✋ 今は持ち続けてOK（決済のサインは出ていません）' : 'まだプランの計算に入っていません（次の計算で入ります）';
  return `<p class="small" style="margin:4px 0 0">📋 あなたのプラン（${esc(v.way.label)}）では：${t}</p>`;
}

let addFormTouched = false;
async function showHoldings(mode) {
  try { await showHoldingsInner(mode); } catch (e) {
    report('あなた専用・持っている株', e);
    $('hold-list').innerHTML = `<div class="card"><p class="small error">表示できませんでした（${esc(e.message)}）。</p><button class="btn block" id="hold-retry">もう一度読み込む</button></div>`;
    $('hold-retry').onclick = () => showHoldings(mode);
  }
}
async function showHoldingsInner(mode) {
  const box = $('hold-list');
  const list = getHoldings(mode);
  // 銘柄が入っていれば、追加の入力欄はたたんでおく（押せば開く）
  if (!addFormTouched) $('hold-add').open = !list.length;
  if (!list.length) {
    // 前に入れていたものが残っていれば、戻せるようにする
    const prev = syncState.prev?.[`holdings_${mode}`];
    box.innerHTML = `<div class="card"><p class="small muted">まだ入力されていません。上の欄に、持っている銘柄・買った値段・数量を入れて「追加する」を押してください。</p>
      ${prev?.value?.length ? `<p class="small" style="margin:8px 0 4px">前に入れていた${prev.value.length}銘柄（${esc(prev.value.map((h) => h.name).slice(0, 5).join('・'))}）が残っています。</p><button class="btn primary block" id="hold-restore">前に入れていた持っている株に戻す</button>` : ''}</div>`;
    if (prev?.value?.length) $('hold-restore').onclick = () => { setHoldings(mode, prev.value); showHoldings(mode); };
    return;
  }
  // 値段が届く前でも、入力した内容はすぐ見せる（値段は届いたら書き足す）
  if (!box.querySelector('.hold-item')) {
    const u = mode === 'fx' ? '通貨' : '株';
    box.innerHTML = list.map((h) => `<div class="card hold-item"><div class="li-head"><span class="name">${esc(h.name)}</span><span class="small muted">${fmtPrice(h.price, mode === 'stock' ? 1 : mode === 'us' ? 2 : 3)} で ${Number(h.qty).toLocaleString()}${u}</span></div><p class="small muted"><span class="spinner"></span> 今の値段を調べています…（15秒ほどで出ます）</p></div>`).join('');
  }
  const rows = await adviceFor(mode, list);
  if (getModeFn() !== mode) return;
  const d = mode === 'stock' ? 1 : mode === 'us' ? 2 : 3;
  const totalYen = rows.reduce((a, r) => a + (r.adv?.plYen || 0), 0);
  const unit = mode === 'fx' ? '通貨' : '株';
  box.innerHTML = `
    <div class="card"><div class="li-head"><span class="name">${list.length}銘柄の合計の損益（今の値段で）</span><b class="${totalYen >= 0 ? 'plus' : 'minus'}" style="font-size:18px">${fmtYen(totalYen)}</b></div></div>
    ${rows.map(({ h, adv, timing, longView, addOn, earningsDate, today }) => {
      if (!adv) return `<div class="card hold-item"><div class="li-head"><span class="name">${symLink(symbolOf(mode, h.code), h.name)}</span><button class="icon-btn hold-del" data-id="${esc(h.id)}" aria-label="消す">✕</button></div><p class="small error">値段を取得できませんでした（データの取得先が混んでいるようです。数分おきに自動で読み直します）。</p></div>`;
      const v = adv.verdict;
      return `<div class="card hold-item">
        <div class="li-head"><span class="name">${symLink(symbolOf(mode, h.code), h.name)}<span class="small muted">（押すとチャート）</span></span><span class="badge ${h.side > 0 ? 'buy' : 'sell'}">${mode === 'fx' ? (h.side > 0 ? '買い' : '売り') : h.side < 0 ? '信用・空売り' : h.acct === 'margin' ? '信用買い' : '現物'}</span><button class="icon-btn hold-del" data-id="${esc(h.id)}" aria-label="消す">✕</button></div>
        <div class="verdict ${v.cls}">${v.icon} <b>${v.label}</b></div>
        <div class="small">${h.buys?.length > 1 ? '平均 ' : ''}${fmtPrice(h.price, d)} で ${Number(h.qty).toLocaleString()}${unit}${h.date ? `（${esc(h.date.slice(5).replace('-', '/'))}${h.buys?.length > 1 ? '〜' : ''}）` : ''} → 今 <b>${fmtPrice(adv.now, d)}</b>　<b class="${adv.plPct >= 0 ? 'plus' : 'minus'}">${adv.plYen != null ? fmtYen(adv.plYen) : ''}（${adv.plPct >= 0 ? '+' : ''}${(adv.plPct * 100).toFixed(1)}%）</b></div>
        <div class="small muted">計算：（今 ${fmtPrice(adv.now, d)} − ${h.buys?.length > 1 ? '平均' : '買った値段'} ${fmtPrice(h.price, d)}）× ${Number(h.qty).toLocaleString()}${unit}${mode === 'us' ? ' × ドル円' : ''}${h.side < 0 ? '（売りなので逆）' : ''}・手数料と税金は入っていません</div>
        ${h.buys?.length > 1 ? `<div class="small muted">買い増しの内訳：${h.buys.map((b) => `${b.date ? esc(b.date.slice(5).replace('-', '/')) + ' ' : ''}${fmtPrice(b.price, d)}×${Number(b.qty).toLocaleString()}`).join('、')}</div>` : ''}
        <details class="hold-edit-box"><summary class="small">直す（値段・数量・日付）</summary>
          <div class="row" style="margin-top:6px"><input class="input grow" data-edit="price" inputmode="decimal" value="${esc(h.price)}" aria-label="平均の値段"><input class="input grow" data-edit="qty" inputmode="numeric" value="${esc(h.qty)}" aria-label="数量"></div>
          <div class="row" style="margin-top:6px"><input class="input grow" data-edit="date" type="date" value="${esc(h.date || '')}" aria-label="買った日"><button class="btn primary hold-save" data-id="${esc(h.id)}">保存</button></div>
          <p class="small muted" style="margin:4px 0 0">左：平均の値段（1株あたり）／右：合計の数量。証券会社の「平均取得価額」「保有数量」を入れると、評価損益がほぼ同じになります。</p>
        </details>
        <div class="grid2 plan-grid" style="margin-top:6px">
          <div class="stat"><div class="label">${adv.protects ? '利益を守る線' : '損切りの線'}</div><div class="value minus" style="font-size:16px">${fmtPrice(adv.stop, d)}</div><div class="small muted">逆指値の注文を入れておく</div></div>
          <div class="stat"><div class="label">利益確定の目標</div><div class="value plus" style="font-size:16px">${fmtPrice(adv.target, d)}</div><div class="small muted">${adv.wall ? `${esc(adv.wall.label)}（${esc(adv.wall.strength)}）` : '値動きの大きさから'}</div></div>
        </div>
        <p class="small" style="margin:6px 0 0">${esc(adv.reasons[0] || '')}</p>
        ${planLine(mode, h)}
        ${earnSoonHtml(earningsDate, today, adv)}
        ${marginNote(mode, h, adv)}
        ${addOn ? `<p class="small" style="margin:4px 0 0">${addOn.icon} <b>${esc(addOn.title)}</b>：${esc(addOn.text)}</p>` : ''}
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
  box.querySelectorAll('.hold-save').forEach((b) => { b.onclick = () => {
    const wrap = b.closest('.hold-edit-box');
    const v = (k) => wrap.querySelector(`[data-edit="${k}"]`).value;
    const n = (x) => Number(String(x).normalize('NFKC').replace(/[,，円\s]/g, ''));
    const price = n(v('price')), qty = n(v('qty'));
    if (!(price > 0) || !(qty > 0)) { alert('値段と数量を数字で入れてください'); return; }
    // 直したときは、まとめた内訳は消して「平均の値段・合計の数量」として持つ
    setHoldings(mode, getHoldings(mode).map((x) => (x.id === b.dataset.id ? { ...x, price, qty, date: v('date') || '', buys: [] } : x)));
    showHoldings(mode);
  }; });
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
  for (const id of ['hold-side', 'hold-acct']) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  }
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
    // 空売り（株で売りから入っている）は信用でしかできない
    const acct = mode === 'fx' ? 'cash' : side < 0 ? 'margin' : ($('hold-acct').querySelector('[aria-pressed="true"]')?.dataset.v || 'cash');
    const buy = { price, qty, date: $('hold-date').value || '' };
    // 同じ銘柄・同じ向き・同じ口座がもうあれば「買い増し」としてまとめる
    const same = list.find((x) => String(x.code).toUpperCase() === String(pick.code).toUpperCase() && x.side === side && (x.acct || 'cash') === acct);
    if (same && confirm(`${pick.name}はもう入っています。\n追加で${side > 0 ? '買った' : '売った'}分（買い増し）として、平均の値段と合計の数量にまとめますか？\n\nOK：まとめる\nキャンセル：別々に入れる`)) {
      Object.assign(same, mergeBuy(same, buy));
    } else {
      list.push({ id: Date.now().toString(36), code: pick.code, name: pick.name, side, ...buy, acct, buys: [] });
    }
    setHoldings(mode, list);
    ['hold-sym', 'hold-price', 'hold-qty', 'hold-amount', 'hold-date'].forEach((id) => { $(id).value = ''; });
    holdPick = null;
    sug.hidden = true;
    showHoldings(mode);
  });
  $('hold-add').addEventListener('click', (e) => { if (e.target.closest('summary')) addFormTouched = true; });
  // 証券会社のCSVから読み込む
  $('hold-import-file').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    const box = $('hold-import-preview');
    if (!files.length) return;
    // 「保有商品一覧（現物）」と「信用建玉一覧」のように、いくつかのCSVをまとめて読める
    const found = { stock: [], us: [], fx: [] };
    let rate = null;
    try {
      for (const f of files) {
        const one = parseHoldingsCsv(decodeFile(await f.arrayBuffer()), { lotSize: getProfile().fxLotSize || 10000 });
        for (const m of Object.keys(found)) found[m].push(...(one[m] || []));
        if (one.marginRate != null) rate = one.marginRate;
      }
    } catch (err) { box.innerHTML = `<p class="small error">読み込めませんでした（${esc(err.message)}）</p>`; return; }
    const NAME = { stock: '日本株', us: '米国株', fx: '為替' };
    const modes = Object.keys(found).filter((m) => found[m].length);
    if (!modes.length) { box.innerHTML = '<p class="small error">持っている銘柄が見つかりませんでした。「保有商品一覧」や「建玉一覧」のCSVか確かめてください。</p>'; return; }
    box.innerHTML = `${modes.map((m) => `<p class="small" style="margin:4px 0"><b>${NAME[m]}：${found[m].length}銘柄</b><br>${found[m].map((x) => `${esc(x.name)}${m === 'fx' ? '' : `（${esc(x.code)}）`} ${x.side < 0 ? '売り' : ''}${x.acct === 'margin' ? '信用' : ''} ${Number(x.price).toLocaleString()} × ${Number(x.qty).toLocaleString()}`).join('<br>')}</p>`).join('')}
      ${found.stock.length ? `<div class="stat" style="margin-top:8px">
        <label class="plan-buy-check"><input type="checkbox" id="imp-budget" checked><span><b>予算も、このCSVに合わせて自動で決める</b>（日本株）${rate != null ? `<br><span class="small muted">保証金率 ${rate}% も読み取りました。信用の保証金は、これから毎日自動で計算します。</span>` : ''}</span></label>
        <div class="stack" style="margin-top:6px">
          <div class="row"><label class="small muted" style="min-width:10em">現物で使える現金</label><input class="input grow" id="imp-free" inputmode="numeric" value="0"><span class="small muted">円</span></div>
          <p class="small muted" style="margin:0">楽天証券の「預り金」と「楽天銀行利用可能額」の合計。全部保証金に入れているなら0のままでOK。</p>
          ${rate != null ? `<div class="row"><label class="small muted" style="min-width:10em">保証金現金（わかれば）</label><input class="input grow" id="imp-dep" inputmode="numeric" placeholder="例 2190784"><span class="small muted">円</span></div>
          <p class="small muted" style="margin:0">「余力・保証金率」の画面の「保証金現金」。入れるとピッタリ合います。空でもだいたい合います。</p>` : ''}
        </div></div>` : ''}
      <div class="row" style="margin-top:6px"><button class="btn primary grow" id="hold-import-replace">この内容に置き換える</button><button class="btn grow" id="hold-import-add">今のものに足す</button></div>
      <p class="small muted" style="margin:4px 0 0">「置き換える」は、上に出た市場（${modes.map((m) => NAME[m]).join('・')}）の持っている株を、CSVの内容だけにします。</p>`;
    const apply = (replace) => {
      for (const m of modes) {
        const now = replace ? [] : getHoldings(m);
        for (const x of found[m]) {
          const same = now.find((y) => String(y.code).toUpperCase() === x.code && y.side === x.side && (y.acct || 'cash') === x.acct);
          if (same && !replace) Object.assign(same, mergeBuy(same, { price: x.price, qty: x.qty, date: x.date }));
          else now.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...x, buys: [] });
        }
        setHoldings(m, now);
      }
      // 予算も自動で決める（日本株）
      let msg = '';
      if (found.stock.length && $('imp-budget')?.checked) {
        const num = (id) => { const t = String($(id)?.value ?? '').normalize('NFKC').replace(/[,，円\s]/g, ''); return t === '' || !Number.isFinite(Number(t)) ? null : Number(t); };
        const st = setupFromCsv(getHoldings('stock'), { rate, cashDeposit: num('imp-dep'), cashFree: num('imp-free') || 0 });
        const p0 = getProfile();
        // 為替・米国株の予算が別になっていなければ、今までの予算をそちらに残しておく
        const next = { ...p0, budget: st.budget, fxBudget: p0.fxBudget || p0.budget || 0, usBudget: p0.usBudget || p0.budget || 0 };
        if (st.marginBudget != null) next.marginBudget = st.marginBudget;
        if (st.cal) next.marginCal = { ...(p0.marginCal || {}), stock: { date: todayJst(), ...st.cal } };
        setProfile(next);
        msg = `<br>予算を<b>現物 ${yen0(st.budget)}</b>${st.marginBudget != null ? `・<b>信用・空売り ${yen0(st.marginBudget)}</b>` : ''}にしました。「あなたのプラン」で、今使えるお金を見られます。`;
      }
      setHoldings('stock', getHoldings('stock').map(({ now, ...x }) => x));
      box.innerHTML = `<p class="small">✅ ${modes.map((m) => `${NAME[m]} ${found[m].length}銘柄`).join('・')}を入れました。${msg}</p>`;
      e.target.value = '';
      showHoldings(getModeFn());
    };
    $('hold-import-replace').onclick = () => apply(true);
    $('hold-import-add').onclick = () => apply(false);
  });
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
  const rec = holdDays[getModeFn()]?.best?.d;
  const days = [...new Set([3, 5, 10, 20, 30, 60, ...(rec ? [rec] : [])])].sort((a, b) => a - b);
  $('swing-days-chips').innerHTML = days.map((d) => `<button type="button" class="chip" data-d="${d}" aria-pressed="${d === sd}">${d}日${d === rec ? ' ★おすすめ' : ''}</button>`).join('');
}

export function updateMine(mode, { force = false } = {}) {
  if ($('view-mine').hidden) return;
  applyMineSub();
  if (mineSub === 'hold') return showHoldings(mode);
  if (mineSub === 'plan') return showPlan(mode, force);
  if (mineSub === 'now') return showNow(mode, force);
  if (mineSub === 'list') return showList(mode, force);
}

// ---------------- スイングで持つ日数：全部試して、おすすめを出す ----------------
// 今のおすすめのやり方で、持つ日数の上限だけを変えて過去1年をやり直し、一番良かった日数を出す
const HOLD_DAYS = [3, 5, 7, 10, 15, 20, 30, 45, 60, 90];
const holdDays = {};
let holdRunning = null;
async function updateHoldDays(mode, r) {
  const el = $('swing-days-best');
  if (!r?.list || r.style !== 'swing') return;
  const pf = forMode(getProfile(), mode);
  const v = viewOf(r, mode);
  const way = v.best.base || v.best;
  const key = JSON.stringify([mode, r.count, Math.floor(r.at / 3600000), way.key, pf.budget, pf.marginBudget, pf.riskPct, pf.maxPos, pf.fxLots]);
  const hit = holdDays[mode];
  if (hit?.key === key) { renderHoldDays(mode); return; }
  if (holdRunning === key) return;
  holdRunning = key;
  el.innerHTML = '<span class="spinner"></span> 持つ日数を3日〜90日で全部試しています…';
  const kind = kindOf(mode);
  const rows = [];
  for (const d of HOLD_DAYS) {
    const trades = [];
    for (const x of r.list) {
      const rs = runStrategy(x.candles, 'combo', { kind, pair: x.symbol.replace(/=X$/, ''), regime: r.regime, days: 250, maxHold: d, sides: way.sides });
      for (const t of rs.trades) trades.push({ ...t, symbol: x.symbol });
    }
    rows.push({ d, r: replayWithBudget(trades, replayOpts(mode, way, pf, r.prices)) });
    await new Promise((res) => setTimeout(res, 0));
  }
  // おすすめ：プラスで、一番減ったときが予算の35%以内のものから、一番増えたもの（ほぼ同じなら短い方）
  const budget = v.budget;
  const ok = rows.filter((x) => x.r.total > 0 && !x.r.broke);
  const safe = ok.filter((x) => x.r.maxDD <= budget * 0.35);
  let best = null;
  for (const x of safe.length ? safe : ok) if (!best || x.r.total > best.r.total + budget * 0.02) best = x;
  // 日数のおすすめも、今月決めたものがまだプラスならそのまま（毎月1日に見直す）
  const month = monthKey();
  const kd = best ? keepDays(rows, best, getProfile().planLock?.[mode], month) : { best, kept: false };
  const fresh = best;
  best = kd.best;
  if (best && (getProfile().planLock?.[mode]?.days !== best.d || getProfile().planLock?.[mode]?.daysMonth !== month)) setLock(mode, { days: best.d, daysMonth: month });
  holdDays[mode] = { key, rows, best, fresh, kept: kd.kept, way };
  holdRunning = null;
  renderHoldDays(mode);
}
function renderHoldDays(mode) {
  const h = holdDays[mode], el = $('swing-days-best');
  if (!h) return;
  const sd = getProfile().swingDays || 30;
  el.innerHTML = `${h.best ? `🏆 <b>おすすめは${h.best.d}日</b>（「${esc(h.way.label)}」で過去1年 ${fmtYen(h.best.r.total)}・税引き後 ${fmtYen(afterTax(h.best.r.total))}）${h.best.d !== sd ? ` <button type="button" class="chip" data-d="${h.best.d}">${h.best.d}日にする</button>` : '（今の設定です）'}<br><span class="small muted">📌 このおすすめは今月の間は変えません（毎月1日に見直し）。${h.kept && h.fresh && h.fresh.d !== h.best.d ? `今日計算し直すと${h.fresh.d}日の方が良い結果ですが、月の途中では変えません。` : ''}</span>` : '⚠ どの日数でもマイナスでした。今はお休みがおすすめです。'}
    <details class="more-box"><summary>日数ごとの成績を見る</summary>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>持つ日数の上限</th><th class="r">1年の損益</th><th class="r">税引き後</th><th class="r">回数・勝率</th><th class="r">一番減ったとき</th></tr></thead><tbody>
      ${h.rows.map((x) => `<tr${x === h.best ? ' class="best"' : ''}><td class="small">${x.d}日${x === h.best ? ' ★' : ''}${x.d === sd ? '（今）' : ''}</td><td class="r small ${x.r.total >= 0 ? 'plus' : 'minus'}">${fmtYen(x.r.total)}</td><td class="r small">${fmtYen(afterTax(x.r.total))}</td><td class="r small">${x.r.trades}回・${pct(x.r.winRate)}</td><td class="r small">${fmtYen(-x.r.maxDD)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted" style="margin:4px 0 0">今のおすすめのやり方「${esc(h.way.label)}」で、持つ日数の上限だけを変えて、あなたの予算で過去1年をやり直しました（費用・金利込み）。日数が来る前でも、損切り・利益確定・判定が変わったときは決済します。</p>
    </details>`;
  applyMineSub();
}

// 「成績」タブ用：サイトがやるとしたら、どのやり方が一番いいか（全銘柄・過去1年・あなたの予算）
export async function showWaysCard(el, mode) {
  try {
    const r = await computeLog(mode, el, false, 'swing');
    if (getModeFn() !== mode) return;
    const v = viewOf(r, mode);
    const b = v.best;
    el.innerHTML = `<p class="small" style="margin:0 0 6px">${r.count}銘柄を、全部のやり方（${WAYS[mode].map((w) => w.label).join('・')}）で過去1年やり直して比べました。</p>
      ${wfHtml(v, mode)}
      ${waysHtml(v, mode)}
      <p class="small" style="margin:6px 0 0">${v.cmp.note === 'rest' ? `どのやり方もマイナスだったので、今はお休みがおすすめです。「あなた専用」では、やるなら一番損が小さい「<b>${esc(b.label)}</b>」で出しています。` : `今は「<b>${esc(b.label)}</b>」でやるのが一番いいと判断して、「あなた専用」のプラン・サイン・メールもこのやり方で出しています。`}</p>
      ${updatedNote(r)}`;
  } catch (e) { el.innerHTML = `<p class="error">${esc(errText('あなた専用', e))}</p>`; }
}

export function initMine(getMode, openChart = () => {}) {
  getModeFn = getMode;
  $('view-mine').addEventListener('click', (e) => {
    // やり方を切り替える（計算し直さずに、表示だけ変える）
    const w = e.target.closest('[data-way]');
    if (w) { setWayPref('wayView', getMode(), w.dataset.way); updateMine(getMode()); return; }
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
  $('swing-days-best').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) setDays(b.dataset.d); });
  $('swing-days-input').addEventListener('change', (e) => setDays(e.target.value));
}
