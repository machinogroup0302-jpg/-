// あなたの予算に合わせて「どれだけ買うか」「損切りはどこか」を計算する
// ・1回の取引で減ってもいい額 ＝ 予算 × リスク（%）
// ・1銘柄に使うお金の上限 ＝ 予算 ÷ 同時に持つ数
// ・日本株は100株単位、米国株は1株単位、為替は1,000通貨単位（証拠金はレバレッジ25倍で計算）

export const FX_LEVERAGE = 25;

// ---------------- 取引のしかた ----------------
// 日本株・米国株は「現物」か「信用」か（信用なら、使えるお金の約3.3倍・米国株は約2倍まで買える）
// 為替は「1回に何ロット取引するか」（空欄＝おまかせ：損切りの幅から量を計算）。証拠金は国内の決まりで25倍
export const LEV_LIMIT = { stock: 3.3, us: 2, fx: 25 };
// ロスカット（強制決済）になる目安：口座のお金が、取引している金額のこの割合を下回ると強制決済
// 日本株の信用は保証金維持率20%、米国株の信用は25%、為替（国内FX）は証拠金維持率100%（＝取引金額の4%）
export const MAINT = { stock: 0.2, us: 0.25, fx: 1 / FX_LEVERAGE };
export function levFor(profile, mode) {
  if (mode === 'fx') return FX_LEVERAGE;
  const v = Number(profile?.[mode === 'us' ? 'levUs' : 'levStock']);
  return v > 1 ? LEV_LIMIT[mode] || 1 : 1;
}
// sizePosition に渡す「取引のしかた」
export function sizeOpts(profile, mode) {
  const o = { leverage: levFor(profile, mode) };
  if (mode === 'fx' && Number(profile?.fxLots) > 0) { o.fxLots = Number(profile.fxLots); o.fxLotSize = Number(profile.fxLotSize) || 10000; }
  return o;
}
// 予算：現物の予算と、信用・空売りの予算（信用口座の保証金）。信用の予算が空なら、現物と同じお金から使う
export function budgets(pf) {
  const cash = Number(pf?.budget) || 1_000_000;
  const sep = Number(pf?.marginBudget) > 0;
  const margin = sep ? Number(pf.marginBudget) : cash;
  return { cash, margin, sep, total: sep ? cash + margin : cash };
}

// 買うときの口座：'cash'（現物）・'margin'（信用）・'mix'（現物で買える分は現物、足りない分は信用）
export function acctOf(profile, mode) {
  if (mode === 'fx') return 'fx';
  const a = mode === 'us' ? profile?.usAcct : profile?.stockAcct;
  if (a === 'cash' || a === 'margin' || a === 'mix') return a;
  if (a === 'both') return 'mix';
  return Number(mode === 'us' ? profile?.levUs : profile?.levStock) > 1 ? 'margin' : 'cash';
}
// 予算のうち、現物に使うお金と信用（保証金）に使うお金（候補の一覧で使う）
export function splitBudget(profile, mode, budget) {
  const a = acctOf(profile, mode);
  if (a === 'cash' || a === 'fx') return { cash: budget, margin: 0 };
  if (a === 'margin') return { cash: 0, margin: budget };
  return { cash: budget, margin: budget };
}
// どちら向きの売買をするか：'both'・'long'（買いだけ）・'short'（売りだけ）
export function sidesFor(profile, mode) {
  if (mode === 'fx') return ['both', 'long', 'short'].includes(profile?.fxSides) ? profile.fxSides : 'both';
  if (mode === 'us') return 'long';
  if (['both', 'long', 'short'].includes(profile?.stockSides)) return profile.stockSides;
  return profile?.stockShort ? 'both' : 'long';
}
export const SIDES_TEXT = { both: '買いも売りも', long: '買いだけ', short: '売りだけ' };
// 信用の金利・貸株料（1年あたりの目安。楽天証券の制度信用くらい）
export const CARRY = { long: 0.028, short: 0.011 };

