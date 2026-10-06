// チャート画面：ローソク足・指標・抵抗線・予想の表示
import { api, $, esc, store, fmtPrice, digitsFor, signalClass, JST, cssVar } from './util.js';
import { sma, bollinger, rsi, macd, ichimoku, technicalSummary } from './indicators.js';
import { supportResistance, trendlines, pivots } from './levels.js';
import { monteCarlo, futureTimes } from './forecast.js';
import { buildScenarioSeries, circled } from './scenario.js';
import { vwap } from './volume.js';
import { renderOrderflow } from './orderflow.js';
import { term } from './glossary.js';
import { stopInfo } from './limits.js';

const LC = window.LightweightCharts;

export const TF_LABELS = { '5m': '5分足', '15m': '15分足', '1h': '1時間足', '4h': '4時間足', '1d': '日足', '1wk': '週足' };
const TF_SPAN = { '5m': '約1時間40分', '15m': '約5時間', '1h': '約1日', '4h': '約3〜4日', '1d': '約1か月', '1wk': '約5か月' };
const LAYERS = [
  ['ma', '平均線'], ['bb', 'いつもの範囲'], ['ichi', '雲（一目）'], ['levels', '壁と支え'], ['trend', '流れの線'], ['pivot', '今日の目安'], ['forecast', '予想の幅'], ['ai', 'AI予想'], ['vol', '売買の量', 'stock'],
];
const SUBS = [['rsi', '買われすぎ度（RSI）'], ['macd', '勢い（MACD）'], ['none', 'なし']];

// 為替と株で、見ている銘柄・時間足を別々に覚える
const MODE_DEFAULTS = {
  fx: { symbol: 'USDJPY=X', name: 'ドル円', tf: '1h' },
  stock: { symbol: '7203.T', name: 'トヨタ自動車', tf: '1d' },
};
let mode = store.get('mode', 'fx') === 'stock' ? 'stock' : 'fx';
const saved = (k) => store.get(`${mode}_${k}`, mode === 'fx' && k !== 'tf' ? store.get(k === 'name' ? 'symbolName' : k, MODE_DEFAULTS.fx[k]) : MODE_DEFAULTS[mode][k]);

