// チャート画面に「決算発表まであと○日」を出す（日本株）
import { api, $, esc } from './util.js';

let lastKey = '';

// 日本時間の今日（YYYY-MM-DD）
export function jstToday(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 2つの日付（YYYY-MM-DD）の差を日数で
export function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function mdw(date) {
  const d = new Date(date + 'T00:00:00Z');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`;
}

// 決算期（2027-03）→「3月決算」
const fiscal = (p) => (/^\d{4}-\d{2}$/.test(p || '') ? `${Number(p.slice(5))}月決算` : '');
const kindLabel = (k) => (k && k !== '-' ? k.replace(/^第(\d)四半期$/, '第$1四半期（3か月ごとの決算）') : '決算');

// 何日後かで、注意の強さを変える
export function earningsInfo(item, today) {
  const days = daysBetween(today, item.date);
  const when = days === 0 ? '今日' : days === 1 ? '明日' : days > 0 ? `あと${days}日` : `${-days}日前に発表済み`;
  const level = days < 0 ? 'neutral' : days <= 3 ? 'bad' : days <= 14 ? 'warn' : 'neutral';
  let advice;
  if (days < 0) advice = '発表のあと数日は、結果を受けて値動きが荒くなりやすいです。';
  else if (days <= 3) advice = '発表が目の前です。結果しだいで翌朝に大きく上下することがあります。持ち越すなら、損切りの値段を必ず決めておきましょう。';
  else if (days <= 14) advice = '発表が近づいています。発表前は様子見の人が増え、動きが小さくなったり、期待で先に動いたりします。';
  else advice = 'まだ先ですが、日付を覚えておきましょう。';
  return { days, when, level, advice };
}

export function renderEarnings(items, today, name) {
  if (!items.length) {
    return { badge: '', html: '<p class="small muted">この銘柄の決算発表の予定は、まだ公表されていません（日本取引所が、発表のだいたい1〜2か月前から公表します）。</p>' };
  }
  const next = items.find((x) => x.date >= today) || items[items.length - 1];
  const info = earningsInfo(next, today);
  const badge = info.days >= 0
    ? `<span class="badge ${info.level}">📅 決算発表まで${info.days === 0 ? '：今日' : info.days === 1 ? '：明日' : ` あと${info.days}日`}（${mdw(next.date)}）</span>`
    : '';
  const big = info.days >= 0 ? (info.days === 0 ? '今日' : info.days === 1 ? '明日' : `あと<b class="num" style="font-size:28px">${info.days}</b>日`) : info.when;
  const rows = items.map((x) => {
    const i = earningsInfo(x, today);
    return `<tr><td>${esc(mdw(x.date))}</td><td>${esc(i.when)}</td><td>${esc(kindLabel(x.kind))}${fiscal(x.period) ? `・${esc(fiscal(x.period))}` : ''}</td></tr>`;
  }).join('');
  const html = `
    <div class="li-head" style="align-items:center;margin-bottom:6px"><span class="name">${esc(name || next.name)}</span><span class="badge ${info.level}">${esc(info.when)}</span></div>
    <div style="font-size:18px;margin:4px 0">${info.days >= 0 ? '次の決算発表まで ' : ''}${big}　<span class="small muted">${esc(mdw(next.date))}・${esc(kindLabel(next.kind))}${fiscal(next.period) ? `・${esc(fiscal(next.period))}` : ''}</span></div>
    <p class="small" style="margin:4px 0 8px">${esc(info.advice)}</p>
    ${items.length > 1 ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>日付</th><th>いつ</th><th>内容</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    <p class="small muted" style="margin:6px 0 0">日本取引所が公表している予定日です。会社の都合で変わることがあります。</p>`;
  return { badge, html };
}

export async function updateEarningsCard(st, mode) {
  const box = $('earn-box'), q = $('q-earn');
  if (mode !== 'stock') { q.hidden = true; return; }
  const code = (st.symbol || '').replace(/\.T$/, '');
  if (!/^[0-9][0-9A-Z]{3}$/.test(code)) {
    q.hidden = true;
    box.innerHTML = '<p class="small muted">個別の会社の株を表示すると、決算発表の日が出ます（指数には決算はありません）。</p>';
    lastKey = '';
    return;
  }
  const today = jstToday();
  const key = `${code}|${today}`;
  if (key === lastKey) return;
  lastKey = key;
  q.hidden = true;
  box.innerHTML = '<p class="small muted"><span class="spinner"></span> 読み込み中…</p>';
  try {
    const from = new Date(Date.parse(today) - 14 * 86400000).toISOString().slice(0, 10);
    const d = await api(`/api/stocks/earnings?codes=${encodeURIComponent(code)}&from=${from}`);
    if (key !== lastKey) return;
    const { badge, html } = renderEarnings(d.items || [], today, st.name);
    box.innerHTML = html;
    q.innerHTML = badge;
    q.hidden = !badge;
    q.onclick = () => box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    if (key === lastKey) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; lastKey = ''; }
  }
}
