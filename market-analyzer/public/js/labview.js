// 「成績」タブ：予想の答え合わせ（1日ずつ）と、自動売買の練習（3つの戦略）
import { api, $, esc, store, fmtPrice, digitsFor, fmtYen, cssVar, JST } from './util.js';
import { term } from './glossary.js';
import { evaluateForecasts } from './backtest.js';
import { runStrategy, regimeLookup, STRATEGIES, pickAndTrade, signalOdds, oddsLabel, oddsText } from './strategies.js';
import { baseUniverse } from './universe.js';
import { pagedList } from './stockscreener.js';
import { futureTimes } from './forecast.js';
import { getFavs, getProfile } from './favorites.js';
import { sizePosition, replayWithBudget } from './plan.js';

const LC = window.LightweightCharts;
const HORIZONS = [[1, '翌日'], [5, '1週間後'], [20, '1か月後']];
let horizon = store.get('lab_h', 1);
let strategy = store.get('lab_s', 'combo');
let ctx = null; // { symbol, name, mode, candles, regime, fundRatio, digits }
let charts = {};
let regimeCache = null;

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const kindOf = (mode) => (mode === 'fx' ? 'fx' : mode === 'us' ? 'us' : 'stock');

function chartOpts(height) {
  const grid = cssVar('--border');
  return {
    autoSize: true, height,
    layout: { background: { type: 'solid', color: cssVar('--surface') }, textColor: cssVar('--muted'), fontSize: 11 },
    grid: { vertLines: { color: grid + '55' }, horzLines: { color: grid + '55' } },
    rightPriceScale: { borderColor: grid, minimumWidth: 70 },
    timeScale: { borderColor: grid },
    localization: { locale: 'ja-JP' },
  };
}

function makeChart(id) {
  if (charts[id]) { charts[id].remove(); }
  charts[id] = LC.createChart($(id), chartOpts());
  return charts[id];
}

async function loadRegime() {
  if (regimeCache && Date.now() - regimeCache.at < 30 * 60 * 1000) return regimeCache.fn;
  const get = (s) => api(`/api/chart?symbol=${encodeURIComponent(s)}&tf=1d`).then((d) => d.candles).catch(() => []);
  const [vix, tnx, nikkei] = await Promise.all([get('^VIX'), get('^TNX'), get('^N225')]);
  regimeCache = { at: Date.now(), fn: regimeLookup({ vix, tnx, nikkei }) };
  return regimeCache.fn;
}

// ---------------- 予想の答え合わせ ----------------
function renderForecast() {
  const res = evaluateForecasts(ctx.candles, { horizon, days: 120 });
  const s = res.stats;
  const d = ctx.digits;
  $('lab-h-seg').innerHTML = HORIZONS.map(([h, l]) => `<button data-h="${h}" aria-pressed="${h === horizon}">${l}</button>`).join('');
  $('lab-fc-stats').innerHTML = `
    <div class="grid2">
      <div class="stat"><div class="label">上がる・下がるの的中率</div><div class="value ${s.dirHit >= 0.55 ? 'plus' : s.dirHit < 0.45 ? 'minus' : ''}">${pct(s.dirHit)}</div></div>
      <div class="stat"><div class="label">予想の幅（90%）に入った割合</div><div class="value">${pct(s.in90)}</div></div>
      <div class="stat"><div class="label">${term('signal', 'テクニカル判定')}の的中率</div><div class="value">${pct(s.techHit)}<span class="small muted">（${s.techCount}回）</span></div></div>
      <div class="stat"><div class="label">予想の中心とのずれ（平均）</div><div class="value">${s.avgError == null ? '—' : `${(s.avgError * 100).toFixed(2)}%`}</div></div>
    </div>
    <p class="small muted" style="margin:8px 0 0">${s.count}日分を答え合わせ（${HORIZONS.find(([h]) => h === horizon)[1]}の値段で判定）。比べる目安：「毎日“上がる”と言い続けた場合」の的中率は ${pct(s.alwaysUp)}。<br>90%の幅に入った割合が90%に近いほど、予想の幅が正しく作れています。</p>`;

  // チャート：実際の値段と、その日に出していた予想（予想した日の${horizon}本先の位置に表示）
  const chart = makeChart('lab-fc-chart');
  const shift = (t) => t + JST;
  const actual = chart.addLineSeries({ color: cssVar('--text'), lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: '実際' });
  const first = res.rows[0]?.time ?? 0;
  actual.setData(ctx.candles.filter((c) => c.time >= first).map((c) => ({ time: shift(c.time), value: c.close })));
  const fut = futureTimes(ctx.candles.map((c) => ({ ...c, time: shift(c.time) })), horizon, '1d');
  // 結果がまだ出ていない予想は、未来の日付の位置に置く
  const n = ctx.candles.length;
  const idxOf = new Map(ctx.candles.map((c, i) => [c.time, i]));
  const placed = res.rows.map((r) => ({ ...r, at: r.targetTime ? shift(r.targetTime) : fut[idxOf.get(r.time) + horizon - n] }));
  const pointsFor = (key) => placed.filter((r) => r.at).map((r) => ({ time: r.at, value: r[key] })).sort((a, b) => a.time - b.time)
    .filter((p, i, arr) => i === 0 || p.time !== arr[i - 1].time);
  chart.addLineSeries({ color: '#f2c94c', lineWidth: 2, lineStyle: LC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, title: '予想' }).setData(pointsFor('center'));
  chart.addLineSeries({ color: '#a0aec088', lineWidth: 1, lineStyle: LC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false }).setData(pointsFor('high90'));
  chart.addLineSeries({ color: '#a0aec088', lineWidth: 1, lineStyle: LC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false }).setData(pointsFor('low90'));
  chart.timeScale().fitContent();

  // 1日ずつの表（新しい順）
  $('lab-fc-table').innerHTML = `<table class="tbl"><thead><tr><th>予想した日</th><th>予想</th><th class="r">予想の中心<br><span class="muted" style="font-weight:400">90%の幅</span></th><th class="r">実際</th><th>結果</th></tr></thead><tbody>
    ${res.rows.slice().reverse().map((r) => `<tr>
      <td class="small">${esc(r.date.slice(5).replace('-', '/'))}${r.targetDate ? `<div class="muted" style="font-size:11px">→${esc(r.targetDate.slice(5).replace('-', '/'))}</div>` : ''}</td>
      <td class="small"><span class="badge ${r.predUp ? 'buy' : 'sell'}">${r.predUp ? '上がる' : '下がる'}</span><div class="muted" style="font-size:11px">上がる確率${Math.round(r.upProb * 100)}%</div></td>
      <td class="r small num">${fmtPrice(r.center, d)}<div class="muted" style="font-size:11px">${fmtPrice(r.low90, d)}〜${fmtPrice(r.high90, d)}</div></td>
      <td class="r small num">${r.actual == null ? '<span class="muted">—</span>' : `<span class="${r.actual >= r.base ? 'plus' : 'minus'}">${fmtPrice(r.actual, d)}</span>`}</td>
      <td class="small">${r.actual == null ? '<span class="badge warn">答え合わせ待ち</span>' : `${r.dirHit ? '<span class="badge ok">○ 方向</span>' : '<span class="badge bad">× 方向</span>'}${r.in90 ? '' : '<div class="muted" style="font-size:11px">幅の外</div>'}`}</td>
    </tr>`).join('')}</tbody></table>`;
  return res;
}