export const state = {
  symbol: saved('symbol'),
  name: saved('name'),
  tf: saved('tf'),
  layers: { ma: true, bb: false, ichi: false, levels: true, trend: true, pivot: false, forecast: true, ai: true, vol: true, ...store.get('layers', {}) },
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
  const raw = state.data.candles;
  const tf = state.tf;
  const candles = raw.map((c) => ({ ...c, time: c.time + JST }));
  const last = candles[candles.length - 1];
  const digits = mode === 'stock' ? 1 : digitsFor(last.close);
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
    legend.push(['#f2c94c', '平均線（5本）'], ['#bb6bd9', '平均線（25本）'], ['#2fb67c', '平均線（75本）']);
  }
  if (L.bb) {
    const bb = bollinger(closes);
    addLine(main, overlay, toPoints(times, bb.upper), '#56ccf2', { lineStyle: LC.LineStyle.Dotted });
    addLine(main, overlay, toPoints(times, bb.mid), '#56ccf288');
    addLine(main, overlay, toPoints(times, bb.lower), '#56ccf2', { lineStyle: LC.LineStyle.Dotted });
    legend.push(['#56ccf2', 'いつもの値動きの範囲']);
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
        title: `${lv.kind === 'resistance' ? '壁' : '支え'}${lv.strength}`,
      }));
    }
    legend.push(['#ff9f43', '上値の壁'], ['#00c2a8', '下値の支え']);
  }
  const tls = trendlines(raw);
  if (L.trend) {
    for (const t of tls) {
      addLine(main, overlay, [{ time: t.from.time + JST, value: t.from.price }, { time: t.to.time + JST, value: t.to.price }], t.kind === 'up' ? '#00c2a8' : '#ff9f43', { lineWidth: 2 });
    }
    if (tls.length) legend.push(['#ffffff99', '流れの線']);
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
    legend.push(['#f2c94c', '予想の中心'], ['#a0aec0', '予想の幅']);
  }

  // AIの理由つき予想（日足に表示）
  const sc = scenarioFor(state.symbol);
  let scenarioLen = 0;
  if (L.ai && sc && tf === '1d') {
    const built = buildScenarioSeries(sc.result, last.time, last.close);
    if (built.line.length > 1) {
      if (built.bull.length > 1) addLine(main, overlay, built.bull, up + 'aa', { lineStyle: LC.LineStyle.Dashed });
      if (built.bear.length > 1) addLine(main, overlay, built.bear, down + 'aa', { lineStyle: LC.LineStyle.Dashed });
      const ln = addLine(main, overlay, built.line, '#c084fc', { lineWidth: 3 });
      ln.setMarkers(built.markers.map((m) => ({
        time: m.time,
        position: m.position,
        shape: m.shape,
        color: m.kind === 'event' ? '#e3a008' : m.up ? up : down,
        text: m.text,
      })));
      scenarioLen = built.line.length;
      legend.push(['#c084fc', 'AI予想'], [up, '上ぶれ'], [down, '下ぶれ']);
    }
    const iv = sc.result.intervention;
    if (iv?.applicable && iv.level > 0) {
      priceLines.push(candleSeries.createPriceLine({ price: iv.level, color: '#e5484d', lineWidth: 2, lineStyle: LC.LineStyle.LargeDashed, axisLabelVisible: true, title: `介入警戒(${iv.risk})` }));
    }
  }

  // ストップ高・ストップ安の値段（株のみ）
  const si = mode === 'stock' ? stopFor(raw, tf) : null;
  if (si) {
    priceLines.push(candleSeries.createPriceLine({ price: si.up, color: up, lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: 'ストップ高' }));
    priceLines.push(candleSeries.createPriceLine({ price: si.down, color: down, lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: 'ストップ安' }));
  }

  // 出来高とVWAP（株のみ。為替は出来高がない）
  const hasVol = raw.some((c) => c.volume > 0);
  if (L.vol && hasVol) {
    const vs = main.addHistogramSeries({ priceScaleId: 'vol', priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'volume' } });
    main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vs.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: (c.close >= c.open ? up : down) + '66' })));
    overlay.push(vs);
    legend.push([up + '66', '売買の量（出来高）']);
    if (!['1d', '1wk'].includes(tf)) {
      addLine(main, overlay, toPoints(times, vwap(raw)), '#56ccf2', { lineWidth: 2 });
      legend.push(['#56ccf2', '今日の平均の買い値（VWAP）']);
    }
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
  main.timeScale().setVisibleLogicalRange({ from: candles.length - visible, to: candles.length + Math.max(L.forecast ? 22 : 4, scenarioLen + 3) });

  renderQuote(raw, digits);
  renderTech(raw);
  renderLevels(levels, tls, pv, last.close, digits);
  renderForecast(fc, digits);
  renderScenarioCard(digits);
  renderStop(raw, digits);
  renderOrderflow(state.data);
}

// ---------------- ストップ高・ストップ安 ----------------
function stopFor(candles, tf) {
  if (tf === '1wk' || candles.length < 2) return null;
  const price = candles[candles.length - 1].close;
  if (tf === '1d') return stopInfo(candles[candles.length - 2].close, price);
  // 時間足は、日本時間で前の日の最後の値段を基準値段にする
  const dayOf = (c) => new Date((c.time + JST) * 1000).toISOString().slice(0, 10);
  const today = dayOf(candles[candles.length - 1]);
  for (let i = candles.length - 2; i >= 0; i--) {
    if (dayOf(candles[i]) !== today) return stopInfo(candles[i].close, price);
  }
  return null;
}

function renderStop(candles, digits) {
  const box = $('stop-box');
  if (mode !== 'stock') return;
  const si = stopFor(candles, state.tf);
  if (!si) {
    box.innerHTML = '<p class="small muted">日足か時間足で表示すると、今日のストップ高・ストップ安の値段が出ます。</p>';
    return;
  }
  const d = Math.max(0, digits === 1 ? 0 : digits);
  const pos = Math.max(0, Math.min(100, ((si.ratio + 1) / 2) * 100));
  const status = si.status
    ? `<span class="badge ${/高/.test(si.status) ? 'buy' : 'sell'}">${esc(si.status)}</span>`
    : '<span class="badge neutral">ふつうの範囲</span>';
  box.innerHTML = `
    <div class="li-head" style="margin-bottom:6px"><span class="name small">今日の状態</span>${status}</div>
    <div class="grid2">
      <div class="stat"><div class="label">ストップ高（今日の上限）</div><div class="value plus">${fmtPrice(si.up, d)}</div></div>
      <div class="stat"><div class="label">ストップ安（今日の下限）</div><div class="value minus">${fmtPrice(si.down, d)}</div></div>
      <div class="stat"><div class="label">基準値段（前の日の終値）</div><div class="value">${fmtPrice(si.base, d)}</div></div>
      <div class="stat"><div class="label">${term('limitWidth', '1日に動ける幅')}</div><div class="value">±${fmtPrice(si.width, 0)}円</div></div>
    </div>
    <div class="stop-bar" aria-hidden="true"><span style="left:${pos}%"></span></div>
    <div class="row small muted"><span class="grow">ストップ安</span><span>前日終値</span><span class="grow" style="text-align:right">ストップ高</span></div>
    <p class="small" style="margin:8px 0 0">今日は前の日から <b class="${si.change >= 0 ? 'plus' : 'minus'}">${si.change >= 0 ? '+' : ''}${fmtPrice(si.change, d)}円</b>。動ける幅の <b>${Math.round(Math.abs(si.ratio) * 100)}%</b> まで${si.change >= 0 ? '上がって' : '下がって'}います。</p>
    <p class="notice" style="margin-top:8px">ストップ高・安が何日も続くと、幅が広げられることがあります。正確な値段は証券会社のアプリでも確認してください。</p>`;
}

