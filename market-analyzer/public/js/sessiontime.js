// 「いつ判断したか」「いつ売買するか」を、市場ごとの時刻で分かりやすく書く（日本時間）
const pad = (n) => String(n).padStart(2, '0');
const jst = (t) => new Date((t + 9 * 3600) * 1000);

// 10/8 15:30 のように書く（t は秒）
export function fmtTime(t) {
  const d = jst(t);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
const md = (t) => { const d = jst(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };

/**
 * 判断した時刻：日足なら、その日の取引が終わった時刻。15分足なら、その足が終わった時刻
 * t: 足の時刻（秒）
 */
export function judgedText(mode, t, day = false) {
  if (!t) return '';
  if (day) return `${fmtTime(t + 15 * 60)}（15分足が終わった時点）`;
  if (mode === 'stock') return `${md(t)} 15:30（その日の取引終了の値段で）`;
  if (mode === 'us') return `${md(t + 86400)} 朝5〜6時（米国のその日の取引終了の値段で）`;
  return `${md(t + 86400)} 朝6〜7時（ニューヨーク市場が閉まった値段で）`;
}

// 売買する時刻
export function execText(mode, day = false) {
  if (day) return 'すぐ（次の15分足の始まり）';
  if (mode === 'stock') return '次の取引日の朝9:00（寄り付き）';
  if (mode === 'us') return '次の取引日の夜（日本時間22:30〜23:30の取引開始）';
  return '次の取引日の朝7時ごろ（週明けは月曜の朝）';
}