// ---------------- 自動売買 ----------------
function renderTrades() {
  const kind = kindOf(ctx.mode);
  const r = runStrategy(ctx.candles, strategy, { kind, pair: ctx.symbol.replace(/=X$/, ''), regime: ctx.regime, fundamentalRatio: ctx.fundRatio });
  const s = r.stats;
  const d = ctx.digits;
  $('lab-s-chips').innerHTML = Object.entries(STRATEGIES).map(([k, v]) => `<button class="chip" data-s="${k}" aria-pressed="${k === strategy}">${v.name}</button>`).join('');
  $('lab-s-desc').textContent = STRATEGIES[strategy].desc + (kind === 'fx' ? '（為替は「売り」から入ることもあります）' : '（株は買いだけ）');
  const nextTxt = r.next ? (r.next.type === 'open' ? `次の取引日に<b>${r.next.side > 0 ? '買い' : '売り'}</b>で入る予定（${esc(r.next.reason)}）` : `次の取引日に<b>決済</b>する予定（${esc(r.next.reason)}）`) : '';
  $('lab-s-stats').innerHTML = `
    <div class="grid2">
      <div class="stat"><div class="label">合計の損益（100万円で取引）</div><div class="value ${s.total >= 0 ? 'plus' : 'minus'}">${fmtYen(s.total)}</div></div>
      <div class="stat"><div class="label">${term('winRate', '勝率')}（${s.trades}回）</div><div class="value">${pct(s.winRate)}</div></div>
      <div class="stat"><div class="label">${term('drawdown', '一番減ったときの額')}</div><div class="value minus">${fmtYen(-s.maxDrawdown)}</div></div>
      <div class="stat"><div class="label">比較：買ってずっと持っていた場合</div><div class="value ${s.buyHold >= 0 ? 'plus' : 'minus'}">${fmtYen(s.buyHold)}</div></div>
    </div>
    <p class="small" style="margin:8px 0 0"><b>今の状態：</b>${r.open ? `${r.open.side > 0 ? '買い' : '売り'}で持っています（${esc(r.open.entryDate)}に${fmtPrice(r.open.entryPrice, d)}で入った・今の含み損益 <span class="${r.open.unreal >= 0 ? 'plus' : 'minus'}">${fmtYen(r.open.unreal)}</span>）` : '持っていません'}${nextTxt ? `<br><b>次の予定：</b>${nextTxt}` : ''}</p>
    <p class="small muted" style="margin:4px 0 0">${esc(s.from)}〜${esc(s.to)}（${r.daily.length}取引日）</p>`;

  // チャート：値段と、入った・出た場所の印
  const chart = makeChart('lab-s-chart');
  const up = cssVar('--up'), down = cssVar('--down');
  const series = chart.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, priceFormat: { type: 'price', precision: d, minMove: 10 ** -d } });
  const from = r.daily[0]?.time ?? 0;
  series.setData(ctx.candles.filter((c) => c.time >= from).map((c) => ({ time: c.time + JST, open: c.open, high: c.high, low: c.low, close: c.close })));
  const markers = [];
  for (const t of r.trades) {
    markers.push({ time: t.entryTime + JST, position: t.side > 0 ? 'belowBar' : 'aboveBar', shape: t.side > 0 ? 'arrowUp' : 'arrowDown', color: t.side > 0 ? up : down, text: '' });
    markers.push({ time: t.exitTime + JST, position: t.side > 0 ? 'aboveBar' : 'belowBar', shape: 'circle', color: t.pnl >= 0 ? '#2fb67c' : '#8b96a3', text: `${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl / 1000)}千` });
  }
  if (r.open) markers.push({ time: r.open.entryTime + JST, position: r.open.side > 0 ? 'belowBar' : 'aboveBar', shape: r.open.side > 0 ? 'arrowUp' : 'arrowDown', color: '#f2c94c', text: '保有中' });
  series.setMarkers(markers.sort((a, b) => a.time - b.time));
  chart.timeScale().fitContent();

  // 損益の推移
  const eq = makeChart('lab-eq-chart');
  eq.addBaselineSeries({ baseValue: { type: 'price', price: 0 }, topLineColor: up, bottomLineColor: down, topFillColor1: up + '33', topFillColor2: up + '05', bottomFillColor1: down + '05', bottomFillColor2: down + '33', priceLineVisible: false, priceFormat: { type: 'volume' } })
    .setData(r.daily.map((x) => ({ time: x.time + JST, value: Math.round(x.equity) })));
  eq.timeScale().fitContent();

  // 取引の一覧
  $('lab-s-trades').innerHTML = r.trades.length ? `<table class="tbl"><thead><tr><th>入った日・値段</th><th>出た日・値段</th><th class="r">損益</th></tr></thead><tbody>
    ${r.trades.slice().reverse().map((t) => `<tr>
      <td class="small"><span class="badge ${t.side > 0 ? 'buy' : 'sell'}">${t.side > 0 ? '買い' : '売り'}</span> ${esc(t.entryDate.slice(5).replace('-', '/'))}<div class="num">${fmtPrice(t.entryPrice, d)}</div><div class="muted" style="font-size:11px">${esc(t.reasonIn)}</div></td>
      <td class="small">${esc(t.exitDate.slice(5).replace('-', '/'))}（${t.days}日）<div class="num">${fmtPrice(t.exitPrice, d)}</div><div class="muted" style="font-size:11px">${esc(t.reasonOut)}</div></td>
      <td class="r small"><b class="${t.pnl >= 0 ? 'plus' : 'minus'}">${fmtYen(t.pnl)}</b><div class="muted">${(t.ret * 100).toFixed(2)}%</div></td></tr>`).join('')}</tbody></table>` : '<p class="empty">この期間は取引がありませんでした</p>';

  // 1日ずつの損益（新しい順・取引があった日は内容も表示）
  $('lab-s-daily').innerHTML = `<table class="tbl"><thead><tr><th>日付</th><th class="r">その日の損益</th><th class="r">累計</th><th>状態</th></tr></thead><tbody>
    ${r.daily.slice(-90).reverse().map((x) => `<tr>
      <td class="small">${esc(x.date.slice(5).replace('-', '/'))}</td>
      <td class="r small"><span class="${x.pnl > 0 ? 'plus' : x.pnl < 0 ? 'minus' : 'muted'}">${Math.abs(x.pnl) < 0.5 ? '0円' : fmtYen(x.pnl)}</span></td>
      <td class="r small"><span class="${x.equity >= 0 ? 'plus' : 'minus'}">${fmtYen(x.equity)}</span></td>
      <td class="small">${esc(x.holding || '—')}${x.events.length ? `<div class="muted" style="font-size:11px">${x.events.map(esc).join('<br>')}</div>` : ''}</td></tr>`).join('')}</tbody></table>`;
  return r;
}

