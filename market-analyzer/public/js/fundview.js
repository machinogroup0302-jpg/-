// ファンダメンタルズ分析の表（チャート画面とニュースタブの両方に表示）
import { api, $, esc } from './util.js';
import { term } from './glossary.js';

let lastKey = '';
let lastHtml = '';

function cls(signal) {
  return signal === '上がる要因' ? 'buy' : signal === '下がる要因' ? 'sell' : 'neutral';
}

export function renderFundamentals(d, isFx) {
  if (!d.rows.length) return '<p class="small muted">この銘柄のファンダメンタルズのデータは見つかりませんでした（指数やETFなど）。</p>';
  const pos = ((d.ratio + 1) / 2) * 100;
  const up = d.rows.filter((r) => r.signal === '上がる要因').length, down = d.rows.filter((r) => r.signal === '下がる要因').length;
  return `
    <div class="gauge"><span class="big ${d.ratio > 0.15 ? 'plus' : d.ratio < -0.15 ? 'minus' : ''}" style="font-size:18px">${esc(d.label)}</span>
      <div class="meter" aria-hidden="true"><span style="left:${pos}%"></span></div></div>
    <p class="small muted" style="margin:0 0 6px">上がる要因 ${up} ／ 下がる要因 ${down} ／ 中立 ${d.rows.length - up - down}${isFx ? '　※「上がる」はこの通貨ペアの値段が上がる（左側の通貨が強くなる）こと' : ''}</p>
    <ul class="list">${d.rows.map((r) => `
      <li><div class="li-head"><span class="name">${term(r.key, r.name)}</span><span class="badge ${cls(r.signal)}">${esc(r.signal)}</span></div>
      <div class="small"><b class="num">${esc(r.value)}</b>　<span class="muted">${esc(r.detail)}</span></div></li>`).join('')}</ul>
    <p class="notice" style="margin-top:8px">数字から機械的に判定した目安です。急なニュースや決算発表で大きく変わることがあります。</p>`;
}

function show(html) {
  lastHtml = html;
  ['fund-box', 'fund-box-news'].forEach((id) => { if ($(id)) $(id).innerHTML = html; });
}

export async function updateFundamentals(st) {
  const key = `${st.symbol}|${st.name}`;
  if (key === lastKey) { show(lastHtml); return; }
  lastKey = key;
  show('<p class="small muted"><span class="spinner"></span> 読み込み中…</p>');
  try {
    const d = await api(`/api/fundamentals?symbol=${encodeURIComponent(st.symbol)}&name=${encodeURIComponent(st.name || '')}`);
    if (key === lastKey) show(renderFundamentals(d, /=X$/.test(st.symbol)));
  } catch (e) {
    if (key === lastKey) show(`<p class="error">${esc(e.message)}</p>`);
  }
}