// ---------------- AIの理由つき予想 ----------------
function scenarioFor(symbol) {
  return store.get('scenario_' + symbol, null);
}

function renderScenarioCard(digits) {
  const sc = scenarioFor(state.symbol);
  const box = $('scenario-box');
  // 処理中はボタンの文字が入れ替わっているので、名前の欄がないこともある
  const nameEl = $('scenario-name');
  if (nameEl) nameEl.textContent = state.name || state.symbol;
  if (!sc) {
    box.innerHTML = '';
    return;
  }
  const r = sc.result;
  // チャートの番号と同じ並び（今より後の点だけ・日付順）にする
  const raw = state.data.candles;
  const pts = buildScenarioSeries(r, raw[raw.length - 1].time + JST, raw[raw.length - 1].close).points;
  const iv = r.intervention || {};
  box.innerHTML = `
    <p class="small muted" style="margin:10px 0 4px">${esc(sc.when)} に作成（作成時の価格 ${fmtPrice(sc.price, digits)}）</p>
    ${state.tf !== '1d' ? '<p class="notice">予想の線と理由の目印は「日足」のチャートに表示されます。</p>' : ''}
    <div class="li-head" style="margin:8px 0"><span class="name">1か月の見通し</span><span class="badge ${signalClass(r.direction || '')}">${esc(r.direction || '—')}</span></div>
    <p class="small">${esc(r.summary || '')}</p>
    ${iv.applicable ? `<div class="notice" style="margin:8px 0"><b>為替介入の警戒度: <span class="${iv.risk === '高' ? 'plus' : ''}">${esc(iv.risk)}</span></b>${iv.level > 0 ? `（目安 ${fmtPrice(iv.level, digits)}・チャートに赤い点線）` : ''}<br>${esc(iv.reason || '')}</div>` : ''}
    <h3>値動きの理由（チャートの番号と対応）</h3>
    <ul class="list">${pts.map((p, i) => {
      const prev = i === 0 ? sc.price : pts[i - 1].price;
      const upMove = p.price >= prev;
      return `<li><div class="li-head"><span class="name small">${circled(i)} ${esc(p.date)}　<span class="num">${fmtPrice(p.price, digits)}</span></span><span class="badge ${upMove ? 'buy' : 'sell'}">${upMove ? '上がる' : '下がる'}</span></div>
        <div class="small"><b>${esc(p.label || '')}</b> ${esc(p.reason || '')}</div></li>`;
    }).join('')}</ul>
    ${(r.events || []).length ? `<h3>今後のイベント（チャートの黄色の四角）</h3><ul class="list">${r.events.map((e) => `<li class="small"><span class="badge ${signalClass(e.impact || '')}">${esc(e.impact)}</span> ${esc(e.date)} <b>${esc(e.name)}</b><div class="muted">${esc(e.detail || '')}</div></li>`).join('')}</ul>` : ''}
    <h3>上ぶれ・下ぶれするとき</h3>
    <p class="small"><b class="plus">上ぶれ:</b> ${esc(r.bull_reason || '')}</p>
    <p class="small"><b class="minus">下ぶれ:</b> ${esc(r.bear_reason || '')}</p>
    ${(r.key_levels || []).length ? `<h3>意識される価格</h3><ul class="list">${r.key_levels.map((k) => `<li class="small"><b class="num">${fmtPrice(Number(k.price), digits)}</b> ${esc(k.reason)}</li>`).join('')}</ul>` : ''}
    <p class="notice">AIがニュースや予定から考えた予想で、外れることがあります。急なニュースで大きく変わることもあります。</p>`;
}

