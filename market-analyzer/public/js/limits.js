// ストップ高・ストップ安（東京証券取引所の値幅制限）
// 1日に動ける値段の幅は、前の日の終値（基準値段）で決まる

const TABLE = [
  [100, 30], [200, 50], [500, 80], [700, 100], [1000, 150], [1500, 300], [2000, 400], [3000, 500],
  [5000, 700], [7000, 1000], [10000, 1500], [15000, 3000], [20000, 4000], [30000, 5000], [50000, 7000],
  [70000, 10000], [100000, 15000], [150000, 30000], [200000, 40000], [300000, 50000], [500000, 70000],
  [700000, 100000], [1000000, 150000], [1500000, 300000], [2000000, 400000], [3000000, 500000],
  [5000000, 700000], [7000000, 1000000], [10000000, 1500000], [15000000, 3000000], [20000000, 4000000],
  [30000000, 5000000], [50000000, 7000000], [Infinity, 10000000],
];

export function priceLimit(base) {
  for (const [under, width] of TABLE) if (base < under) return width;
  return TABLE[TABLE.length - 1][1];
}

// 基準値段（前日終値）と今の値段から、ストップ高・安の状況を出す
export function stopInfo(prevClose, price) {
  if (!(prevClose > 0) || !(price > 0)) return null;
  const width = priceLimit(prevClose);
  const up = prevClose + width, down = Math.max(1, prevClose - width);
  const change = price - prevClose;
  const ratio = change / width; // +1 でストップ高、-1 でストップ安
  let status = null;
  if (price >= up) status = 'ストップ高';
  else if (price <= down) status = 'ストップ安';
  else if (ratio >= 0.7) status = 'ストップ高に近い';
  else if (ratio <= -0.7) status = 'ストップ安に近い';
  return { base: prevClose, width, up, down, change, ratio, status };
}
