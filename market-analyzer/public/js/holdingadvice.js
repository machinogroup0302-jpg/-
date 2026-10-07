// 自分で持っている株・通貨について「どうした方がいいか」を出す
// （サイトの「持っている株」と、メールのお知らせの両方で使う）
import { atr, rsi, technicalSummary } from './indicators.js';
import { supportResistance } from './levels.js';
import { quoteToJpy } from './plan.js';

const num = (v) => Number(Number(v).toPrecision(6)).toLocaleString('ja-JP', { maximumFractionDigits: 4 });
const yen = (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString()}円`;
const short = (t) => String(t).replace(/（[^）]*）/g, '');

export const VERDICTS = {
  cut: { label: '損切りを', cls: 'danger', icon: '🛑' },
  exit: { label: '決済を考える', cls: 'warn', icon: '⚠️' },
  trim: { label: '一部を利益確定', cls: 'ok', icon: '💰' },
  hold: { label: '持ち続けてOK', cls: 'ok', icon: '👍' },
};

// 値段が1動くと何円か（日本株は1、米国株はドル円、為替は決済通貨の円の値段）
export function yenPerUnit(mode, symbol, { prices = {}, usdjpy = null } = {}) {
  if (mode === 'stock') return 1;
  if (mode === 'us') return usdjpy;
  return quoteToJpy(symbol, prices);
}

/**
 * h: { symbol, name, side(1/-1), price(入った値段), qty(数量), date?(YYYY-MM-DD) }
 * candles: 日足
 */
export function adviseHolding(h, candles, { mode, prices = {}, usdjpy = null, profile = null, earningsDate = null, today = null } = {}) {
  if (!candles || candles.length < 60) return null;
  const side = h.side < 0 ? -1 : 1;
  const long = side > 0;
  const last = candles[candles.length - 1];
  const now = last.close;
  const a = atr(candles).filter((v) => v != null).pop() || now * 0.01;
  const r = rsi(candles.map((c) => c.close)).filter((v) => v != null).pop();
  const ts = technicalSummary(candles.slice(-200));
  const ypu = yenPerUnit(mode, h.symbol, { prices, usdjpy });
  const qty = Number(h.qty) || 0;
  const entry = Number(h.price);
  const plPct = side * (now / entry - 1);
  const plYen = ypu != null && qty ? side * (now - entry) * qty * ypu : null;

  // 持ち始めてからの一番良かった値段（日付がなければ最近20日）
  const since = h.date ? candles.filter((c) => new Date(c.time * 1000).toISOString().slice(0, 10) >= h.date) : candles.slice(-20);
  const span = since.length ? since : candles.slice(-20);
  const peak = long ? Math.max(...span.map((c) => c.high)) : Math.min(...span.map((c) => c.low));
  // 損切りの線：入った値段から2ATR。値段が有利に動いたら、一番良かった値段から2.5ATRまで引き上げる
  const base = entry - side * 2 * a;
  const trail = peak - side * 2.5 * a;
  const stop = long ? Math.max(base, trail) : Math.min(base, trail);
  const protects = long ? stop > entry : stop < entry;

  // 目標：上（下）にある一番近い「壁」か、入った値段から3ATR
  const lv = supportResistance(candles);
  const walls = lv.filter((l) => (long ? l.kind === 'resistance' && l.price > now : l.kind === 'support' && l.price < now))
    .sort((x, y) => (long ? x.price - y.price : y.price - x.price));
  const target = walls[0]?.price ?? (now + side * 3 * a);

  const against = long ? /売り/.test(ts.label) : /買い/.test(ts.label);
  const hot = long ? r > 75 : r < 25;
  const nearTarget = Math.abs(target - now) < a * 0.5;
  const broken = long ? now <= stop : now >= stop;

  let key;
  if (broken) key = protects ? 'exit' : 'cut';
  else if (against) key = 'exit';
  else if (hot || nearTarget) key = 'trim';
  else key = 'hold';

  const reasons = [];
  if (broken) reasons.push(protects ? `値段が利益を守る線（${num(stop)}）を下回った。利益があるうちに決済を` : `値段が損切りの線（${num(stop)}）を割っている。これ以上損を広げないために決済を`);
  if (against) reasons.push(`テクニカル判定が「${ts.label}」に変わった（${long ? '下がる' : '上がる'}サインが多い）`);
  if (hot) reasons.push(`買われすぎ・売られすぎ度（RSI）が${Math.round(r)}。${long ? '上がりすぎで、いったん下がりやすい' : '下がりすぎで、いったん戻りやすい'}`);
  if (nearTarget && !broken) reasons.push(`目標の値段（${num(target)}）のすぐ近く。${walls[0] ? `${walls[0].label}（${walls[0].strength}）で止まりやすい` : ''}`);
  if (key === 'hold') {
    const agree = ts.rows.filter((x) => x.signal === (long ? '買い' : '売り'));
    reasons.push(`テクニカル判定は「${ts.label}」で、流れはまだ${long ? '上向き' : '下向き'}`);
    agree.slice(0, 2).forEach((x) => reasons.push(short(x.detail)));
  }
  const toStop = side * (stop / now - 1);
  const stopYen = ypu != null && qty ? side * (stop - entry) * qty * ypu : null;
  if (!broken) reasons.push(`${protects ? '利益を守る線' : '損切りの線'}は ${num(stop)}（今から${(toStop * 100).toFixed(1)}%${stopYen != null ? `・そこで決済すると${yen(stopYen)}` : ''}）。逆指値の注文を入れておきましょう`);
  if (earningsDate && today) {
    const days = Math.round((Date.parse(earningsDate) - Date.parse(today)) / 86400000);
    if (days >= 0 && days <= 14) reasons.push(`決算発表まであと${days}日（${earningsDate.slice(5).replace('-', '/')}）。発表の翌日は大きく動くことがあるので、持ち越すか考えましょう`);
  }
  if (profile?.budget && ypu != null && qty) {
    const value = (mode === 'fx' ? now * qty * ypu / 25 : now * qty * ypu);
    const share = value / profile.budget;
    if (share > 0.5) reasons.push(`この銘柄に予算の${Math.round(share * 100)}%を使っています。1つに集中しすぎると、外れたときの損が大きくなります`);
    const risk = stopYen != null && stopYen < 0 ? -stopYen / profile.budget : 0;
    if (risk > (profile.riskPct || 2) / 100 * 1.5) reasons.push(`損切りの線で決済すると予算の${(risk * 100).toFixed(1)}%が減ります（あなたのルールは${profile.riskPct || 2}%）。量を減らすことも考えましょう`);
  }
  return { key, verdict: VERDICTS[key], now, plPct, plYen, stop, protects, target, wall: walls[0] || null, rsi: r, tech: ts.label, reasons, atr: a, date: new Date(last.time * 1000).toISOString().slice(0, 10) };
}