// やり方に合わせて「どの口座で・どれだけ」入るか
export function sizeFor(profile, mode, side, args) {
  if (mode === 'fx') { const z = sizePosition({ ...args, mode, ...sizeOpts(profile, mode), riskBudget: args.riskBase }); return z && { ...z, lotSize: Number(profile?.fxLotSize) || 10000 }; }
  const acct = acctOf(profile, mode);
  const L = LEV_LIMIT[mode];
  // args.budget は現物の予算。信用・空売りの予算が別にあれば、そちらを信用の上限に使う（1回で減ってもいい額は合計から）
  const sep = Number(profile?.marginBudget) > 0;
  const mb = args.marginCap ?? (sep ? Number(profile.marginBudget) : args.budget);
  const riskBase = args.riskBase ?? (sep ? args.budget + mb : args.budget);
  const cashZ = () => { const z = sizePosition({ ...args, mode, budget: riskBase, capBudget: args.budget, leverage: 1 }); return z && { ...z, acct: 'cash', acctText: '現物' }; };
  const marginZ = () => { const z = sizePosition({ ...args, mode, budget: riskBase, capBudget: mb, leverage: L }); return z && { ...z, acct: 'margin', acctText: '信用' }; };
  if (side < 0) {
    if (mode !== 'stock' || !profile?.stockShort) return { qty: 0, why: mode === 'us' ? '米国株は空売りしない計算です' : 'このやり方では空売りしません' };
    return marginZ();
  }
  if (acct === 'margin') return marginZ();
  const c = cashZ();
  if (acct !== 'mix') return c;
  const m = marginZ();
  if (!(m?.qty > 0) || (c?.qty > 0 && m.qty <= c.qty)) return c;
  if (!(c?.qty > 0)) return m;
  // 現物で買える分は現物、足りない分は信用で買い足す
  // 信用の分の保証金は、現物で買った株を担保（代用・評価は8割）にして出す
  const per = m.notional / m.qty;
  const maxExtra = Math.floor((((sep ? mb / (args.maxPos || 3) : 0) + c.notional * 0.8) * L) / per / m.unit) * m.unit;
  const extra = Math.min(m.qty - c.qty, maxExtra);
  if (!(extra > 0)) return c;
  const qty = c.qty + extra;
  return { ...m, acct: 'mix', acctText: '現物＋信用', qty, cashQty: c.qty, marginQty: extra, notional: qty * per, cost: c.cost, maxLoss: (m.maxLoss / m.qty) * qty, perPrice: (m.perPrice / m.qty) * qty,
    kindLabel: '必要なお金（現物の分。信用の分は、買った株を担保にします）' };
}
// 「現物で買う：100株」「信用で空売り：100株」「2ロット（20,000通貨）買う」のような書き方
export function orderText(side, s) {
  const amount = s.lots ? `${s.lots}ロット（${s.qty.toLocaleString()}${s.unitLabel}）` : s.lotSize ? `${Math.round((s.qty / s.lotSize) * 10) / 10}ロット（${s.qty.toLocaleString()}${s.unitLabel}）` : `${s.qty.toLocaleString()}${s.unitLabel}`;
  if (!s.acct) return `${side > 0 ? '買う' : '売る'}：${amount}`;
  if (s.acct === 'mix') return `現物で買う：${s.cashQty.toLocaleString()}${s.unitLabel}＋信用で買う：${s.marginQty.toLocaleString()}${s.unitLabel}（合計${s.qty.toLocaleString()}${s.unitLabel}）`;
  return `${s.acctText}で${side > 0 ? '買う' : '空売り'}：${amount}`;
}
export const kindText = (profile, mode) => {
  if (mode === 'fx') return `${Number(profile?.fxLots) > 0 ? `毎回${profile.fxLots}ロット（1ロット＝${(Number(profile.fxLotSize) || 10000).toLocaleString()}通貨）` : 'ロット数はおまかせ'}・${SIDES_TEXT[sidesFor(profile, mode)]}`;
  const acct = acctOf(profile, mode), sides = sidesFor(profile, mode);
  const w = WAYS[mode].find((x) => x.long === acct && x.sides === sides && !!x.short === (mode === 'stock' && !!profile?.stockShort));
  return w ? w.label : acct === 'cash' ? '現物' : '信用';
};
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
export function sizePosition({ mode, symbol, price, stop, budget, riskPct, maxPos, prices = {}, usdjpy = null, leverage = null, fxLots = 0, fxLotSize = 10000, capBudget = null, riskBudget = null }) {
  const riskYen = (riskBudget ?? budget) * riskPct / 100;
  // 1銘柄に使えるお金。レバレッジをかけると、その倍の金額まで取引できる
  const lev = leverage ?? (mode === 'fx' ? FX_LEVERAGE : 1);
  const cap = ((capBudget ?? budget) / maxPos) * lev;
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
  // 為替でロット数を決めているとき：その量で取引し、証拠金が足りるか・損切りでいくら減るかを出す
  if (mode === 'fx' && fxLots > 0) {
    const qty = Math.round(fxLots * fxLotSize);
    const k = qty / unit;
    const notional = k * costPerUnit, maxLoss = k * lossPerUnit, cost = notional / FX_LEVERAGE;
    const res = { unit, unitLabel, kindLabel, costPerUnit, lossPerUnit, riskYen, cap, lev: FX_LEVERAGE, lots: fxLots, effLev: budget ? notional / budget : null };
    if (cost > budget / maxPos) return { ...res, qty: 0, why: `${fxLots}ロットだと証拠金が約${Math.round(cost).toLocaleString()}円必要（1銘柄に使える${Math.round(budget / maxPos).toLocaleString()}円を超える）` };
    return { ...res, qty, cost, notional, maxLoss, perPrice: maxLoss / dist, over: maxLoss > riskYen };
  }
  const byRisk = Math.floor(riskYen / lossPerUnit);
  const byCash = Math.floor(cap / costPerUnit);
  const n = Math.min(byRisk, byCash);
  // 実際に必要なお金：現物は取引する金額そのもの、信用・為替は取引する金額 ÷ レバレッジ（為替は国内の決まりで25倍で計算）
  const need = (x) => (mode === 'fx' ? x / FX_LEVERAGE : x / lev);
  const res = { unit, unitLabel, kindLabel, costPerUnit, lossPerUnit, riskYen, cap, lev };
  if (n < 1) {
    return { ...res, qty: 0, why: byCash < 1 ? `最低${unit.toLocaleString()}${unitLabel}で${Math.round(need(costPerUnit)).toLocaleString()}円必要（1銘柄に使える${lev > 1 ? (mode === 'fx' ? '証拠金の範囲' : '保証金の範囲') : `${Math.round(cap).toLocaleString()}円`}を超える）` : `損切りまでの幅が大きく、最低${unit.toLocaleString()}${unitLabel}でも${Math.round(lossPerUnit).toLocaleString()}円減る可能性がある（1回で減ってもいい${Math.round(riskYen).toLocaleString()}円を超える）` };
  }
  return { ...res, qty: n * unit, cost: need(n * costPerUnit), notional: n * costPerUnit, maxLoss: n * lossPerUnit, perPrice: (n * lossPerUnit) / dist };
}

