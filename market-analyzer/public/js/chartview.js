// チャート画面：ローソク足・指標・抵抗線・予想の表示
import { api, $, esc, store, fmtPrice, digitsFor, signalClass, JST, cssVar } from './util.js';
import { sma, bollinger, rsi, macd, ichimoku, technicalSummary } from './indicators.js';
import { supportResistance, trendlines, pivots } from './levels.js';
import { monteCarlo, futureTimes } from './forecast.js';

const LC = window.LightweightCharts;

export const TF_LABELS = { '5m': '5分', '15m': '15分', '1h': '1時間', '4h': '4時間', '1d': '日足', '1wk': '週足' };
const TF_SPAN = { '5m': '約1時間40分', '15m': '約5時間', '1h': '約1日', '4h': '約3〜4日', '1d': '約1か月', '1wk': '約5か月' };
const LAYERS = [
  ['ma', '移動平均'], ['bb', 'ボリンジャー'], ['ichi', '一目均衡表'], ['levels', '抵抗線・支持線'], ['trend', 'トレンドライン'], ['pivot', 'ピボット'], ['forecast', '予想'],
];
const SUBS = [['rsi', 'RSI'], ['macd', 'MACD'], ['none', 'なし']];

export const state = {
  symbol: store.get('symbol', 'USDJPY=X'),
  name: store.get('symbolName', 'ドル円'),
  tf: store.get('tf', '1h'),
  layers: store.get('layers', { ma: true, bb: false, ichi: false, levels: true, trend: true, pivot: false, forecast: true }),
  sub: store.get('sub', 'rsi'),
  data: null,
};

const listeners = [];
export function onSymbolChange(fn) { listeners.push(fn); }

let main, sub, candleSeries, overlay = [], priceLines = [], subSeries = [];

function themeOpts() {
  const text = cssVar('--muted'), grid = cssVar('--border'), bg = cssVar('--surface');
  return {
    layout: { background: { type: 'solid', color: bg }, textColor: text, fontSize: 11 },
    grid: { vertLines: { color: grid + '55' }, horzLines: { color: grid + '55' } },
    rightPriceScale: { borderColor: grid },
    timeScale: { borderColor: grid },
  };
}

function initCharts() {
  main = LC.createChart($('chart-main'), {
    autoSize: true,
    ...themeOpts(),
    crosshair: { mode: LC.CrosshairMode.Normal },
    timeScale: { ...themeOpts().timeScale, timeVisible: true, secondsVisible: false, rightOffset: 4 },
    localization: { locale: 'ja-JP' },
    handleScale: { axisPressedMouseMove: { time: true, price: true } },
  });
  sub = LC.createChart($('chart-sub'), {
    autoSize: true,
    ...themeOpts(),
    timeScale: { visible: false },
    handleScroll: false,
    handleScale: false,
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { ...themeOpts().rightPriceScale, minimumWidth: 70 },
    localization: { locale: 'ja-JP' },
  });
  main.applyOptions({ rightPriceScale: { ...themeOpts().rightPriceScale, minimumWidth: 70 } });
  main.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r) sub.timeScale().setVisibleLogicalRange(r); });
}

export function refreshTheme() {
  if (!main) return;
  main.applyOptions(themeOpts());
  sub.applyOptions(themeOpts());
  if (state.data) render();
}

function clearOverlays() {
  overlay.forEach((s) => main.removeSeries(s));
  overlay = [];
  priceLines.forEach((p) => candleSeries.removePriceLine(p));
  priceLines = [];
  subSeries.forEach((s) => sub.removeSeries(s));
  subSeries = [];
}

function addLine(chart, list, points, color, opts = {}) {
  const s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts });
  s.setData(points);
  list.push(s);
  return s;
}

const toPoints = (times, values) => times.map((time, i) => (values[i] == null ? { time } : { time, value: values[i] }));

