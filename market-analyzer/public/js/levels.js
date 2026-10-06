// サポート・レジスタンス・トレンドラインの自動検出
import { atr } from './indicators.js';

// 左右 k 本より高い（安い）足を山（谷）とする
export function swings(candles, k = 3) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      // 同じ値が並んだときは、最後の足を山（谷）とする
      if (j < i ? candles[j].high > candles[i].high : candles[j].high >= candles[i].high) isHigh = false;
      if (j < i ? candles[j].low < candles[i].low : candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

// 近い価格の山・谷をまとめて「何度も止められた価格帯」を探す
export function supportResistance(candles, { k = 3, maxEach = 3 } = {}) {
  if (candles.length < 30) return [];
  const a = atr(candles).filter((v) => v != null);
  const tol = (a[a.length - 1] || candles[candles.length - 1].close * 0.003) * 0.6;
  const price = candles[candles.length - 1].close;
  const { highs, lows } = swings(candles, k);
  const points = [...highs.map((p) => ({ ...p, t: 'h' })), ...lows.map((p) => ({ ...p, t: 'l' }))].sort((x, y) => x.price - y.price);

  const clusters = [];
  for (const p of points) {
    const c = clusters[clusters.length - 1];
    if (c && p.price - c.max <= tol) {
      c.pts.push(p);
      c.max = p.price;
    } else {
      clusters.push({ pts: [p], max: p.price });
    }
  }

  const n = candles.length;
  const levels = clusters.map((c) => {
    const avg = c.pts.reduce((s, p) => s + p.price, 0) / c.pts.length;
    const recency = Math.max(...c.pts.map((p) => p.i)) / n; // 新しいほど重視
    const touches = c.pts.length;
    return { price: avg, touches, score: touches + recency * 1.5, lastTime: Math.max(...c.pts.map((p) => p.time)) };
  });

  const above = levels.filter((l) => l.price > price).sort((x, y) => y.score - x.score).slice(0, maxEach);
  const below = levels.filter((l) => l.price <= price).sort((x, y) => y.score - x.score).slice(0, maxEach);
  const strength = (l) => (l.touches >= 3 ? '強' : l.touches === 2 ? '中' : '弱');
  return [
    ...above.map((l) => ({ ...l, kind: 'resistance', label: 'レジスタンス', strength: strength(l) })),
    ...below.map((l) => ({ ...l, kind: 'support', label: 'サポート', strength: strength(l) })),
  ].sort((x, y) => y.price - x.price);
}

// 直近の谷どうし・山どうしを結んでトレンドラインを作る
export function trendlines(candles, k = 4) {
  const { highs, lows } = swings(candles, k);
  const out = [];
  const n = candles.length;
  const build = (pts, kind) => {
    for (let a = pts.length - 2; a >= Math.max(0, pts.length - 6); a--) {
      const p1 = pts[a], p2 = pts[pts.length - 1];
      if (p2.i - p1.i < 5) continue;
      const slope = (p2.price - p1.price) / (p2.i - p1.i);
      if (kind === 'up' && slope <= 0) continue;
      if (kind === 'down' && slope >= 0) continue;
      // 線を大きく割り込んだ足があれば無効
      let broken = 0;
      for (let i = p1.i; i < n; i++) {
        const y = p1.price + slope * (i - p1.i);
        if (kind === 'up' && candles[i].close < y) broken++;
        if (kind === 'down' && candles[i].close > y) broken++;
      }
      if (broken > (n - p1.i) * 0.08) continue;
      const endI = n - 1;
      out.push({
        kind,
        label: kind === 'up' ? '上昇トレンドライン' : '下降トレンドライン',
        from: { time: p1.time, price: p1.price },
        to: { time: candles[endI].time, price: p1.price + slope * (endI - p1.i) },
      });
      return;
    }
  };
  build(lows, 'up');
  build(highs, 'down');
  return out;
}

// 前の足（日足なら前日）の高値・安値・終値から計算するピボット
export function pivots(prev) {
  const p = (prev.high + prev.low + prev.close) / 3;
  return {
    R2: p + (prev.high - prev.low),
    R1: 2 * p - prev.low,
    P: p,
    S1: 2 * p - prev.high,
    S2: p - (prev.high - prev.low),
  };
}