/**
 * 過去1年の取引を、あなたの予算・ルールでやり直したらどうなったか
 * trades: { entryDate, exitDate, ret, stopPct, odds? }
 */
export function replayWithBudget(trades, { budget, riskPct, maxPos, minOdds = 0, leverage = 0, maint = 0, notionalOf = null, capLev = 1, carry = null, acct = null }) {
  // leverage を入れると「1銘柄に 予算÷同時に持つ数 × レバレッジ の金額で入る」計算にする（損切りの幅で量を減らさない）
  const list = trades.filter((t) => !minOdds || (t.odds && t.odds.p >= minOdds)).slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const open = [];
  let equity = 0, peak = 0, maxDD = 0, taken = 0, wins = 0, skipped = 0, losscuts = 0, broke = false, longYen = 0, shortYen = 0, longN = 0, shortN = 0;
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
  const base = { leverage, maint, notionalOf, capLev, carry, acct };
  const log = [];
  for (const t of list) {
    settle(t.entryDate);
    if (broke) break;
    if (open.length >= maxPos) { skipped++; continue; }
    const alloc = budget / maxPos;
    // 取引ごとに条件が違うとき（月ごとにやり方を変える練習など）は、その取引の条件を使う
    const { leverage, maint, notionalOf, capLev, carry, acct } = t.__o ? { ...base, ...t.__o } : base;
    let yen;
    if (leverage || notionalOf) {
      // notionalOf があれば、その取引の金額（為替で毎回同じロット数など）
      const notional = notionalOf ? notionalOf(t) : alloc * leverage;
      // 証拠金（保証金）が足りなくて、そもそも入れない取引は飛ばす
      if (!(notional > 0) || notional * maint >= alloc) { skipped++; continue; }
      // 持っている間に一番不利だったとき、その銘柄に分けたお金が「維持率」を割ったらロスカット
      const limit = -alloc + notional * maint; // これより損が大きくなると強制決済（マイナスの数）
      if (t.mae != null && notional * t.mae <= limit) { yen = limit; losscuts++; } else yen = t.ret * notional;
      if (carry && t.exitTime && t.entryTime) yen -= notional * (t.side < 0 ? carry.short : carry.long) * Math.max(1, (t.exitTime - t.entryTime) / 86400) / 365;
    } else if (acct) {
      // 株：買いは口座（現物・信用・現物＋信用）ごとの上限まで、空売りは信用。量はふだん損切りの幅で決まる
      const risk = t.stopPct > 0 ? (budget * riskPct / 100) / t.stopPct : alloc;
      const kind = t.side < 0 ? 'margin' : acct.long;
      // 現物の予算・信用の予算から、1銘柄に使える上限（現物＋信用は、買った株も担保に8割で使う）
      const cA = (acct.cash ?? budget) / maxPos, mA = (acct.margin ?? budget) / maxPos;
      const cap = kind === 'cash' ? cA : kind === 'margin' ? mA * acct.L : cA + ((acct.sep ? mA : 0) + cA * 0.8) * acct.L;
      const size = Math.min(cap, risk);
      yen = t.ret * size;
      // 信用の金利・貸株料：信用で入った分だけ（現物＋信用なら、現物で足りない分だけ）
      const onMargin = kind === 'margin' ? size : kind === 'mix' ? Math.max(0, size - cA) : 0;
      if (onMargin && t.exitTime && t.entryTime) yen -= onMargin * (t.side < 0 ? CARRY.short : CARRY.long) * Math.max(1, (t.exitTime - t.entryTime) / 86400) / 365;
    } else {
      // capLev：信用・為替なら、1銘柄に使えるお金のその倍まで（量はふだん損切りの幅で決まる）
      const size = Math.min(alloc * capLev, t.stopPct > 0 ? (budget * riskPct / 100) / t.stopPct : alloc);
      yen = t.ret * size;
      // 信用の金利・貸株料（持っていた日数分）
      if (carry && t.exitTime && t.entryTime) yen -= size * (t.side < 0 ? carry.short : carry.long) * Math.max(1, (t.exitTime - t.entryTime) / 86400) / 365;
    }
    open.push({ ...t, yen });
    log.push({ t, yen });
    taken++;
    if (yen > 0) wins++;
    if (t.side < 0) { shortYen += yen; shortN++; } else { longYen += yen; longN++; }
  }
  settle(null);
  return { total: equity, pct: budget ? equity / budget : 0, trades: taken, winRate: taken ? wins / taken : null, maxDD, skipped, losscuts, broke, longYen, shortYen, longN, shortN, log };
}

