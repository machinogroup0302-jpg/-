// あなたの予算に合わせて「どれだけ買うか」「損切りはどこか」を計算する
// ・1回の取引で減ってもいい額 ＝ 予算 × リスク（%）
// ・1銘柄に使うお金の上限 ＝ 予算 ÷ 同時に持つ数
// ・日本株は100株単位、米国株は1株単位、為替は1,000通貨単位（証拠金はレバレッジ25倍で計算）

export const FX_LEVERAGE = 25;
const CCY = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'ZAR', 'MXN', 'TRY', 'CNH', 'HKD', 'SGD', 'NOK', 'SEK'];

// 為替：値段の単位（決済通貨）が1動いたら何円か。例：EURUSD → USDJPY の値段
export function quoteToJpy(symbol, prices) {
  const code = symbol.replace(/=X$/, '');
  const quote = code.slice(3, 6);
  if (quote === 'JPY') return 1;
  const direct = prices[`${quote}JPY=X`];
  if (direct) return direct;
  const inv = prices[`JPY${quote}=X`];
  return inv ? 1 / inv : null;
}

/**
 * @param {object} p { mode, symbol, price, stop, side, budget, riskPct, maxPos, prices, usdjpy }
 */
export function sizePosition({ mode, symbol, price, stop, budget, riskPct, maxPos, prices = {}, usdjpy = null }) {
  const riskYen = budget * riskPct / 100;
  const cap = budget / maxPos;
  const dist = Math.abs(price - stop);
  if (!(price > 0) || !(dist > 0)) return null;
  let unit, unitLabel, costPerUnit, lossPerUnit, kindLabel;
  if (mode === 'stock') {
    unit = 100; unitLabel = '株'; kindLabel = '必要なお金';
    costPerUnit = price * 100; lossPerUnit = dist * 100;
  } else if (mode === 'us') {
    if (!usdjpy) return null;
    unit = 1; unitLabel = '株'; kindLabel = '必要なお金';
    costPerUnit = price * usdjpy; lossPerUnit = dist * usdjpy;
  } else {
    const q = quoteToJpy(symbol, prices);
    if (!q) return null;
    unit = 1000; unitLabel = '通貨'; kindLabel = '必要な証拠金';
    costPerUnit = (price * 1000 * q) / FX_LEVERAGE; lossPerUnit = dist * 1000 * q;
  }
  const byRisk = Math.floor(riskYen / lossPerUnit);
  const byCash = Math.floor(cap / costPerUnit);
  const n = Math.min(byRisk, byCash);
  const res = { unit, unitLabel, kindLabel, costPerUnit, lossPerUnit, riskYen, cap };
  if (n < 1) {
    return { ...res, qty: 0, why: byCash < 1 ? `最低${unit.toLocaleString()}${unitLabel}で${Math.round(costPerUnit).toLocaleString()}円必要（1銘柄に使える${Math.round(cap).toLocaleString()}円を超える）` : `損切りまでの幅が大きく、最低${unit.toLocaleString()}${unitLabel}でも${Math.round(lossPerUnit).toLocaleString()}円減る可能性がある（1回で減ってもいい${Math.round(riskYen).toLocaleString()}円を超える）` };
  }
  return { ...res, qty: n * unit, cost: n * costPerUnit, maxLoss: n * lossPerUnit, perPrice: (n * lossPerUnit) / dist };
}

/**
 * 過去1年の取引を、あなたの予算・ルールでやり直したらどうなったか
 * trades: { entryDate, exitDate, ret, stopPct, odds? }
 */
export function replayWithBudget(trades, { budget, riskPct, maxPos, minOdds = 0 }) {
  const list = trades.filter((t) => !minOdds || (t.odds && t.odds.p >= minOdds)).slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const open = [];
  let equity = 0, peak = 0, maxDD = 0, taken = 0, wins = 0, skipped = 0;
  const closed = [];
  for (const t of list) {
    // その日までに終わった取引を閉じる
    for (let i = open.length - 1; i >= 0; i--) if (open[i].exitDate <= t.entryDate) { closed.push(open[i]); open.splice(i, 1); }
    closed.sort((a, b) => a.exitDate.localeCompare(b.exitDate)).forEach((x) => { equity += x.yen; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity); });
    closed.length = 0;
    if (open.length >= maxPos) { skipped++; continue; }
    const size = Math.min(budget / maxPos, t.stopPct > 0 ? (budget * riskPct / 100) / t.stopPct : budget / maxPos);
    const yen = t.ret * size;
    open.push({ ...t, yen });
    taken++;
    if (t.ret > 0) wins++;
  }
  open.sort((a, b) => a.exitDate.localeCompare(b.exitDate)).forEach((x) => { equity += x.yen; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity); });
  return { total: equity, pct: budget ? equity / budget : 0, trades: taken, winRate: taken ? wins / taken : null, maxDD, skipped };
}
