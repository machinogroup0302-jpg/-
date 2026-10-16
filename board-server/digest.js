// 「2日後の予定・引き落とし」のまとめ（毎朝のメール用）
// 画面（todo/index.html）と同じ決まりで計算する
const YEN = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
const OWNERS = { corp: '法人', personal: '個人' };
const pad = (n) => String(n).padStart(2, '0');
// 日付はすべて「日本の暦の年月日」として UTC で扱う（サーバーの時差に左右されないように）
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const mkey = (y, m) => `${y}-${pad(m + 1)}`;
const parse = (s) => new Date(s + 'T00:00:00Z');
const lastOf = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// 何日後の日付か（日本時間）。メールは2日前に知らせる
export const DAYS_AHEAD = 2;
export function aheadJst(days = DAYS_AHEAD, now = Date.now()) {
  const d = new Date(now + 9 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

function amountOf(fixed, p, k) {
  const v = fixed.amounts?.[k]?.[p.id];
  if (v != null) return +v;
  return p.fixedAmount && k >= (p.fixedFrom || '') ? +p.fixedAmount : 0;
}
// シートの行の月（y, m）の分が実際に引き落とされる日
function payDate(p, y, m) {
  if (!p.day) return null;
  const t = new Date(Date.UTC(y, m + (+p.shift || 0), 1));
  const ty = t.getUTCFullYear(), tm = t.getUTCMonth(), last = lastOf(ty, tm);
  return ymd(new Date(Date.UTC(ty, tm, p.day === 'end' ? last : Math.min(+p.day, last))));
}
export function paymentsOn(fixed, ds) {
  const out = [];
  const d = parse(ds);
  // 「翌月」払いがあるので、前の月の行も見る
  for (const back of [1, 0]) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
    const y = t.getUTCFullYear(), m = t.getUTCMonth(), k = mkey(y, m);
    for (const p of fixed.payees || []) {
      const amount = amountOf(fixed, p, k);
      if (amount && payDate(p, y, m) === ds) out.push({ name: p.name, owner: p.owner, amount, method: p.method || '' });
    }
  }
  for (const o of fixed.oneoffs || []) {
    if (o.date === ds && +o.amount) out.push({ name: o.name, owner: o.owner, amount: +o.amount, method: o.method || '' });
  }
  return out.sort((a, b) => b.amount - a.amount);
}
function occursOn(ev, ds) {
  if (!ev.repeat) return ev.date === ds;
  if (ds < ev.date) return false;
  const a = parse(ev.date), b = parse(ds);
  const last = lastOf(b.getUTCFullYear(), b.getUTCMonth());
  if (ev.repeat === 'weekly') return a.getUTCDay() === b.getUTCDay();
  if (ev.repeat === 'monthend') return b.getUTCDate() === last;
  if (ev.repeat === 'yearly' && a.getUTCMonth() !== b.getUTCMonth()) return false;
  return b.getUTCDate() === Math.min(a.getUTCDate(), last);
}
export function eventsOn(schedule, ds) {
  return (schedule?.list || [])
    .filter((ev) => occursOn(ev, ds) && !(ev.repeat ? (ev.doneDates || []).includes(ds) : ev.done))
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
}

// メールの中身。予定も引き落としもなければ count: 0
export function buildDigest({ schedule, fixed, settings }, ds, siteUrl = '') {
  const evs = eventsOn(schedule, ds);
  const pays = paymentsOn(fixed || {}, ds);
  const d = parse(ds);
  const label = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${'日月火水木金土'[d.getUTCDay()]}）`;
  const lines = [`2日後（あさって）${label} のお知らせです。`, ''];
  if (evs.length) {
    lines.push('■ 予定');
    for (const ev of evs) lines.push(`・${ev.time ? ev.time + ' ' : ''}${ev.title}${ev.memo ? `（${ev.memo}）` : ''}`);
    lines.push('');
  }
  if (pays.length) {
    lines.push('■ 引き落とし');
    for (const o of ['corp', 'personal']) {
      const ps = pays.filter((p) => p.owner === o);
      if (!ps.length) continue;
      lines.push(`${OWNERS[o]}　合計 ${YEN(ps.reduce((s, p) => s + p.amount, 0))}`);
      for (const p of ps) lines.push(`　・${p.name} ${YEN(p.amount)}${p.method ? `（${p.method}）` : ''}`);
    }
    lines.push('');
  }
  if (!evs.length && !pays.length) lines.push('この日は予定も引き落としもありません。', '');
  if (siteUrl) lines.push(siteUrl);
  const total = pays.reduce((s, p) => s + p.amount, 0);
  const subject = `【やることボード】あさって${label}：` +
    ([evs.length && `予定${evs.length}件`, pays.length && `引き落とし ${YEN(total)}`].filter(Boolean).join('・') || '予定・引き落としなし');
  return {
    date: ds,
    to: settings?.notify && settings?.email ? settings.email : '',
    count: evs.length + pays.length,
    subject,
    text: lines.join('\n'),
  };
}
