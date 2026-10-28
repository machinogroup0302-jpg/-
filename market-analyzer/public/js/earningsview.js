// チャート画面に「決算発表まであと○日」を出す（日本株）
import { api, $, esc } from './util.js';
import { errText } from './report.js';

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

// 決算後の見通し：上がりやすい・下がりやすい・五分五分と、その理由
export function outlookHtml(o) {
  const V = { up: ['📈 上がる材料の方が多い', 'ok'], down: ['📉 下がる材料の方が多い', 'danger'], even: ['⚖️ 材料はまちまち（どちらとも言えない）', 'warn'] };
  const [label, cls] = V[o.verdict] || V.even;
  const mark = (p) => (p > 0 ? '<span class="plus">＋</span>' : p < 0 ? '<span class="minus">－</span>' : '<span class="muted">・</span>');
  return `<div class="stat" style="margin-top:10px">
    <div class="label">決算後の見通し（目安）</div>
    <div class="verdict ${cls}" style="font-size:15px">${label}</div>
    ${o.swing != null ? `<p class="small" style="margin:4px 0">この会社は、決算の翌日にふだん<b>±${(o.swing * 100).toFixed(1)}%くらい</b>動きます。</p>` : ''}
    <ul class="why" style="font-size:13px;color:var(--text)">${o.items.map((x) => `<li>${mark(x.pts)} ${esc(x.text)}</li>`).join('')}</ul>
    ${o.reactions?.length ? `<details class="more-box"><summary>過去の決算の翌日の動き（${o.reactions.length}回）</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>日付（推定）</th><th class="r">翌日</th><th class="r">2日間</th><th class="r">出来高</th></tr></thead><tbody>
      ${o.reactions.slice().reverse().map((r) => `<tr><td class="small">${esc(r.date.slice(0, 4))}/${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}</td><td class="r small ${r.ret >= 0 ? 'plus' : 'minus'}">${r.ret >= 0 ? '+' : ''}${(r.ret * 100).toFixed(1)}%</td><td class="r small ${r.ret2 >= 0 ? 'plus' : 'minus'}">${r.ret2 >= 0 ? '+' : ''}${(r.ret2 * 100).toFixed(1)}%</td><td class="r small">${r.volRatio.toFixed(1)}倍</td></tr>`).join('')}
      </tbody></table></div><p class="small muted" style="margin:4px 0 0">過去の発表日は、3か月ごとに出来高が急に増えた日から推定しています。</p></details>` : ''}
    <p class="small muted" style="margin:6px 0 0">過去の決算の動き・業績・ニュース・掲示板やSNSの声・発表前の値動きを、上がる材料（＋）と下がる材料（－）として数えたものです。<b>確率ではありません</b>。決算は中身と「期待との差」で動くので、材料が多くても逆に動くことはよくあります。持ち越すなら、損切りの値段を決めておきましょう。</p>
  </div>`;
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
    // 次の決算のあと、上がりやすいか・下がりやすいか
    const next = (d.items || []).find((x) => x.date >= today);
    if (next) {
      const ob = document.createElement('div');
      ob.innerHTML = '<p class="small muted"><span class="spinner"></span> 決算のあと上がりやすいか、過去の決算・業績・ニュース・みんなの声から調べています…</p>';
      box.appendChild(ob);
      api(`/api/stocks/earnings-outlook?symbol=${encodeURIComponent(`${code}.T`)}&name=${encodeURIComponent(st.name || next.name || '')}&date=${next.date}`)
        .then((o) => { if (key === lastKey) ob.innerHTML = outlookHtml(o); })
        .catch(() => { if (key === lastKey) ob.innerHTML = '<p class="small muted">決算後の見通しは、今は調べられませんでした。</p>'; });
    }
    q.innerHTML = badge;
    q.hidden = !badge;
    q.onclick = () => box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    if (key === lastKey) { box.innerHTML = `<p class="error">${esc(errText('チャート・決算', e))}</p>`; lastKey = ''; }
  }
}