// 候補の一覧（日本株）：値段だけから「現物なら・信用なら・空売りなら」をひとことで
export function lotNote(profile, side, price, bestKey = null) {
  const budget = Number(profile?.budget) || 0;
  if (!budget || !(price > 0)) return '';
  const per = budget / (Number(profile?.maxPos) || 3);
  const lot = price * 100;
  const y = (v) => `${Math.round(v).toLocaleString()}円`;
  const best = bestKey ? WAYS.stock.find((w) => w.key === bestKey) : null;
  if (side < 0) {
    const can = per * LEV_LIMIT.stock >= lot ? `空売りするなら信用で100株（約${y(lot)}分）` : `100株で約${y(lot)}分：空売りでも1銘柄に使えるお金では足りない`;
    return `持っていたら売る候補／${can}${best ? (best.short ? '（おすすめのやり方に空売りが入っています）' : '（おすすめのやり方では空売りしません）') : ''}`;
  }
  if (per >= lot) return `現物で買える（100株 約${y(lot)}）`;
  if (per * LEV_LIMIT.stock >= lot) return `現物では足りないが、信用なら買える（100株 約${y(lot)}）${best && best.long === 'cash' ? '・おすすめは現物だけなので見送りでもOK' : ''}`;
  return `100株 約${y(lot)}：1銘柄に使えるお金では買えない`;
}

// ---------------- やり方を自動で選ぶ ----------------
// 設定で決めるのではなく、全部のやり方（組み合わせ）で過去1年をやり直して、一番良かったものを使う
// 並び順は「簡単・安全な順」。はっきり成績が良いときだけ、後ろのやり方を選ぶ
export const WAYS = {
  stock: [
    { key: 'cash', label: '現物で買うだけ', sides: 'long', long: 'cash' },
    { key: 'mix', label: '現物＋信用で買う', sides: 'long', long: 'mix' },
    { key: 'margin', label: '信用で買うだけ', sides: 'long', long: 'margin' },
    { key: 'cashShort', label: '現物で買う＋信用で空売り', sides: 'both', long: 'cash', short: true },
    { key: 'mixShort', label: '現物＋信用で買う＋空売り', sides: 'both', long: 'mix', short: true },
    { key: 'short', label: '信用で買う＋空売り', sides: 'both', long: 'margin', short: true },
    { key: 'shortOnly', label: '信用で空売りだけ', sides: 'short', long: 'margin', short: true },
  ],
  us: [
    { key: 'cash', label: '現物で買うだけ', sides: 'long', long: 'cash' },
    { key: 'mix', label: '現物＋信用で買う', sides: 'long', long: 'mix' },
    { key: 'margin', label: '信用で買うだけ', sides: 'long', long: 'margin' },
  ],
  fx: [
    { key: 'long', label: '買いだけ', sides: 'long' },
    { key: 'short', label: '売りだけ', sides: 'short' },
    { key: 'both', label: '買いも売りも', sides: 'both' },
  ],
};
export const DEFAULT_WAY = { stock: 'cash', us: 'cash', fx: 'both' };
export const wayOf = (mode, key) => WAYS[mode].find((w) => w.key === key) || WAYS[mode].find((w) => w.key === DEFAULT_WAY[mode]);
export const waySides = (mode) => [...new Set(WAYS[mode].map((w) => w.sides))];

// そのやり方で計算するための設定（あなたの予算・ロット数などはそのまま）
export function wayProfile(pf, mode, key) {
  const w = wayOf(mode, key);
  if (mode === 'fx') return { ...pf, fxSides: w.sides };
  if (mode === 'us') return { ...pf, usAcct: w.long, levUs: w.long === 'cash' ? 1 : LEV_LIMIT.us };
  return { ...pf, stockAcct: w.long, stockShort: !!w.short, stockSides: w.sides, levStock: w.long === 'cash' ? 1 : LEV_LIMIT.stock };
}

// そのやり方で過去をやり直すときの条件
export function replayOpts(mode, w, pf, prices = {}) {
  const b = budgets(pf);
  const base = { budget: mode === 'fx' ? b.cash : b.total, riskPct: pf.riskPct || 2, maxPos: pf.maxPos || 3 };
  if (mode !== 'fx') return { ...base, acct: { long: w.long, L: LEV_LIMIT[mode], cash: b.cash, margin: b.margin, sep: b.sep } };
  base.budget = b.cash;
  const lots = pf.fxLots > 0 ? pf.fxLots : 0, size = pf.fxLotSize || 10000;
  return lots ? { ...base, notionalOf: (t) => lots * size * t.entryPrice * (quoteToJpy(t.symbol, prices) || 0), maint: MAINT.fx } : { ...base, capLev: FX_LEVERAGE };
}

/**
 * 全部のやり方で比べて、一番いいものを選ぶ
 * tradesBy: { long: [...], short: [...], both: [...] }（向きごとの過去の取引）
 */
