// あなたの予算に合わせて「どれだけ買うか」「損切りはどこか」を計算する
// ・1回の取引で減ってもいい額 ＝ 予算 × リスク（%）
// ・1銘柄に使うお金の上限 ＝ 予算 ÷ 同時に持つ数
// ・日本株は100株単位、米国株は1株単位、為替は1,000通貨単位（証拠金はレバレッジ25倍で計算）

export const FX_LEVERAGE = 25;

// ---------------- レバレッジ ----------------
// あなたの設定のレバレッジ（日本株は現物＝1倍か信用で最大3.3倍、米国株は最大2倍、為替は最大25倍）
export const LEV_LIMIT = { stock: 3.3, us: 2, fx: 25 };
// ロスカット（強制決済）になる目安：口座のお金が、取引している金額のこの割合を下回ると強制決済
// 日本株の信用は保証金維持率20%、米国株の信用は25%、為替（国内FX）は証拠金維持率100%（＝取引金額の4%）
export const MAINT = { stock: 0.2, us: 0.25, fx: 1 / FX_LEVERAGE };
export function levFor(profile, mode) {
  const v = Number(profile?.[{ stock: 'levStock', us: 'levUs', fx: 'levFx' }[mode]]);
  return Math.max(1, Math.min(LEV_LIMIT[mode] || 1, Number.isFinite(v) && v > 0 ? v : 1));
}
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
export function sizePosition({ mode, symbol, price, stop, budget, riskPct, maxPos, prices = {}, usdjpy = null, leverage = null }) {
  const riskYen = budget * riskPct / 100;
  // 1銘柄に使えるお金。レバレッジをかけると、その倍の金額まで取引できる
  const lev = leverage ?? (mode === 'fx' ? FX_LEVERAGE : 1);
  const cap = (budget / maxPos) * lev;
  const dist = Math.abs(price - stop);
  if (!(price > 0) || !(dist > 0)) return null;
  let unit, unitLabel, costPerUnit, lossPerUnit, kindLabel;
  if (mode === 'stock') {
    unit = 100; unitLabel = '株'; kindLabel = lev > 1 ? '必要な保証金（信用）' : '必要なお金';
    costPerUnit = price * 100; lossPerUnit = dist * 100;
  } else if (mode === 'us') {
    if (!usdjpy) return null;
    unit = 1; unitLabel = '株'; kindLabel = lev > 1 ? '必要な保証金（信用）' : '必要なお金';
    costPerUnit = price * usdjpy; lossPerUnit = dist * usdjpy;
  } else {
    const q = quoteToJpy(symbol, prices);
    if (!q) return null;
    unit = 1000; unitLabel = '通貨'; kindLabel = '必要な証拠金';
    costPerUnit = price * 1000 * q; lossPerUnit = dist * 1000 * q;
  }
  const byRisk = Math.floor(riskYen / lossPerUnit);
  const byCash = Math.floor(cap / costPerUnit);
  const n = Math.min(byRisk, byCash);
  // 実際に必要なお金：現物は取引する金額そのもの、信用・為替は取引する金額 ÷ レバレッジ（為替は国内の決まりで25倍で計算）
  const need = (x) => (mode === 'fx' ? x / FX_LEVERAGE : x / lev);
  const res = { unit, unitLabel, kindLabel, costPerUnit, lossPerUnit, riskYen, cap, lev };
  if (n < 1) {
    return { ...res, qty: 0, why: byCash < 1 ? `最低${unit.toLocaleString()}${unitLabel}で${Math.round(need(costPerUnit)).toLocaleString()}円必要（1銘柄に使える${Math.round(cap / lev).toLocaleString()}円${lev > 1 ? `×レバレッジ${lev}倍` : ''}を超える）` : `損切りまでの幅が大きく、最低${unit.toLocaleString()}${unitLabel}でも${Math.round(lossPerUnit).toLocaleString()}円減る可能性がある（1回で減ってもいい${Math.round(riskYen).toLocaleString()}円を超える）` };
  }
  return { ...res, qty: n * unit, cost: need(n * costPerUnit), notional: n * costPerUnit, maxLoss: n * lossPerUnit, perPrice: (n * lossPerUnit) / dist };
}

/**
 * 過去1年の取引を、あなたの予算・ルールでやり直したらどうなったか
 * trades: { entryDate, exitDate, ret, stopPct, odds? }
 */
export function replayWithBudget(trades, { budget, riskPct, maxPos, minOdds = 0, leverage = 0, maint = 0 }) {
  // leverage を入れると「1銘柄に 予算÷同時に持つ数 × レバレッジ の金額で入る」計算にする（損切りの幅で量を減らさない）
  const list = trades.filter((t) => !minOdds || (t.odds && t.odds.p >= minOdds)).slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const open = [];
  let equity = 0, peak = 0, maxDD = 0, taken = 0, wins = 0, skipped = 0, losscuts = 0, broke = false;
  const settle = (upTo) => {
    open.sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    while (open.length && (upTo == null || open[0].exitDate <= upTo)) {
      const x = open.shift();
      equity += x.yen;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak - equity);
      if (budget + equity <= 0) broke = true;
    }
  };
  for (const t of list) {
    settle(t.entryDate);
    if (broke) break;
    if (open.length >= maxPos) { skipped++; continue; }
    const alloc = budget / maxPos;
    let yen;
    if (leverage) {
      const notional = alloc * leverage;
      // 持っている間に一番不利だったとき、その銘柄に分けたお金が「維持率」を割ったらロスカット
      const limit = -alloc + notional * maint; // これより損が大きくなると強制決済（マイナスの数）
      if (t.mae != null && notional * t.mae <= limit) { yen = limit; losscuts++; } else yen = t.ret * notional;
    } else {
      const size = Math.min(alloc, t.stopPct > 0 ? (budget * riskPct / 100) / t.stopPct : alloc);
      yen = t.ret * size;
    }
    open.push({ ...t, yen });
    taken++;
    if (yen > 0) wins++;
  }
  settle(null);
  return { total: equity, pct: budget ? equity / budget : 0, trades: taken, winRate: taken ? wins / taken : null, maxDD, skipped, losscuts, broke };
}