async function runScenario() {
  const btn = $('scenario-run');
  btn.disabled = true;
  btn.dataset.label = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> AIがニュースと予定を調べています（1〜2分）…';
  try {
    if (state.tf !== '1d') await loadChart(state.symbol, state.name, '1d');
    const raw = state.data.candles;
    const price = raw[raw.length - 1].close;
    const d = digitsFor(price);
    const round = (v) => Number(v.toFixed(d));
    const fc = monteCarlo(raw, { horizon: 20 });
    const end = fc.bands[fc.bands.length - 1];
    const result = await api('/api/ai/scenario', {
      method: 'POST',
      body: {
        symbol: state.symbol,
        name: state.name,
        price: round(price),
        closes: raw.slice(-60).map((c) => round(c.close)),
        technical: technicalSummary(raw).label,
        levels: supportResistance(raw).map((l) => `${l.label} ${round(l.price)}(${l.strength})`),
        mc: { p05: round(end.p05), p50: round(end.p50), p95: round(end.p95) },
      },
    });
    store.set('scenario_' + state.symbol, { result, when: new Date().toLocaleString('ja-JP'), price });
    state.layers.ai = true;
    store.set('layers', state.layers);
    renderControls();
    render();
    $('chart-main').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('scenario-box').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label;
    $('scenario-name').textContent = state.name || state.symbol;
  }
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
    <p class="small muted" style="margin:0 0 6px">${term('signal', '判定の見方')}　買い ${t.rows.filter((r) => r.signal === '買い').length} ／ 売り ${t.rows.filter((r) => r.signal === '売り').length} ／ 中立 ${t.rows.filter((r) => r.signal === '中立').length}</p>
    <ul class="list">${t.rows.map((r) => `
      <li><div class="li-head"><span class="name">${term(r.key, r.name)}</span><span class="badge ${signalClass(r.signal)}">${esc(r.signal)}</span></div>
      <div class="small muted">${esc(r.detail)}</div></li>`).join('')}</ul>`;
}

function renderLevels(levels, tls, pv, price, digits) {
  const rows = levels.map((l) => `
    <li class="lv-row"><span class="badge ${l.kind === 'resistance' ? 'warn' : 'ok'}">${term(l.kind, l.label)}</span>
    <span class="num" style="font-weight:700">${fmtPrice(l.price, digits)}</span>
    <span class="small muted">強さ:${esc(l.strength)}（${l.touches}回止まった）</span></li>`);
  const near = levels.reduce((best, l) => (!best || Math.abs(l.price - price) < Math.abs(best.price - price) ? l : best), null);
  $('levels-list').innerHTML = `
    ${near ? `<p class="small" style="margin:0 0 8px">いちばん近いのは <b>${esc(near.label)} ${fmtPrice(near.price, digits)}</b>（今の値段から ${fmtPrice(Math.abs(near.price - price), digits)}）</p>` : ''}
    <p class="small muted" style="margin:0 0 6px">${term('strength', '強さの見方')}</p>
    <ul class="list">${rows.join('') || '<li class="empty">見つかりませんでした</li>'}</ul>
    ${tls.length ? `<h3>${term('trendline', '流れの線（トレンドライン）')}</h3><ul class="list">${tls.map((t) => `<li class="small">${esc(t.label)}: 今の位置 <b class="num">${fmtPrice(t.to.price, digits)}</b></li>`).join('')}</ul>` : ''}
    ${pv ? `<h3>${term('pivot', '今日の目安（ピボット）')}</h3><div class="small num">${Object.entries(pv).map(([k, v]) => `${k}: ${fmtPrice(v, digits)}`).join('　')}</div>` : ''}
    <p class="notice" style="margin-top:10px">${mode === 'fx' ? 'LION FX' : 'iSPEED'} でも、この値段に横線を引くと同じ線になります。</p>`;
}

function renderForecast(fc, digits) {
  if (!fc) { $('forecast-box').innerHTML = '<p class="empty">データが足りません</p>'; return; }
  const end = fc.bands[fc.bands.length - 1];
  const upPct = Math.round(fc.upProb * 100);
  $('forecast-box').innerHTML = `
    <div class="grid2">
      <div class="stat"><div class="label">${TF_SPAN[state.tf]}後に今より上がっている確率</div><div class="value ${upPct >= 50 ? 'plus' : 'minus'}">${upPct}%</div></div>
      <div class="stat"><div class="label">予想の中心（${TF_SPAN[state.tf]}後）</div><div class="value">${fmtPrice(end.p50, digits)}</div></div>
      <div class="stat"><div class="label">半分くらいの確率で入る範囲</div><div class="value small num">${fmtPrice(end.p25, digits)} 〜 ${fmtPrice(end.p75, digits)}</div></div>
      <div class="stat"><div class="label">ほぼ（90%）この中に入る範囲</div><div class="value small num">${fmtPrice(end.p05, digits)} 〜 ${fmtPrice(end.p95, digits)}</div></div>
    </div>
    <p class="small muted" style="margin:8px 0 0">過去の値動きのくせを使って、これからの動きを2,000通り計算した結果です。ニュースなどの急な動きは入っていません。</p>`;
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
    store.set(`${mode}_symbol`, state.symbol);
    store.set(`${mode}_name`, state.name);
    store.set(`${mode}_tf`, tf);
    if (mode === 'stock' && !name && /\.T$/.test(state.symbol)) lookupStockName(state.symbol);
    $('chart-msg').hidden = true;
    renderControls();
    render();
    listeners.forEach((fn) => fn(state));
  } catch (e) {
    $('chart-msg').hidden = false;
    $('chart-msg').textContent = e.message;
  }
}

// 株は会社名を日本語で表示する（上場企業の一覧から探す）
async function lookupStockName(symbol) {
  try {
    const code = symbol.replace(/\.T$/, '');
    const { items } = await api(`/api/stocks/search?q=${encodeURIComponent(code)}`);
    const hit = items.find((x) => x.code === code);
    if (hit && state.symbol === symbol) {
      state.name = hit.name;
      store.set(`${mode}_name`, hit.name);
      $('q-name').textContent = hit.name;
      listeners.forEach((fn) => fn(state));
    }
  } catch { /* 名前が取れなくても表示は続ける */ }
}

export function getMode() {
  return mode;
}

export function setMode(next) {
  if (next === mode) return;
  mode = next;
  store.set('mode', mode);
  state.symbol = saved('symbol');
  state.name = saved('name');
  state.tf = saved('tf');
  state.data = null;
  renderControls();
  loadChart();
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
  // ボタンは狭いので「足」を省いて短く表示する
  $('tf-seg').innerHTML = Object.entries(TF_LABELS).map(([k, v]) => `<button data-tf="${k}" aria-pressed="${k === state.tf}">${/^\d/.test(v) ? v.replace(/足$/, '') : v}</button>`).join('');
  $('layer-chips').innerHTML = LAYERS.filter(([, , only]) => !only || only === mode).map(([k, v]) => `<button class="chip" data-layer="${k}" aria-pressed="${!!state.layers[k]}">${v}</button>`).join('');
  $('sub-seg').innerHTML = SUBS.map(([k, v]) => `<button data-sub="${k}" aria-pressed="${k === state.sub}">${v}</button>`).join('');
  markFav();
}

export function initChartView() {
  initCharts();
  $('scenario-run').addEventListener('click', runScenario);
  renderControls();
  $('symbol-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let v = $('symbol-input').value.trim();
    if (!v) return;
    $('symbol-input').value = '';
    $('symbol-input').blur();
    // 株は「7203 トヨタ自動車」のような候補や、会社名でも探せる
    if (mode === 'stock') {
      const code = v.match(/^([0-9][0-9A-Za-z]{3})(\s|$)/);
      if (code) {
        v = code[1];
      } else if (!/^[\^A-Za-z0-9.=-]+$/.test(v)) {
        try {
          const { items } = await api(`/api/stocks/search?q=${encodeURIComponent(v)}`);
          if (!items.length) { $('chart-msg').hidden = false; $('chart-msg').textContent = `「${v}」に当てはまる会社が見つかりませんでした`; return; }
          return loadChart(`${items[0].code}.T`, items[0].name);
        } catch (err) { $('chart-msg').hidden = false; $('chart-msg').textContent = err.message; return; }
      }
    }
    const fav = [...document.querySelectorAll('#fav-chips .chip')].find((b) => b.dataset.code.toUpperCase() === v.toUpperCase());
    loadChart(v, fav?.dataset.name);
  });
  // 株は入力中に候補を出す
  let timer;
  $('symbol-input').addEventListener('input', () => {
    if (mode !== 'stock') return;
    clearTimeout(timer);
    const q = $('symbol-input').value.trim();
    if (!q || /^[0-9][0-9A-Za-z]{3} /.test(q)) return;
    timer = setTimeout(async () => {
      try {
        const { items } = await api(`/api/stocks/search?q=${encodeURIComponent(q)}`);
        $('symbol-list').innerHTML = items.map((x) => `<option value="${esc(x.code)} ${esc(x.name)}">${esc(x.market)}・${esc(x.sector)}</option>`).join('');
      } catch { /* 候補が出せなくても入力はできる */ }
    }, 250);
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