export function compareWays(tradesBy, mode, pf, budget, prices = {}) {
  // budget：比べるときの基準（予算の合計）。それぞれの口座の予算は pf から読む
  const p = pf.budget ? pf : { ...pf, budget };
  const rows = WAYS[mode].filter((w) => tradesBy[w.sides]).map((w) => ({ ...w, r: replayWithBudget(tradesBy[w.sides], replayOpts(mode, w, p, prices)) }));
  if (!rows.length) return { rows, best: null };
  // おすすめの選び方
  // 1) プラスになったものだけを候補にする（マイナスのやり方は、どんなに減り方が小さくても選ばない）
  // 2) その中で、途中で資金がなくならず、一番減ったときが予算の35%以内のものを優先
  // 3) 簡単なやり方から順に見て、はっきり（予算の2%か1割以上）良いときだけ、手間やリスクの多いやり方を選ぶ
  // 4) どれもマイナスなら「お休みがおすすめ」（やるなら一番損が小さいもの）
  const pick = (list) => {
    let b = null;
    for (const x of list) if (!b || x.r.total > b.r.total + Math.max(budget * 0.02, Math.abs(b.r.total) * 0.1)) b = x;
    return b;
  };
  const plus = rows.filter((x) => x.r.total > 0 && !x.r.broke);
  const safe = plus.filter((x) => x.r.maxDD <= budget * 0.35);
  let best, note = '';
  if (safe.length) best = pick(safe);
  else if (plus.length) {
    // プラスだが減り方が大きいものしかない：増え方÷一番減ったとき が一番いいもの
    best = plus.slice().sort((a, b) => b.r.total / Math.max(1, b.r.maxDD) - a.r.total / Math.max(1, a.r.maxDD))[0];
    note = 'dd';
  } else {
    best = rows.slice().sort((a, b) => b.r.total - a.r.total)[0];
    note = 'rest';
  }
  return { rows, best, note };
}

// 比べた結果の説明（「信用で買うと…」「空売りを入れると…」）
export function wayNotes(cmp, mode, budget) {
  const y0 = (v) => `${Math.round(Math.abs(v)).toLocaleString()}円`;
  const yen = (v) => `${v >= 0 ? '+' : '−'}${y0(v)}`;
  const get = (k) => cmp.rows.find((x) => x.key === k)?.r;
  const thr = budget * 0.02;
  const notes = [];
  if (mode === 'fx') {
    const l = get('long'), s = get('short'), b = get('both');
    if (l && s) notes.push(`買いだけだと${yen(l.total)}、売りだけだと${yen(s.total)}、両方やると${b ? yen(b.total) : '—'}でした。`);
    if (b) notes.push(`「買いも売りも」のうち、買いの分は${yen(b.longYen)}（${b.longN}回）、売りの分は${yen(b.shortYen)}（${b.shortN}回）です。${b.shortYen < 0 && b.longYen > 0 ? '売りが足を引っぱっているので、売りはやめた方が良さそうです。' : b.longYen < 0 && b.shortYen > 0 ? '買いが足を引っぱっているので、買いはやめた方が良さそうです。' : ''}`);
  } else {
    const c = get('cash'), mx = get('mix'), m = get('margin'), cs = get('cashShort'), so = get('shortOnly');
    const marginBest = [mx, m].filter(Boolean).sort((a, b) => b.total - a.total)[0];
    if (c && marginBest) {
      notes.push(marginBest.total > c.total + thr
        ? `信用も使って買うと、現物だけより約${y0(marginBest.total - c.total)}多く増えました（金利の目安も差し引き済み）。ただ、一番減ったときも${y0(c.maxDD)}→${y0(marginBest.maxDD)}に大きくなります。`
        : `信用を使っても現物だけとくらべて${marginBest.total > c.total ? 'あまり増えず' : '増えず'}、金利もかかるので、買うのは現物だけで十分です。`);
    }
    if (c && cs) {
      notes.push(cs.total > c.total + thr && cs.shortYen > 0
        ? `空売りも入れると、さらに約${y0(cs.total - c.total)}多く増えました（空売りの分だけで${yen(cs.shortYen)}・${cs.shortN}回）。空売りもやって良さそうです。`
        : `空売りを入れても${cs.total < c.total ? `成績は約${y0(c.total - cs.total)}悪くなりました` : 'あまり変わりませんでした'}（空売りの分だけで${yen(cs.shortYen)}・${cs.shortN}回）。空売りはやめた方がいいです。`);
    }
    if (so) notes.push(`空売りだけだと${yen(so.total)}（${so.trades}回・勝率${so.winRate == null ? '—' : Math.round(so.winRate * 100) + '%'}）でした。${so.total < 0 ? '空売りだけでやるのはおすすめしません。' : ''}`);
    if (mode === 'us') notes.push('米国株は空売りなしで計算しています。');
  }
  return notes;
}

