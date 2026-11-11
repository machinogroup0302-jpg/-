// 日本株のリアルタイムの値段（Yahoo!ファイナンス日本版。チャートの元のデータは約20分遅れるので、最後の足をこれで直す）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const cache = new Map();
const CACHE_MS = 15 * 1000;

// ページの中の「値段の板」の部分から、今の値段と時刻を読む
export function parseRealtime(html, code) {
  const t = String(html || '').replace(/\\"/g, '"');
  const at = t.indexOf(`"codeWithMarketExtension":"${code}.T"`);
  if (at < 0) return null;
  const part = t.slice(at, at + 3000);
  const price = Number((part.match(/"price":\{"value":"([\d,.]+)"/) || [])[1]?.replace(/,/g, ''));
  const hm = (part.match(/"japanUpdateTime":"(\d{1,2}):(\d{2})"/) || []).slice(1).map(Number);
  const delay = Number((part.match(/"delayMinutes":(\d+)/) || [])[1] ?? NaN);
  if (!(price > 0) || hm.length !== 2) return null;
  return { price, h: hm[0], m: hm[1], delay };
}

// 取引時間（平日 9:00〜15:35）なら、今の値段を返す。それ以外は null
export async function jpRealtime(code, now = Date.now()) {
  const j = new Date(now + 9 * 3600e3);
  const mins = j.getUTCHours() * 60 + j.getUTCMinutes();
  if (j.getUTCDay() === 0 || j.getUTCDay() === 6 || mins < 9 * 60 || mins > 15 * 60 + 35) return null;
  const hit = cache.get(code);
  if (hit && now - hit.at < CACHE_MS) return hit.v;
  let v = null;
  try {
    const r = await fetch(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T/chart`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const p = parseRealtime(await r.text(), code);
      // 値段の時刻（日本時間の今日）を、UNIX秒にする
      if (p && !(p.delay > 0)) v = { price: p.price, time: Math.floor((Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate(), p.h, p.m) - 9 * 3600e3) / 1000) };
    }
  } catch { /* 取れないときは元のデータのまま */ }
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(code, { at: now, v });
  return v;
}

// 足の並びの最後を、今の値段で直す（同じ足の中なら終値・高値・安値を更新、新しい足の時間なら足を足す）
export function applyRealtime(candles, rt, barSec) {
  if (!rt || !candles.length) return candles;
  const out = candles.slice();
  const last = { ...out[out.length - 1] };
  if (rt.time < last.time) return candles; // 元のデータの方が新しい
  if (rt.time < last.time + barSec) {
    last.close = rt.price;
    last.high = Math.max(last.high, rt.price);
    last.low = Math.min(last.low, rt.price);
    out[out.length - 1] = last;
  } else {
    // 抜けている足の時刻にそろえる（日本時間の 9:00 から barSec ごと）
    const t = last.time + Math.floor((rt.time - last.time) / barSec) * barSec;
    out.push({ time: t, open: rt.price, high: rt.price, low: rt.price, close: rt.price, volume: 0 });
  }
  return out;
}
