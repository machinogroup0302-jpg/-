// 予想チャート（モンテカルロ・シミュレーション）
// 過去の値動き（変化率）をランダムに並べ替えて将来の道筋を何千回も作り、
// 「この範囲に入る可能性が高い」という幅を出す。当たる保証はありません。

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function monteCarlo(candles, { horizon = 20, paths = 2000, lookback = 250, block = 5, seed = 42 } = {}) {
  const closes = candles.map((c) => c.close).slice(-lookback - 1);
  if (closes.length < 30) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));

  // 直近の勢い（傾き）を少しだけ反映し、残りは平均ゼロに近づける
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const recent = rets.slice(-20);
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const drift = mean * 0.5 + recentMean * 0.2;
  const centered = rets.map((r) => r - mean + drift);

  const rand = mulberry32(seed);
  const last = closes[closes.length - 1];
  const sims = Array.from({ length: horizon }, () => new Float64Array(paths));
  for (let p = 0; p < paths; p++) {
    let lp = 0;
    let h = 0;
    while (h < horizon) {
      // 連続した数本をまとめて使い、値動きの癖（勢いの続きやすさ）を残す
      const start = Math.floor(rand() * (centered.length - block));
      for (let b = 0; b < block && h < horizon; b++, h++) {
        lp += centered[start + b];
        sims[h][p] = last * Math.exp(lp);
      }
    }
  }

  const bands = sims.map((arr) => {
    const s = Array.from(arr).sort((a, b) => a - b);
    return { p05: quantile(s, 0.05), p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p95: quantile(s, 0.95) };
  });
  const finalArr = Array.from(sims[horizon - 1]);
  const upProb = finalArr.filter((v) => v > last).length / paths;
  return { last, bands, upProb };
}

// 将来の足の時刻（土日を飛ばす）
export function futureTimes(candles, horizon, tf) {
  const step = candles.length > 1 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 3600;
  const unit = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1wk': 604800 }[tf] || step;
  const out = [];
  let t = candles[candles.length - 1].time;
  while (out.length < horizon) {
    t += unit;
    const day = new Date(t * 1000).getUTCDay();
    if (tf !== '1wk' && (day === 0 || day === 6)) continue;
    out.push(t);
  }
  return out;
}
