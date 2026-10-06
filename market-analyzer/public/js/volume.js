// 出来高を使った「注文・約定」の分析（株向け。為替は出来高データがないため対象外）

// 価格帯別出来高：どの値段でたくさん売買されたか
export function volumeProfile(candles, bins = 24) {
  const withVol = candles.filter((c) => c.volume > 0);
  if (withVol.length < 5) return null;
  const lo = Math.min(...withVol.map((c) => c.low)), hi = Math.max(...withVol.map((c) => c.high));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const rows = Array.from({ length: bins }, (_, i) => ({ from: lo + i * step, to: lo + (i + 1) * step, buy: 0, sell: 0 }));
  for (const c of withVol) {
    const { buy, sell } = splitVolume(c);
    // 足の高値〜安値の範囲に、出来高を均等に配る
    const a = Math.max(0, Math.floor((c.low - lo) / step));
    const b = Math.min(bins - 1, Math.floor((c.high - lo) / step));
    const n = b - a + 1;
    for (let i = a; i <= b; i++) {
      rows[i].buy += buy / n;
      rows[i].sell += sell / n;
    }
  }
  rows.forEach((r) => { r.total = r.buy + r.sell; r.mid = (r.from + r.to) / 2; });
  const total = rows.reduce((s, r) => s + r.total, 0);
  const poc = rows.reduce((best, r) => (r.total > best.total ? r : best), rows[0]);
  // 出来高の70%が集まる価格帯（バリューエリア）
  const sorted = rows.slice().sort((x, y) => y.total - x.total);
  let acc = 0;
  const inArea = new Set();
  for (const r of sorted) {
    if (acc >= total * 0.7) break;
    acc += r.total;
    inArea.add(r);
  }
  const area = [...inArea];
  return {
    rows,
    poc,
    valueHigh: Math.max(...area.map((r) => r.to)),
    valueLow: Math.min(...area.map((r) => r.from)),
    total,
  };
}

// 1本の足の出来高を、終値の位置から買いと売りに分けて推定する
// （終値が高値に近いほど買いが多かったとみなす）
export function splitVolume(c) {
  const range = c.high - c.low;
  const ratio = range > 0 ? (c.close - c.low) / range : 0.5;
  return { buy: c.volume * ratio, sell: c.volume * (1 - ratio) };
}

// 買いと売りの勢い（足ごとの差と、その積み上げ）
export function buySellPressure(candles) {
  let cum = 0;
  return candles.map((c) => {
    const { buy, sell } = splitVolume(c);
    cum += buy - sell;
    return { time: c.time, buy, sell, delta: buy - sell, cum };
  });
}

// VWAP（出来高で重みを付けた平均値段）。日本時間の1日ごとにリセットする
export function vwap(candles, offsetSec = 9 * 3600) {
  let day = null, pv = 0, vol = 0;
  return candles.map((c) => {
    const d = Math.floor((c.time + offsetSec) / 86400);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * (c.volume || 0);
    vol += c.volume || 0;
    return vol > 0 ? pv / vol : null;
  });
}

// 出来高が平均の何倍か（急増した足を探す）
export function volumeSpikes(candles, lookback = 20, factor = 2.5) {
  const out = [];
  for (let i = lookback; i < candles.length; i++) {
    let s = 0;
    for (let j = i - lookback; j < i; j++) s += candles[j].volume || 0;
    const avg = s / lookback;
    if (avg > 0 && candles[i].volume >= avg * factor) out.push({ i, time: candles[i].time, ratio: candles[i].volume / avg, up: candles[i].close >= candles[i].open });
  }
  return out;
}

// 板・歩み値（AIが画像から読み取ったもの）の集計
export function summarizeTicks(ticks) {
  const byPrice = new Map();
  let buy = 0, sell = 0;
  for (const t of ticks) {
    if (!(t.qty > 0)) continue;
    const r = byPrice.get(t.price) || { price: t.price, buy: 0, sell: 0, other: 0 };
    if (t.side === '買い') { r.buy += t.qty; buy += t.qty; }
    else if (t.side === '売り') { r.sell += t.qty; sell += t.qty; }
    else r.other += t.qty;
    byPrice.set(t.price, r);
  }
  const rows = [...byPrice.values()].sort((a, b) => b.price - a.price);
  const sizes = ticks.map((t) => t.qty).filter((q) => q > 0).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const big = ticks.filter((t) => median > 0 && t.qty >= median * 5);
  return { rows, buy, sell, big };
}
