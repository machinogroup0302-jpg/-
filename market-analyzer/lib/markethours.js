// 取引時間の判定（メールのお知らせで使う）
// 今、取引時間中の市場（日本時間で判断。米国は夏時間も考える）
export function openMarkets(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const wd = jst.getUTCDay(), min = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const out = [];
  if (wd >= 1 && wd <= 5 && ((min >= 9 * 60 && min < 11 * 60 + 30) || (min >= 12 * 60 + 30 && min < 15 * 60 + 30))) out.push('stock');
  const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const g = (t) => ny.find((p) => p.type === t)?.value;
  const nyMin = (Number(g('hour')) % 24) * 60 + Number(g('minute'));
  if (!['Sat', 'Sun'].includes(g('weekday')) && nyMin >= 9 * 60 + 30 && nyMin < 16 * 60) out.push('us');
  // 為替：月曜の朝7時〜土曜の朝6時（日本時間）
  const fxOpen = !(wd === 0 || (wd === 6 && min >= 6 * 60) || (wd === 1 && min < 7 * 60));
  if (fxOpen) out.push('fx');
  return out;
}
