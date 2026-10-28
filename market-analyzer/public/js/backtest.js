// 予想の答え合わせ（1日ずつ）
// その日までのデータだけを使って予想を出し直し、そのあと実際にどう動いたかと比べる。
// 予想の計算は毎回同じ結果になる（乱数の種が決まっている）ので、過去の予想も、まだ結果が出ていない最近の予想も同じ方法で並べられる。
import { monteCarlo } from './forecast.js';
import { technicalSummary } from './indicators.js';

export function dayKey(time) {
  return new Date((time + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

// horizon: 何本先（日足なら何営業日先）の値段を予想するか / days: 何日分答え合わせするか
export function evaluateForecasts(candles, { horizon = 1, days = 120, paths = 500, minHistory = 120 } = {}) {
  const rows = [];
  const start = Math.max(minHistory, candles.length - days - horizon);
  for (let i = start; i < candles.length; i++) {
    const past = candles.slice(0, i + 1);
    const fc = monteCarlo(past, { horizon, paths, seed: 42 + i });
    if (!fc) continue;
    const band = fc.bands[horizon - 1];
    const base = candles[i].close;
    const tech = technicalSummary(past.slice(-200));
    // 上がる・下がるの予想は、テクニカルのサイン（「あなた専用」のプランと同じ考え方）で出す。
    // サインがはっきりしない日は「どちらとも言えない」として、当たり外れに数えない（コインを投げるのと同じになるため）
    const predUp = tech.ratio >= 0.15 ? true : tech.ratio <= -0.15 ? false : null;
    const strong = Math.abs(tech.ratio || 0) >= 0.5;
    const row = {
      date: dayKey(candles[i].time),
      time: candles[i].time,
      base,
      center: band.p50, low90: band.p05, high90: band.p95, low50: band.p25, high50: band.p75,
      upProb: fc.upProb,
      predUp,
      strong,
      tech: tech.label,
      targetTime: candles[i + horizon]?.time ?? null,
      actual: null,
    };
    const target = candles[i + horizon];
    if (target) {
      row.actual = target.close;
      row.targetDate = dayKey(target.time);
      row.dirHit = predUp == null ? null : (target.close >= base) === predUp;
      row.in90 = target.close >= band.p05 && target.close <= band.p95;
      row.in50 = target.close >= band.p25 && target.close <= band.p75;
      row.error = (target.close - band.p50) / base;
      const techUp = /買い/.test(tech.label), techDown = /売り/.test(tech.label);
      row.techHit = techUp ? target.close > base : techDown ? target.close < base : null;
    }
    rows.push(row);
  }
  const done = rows.filter((r) => r.actual != null);
  const rate = (list, key) => (list.length ? list.filter((r) => r[key]).length / list.length : null);
  const techRows = done.filter((r) => r.techHit != null);
  const called = done.filter((r) => r.dirHit != null);
  const strongRows = called.filter((r) => r.strong);
  return {
    horizon,
    rows,
    stats: {
      count: done.length,
      pending: rows.length - done.length,
      // サインが出た日だけの的中率（何日サインが出たか）と、強いサインの日だけの的中率
      dirHit: rate(called, 'dirHit'),
      calls: called.length,
      strongHit: rate(strongRows, 'dirHit'),
      strongCount: strongRows.length,
      in90: rate(done, 'in90'),
      in50: rate(done, 'in50'),
      avgError: done.length ? done.reduce((s, r) => s + Math.abs(r.error), 0) / done.length : null,
      techCount: techRows.length,
      techHit: rate(techRows, 'techHit'),
      // 何も考えずに「上がる」と言い続けた場合（比べるための目安）
      alwaysUp: done.length ? done.filter((r) => r.actual >= r.base).length / done.length : null,
    },
  };
}