async function prepare(st, mode) {
  const data = await api(`/api/chart?symbol=${encodeURIComponent(st.symbol)}&tf=1d`);
  if (data.candles.length < 150) throw new Error('この銘柄はデータが少なすぎて計算できません');
  const [regime, fund] = await Promise.all([
    loadRegime(),
    mode === 'fx' ? null : api(`/api/fundamentals?symbol=${encodeURIComponent(st.symbol)}&name=${encodeURIComponent(st.name || '')}`).catch(() => null),
  ]);
  const last = data.candles[data.candles.length - 1].close;
  return { symbol: data.symbol, name: st.name || data.name, mode, candles: data.candles, regime, fundRatio: fund?.rows?.length ? fund.ratio : null, digits: mode === 'stock' ? 1 : mode === 'us' ? 2 : digitsFor(last) };
}

// 成績タブの中の切り替え（今のサイン・売買の一覧・この銘柄の売買・予想の答え合わせ・銘柄選び）
let labSub = store.get('lab_sub', 'plan');
let getModeFn = () => 'fx';
let lastSt = null;

function applySub() {
  document.querySelectorAll('#lab-sub button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sub === labSub)));
  document.querySelectorAll('[data-labpanel]').forEach((el) => { el.hidden = !el.dataset.labpanel.split(' ').includes(labSub); });
  document.querySelectorAll('[data-labsub]').forEach((el) => { el.hidden = el.dataset.labsub !== labSub; });
}

export async function updateLab(st, mode) {
  if (st) lastSt = st;
  if ($('view-lab').hidden) return;
  applySub();
  if (labSub === 'plan') return showPlan(mode);
  if (labSub === 'now') return showNow(mode);
  if (labSub === 'list') return showList(mode);
  if (labSub === 'more' || !lastSt) return;
  return updateSymbol(lastSt, mode);
}

// 自動更新：今見ている画面を最新にする
export function refreshLab(mode) {
  if ($('view-lab').hidden) return;
  if (labSub === 'plan') return showPlan(mode, true);
  if (labSub === 'now') return showNow(mode, true);
  if (labSub === 'list') return showList(mode, true);
  if ((labSub === 'trade' || labSub === 'fc') && lastSt) { ctx = null; return updateSymbol(lastSt, mode, { silent: true }); }
}

async function updateSymbol(st, mode, { silent = false } = {}) {
  const key = `${st.symbol}|${mode}`;
  if (ctx && `${ctx.symbol}|${ctx.mode}` === key) return;
  $('lab-name').textContent = st.name || st.symbol;
  if (!silent) {
    $('lab-body').hidden = true;
    $('lab-status').innerHTML = '<span class="spinner"></span> 過去のデータを読み込んで計算しています…';
  }
  try {
    const next = await prepare(st, mode);
    ctx = next;
    $('lab-status').textContent = '';
    $('lab-body').hidden = false;
    renderForecast();
    renderTrades();
  } catch (e) {
    $('lab-status').innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}

// お気に入りの銘柄をまとめて計算
async function runBatch(mode) {
  const favs = getFavs(mode);
  const out = $('lab-batch');
  const rows = [];
  $('lab-batch-run').disabled = true;
  for (let i = 0; i < favs.length; i++) {
    out.innerHTML = `<p class="small muted"><span class="spinner"></span> 計算中… ${i + 1} / ${favs.length}（${esc(favs[i].name)}）</p>`;
    try {
      const c = await prepare({ symbol: favs[i].code, name: favs[i].name }, mode);
      const fc = evaluateForecasts(c.candles, { horizon: 1, days: 120 });
      const kind = kindOf(mode);
      const res = Object.keys(STRATEGIES).map((id) => runStrategy(c.candles, id, { kind, pair: c.symbol.replace(/=X$/, ''), regime: c.regime, fundamentalRatio: c.fundRatio }).stats.total);
      rows.push({ name: favs[i].name, dir: fc.stats.dirHit, tech: fc.stats.techHit, res });
    } catch (e) {
      rows.push({ name: favs[i].name, error: e.message });
    }
  }
  $('lab-batch-run').disabled = false;
  const sum = Object.keys(STRATEGIES).map((_, k) => rows.reduce((s, r) => s + (r.res ? r.res[k] : 0), 0));
  out.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>銘柄</th><th class="r">翌日の<br>的中率</th>${Object.values(STRATEGIES).map((v) => `<th class="r">${esc(v.name)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="small">${esc(r.name)}</td>${r.error ? `<td colspan="4" class="small muted">${esc(r.error)}</td>` : `<td class="r small">${pct(r.dir)}</td>${r.res.map((v) => `<td class="r small"><span class="${v >= 0 ? 'plus' : 'minus'}">${fmtYen(v)}</span></td>`).join('')}`}</tr>`).join('')}
    <tr><td class="small"><b>合計</b></td><td></td>${sum.map((v) => `<td class="r small"><b class="${v >= 0 ? 'plus' : 'minus'}">${fmtYen(v)}</b></td>`).join('')}</tr>
    </tbody></table></div>
    <p class="small muted">それぞれの銘柄を100万円ずつ、約1年間取引した場合の合計です。</p>`;
}

// ---------------- 勝率の高い銘柄だけを選んで売買 ----------------
function universe(mode) {
  const base = baseUniverse(mode);
  const favs = getFavs(mode).filter((f) => !/^\^/.test(f.code)).map((f) => [f.code, f.name]);
  const seen = new Set();
  return [...favs, ...base].filter(([c]) => (seen.has(c.toUpperCase()) ? false : seen.add(c.toUpperCase())));
}

// 銘柄ごとの日足を、3つずつ並べて取ってくる
async function loadCandles(syms, out) {
  const list = [];
  let done = 0;
  const queue = [...syms];
  const worker = async () => {
    while (queue.length) {
      const [code, name] = queue.shift();
      try {
        const d = await api(`/api/chart?symbol=${encodeURIComponent(code)}&tf=1d`);
        if (d.candles.length >= 200) list.push({ symbol: d.symbol, name, candles: d.candles, fundRatio: null });
      } catch { /* 取れない銘柄は飛ばす */ }
      done++;
      out.innerHTML = `<p class="small muted"><span class="spinner"></span> 過去のデータを読み込み中… ${done} / ${syms.length}</p>`;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return list;
}

async function runPicks(mode) {
  const out = $('lab-pick');
  const btn = $('lab-pick-run');
  btn.disabled = true;
  try {
    const regime = await loadRegime();
    const list = await loadCandles(universe(mode), out);
    out.innerHTML = '<p class="small muted"><span class="spinner"></span> 計算しています…</p>';
    await new Promise((r) => setTimeout(r, 30));
    renderPicks(pickAndTrade(list, { kind: kindOf(mode), regime }), mode);
  } catch (e) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 全銘柄の売買一覧（理由つき） ----------------
async function logUniverse(mode) {
  const syms = universe(mode);
  if (mode !== 'stock') return syms;
  // 候補チェックが終わっていれば、上がりそう・下がりそうの上位も入れる
  const seen = new Set(syms.map(([c]) => c));
  for (const view of ['buy', 'sell']) {
    try {
      const r = await api(`/api/stocks/scan?view=${view}&limit=15`);
      for (const x of r.results || []) if (!seen.has(x.code)) { seen.add(x.code); syms.push([x.code, x.name]); }
    } catch { /* チェックしていなければ使わない */ }
  }
  return syms;
}

const whyList = (arr) => (arr?.length ? `<ul class="why">${arr.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
const sideBadge = (s) => `<span class="badge ${s > 0 ? 'buy' : 'sell'}">${s > 0 ? '買い' : '売り'}</span>`;
const digitsOf = (mode) => (mode === 'stock' ? 1 : mode === 'us' ? 2 : 3);
const ymd = (x) => esc(`${Number(String(x).slice(5, 7))}/${Number(String(x).slice(8, 10))}`);

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
  const hit = logCache[mode];
  if (hit && !force && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  if (logRunning?.mode === mode) return logRunning.p;
  const p = (async () => {
    const regime = await loadRegime();
    const list = await loadCandles(await logUniverse(mode), out);
    out.innerHTML = '<p class="small muted"><span class="spinner"></span> 計算しています…</p>';
    await new Promise((r) => setTimeout(r, 30));
    const kind = kindOf(mode);
    const trades = [], holding = [], next = [];
    const prices = {};
    for (const x of list) {
      prices[x.symbol] = x.candles[x.candles.length - 1].close;
      const r = runStrategy(x.candles, 'combo', { kind, pair: x.symbol.replace(/=X$/, ''), regime });
      const last = x.candles[x.candles.length - 1];
      for (const t of r.trades) trades.push({ ...t, name: x.name, symbol: x.symbol });
      if (r.open) holding.push({ ...r.open, name: x.name, symbol: x.symbol, last: last.close });
      if (r.next) next.push({ ...r.next, name: x.name, symbol: x.symbol, open: r.open, last: last.close, date: dayKeyOf(last.time) });
    }
    // 確率：これからの売買は全部の取引から、過去の売買は「その日より前に終わった取引」だけから計算する
    for (const x of next) if (x.type === 'open') x.odds = signalOdds(trades, { symbol: x.symbol, side: x.side, strength: x.strength });
    for (const x of holding) x.odds = signalOdds(trades, { symbol: x.symbol, side: x.side, strength: x.strength, before: x.entryDate });
    for (const t of trades) t.odds = signalOdds(trades, { symbol: t.symbol, side: t.side, strength: t.strength, before: t.entryDate });
    let usdjpy = prices['USDJPY=X'] || null;
    if (!usdjpy) { try { const u = await api('/api/chart?symbol=USDJPY&tf=1d'); usdjpy = u.candles[u.candles.length - 1].close; } catch { /* 取れなければ米国株の量は出さない */ } }
    const data = { trades, holding, next, prices, usdjpy, count: list.length, at: Date.now() };
    logCache[mode] = { at: Date.now(), data };
    return data;
  })();
  logRunning = { mode, p };
  try { return await p; } finally { logRunning = null; }
}

const dayKeyOf = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);

function refreshBtn(id) {
  return `<button class="btn block" id="${id}" style="margin-top:10px">最新にする</button>`;
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
  const sz = (x, stop) => sizePosition({ mode, symbol: x.symbol, price: x.last, stop, budget, riskPct: pf.riskPct, maxPos: pf.maxPos, prices: r.prices, usdjpy: r.usdjpy });
  const opens = r.next.filter((x) => x.type === 'open').map((x) => ({ ...x, size: sz(x, x.stopEst) }))
    .sort((a, b) => (b.odds?.p || 0) - (a.odds?.p || 0));
  const good = opens.filter((x) => x.odds && x.odds.p >= minOdds && x.odds.expect > 0);
  const picks = good.filter((x) => x.size?.qty > 0).slice(0, pf.maxPos);
  const rest = opens.filter((x) => !picks.includes(x));
  const closes = r.next.filter((x) => x.type === 'close');
  const replayCard = (t, x) => `<div class="stat"><div class="label">${t}</div><div class="value ${x.total >= 0 ? 'plus' : 'minus'}">${fmtYen(x.total)}</div><div class="small muted">${x.trades}回・勝率${pct(x.winRate)}・一番減ったとき ${fmtYen(-x.maxDD)}</div></div>`;
  $('lab-plan').innerHTML = `
    ${pf.budget ? '' : '<p class="notice" style="margin:0 0 8px">予算がまだ入っていないので、100万円で計算しています。右上の⚙（設定）の「あなたの設定」で入れてください。</p>'}
    <div class="plan-rule small">予算 <b>${yen0(budget)}</b>　／　1回で減ってもいい額 <b>${yen0(budget * pf.riskPct / 100)}</b>（${pf.riskPct}%）　／　同時に <b>${pf.maxPos}銘柄</b>まで（1銘柄 ${yen0(budget / pf.maxPos)}まで）</div>
    <button class="btn block" id="plan-settings" style="margin:8px 0 4px">予算・ルールを変える</button>

    <h3>✅ 今やるといいこと<span class="sub">次の取引日の始まりに</span></h3>
    ${picks.length ? `<ul class="list">${picks.map((x) => {
      const s = x.size;
      const gain = x.takeEst ? Math.abs(x.takeEst - x.last) * s.perPrice : null;
      return `<li class="plan-pick">
        <div class="li-head"><span class="name">${esc(x.name)}</span>${sideBadge(x.side)}</div>
        <div class="plan-order"><b>${x.side > 0 ? '買う' : '売る'}：${s.qty.toLocaleString()}${s.unitLabel}</b>（今 ${fmtPrice(x.last, d)}・${s.kindLabel} 約${yen0(s.cost)}）</div>
        <div class="grid2 plan-grid">
          <div class="stat"><div class="label">損切りの値段</div><div class="value minus" style="font-size:16px">${fmtPrice(x.stopEst, d)}</div><div class="small muted">ここまで来たら決済：約−${yen0(s.maxLoss)}</div></div>
          <div class="stat"><div class="label">利益確定の目標</div><div class="value plus" style="font-size:16px">${x.takeEst ? fmtPrice(x.takeEst, d) : '—'}</div><div class="small muted">${gain ? `届いたら決済：約+${yen0(gain)}` : '判定が変わるまで持つ'}</div></div>
        </div>
        ${oddsHtml(x.odds, { compact: true })}
        <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details></li>`;
    }).join('')}</ul>` : `<p class="small muted">今は、あなたのルールに合うサインがありません（勝つ確率の目安${Math.round(minOdds * 100)}%以上・予算内で買える量があるもの）。お休みも大事なトレードです。</p>`}

    <h3>🔴 持っていたら決済した方がいいもの</h3>
    ${closes.length ? `<ul class="list">${closes.map((x) => `<li><div class="li-head"><span class="name">${esc(x.name)}</span>${x.open ? sideBadge(x.open.side) : ''}</div>
      <div class="small"><b>次の取引日の始まりに決済</b>：${esc(x.reason)}</div></li>`).join('')}</ul>` : '<p class="small muted">今はありません。</p>'}

    ${rest.length ? `<details class="why-box" style="margin-top:10px"><summary>見送ったサイン（${rest.length}件）</summary><ul class="list">${rest.map((x) => `<li class="small"><b>${esc(x.name)}</b> ${sideBadge(x.side)} 確率${x.odds ? Math.round(x.odds.p * 100) + '%' : '—'}　<span class="muted">${
      !x.odds || x.odds.p < minOdds ? `勝つ確率の目安が${Math.round(minOdds * 100)}%未満` : x.odds.expect <= 0 ? '勝っても負けても平均するとマイナス' : x.size && x.size.qty === 0 ? esc(x.size.why) : !x.size ? '量を計算できませんでした' : `同時に持つ数（${pf.maxPos}つ）を超えるため`}</span></li>`).join('')}</ul></details>` : ''}

    <h3>📊 あなたの予算で、このやり方を1年続けていたら</h3>
    <div class="grid2">${replayCard('サインが出たら全部やる', all)}${replayCard('確率の目安55%以上だけやる', picky)}</div>
    <p class="small" style="margin:6px 0 0"><b>おすすめ：</b>${usePicky ? '確率の目安が55%以上のサインだけに絞る方が成績が良かったので、上の「今やるといいこと」も55%以上に絞っています。' : '絞らずにサインどおりにやる方が成績が良かったので、50%以上のサインを出しています。'}</p>
    <p class="notice" style="margin-top:8px">過去の値動きでの計算です。日本株は100株単位、為替は1,000通貨単位・レバレッジ25倍で計算しています。手数料などは差し引いていますが、実際の値段（次の日の始まりの値段）は少しずれます。最終的な判断はご自身で行ってください。</p>
    ${refreshBtn('lab-plan-refresh')}`;
  $('lab-plan-refresh').onclick = () => showPlan(mode, true);
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
  const when = r.next[0]?.date ? `${ymd(r.next[0].date)}の終わりの値段で判断` : '';
  $('lab-now').innerHTML = `
    <h3>🟢 新しく入るサイン<span class="sub">${opens.length}件・${when}</span></h3>
    ${opens.length ? `<ul class="list">${opens.map((x) => `<li>
      <div class="li-head"><span class="name">${esc(x.name)}</span>${sideBadge(x.side)}</div>
      <div class="small"><b>次の取引日の始まりに${x.side > 0 ? '買う' : '売る'}</b>（今 ${fmtPrice(x.last, d)}）</div>
      ${oddsHtml(x.odds)}
      <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details></li>`).join('')}</ul>` : '<p class="small muted">今は新しく入るサインはありません。</p>'}
    <h3>🔴 決済するサイン<span class="sub">${closes.length}件</span></h3>
    ${closes.length ? `<ul class="list">${closes.map((x) => {
      const g = x.open ? x.open.side * (x.last / x.open.entryPrice - 1) : 0;
      return `<li><div class="li-head"><span class="name">${esc(x.name)}</span>${x.open ? sideBadge(x.open.side) : ''}<b class="${g >= 0 ? 'plus' : 'minus'}">${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%</b></div>
      <div class="small"><b>次の取引日の始まりに決済</b>：${esc(x.reason)}</div>
      ${x.open ? `<div class="small muted">${ymd(x.open.entryDate)}に${fmtPrice(x.open.entryPrice, d)}で${x.open.side > 0 ? '買い' : '売り'} → 今 ${fmtPrice(x.last, d)}</div>` : ''}
      <details class="why-box"><summary>理由を見る</summary>${whyList(x.why)}</details></li>`;
    }).join('')}</ul>` : '<p class="small muted">今は決済するサインはありません。</p>'}
    <h3>📦 今持っている銘柄<span class="sub">${r.holding.length}件</span></h3>
    ${r.holding.length ? `<ul class="list">${r.holding.map((x) => {
      const g = x.side * (x.last / x.entryPrice - 1);
      return `<li><div class="li-head"><span class="name">${esc(x.name)}</span>${sideBadge(x.side)}<b class="${g >= 0 ? 'plus' : 'minus'}">${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%</b></div>
      <div class="small">${ymd(x.entryDate)}に ${fmtPrice(x.entryPrice, d)} で${x.side > 0 ? '買い' : '売り'} → 今 ${fmtPrice(x.last, d)}</div>
      <div class="small muted">損切りの線 ${fmtPrice(x.stop, d)}${x.take ? `・利益確定の目標 ${fmtPrice(x.take, d)}` : ''}</div>
      ${oddsHtml(x.odds, { compact: true })}
      <details class="why-box"><summary>入った理由を見る</summary>${whyList(x.why)}</details></li>`;
    }).join('')}</ul>` : '<p class="small muted">今持っている銘柄はありません。</p>'}
    <p class="notice" style="margin-top:8px">「勝つ確率の目安」は過去の成績からの見積もりで、当たる保証はありません。${r.count}銘柄を計算・${new Date(r.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}時点。</p>
    ${refreshBtn('lab-now-refresh')}`;
  $('lab-now-refresh').onclick = () => showNow(mode, true);
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
    ${refreshBtn('lab-log-refresh')}`;
  $('lab-log-refresh').onclick = () => showList(mode, true);
  const draw = () => {
    const f = { all: () => true, win: (t) => t.pnl > 0, loss: (t) => t.pnl <= 0, buy: (t) => t.side > 0, sell: (t) => t.side < 0 }[logFilter];
    pagedList($('lab-log-list'), sorted.filter(f), (t) => `<li class="log-item">
      <div class="li-head"><span class="name">${esc(t.name)}</span>${sideBadge(t.side)}<b class="${t.pnl >= 0 ? 'plus' : 'minus'}" style="font-size:16px">${t.pnl >= 0 ? '勝ち ' : '負け '}${fmtYen(t.pnl)}</b></div>
      <div class="timeline">
        <div class="tl-step"><span class="tl-dot in"></span><div><b>${ymd(t.entryDate)} ${t.side > 0 ? '買った' : '売った'}</b>　<span class="num">${fmtPrice(t.entryPrice, d)}</span><div class="small muted">${esc(t.reasonIn)}</div></div></div>
        <div class="tl-step"><span class="tl-dot out"></span><div><b>${ymd(t.exitDate)} 決済</b>　<span class="num">${fmtPrice(t.exitPrice, d)}</span>（${t.days}日間・<span class="${t.ret >= 0 ? 'plus' : 'minus'}">${t.ret >= 0 ? '+' : ''}${(t.ret * 100).toFixed(1)}%</span>）<div class="small muted">${esc(t.reasonOut)}</div></div></div>
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

function renderPicks(r, mode) {
  const s = r.stats;
  const d = mode === 'stock' ? 1 : mode === 'us' ? 2 : 3;
  const md = (x) => esc(String(x).slice(5).replace('-', '/'));
  $('lab-pick').innerHTML = `
    <div class="grid2">
      <div class="stat"><div class="label">合計の損益</div><div class="value ${s.total >= 0 ? 'plus' : 'minus'}">${fmtYen(s.total)}</div></div>
      <div class="stat"><div class="label">勝率（${s.trades}回）</div><div class="value">${pct(s.winRate)}</div></div>
      <div class="stat"><div class="label">一番減ったときの額</div><div class="value minus">${fmtYen(-s.maxDrawdown)}</div></div>
      <div class="stat"><div class="label">比較：選ばずに全部で売買（3銘柄分）</div><div class="value ${s.allAvg >= 0 ? 'plus' : 'minus'}">${fmtYen(s.allAvg)}</div></div>
    </div>
    <p class="small muted" style="margin:8px 0 0">${esc(s.from)}〜${esc(s.to)}・候補${s.universe}銘柄から選択・1銘柄100万円（最大3銘柄＝300万円）</p>
    <h3>今選んでいる銘柄（これからの20日間）</h3>
    ${r.current.length ? `<ul class="list">${r.current.map((c) => `<li><div class="li-head"><span class="name">${esc(c.name)}</span><span class="badge ok">勝率${pct(c.winRate)}</span></div>
      <div class="small">過去半年 ${c.trades}回で ${fmtYen(c.pnl)}　${c.open ? `<b>${c.open.side > 0 ? '買い' : '売り'}で保有中</b>（${md(c.open.entryDate)}・${fmtPrice(c.open.entryPrice, d)}）` : '今は持っていない'}</div>
      ${c.next ? `<div class="small muted">次の取引日：${c.next.type === 'open' ? (c.next.side > 0 ? '買いで入る予定' : '売りで入る予定') : '決済する予定'}（${esc(c.next.reason)}）</div>` : ''}</li>`).join('')}</ul>`
      : '<p class="small muted">今は条件（過去半年で2回以上取引・勝率50%以上・利益あり）を満たす銘柄がないため、取引を休みます。</p>'}
    <h3>損益の推移</h3>
    <div class="lab-chart short" id="lab-pick-chart"></div>
    <h3>選んだ銘柄の移り変わり</h3>
    <div class="tbl-wrap lab-table" id="lab-pick-periods"></div>
    <h3>取引の一覧</h3>
    <div class="tbl-wrap lab-table" id="lab-pick-trades"></div>
    <h3>1日ずつの損益</h3>
    <div id="lab-pick-daily"></div>`;
  const eq = makeChart('lab-pick-chart');
  const up = cssVar('--up'), down = cssVar('--down');
  eq.addBaselineSeries({ baseValue: { type: 'price', price: 0 }, topLineColor: up, bottomLineColor: down, topFillColor1: up + '33', topFillColor2: up + '05', bottomFillColor1: down + '05', bottomFillColor2: down + '33', priceLineVisible: false, priceFormat: { type: 'volume' } })
    .setData(r.daily.map((x) => ({ time: Date.parse(x.date + 'T00:00:00Z') / 1000, value: Math.round(x.equity) })));
  eq.timeScale().fitContent();
  $('lab-pick-periods').innerHTML = `<table class="tbl"><thead><tr><th>期間</th><th>選んだ銘柄（その時点の勝率）</th></tr></thead><tbody>
    ${r.periods.slice().reverse().map((p) => `<tr><td class="small">${md(p.from)}〜${md(p.to)}</td><td class="small">${p.picks.length ? p.picks.map((x) => `${esc(x.name)}（${pct(x.winRate)}）`).join('、') : '<span class="muted">休み（条件に合う銘柄なし）</span>'}</td></tr>`).join('')}</tbody></table>`;
  $('lab-pick-trades').innerHTML = r.trades.length ? `<table class="tbl"><thead><tr><th>銘柄</th><th>入った</th><th>出た</th><th class="r">損益</th></tr></thead><tbody>
    ${r.trades.slice().sort((a, b) => b.exitDate.localeCompare(a.exitDate)).map((t) => `<tr>
      <td class="small"><b>${esc(t.name)}</b><div><span class="badge ${t.side > 0 ? 'buy' : 'sell'}">${t.side > 0 ? '買い' : '売り'}</span></div></td>
      <td class="small">${md(t.entryDate)}<div class="num">${fmtPrice(t.entryPrice, d)}</div><div class="muted" style="font-size:11px">${esc(t.reasonIn)}</div></td>
      <td class="small">${md(t.exitDate)}<div class="num">${fmtPrice(t.exitPrice, d)}</div><div class="muted" style="font-size:11px">${esc(t.reasonOut)}</div></td>
      <td class="r small"><b class="${t.pnl >= 0 ? 'plus' : 'minus'}">${fmtYen(t.pnl)}</b></td></tr>`).join('')}</tbody></table>` : '<p class="empty">取引はありませんでした</p>';
  pagedList($('lab-pick-daily'), r.daily.slice().reverse(), (x) => `<tr><td class="small">${md(x.date)}</td>
      <td class="r small"><span class="${x.pnl > 0 ? 'plus' : x.pnl < 0 ? 'minus' : 'muted'}">${Math.abs(x.pnl) < 0.5 ? '0円' : fmtYen(x.pnl)}</span></td>
      <td class="r small"><span class="${x.equity >= 0 ? 'plus' : 'minus'}">${fmtYen(x.equity)}</span></td>
      <td class="small muted" style="font-size:11px">${x.events.map(esc).join('<br>')}</td></tr>`,
  { tag: 'table', wrap: (b) => `<div class="tbl-wrap lab-table"><table class="tbl"><thead><tr><th>日付</th><th class="r">その日</th><th class="r">累計</th><th>出来事</th></tr></thead><tbody>${b}</tbody></table></div>` });
}

export function initLab(getMode) {
  getModeFn = getMode;
  $('lab-sub').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (!b) return;
    labSub = b.dataset.sub;
    store.set('lab_sub', labSub);
    updateLab(null, getMode());
  });
  $('lab-pick-run').addEventListener('click', () => runPicks(getMode()));
  $('lab-h-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-h]');
    if (!b || !ctx) return;
    horizon = Number(b.dataset.h);
    store.set('lab_h', horizon);
    renderForecast();
  });
  $('lab-s-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b || !ctx) return;
    strategy = b.dataset.s;
    store.set('lab_s', strategy);
    renderTrades();
  });
  $('lab-batch-run').addEventListener('click', () => runBatch(getMode()));
}

export function resetLab() {
  ctx = null;
}