// ---------------- 為替：pips（どれだけ動いたか）とロット ----------------
// 円の通貨ペアは0.01円＝1pips（1銭）、それ以外は0.0001＝1pips
export const pipOf = (symbol) => (/JPY/i.test(String(symbol).replace(/=X$/, '').slice(3, 6)) ? 0.01 : 0.0001);
export const pipsOf = (symbol, side, from, to) => (side * (to - from)) / pipOf(symbol);
export const pipsText = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}pips`;
// 為替：あなたのロット設定（おまかせなら1ロット）で、その値動きがいくらになるか
export function fxLotYen(pf, symbol, side, from, to, prices = {}) {
  const lots = pf?.fxLots > 0 ? pf.fxLots : 1, size = pf?.fxLotSize || 10000;
  const q = quoteToJpy(symbol, prices);
  if (!q) return null;
  return { lots, size, yen: side * (to - from) * lots * size * q, auto: !(pf?.fxLots > 0) };
}

// ---------------- AIが見つける特別ルール ----------------
// 決まったやり方に「勝つ確率の目安が○%以上のサインだけやる」を組み合わせて、一番いいものを探す。
// たまたま当たったルールを選ばないように、過去1年を前半と後半に分ける：
//   前半だけで一番良かったルールを選び → 後半（選ぶときに見ていない期間）でも本当に良かったかを確かめる
export const ODDS_STEPS = [0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
export function searchCustom(tradesBy, mode, pf, budget, prices = {}, std = null) {
  const all = Object.values(tradesBy).flat();
  if (all.length < 20) return null;
  const dates = [...new Set(all.map((t) => t.entryDate))].sort();
  const mid = dates[Math.floor(dates.length / 2)];
  const p = pf.budget ? pf : { ...pf, budget };
  const run = (w, minOdds, list) => replayWithBudget(list, { ...replayOpts(mode, w, p, prices), minOdds });
  const cands = [];
  for (const w of WAYS[mode]) {
    const ts = tradesBy[w.sides];
    if (!ts) continue;
    const first = ts.filter((t) => t.entryDate < mid);
    for (const m of ODDS_STEPS) {
      const tr = run(w, m, first);
      if (tr.trades < 5 || tr.total <= 0 || tr.broke) continue;
      cands.push({ w, minOdds: m, train: tr });
    }
  }
  if (!cands.length) return null;
  // 前半で一番良かったもの（増えた額から、一番減ったときの半分を引いた点数で比べる）
  const score = (r) => r.total - 0.5 * r.maxDD;
  cands.sort((a, b) => score(b.train) - score(a.train));
  const c = cands[0];
  const ts = tradesBy[c.w.sides];
  const second = ts.filter((t) => t.entryDate >= mid);
  const test = run(c.w, c.minOdds, second);
  const full = run(c.w, c.minOdds, ts);
  // ふつうのおすすめ（条件なし）を、同じ後半だけでやった場合
  const sb = std?.best;
  const stdTest = sb && tradesBy[sb.sides] ? run(sb, 0, tradesBy[sb.sides].filter((t) => t.entryDate >= mid)) : null;
  const adopted = test.trades >= 3 && test.total > 0 && full.total > 0 && !full.broke
    && (!stdTest || test.total > stdTest.total + budget * 0.01);
  return {
    key: 'custom', base: c.w, sides: c.w.sides, long: c.w.long, short: c.w.short, minOdds: c.minOdds,
    label: `${c.w.label}・勝つ確率${Math.round(c.minOdds * 100)}%以上のサインだけ`,
    train: c.train, test, full, stdTest, adopted, mid, tried: cands.length,
  };
}

// ---------------- 1年前から「先を知らずに」やっていたら（本当の練習） ----------------
// 毎月の初めに、その時点までに終わった取引（過去半年）だけを見て「今月のやり方」を決める。
// 決めたやり方で、その月に出たサインどおりに売買する。これを12か月くり返す（後から分かったことは使わない）。
// tradesBy：向きごとの取引（1年より前から計算しておく。勝つ確率の目安は、その取引より前のことだけで計算済み）
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
export function walkForward(tradesBy, mode, pf, prices = {}, { months = 12, lookback = 6, odds = [0, 0.55, 0.6, 0.7] } = {}) {
  const all = Object.values(tradesBy).flat();
  if (!all.length) return null;
  const b = budgets(pf);
  const budget = mode === 'fx' ? b.cash : b.total;
  const last = all.reduce((a, t) => (t.exitDate > a ? t.exitDate : a), '').slice(0, 7);
  const first = addMonths(last, -(months - 1));
  const p = pf.budget ? pf : { ...pf, budget };
  const pickOpts = (w) => { const o = replayOpts(mode, w, p, prices); return { leverage: o.leverage, maint: o.maint, notionalOf: o.notionalOf, capLev: o.capLev, carry: o.carry, acct: o.acct }; };
  const plan = [];
  const chosen = [];
  for (let i = 0; i < months; i++) {
    const ym = addMonths(first, i);
    const start = `${ym}-01`, end = `${addMonths(ym, 1)}-01`, from = `${addMonths(ym, -lookback)}-01`;
    // その月の初めの時点で、もう結果が分かっている取引だけで比べる
    const cands = [];
    for (const w of WAYS[mode]) {
      const past = (tradesBy[w.sides] || []).filter((t) => t.exitDate < start && t.entryDate >= from);
      for (const m of odds) {
        const r = replayWithBudget(past, { ...replayOpts(mode, w, p, prices), minOdds: m });
        if (r.trades >= 5 && r.total > 0 && !r.broke) cands.push({ w, m, r });
      }
    }
    // 簡単なやり方・絞らないものから順に見て、はっきり良いときだけ切り替える（ふだんのおすすめと同じ考え方）
    let best = null;
    const safe = cands.filter((c) => c.r.maxDD <= budget * 0.35);
    for (const c of safe.length ? safe : cands) if (!best || c.r.total > best.r.total + Math.max(budget * 0.02, Math.abs(best.r.total) * 0.1)) best = c;
    const label = best ? `${best.w.label}${best.m ? `・確率${Math.round(best.m * 100)}%以上` : ''}` : 'お休み（過去半年はどのやり方もマイナス）';
    plan.push({ ym, label, rest: !best });
    if (!best) continue;
    const o = pickOpts(best.w);
    for (const t of tradesBy[best.w.sides] || []) {
      if (t.entryDate >= start && t.entryDate < end && (!best.m || (t.odds && t.odds.p >= best.m))) chosen.push({ ...t, __o: o, __ym: ym });
    }
  }
  const r = replayWithBudget(chosen, { ...replayOpts(mode, WAYS[mode][0], p, prices), minOdds: 0 });
  // 月ごとの成績と、月末の残高
  let bal = budget;
  const byMonth = plan.map((x) => {
    const items = r.log.filter((l) => l.t.__ym === x.ym);
    const pnl = items.reduce((a, l) => a + l.yen, 0);
    bal += pnl;
    return { ...x, n: items.length, wins: items.filter((l) => l.yen > 0).length, pnl, balance: bal };
  });
  return { ...r, months: byMonth, from: first, to: last, budget };
}

// 税金：株も為替も、1年の利益に約20%（所得税・住民税で20.315%）。損した年はかからない
export const TAX = 0.20315;
export const afterTax = (v) => (v > 0 ? v * (1 - TAX) : v);

// ---------------- 持っている株と、あなたのプランをつなぐ ----------------
// 持っている株で使っているお金：現物はその金額、信用・空売りは保証金（金額 ÷ 倍率）、為替は証拠金（金額 ÷ 25）
// nowOf(h) で今の値段が分かれば、信用・空売り・為替の含み損益も出す（保証金・証拠金は含み損の分だけ減る）
export function heldUse(holdings, mode, { prices = {}, usdjpy = null, nowOf = null } = {}) {
  let cash = 0, margin = 0, n = 0, pl = 0, notional = 0;
  const rows = [];
  for (const h of holdings || []) {
    const qty = Number(h.qty) || 0, price = Number(h.price) || 0;
    if (!(qty > 0 && price > 0)) continue;
    n++;
    const now = nowOf ? Number(nowOf(h)) || null : null;
    if (mode === 'fx') {
      const q = quoteToJpy(`${String(h.code).replace(/=X$/i, '').toUpperCase()}=X`, prices) ?? (usdjpy || 150);
      cash += (qty * price * q) / FX_LEVERAGE;
      notional += qty * price * q;
      const p = now ? (h.side < 0 ? -1 : 1) * (now - price) * qty * q : 0;
      pl += p;
      rows.push({ h, pl: p, now });
      continue;
    }
    const k = mode === 'us' ? usdjpy || 150 : 1;
    const yen = qty * price * k;
    if (h.side < 0 || h.acct === 'margin') {
      margin += yen / LEV_LIMIT[mode];
      notional += yen;
      const p = now ? (h.side < 0 ? -1 : 1) * (now - price) * qty * k : 0;
      pl += p;
      rows.push({ h, pl: p, now });
    } else cash += yen;
  }
  // 信用：評価損は保証金から引かれ、評価益は足されない（楽天証券など国内の決まり）。為替：含み益も含み損も有効証拠金に入る
  const plAdj = mode === 'fx' ? pl : Math.min(0, pl);
  return { cash, margin, n, pl, plAdj, notional, rows };
}
// 残りの予算と、あと何銘柄まで持てるか（信用の予算を分けていないときは、どちらも同じお金から引く）
// 信用・為替は「入れたお金 ＋ 含み損益（信用は損だけ）」が本当の保証金・証拠金になる
export function leftBudget(pf, use) {
  const b = budgets(pf);
  const slots = Math.max(0, (Number(pf?.maxPos) || 3) - use.n);
  const adj = use.plAdj || 0;
  if (b.sep) return { cash: Math.max(0, b.cash - use.cash), margin: Math.max(0, b.margin + adj - use.margin), slots, sep: true };
  const left = Math.max(0, b.cash + adj - use.cash - use.margin);
  return { cash: left, margin: left, slots, sep: false };
}
// 保証金（証拠金）維持率：本当の保証金 ÷ 建てている金額。日本株の信用は20%、米国株は25%、為替は4%（＝証拠金維持率100%）を下回ると追証・ロスカット
export function marginHealth(pf, use, mode) {
  if (!(use.notional > 0)) return null;
  const b = budgets(pf);
  const deposit = mode === 'fx' ? b.cash : b.sep ? b.margin : Math.max(0, b.cash - use.cash);
  const equity = deposit + (use.plAdj || 0);
  const maint = MAINT[mode];
  return { deposit, equity, ratio: equity / use.notional, maint, buffer: equity - maint * use.notional, need: mode === 'fx' ? use.notional / FX_LEVERAGE : use.notional / LEV_LIMIT[mode] };
}

// ---------------- おすすめを、ある程度決めておく ----------------
// 毎日計算し直すと、ほぼ同じ成績のやり方が入れ替わって、サインもころころ変わってしまう。
// そこで、月の初めに決めたやり方は、その月の間は変えない（「1年前から先を知らずに」の練習と同じ、月に1回の見直し）。
// ただし、決めたやり方が過去1年でマイナスになったら、すぐに見直す。
export const monthKey = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 7);
export function keepWay(cmp, custom, lock, month = monthKey()) {
  const fresh = custom?.adopted && cmp.note !== 'rest' ? custom : cmp.best;
  if (!lock?.way || lock.month !== month || cmp.note === 'rest') return { best: fresh, fresh, kept: false };
  const pool = [...cmp.rows, ...(custom?.adopted ? [custom] : [])];
  const w = pool.find((x) => x.key === lock.way);
  const total = w ? (w.full?.total ?? w.r?.total) : null;
  if (!w || !(total > 0)) return { best: fresh, fresh, kept: false, dropped: !!w };
  return { best: w, fresh, kept: true };
}
// スイングで持つ日数のおすすめも同じ：今月決めた日数が、まだプラスならそのまま
export function keepDays(rows, best, lock, month = monthKey()) {
  if (!lock?.days || lock.daysMonth !== month) return { best, kept: false };
  const w = rows.find((x) => x.d === lock.days);
  if (!w || !(w.r.total > 0) || w.r.broke) return { best, kept: false };
  return { best: w, kept: true };
}

// ---------------- 信用の保証金を、値動きに合わせて自動で計算する（日本株・米国株） ----------------
// 本当の保証金 ＝ 入れている現金の保証金 ＋ 代用（現物の株の評価 × 8割・日本株） ＋ 信用の含み損（含み益は足さない）
// 保証金率 ＝ 本当の保証金 ÷ 信用で建てている金額（建てたときの値段で）
// 「入れている現金の保証金」は、楽天証券の保証金率を1回入れてもらえば逆算できる。入れていなければ設定の「信用・空売りの予算」を使う
export const SUBST = 0.8;
export function marginBook(pf, holdings, mode, { usdjpy = null, nowOf = null } = {}) {
  if (mode === 'fx') return null;
  const k = mode === 'us' ? usdjpy || 150 : 1;
  let N = 0, pl = 0, V = 0, longNow = 0;
  for (const h of holdings || []) {
    const qty = Number(h.qty) || 0, price = Number(h.price) || 0;
    if (!(qty > 0 && price > 0)) continue;
    const now = (nowOf && Number(nowOf(h))) || price;
    if (h.side < 0 || h.acct === 'margin') {
      N += qty * price * k;
      pl += (h.side < 0 ? -1 : 1) * (now - price) * qty * k;
      if (h.side > 0) longNow += qty * now * k;
    } else if (mode === 'stock') V += qty * now * k;
  }
  const cal = pf?.marginCal?.[mode];
  // 代用の掛け目：楽天証券の数字から分かっていればそれ（担保にしていない株があると8割より小さくなる）
  const sr = cal?.substRate ?? SUBST;
  const subst = sr * V;
  const plAdj = Math.min(0, pl);
  const b = budgets(pf);
  const base = cal?.base ?? (b.sep ? b.margin : null);
  if (base == null) return { N, pl, plAdj, subst, V, base: null };
  const E = base + subst + plAdj;
  const ratio = N > 0 ? E / N : null;
  const maint = MAINT[mode];
  const NEW = 0.3;
  // 新しく建てるのに使える保証金（建てている金額の30%を残した分。サイトの量の計算は「保証金 × 約3.3倍」まで建てる）
  const room = ratio != null && ratio < NEW ? 0 : Math.max(0, E - N * NEW);
  const topUp = ratio != null && ratio < maint ? Math.ceil(maint * N - E) : 0;
  // 追証まで：あといくら損が増えてよいか、信用で買っている株と代用の株がそろって何%下がるとそうなるか
  const buffer = E - maint * N;
  const dropPct = buffer > 0 && longNow + subst > 0 ? buffer / (longNow + subst) : null;
  // 信用を全部いま決済したら残るお金（保証金の現金 − 含み損）＋ 現物の株の今の評価
  const total = base + plAdj + V;
  return { N, pl, plAdj, subst, sr, V, base, cal, E, ratio, maint, NEW, room, topUp, buffer, dropPct, longNow, total };
}
// 楽天証券の保証金率（%）から「入れている現金の保証金」を逆算する
export function calibrateMargin(ratePct, book) {
  if (!(book?.N > 0) || !Number.isFinite(ratePct)) return null;
  return Math.round((ratePct / 100) * book.N - book.subst - book.plAdj);
}

// 証券会社のCSV（持っている株＋保証金率）から、予算と保証金を自動で決める（日本株）
// list：読み込んだ持っている株（now＝CSVの今の値段つき）、rate：保証金率（%）
// cashDeposit：保証金の現金（分かれば。なければ代用を8割として逆算）、cashFree：現物で使える現金（預り金・楽天銀行）
export function setupFromCsv(list, { rate = null, cashDeposit = null, cashFree = 0 } = {}) {
  let N = 0, pl = 0, V = 0, cost = 0;
  for (const h of list) {
    const now = h.now || h.price;
    if (h.side < 0 || h.acct === 'margin') { N += h.price * h.qty; pl += (h.side < 0 ? -1 : 1) * (now - h.price) * h.qty; }
    else { V += now * h.qty; cost += h.price * h.qty; }
  }
  const out = { budget: Math.round(cost + (Number(cashFree) || 0)) };
  if (!(N > 0) || !(rate > 0)) return out;
  const E = (rate / 100) * N, plAdj = Math.min(0, pl);
  let base, substRate = SUBST;
  if (cashDeposit > 0) {
    base = Math.round(cashDeposit);
    substRate = V > 0 ? Math.max(0, Math.min(SUBST, (E - base - plAdj) / V)) : SUBST;
  } else base = Math.round(E - SUBST * V - plAdj);
  out.marginBudget = Math.max(0, base);
  out.cal = { base, rate, substRate: Math.round(substRate * 1000) / 1000 };
  return out;
}
