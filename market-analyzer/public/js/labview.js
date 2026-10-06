// 「成績」タブ：予想の答え合わせ（1日ずつ）と、自動売買の練習（3つの戦略）
import { api, $, esc, store, fmtPrice, digitsFor, fmtYen, cssVar, JST } from './util.js';
import { term } from './glossary.js';
import { evaluateForecasts } from './backtest.js';
import { runStrategy, regimeLookup, STRATEGIES } from './strategies.js';
import { futureTimes } from './forecast.js';
import { getFavs } from './favorites.js';

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

export async function updateLab(st, mode) {
  if ($('view-lab').hidden) return;
  const key = `${st.symbol}|${mode}`;
  if (ctx && `${ctx.symbol}|${ctx.mode}` === key) return;
  $('lab-name').textContent = st.name || st.symbol;
  $('lab-body').hidden = true;
  $('lab-status').innerHTML = '<span class="spinner"></span> 過去のデータを読み込んで計算しています…';
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

export function initLab(getMode) {
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