function render() {
  const { candles: raw, tf } = state.data;
  const candles = raw.map((c) => ({ ...c, time: c.time + JST }));
  const last = candles[candles.length - 1];
  const digits = digitsFor(last.close);
  const up = cssVar('--up'), down = cssVar('--down');

  if (candleSeries) {
    clearOverlays();
    main.removeSeries(candleSeries);
  }
  candleSeries = main.addCandlestickSeries({
    upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
    priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits },
  });
  candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

  const times = candles.map((c) => c.time);
  const closes = candles.map((c) => c.close);
  const legend = [];
  const L = state.layers;

  if (L.ma) {
    addLine(main, overlay, toPoints(times, sma(closes, 5)), '#f2c94c');
    addLine(main, overlay, toPoints(times, sma(closes, 25)), '#bb6bd9');
    addLine(main, overlay, toPoints(times, sma(closes, 75)), '#2fb67c');
    legend.push(['#f2c94c', '平均5'], ['#bb6bd9', '平均25'], ['#2fb67c', '平均75']);
  }
  if (L.bb) {
    const bb = bollinger(closes);
    addLine(main, overlay, toPoints(times, bb.upper), '#56ccf2', { lineStyle: LC.LineStyle.Dotted });
    addLine(main, overlay, toPoints(times, bb.mid), '#56ccf288');
    addLine(main, overlay, toPoints(times, bb.lower), '#56ccf2', { lineStyle: LC.LineStyle.Dotted });
    legend.push(['#56ccf2', 'ボリンジャー±2σ']);
  }
  if (L.ichi) {
    const ich = ichimoku(candles);
    const fut = futureTimes(candles, ich.shift, tf);
    const shifted = [...times.slice(ich.shift), ...fut];
    addLine(main, overlay, toPoints(times, ich.tenkan), '#eb5757');
    addLine(main, overlay, toPoints(times, ich.kijun), '#2d9cdb');
    addLine(main, overlay, toPoints(shifted, ich.spanA), '#27ae6099', { lineWidth: 2 });
    addLine(main, overlay, toPoints(shifted, ich.spanB), '#9b51e099', { lineWidth: 2 });
    legend.push(['#eb5757', '転換線'], ['#2d9cdb', '基準線'], ['#27ae60', '先行A'], ['#9b51e0', '先行B']);
  }

  const levels = supportResistance(raw);
  if (L.levels) {
    for (const lv of levels) {
      priceLines.push(candleSeries.createPriceLine({
        price: lv.price,
        color: lv.kind === 'resistance' ? '#ff9f43' : '#00c2a8',
        lineWidth: lv.strength === '強' ? 2 : 1,
        lineStyle: lv.strength === '弱' ? LC.LineStyle.Dotted : LC.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${lv.kind === 'resistance' ? 'R' : 'S'}${lv.strength}`,
      }));
    }
    legend.push(['#ff9f43', 'レジスタンス'], ['#00c2a8', 'サポート']);
  }
  const tls = trendlines(raw);
  if (L.trend) {
    for (const t of tls) {
      addLine(main, overlay, [{ time: t.from.time + JST, value: t.from.price }, { time: t.to.time + JST, value: t.to.price }], t.kind === 'up' ? '#00c2a8' : '#ff9f43', { lineWidth: 2 });
    }
    if (tls.length) legend.push(['#ffffff99', 'トレンドライン']);
  }

  const pv = pivotFor(raw, tf);
  if (L.pivot && pv) {
    for (const [k, v] of Object.entries(pv)) {
      priceLines.push(candleSeries.createPriceLine({ price: v, color: '#a0aec0', lineWidth: 1, lineStyle: LC.LineStyle.SparseDotted, axisLabelVisible: false, title: k }));
    }
  }

  const fc = monteCarlo(raw, { horizon: 20 });
  if (L.forecast && fc) {
    const fut = futureTimes(candles, 20, tf);
    const start = { time: last.time, value: last.close };
    const band = (key) => [start, ...fut.map((time, i) => ({ time, value: fc.bands[i][key] }))];
    addLine(main, overlay, band('p95'), '#a0aec088', { lineStyle: LC.LineStyle.Dotted });
    addLine(main, overlay, band('p75'), '#f2c94caa', { lineStyle: LC.LineStyle.Dashed });
    addLine(main, overlay, band('p50'), '#f2c94c', { lineWidth: 2, lineStyle: LC.LineStyle.Dashed });
    addLine(main, overlay, band('p25'), '#f2c94caa', { lineStyle: LC.LineStyle.Dashed });
    addLine(main, overlay, band('p05'), '#a0aec088', { lineStyle: LC.LineStyle.Dotted });
    legend.push(['#f2c94c', '予想の中心'], ['#a0aec0', '予想の幅(90%)']);
  }

  // 下のサブチャート
  $('chart-sub').hidden = state.sub === 'none';
  if (state.sub === 'rsi') {
    const s = addLine(sub, subSeries, toPoints(times, rsi(closes)), '#bb6bd9', { lastValueVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
    s.createPriceLine({ price: 70, color: '#ff9f43', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
    s.createPriceLine({ price: 30, color: '#00c2a8', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
  } else if (state.sub === 'macd') {
    const m = macd(closes);
    const h = sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } });
    h.setData(times.map((time, i) => (m.hist[i] == null ? { time } : { time, value: m.hist[i], color: m.hist[i] >= 0 ? up + '99' : down + '99' })));
    subSeries.push(h);
    addLine(sub, subSeries, toPoints(times, m.line), '#56ccf2');
    addLine(sub, subSeries, toPoints(times, m.signal), '#ff9f43');
  }

  $('legend').innerHTML = legend.map(([c, l]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join('');
  const visible = Math.min(candles.length, window.innerWidth < 600 ? 90 : 160);
  main.timeScale().setVisibleLogicalRange({ from: candles.length - visible, to: candles.length + (L.forecast ? 22 : 4) });

  renderQuote(raw, digits);
  renderTech(raw);
  renderLevels(levels, tls, pv, last.close, digits);
  renderForecast(fc, digits);
}

function pivotFor(candles, tf) {
  if (tf === '1wk' || candles.length < 3) return null;
  if (tf === '1d') return pivots(candles[candles.length - 2]);
  // 時間足は日本時間の日ごとにまとめて、前日の高値・安値・終値を使う
  const days = new Map();
  for (const c of candles) {
    const d = new Date((c.time + JST) * 1000).toISOString().slice(0, 10);
    const cur = days.get(d);
    if (!cur) days.set(d, { high: c.high, low: c.low, close: c.close });
    else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; }
  }
  const list = [...days.values()];
  return list.length >= 2 ? pivots(list[list.length - 2]) : null;
}

function renderQuote(candles, digits) {
  const last = candles[candles.length - 1], prev = candles[candles.length - 2] || last;
  const diff = last.close - prev.close;
  $('q-name').textContent = state.name || state.symbol;
  $('q-price').textContent = fmtPrice(last.close, digits);
  $('q-change').innerHTML = `<span class="${diff >= 0 ? 'plus' : 'minus'}">${diff >= 0 ? '+' : ''}${fmtPrice(diff, digits)}（${((diff / prev.close) * 100).toFixed(2)}%）</span> <span class="small muted">前の足比</span>`;
}

function renderTech(candles) {
  const t = technicalSummary(candles);
  $('tech-tf').textContent = TF_LABELS[state.tf];
  if (!t.rows.length) { $('tech-summary').innerHTML = '<p class="empty">データが足りません</p>'; return; }
  const pos = ((t.ratio + 1) / 2) * 100;
  $('tech-summary').innerHTML = `
    <div class="gauge"><span class="big ${signalClass(t.label) === 'buy' ? 'plus' : signalClass(t.label) === 'sell' ? 'minus' : ''}">${esc(t.label)}</span>
      <div class="meter" aria-hidden="true"><span style="left:${pos}%"></span></div></div>
    <p class="small muted" style="margin:0 0 6px">買い ${t.rows.filter((r) => r.signal === '買い').length} ／ 売り ${t.rows.filter((r) => r.signal === '売り').length} ／ 中立 ${t.rows.filter((r) => r.signal === '中立').length}</p>
    <ul class="list">${t.rows.map((r) => `
      <li><div class="li-head"><span class="name">${esc(r.name)}</span><span class="badge ${signalClass(r.signal)}">${esc(r.signal)}</span></div>
      <div class="small muted">${esc(r.detail)}</div></li>`).join('')}</ul>`;
}

function renderLevels(levels, tls, pv, price, digits) {
  const rows = levels.map((l) => `
    <li class="lv-row"><span class="badge ${l.kind === 'resistance' ? 'warn' : 'ok'}">${esc(l.label)}</span>
    <span class="num" style="font-weight:700">${fmtPrice(l.price, digits)}</span>
    <span class="small muted">強さ:${esc(l.strength)}（${l.touches}回）</span></li>`);
  const near = levels.reduce((best, l) => (!best || Math.abs(l.price - price) < Math.abs(best.price - price) ? l : best), null);
  $('levels-list').innerHTML = `
    ${near ? `<p class="small" style="margin:0 0 8px">いちばん近いのは <b>${esc(near.label)} ${fmtPrice(near.price, digits)}</b>（現在値から ${fmtPrice(Math.abs(near.price - price), digits)}）</p>` : ''}
    <ul class="list">${rows.join('') || '<li class="empty">見つかりませんでした</li>'}</ul>
    ${tls.length ? `<h3>トレンドライン</h3><ul class="list">${tls.map((t) => `<li class="small">${esc(t.label)}: 今の位置 <b class="num">${fmtPrice(t.to.price, digits)}</b></li>`).join('')}</ul>` : ''}
    ${pv ? `<h3>ピボット（前日基準）</h3><div class="small num">${Object.entries(pv).map(([k, v]) => `${k}: ${fmtPrice(v, digits)}`).join('　')}</div>` : ''}
    <p class="notice" style="margin-top:10px">iSPEED や LION FX でも、この価格に水平線を引くと同じ線になります。</p>`;
}

function renderForecast(fc, digits) {
  if (!fc) { $('forecast-box').innerHTML = '<p class="empty">データが足りません</p>'; return; }
  const end = fc.bands[fc.bands.length - 1];
  const upPct = Math.round(fc.upProb * 100);
  $('forecast-box').innerHTML = `
    <div class="grid2">
      <div class="stat"><div class="label">20本先に上がっている確率</div><div class="value ${upPct >= 50 ? 'plus' : 'minus'}">${upPct}%</div></div>
      <div class="stat"><div class="label">予想の中心（${TF_SPAN[state.tf]}後）</div><div class="value">${fmtPrice(end.p50, digits)}</div></div>
      <div class="stat"><div class="label">50%の確率で入る範囲</div><div class="value small num">${fmtPrice(end.p25, digits)} 〜 ${fmtPrice(end.p75, digits)}</div></div>
      <div class="stat"><div class="label">90%の確率で入る範囲</div><div class="value small num">${fmtPrice(end.p05, digits)} 〜 ${fmtPrice(end.p95, digits)}</div></div>
    </div>
    <p class="small muted" style="margin:8px 0 0">過去の値動きのパターンを使って2,000通りの未来をシミュレーションした結果です。ニュースや指標発表などの突発的な動きは含まれません。</p>`;
}

export async function loadChart(symbol = state.symbol, name, tf = state.tf) {
  $('chart-msg').hidden = false;
  $('chart-msg').textContent = '読み込み中…';
  try {
    const data = await api(`/api/chart?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
    if (!data.candles?.length) throw new Error('データがありません（市場が休みの可能性があります）');
    const changed = data.symbol !== state.symbol;
    state.symbol = data.symbol;
    state.name = name || (changed ? data.name : state.name) || data.symbol;
    state.tf = tf;
    state.data = data;
    store.set('symbol', state.symbol);
    store.set('symbolName', state.name);
    store.set('tf', tf);
    $('chart-msg').hidden = true;
    renderControls();
    render();
    listeners.forEach((fn) => fn(state));
  } catch (e) {
    $('chart-msg').hidden = false;
    $('chart-msg').textContent = e.message;
  }
}

export function renderFavorites(favs) {
  $('fav-chips').innerHTML = favs.map((f) => `<button class="chip" data-code="${esc(f.code)}" data-name="${esc(f.name)}">${esc(f.name)}</button>`).join('');
  $('symbol-list').innerHTML = favs.map((f) => `<option value="${esc(f.code)}">${esc(f.name)}</option>`).join('');
  markFav();
}

function markFav() {
  document.querySelectorAll('#fav-chips .chip').forEach((b) => {
    const code = b.dataset.code.toUpperCase();
    b.setAttribute('aria-pressed', String(state.symbol === code || state.symbol === `${code}=X` || state.symbol === `${code}.T`));
  });
}

function renderControls() {
  $('tf-seg').innerHTML = Object.entries(TF_LABELS).map(([k, v]) => `<button data-tf="${k}" aria-pressed="${k === state.tf}">${v}</button>`).join('');
  $('layer-chips').innerHTML = LAYERS.map(([k, v]) => `<button class="chip" data-layer="${k}" aria-pressed="${!!state.layers[k]}">${v}</button>`).join('');
  $('sub-seg').innerHTML = SUBS.map(([k, v]) => `<button data-sub="${k}" aria-pressed="${k === state.sub}">${v}</button>`).join('');
  markFav();
}

export function initChartView() {
  initCharts();
  renderControls();
  $('symbol-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('symbol-input').value.trim();
    if (!v) return;
    const fav = [...document.querySelectorAll('#fav-chips .chip')].find((b) => b.dataset.code.toUpperCase() === v.toUpperCase());
    loadChart(v, fav?.dataset.name);
    $('symbol-input').value = '';
    $('symbol-input').blur();
  });
  $('fav-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (b) loadChart(b.dataset.code, b.dataset.name);
  });
  $('tf-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) loadChart(state.symbol, state.name, b.dataset.tf);
  });
  $('layer-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.layers[b.dataset.layer] = !state.layers[b.dataset.layer];
    store.set('layers', state.layers);
    renderControls();
    if (state.data) render();
  });
  $('sub-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.sub = b.dataset.sub;
    store.set('sub', state.sub);
    renderControls();
    if (state.data) render();
  });
}
