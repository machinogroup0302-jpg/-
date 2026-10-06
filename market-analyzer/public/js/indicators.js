// テクニカル指標の計算と、売買サインの一覧づくり
// candles: [{ time, open, high, low, close, volume }]（古い順）

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (prev == null) {
      if (i >= n - 1) {
        let s = 0, ok = true;
        for (let j = i - n + 1; j <= i; j++) { if (values[j] == null) { ok = false; break; } s += values[j]; }
        if (ok) prev = s / n;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

export function bollinger(values, n = 20, mult = 2) {
  const mid = sma(values, n);
  const upper = [], lower = [];
  for (let i = 0; i < values.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
  }
  return { mid, upper, lower };
}

export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast), s = ema(values, slow);
  const line = values.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

export function stochastic(candles, k = 14, d = 3) {
  const kv = candles.map((_, i) => {
    if (i < k - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - k + 1; j <= i; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
    return hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  });
  const dv = kv.map((_, i) => {
    if (i < k - 1 + d - 1) return null;
    let s = 0;
    for (let j = i - d + 1; j <= i; j++) s += kv[j];
    return s / d;
  });
  return { k: kv, d: dv };
}

export function atr(candles, n = 14) {
  const tr = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  const out = new Array(candles.length).fill(null);
  let prev = null;
  for (let i = 0; i < tr.length; i++) {
    if (i === n - 1) { prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n; out[i] = prev; }
    else if (i >= n) { prev = (prev * (n - 1) + tr[i]) / n; out[i] = prev; }
  }
  return out;
}

// 一目均衡表（先行スパンは26本先にずらす前提で、ここではずらす前の値を返す）
export function ichimoku(candles, a = 9, b = 26, c = 52) {
  const mid = (i, n) => {
    if (i < n - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
    return (hi + lo) / 2;
  };
  const tenkan = candles.map((_, i) => mid(i, a));
  const kijun = candles.map((_, i) => mid(i, b));
  const spanA = candles.map((_, i) => (tenkan[i] != null && kijun[i] != null ? (tenkan[i] + kijun[i]) / 2 : null));
  const spanB = candles.map((_, i) => mid(i, c));
  return { tenkan, kijun, spanA, spanB, shift: b };
}

const last = (arr, back = 0) => arr[arr.length - 1 - back];

// 各指標のサインを「買い / 売り / 中立」で一覧にする
export function technicalSummary(candles) {
  if (candles.length < 60) return { rows: [], score: 0, label: 'データ不足' };
  const closes = candles.map((c) => c.close);
  const price = last(closes);
  const rows = [];
  const add = (key, name, signal, detail, value) => rows.push({ key, name, signal, detail, value });

  const s25 = sma(closes, 25), s75 = sma(closes, 75);
  if (last(s25) != null) {
    add('ma', '最近の平均値段との比較', price > last(s25) ? '買い' : '売り', price > last(s25) ? '今の値段が、最近25本の平均より高い（上向きの流れ）' : '今の値段が、最近25本の平均より低い（下向きの流れ）', last(s25));
  }
  if (last(s75) != null && last(s25) != null) {
    const gc = last(s25, 1) <= last(s75, 1) && last(s25) > last(s75);
    const dc = last(s25, 1) >= last(s75, 1) && last(s25) < last(s75);
    add('cross', '短期と長期の平均線', last(s25) > last(s75) ? '買い' : '売り',
      gc ? '短い期間の平均線が長い期間の平均線を上に抜けた（ゴールデンクロス＝上がり始めのサイン）' : dc ? '短い期間の平均線が長い期間の平均線を下に抜けた（デッドクロス＝下がり始めのサイン）' : last(s25) > last(s75) ? '短い期間の平均が長い期間の平均より上（上向きが続いている）' : '短い期間の平均が長い期間の平均より下（下向きが続いている）');
  }

  const r = last(rsi(closes));
  if (r != null) {
    add('rsi', '買われすぎ・売られすぎ度', r < 30 ? '買い' : r > 70 ? '売り' : '中立',
      r < 30 ? '売られすぎ。そろそろ上がり返しやすい' : r > 70 ? '買われすぎ。そろそろ下がり返しやすい' : r >= 50 ? '買う人がやや多い' : '売る人がやや多い', r);
  }

  const m = macd(closes);
  if (last(m.line) != null && last(m.signal) != null) {
    const crossUp = last(m.line, 1) <= last(m.signal, 1) && last(m.line) > last(m.signal);
    const crossDown = last(m.line, 1) >= last(m.signal, 1) && last(m.line) < last(m.signal);
    add('macd', '勢いの変化', last(m.line) > last(m.signal) ? '買い' : '売り',
      crossUp ? '上がる勢いに切り替わったところ' : crossDown ? '下がる勢いに切り替わったところ' : last(m.line) > last(m.signal) ? '上がる勢いが続いている' : '下がる勢いが続いている', last(m.line));
  }

  const bb = bollinger(closes);
  if (last(bb.upper) != null) {
    const pos = (price - last(bb.lower)) / (last(bb.upper) - last(bb.lower));
    add('bb', 'いつもの値動きの範囲', pos < 0.05 ? '買い' : pos > 0.95 ? '売り' : '中立',
      pos < 0.05 ? 'いつもの範囲の下の端。下がりすぎ' : pos > 0.95 ? 'いつもの範囲の上の端。上がりすぎ' : `いつもの範囲の中で、下から${Math.round(pos * 100)}%の位置`, pos);
  }

  const st = stochastic(candles);
  if (last(st.k) != null && last(st.d) != null) {
    const k = last(st.k), d = last(st.d);
    add('stoch', '最近の値幅の中での位置', k < 20 && k > d ? '買い' : k > 80 && k < d ? '売り' : '中立',
      k < 20 ? '最近の値幅の底のあたり（売られすぎ）' : k > 80 ? '最近の値幅の天井のあたり（買われすぎ）' : '最近の値幅の真ん中あたり', k);
  }

  const ich = ichimoku(candles);
  const i0 = candles.length - 1 - ich.shift; // 今のローソク足の位置にある雲
  if (i0 >= 0 && ich.spanA[i0] != null && ich.spanB[i0] != null) {
    const top = Math.max(ich.spanA[i0], ich.spanB[i0]), bottom = Math.min(ich.spanA[i0], ich.spanB[i0]);
    add('cloud', '雲との位置関係', price > top ? '買い' : price < bottom ? '売り' : '中立',
      price > top ? '値段が雲より上（上向きの流れ）' : price < bottom ? '値段が雲より下（下向きの流れ）' : '値段が雲の中（どちらに行くか迷っている）');
  }
  if (last(ich.tenkan) != null && last(ich.kijun) != null) {
    add('ichimoku', '短期と中期の流れ', last(ich.tenkan) > last(ich.kijun) ? '買い' : last(ich.tenkan) < last(ich.kijun) ? '売り' : '中立',
      last(ich.tenkan) > last(ich.kijun) ? '短期の流れが中期の流れより強い（上向き）' : '短期の流れが中期の流れより弱い（下向き）');
  }

  // 直近20本の高値・安値ブレイク
  const recent = candles.slice(-21, -1);
  const hi = Math.max(...recent.map((c) => c.high)), lo = Math.min(...recent.map((c) => c.low));
  add('breakout', '最近の高値・安値の突破', price > hi ? '買い' : price < lo ? '売り' : '中立',
    price > hi ? '最近20本の一番高い値段を超えた（上に抜けた）' : price < lo ? '最近20本の一番安い値段を下回った（下に抜けた）' : '最近20本の高値と安値の間で動いている');

  const score = rows.reduce((s, r2) => s + (r2.signal === '買い' ? 1 : r2.signal === '売り' ? -1 : 0), 0);
  const ratio = score / rows.length;
  const label = ratio >= 0.5 ? '強い買い' : ratio >= 0.15 ? '買い' : ratio <= -0.5 ? '強い売り' : ratio <= -0.15 ? '売り' : '中立';
  return { rows, score, ratio, label };
}
