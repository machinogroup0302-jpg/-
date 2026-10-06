// レーティング（アナリストの評価・目標株価）と PTS（夜間などの私設市場）の表示
import { api, $, esc, fmtPrice } from './util.js';
import { term } from './glossary.js';

let lastKey = '';

function money(v, isUs) {
  if (v == null) return '—';
  return isUs ? `$${fmtPrice(v, 2)}` : `${fmtPrice(v, v >= 1000 ? 0 : 1)}円`;
}

function countsBar(c) {
  const parts = [['strongBuy', '強い買い', 'var(--buy)', 1], ['buy', '買い', 'var(--buy)', 0.6], ['hold', '中立', 'var(--neutral)', 0.6], ['sell', '売り', 'var(--sell)', 0.6], ['strongSell', '強い売り', 'var(--sell)', 1]];
  const total = parts.reduce((s, [k]) => s + (c[k] || 0), 0);
  if (!total) return '';
  return `<div style="display:flex;height:14px;border-radius:999px;overflow:hidden;margin:8px 0 4px">${parts.map(([k, , color, op]) => (c[k] ? `<span style="flex:${c[k]};background:${color};opacity:${op}"></span>` : '')).join('')}</div>
    <div class="small muted">${parts.filter(([k]) => c[k]).map(([k, label]) => `${label} ${c[k]}人`).join('　')}</div>`;
}

function render(d, isUs) {
  const s = d.summary;
  const box = $('rating-box');
  let html = '';
  if (s && (s.consensus || s.target?.mean || s.history?.length)) {
    const upside = s.target?.mean && s.price ? (s.target.mean / s.price - 1) * 100 : null;
    html += `
      ${s.consensus ? `<div class="li-head" style="margin-bottom:4px"><span class="name">アナリスト${s.analysts ? `${s.analysts}人` : ''}の${term('consensus', '平均の評価')}</span>
        <span class="badge ${/買い/.test(s.consensus) ? 'buy' : /売り/.test(s.consensus) ? 'sell' : 'neutral'}">${esc(s.consensus)}</span></div>` : ''}
      ${s.counts ? countsBar(s.counts) : ''}
      ${s.target?.mean ? `<div class="grid2" style="margin-top:10px">
        <div class="stat"><div class="label">${term('target', '目標株価')}（平均）</div><div class="value">${money(s.target.mean, isUs)}</div></div>
        <div class="stat"><div class="label">今の値段との差</div><div class="value ${upside >= 0 ? 'plus' : 'minus'}">${upside == null ? '—' : `${upside >= 0 ? '+' : ''}${upside.toFixed(1)}%`}</div></div>
        <div class="stat"><div class="label">一番高い目標</div><div class="value small num">${money(s.target.high, isUs)}</div></div>
        <div class="stat"><div class="label">一番低い目標</div><div class="value small num">${money(s.target.low, isUs)}</div></div>
      </div>` : ''}
      ${s.history?.length ? `<h3>最近の評価の変更</h3><ul class="list">${s.history.map((h) => `
        <li><div class="li-head"><span class="name small">${esc(h.date)}　${esc(h.firm)}</span>
          <span class="badge ${h.up ? 'buy' : h.down ? 'sell' : 'neutral'}">${esc(h.action)}</span></div>
          <div class="small">${h.from && h.from !== h.to ? `${esc(h.from)} → ` : ''}<b>${esc(h.to)}</b></div></li>`).join('')}</ul>` : ''}`;
  }
  if (d.news?.length) {
    html += `<h3>レーティングのニュース</h3><ul class="list">${d.news.map((n) => `
      <li><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--text);font-weight:600;text-decoration:none">${esc(n.title)}</a>
      <div class="small muted">${esc(n.source)}・${esc(n.date ? new Date(n.date).toLocaleDateString('ja-JP') : '')}</div></li>`).join('')}</ul>`;
  }
  box.innerHTML = html || '<p class="small muted">この銘柄のレーティング情報は見つかりませんでした（アナリストが評価していない銘柄もあります）。</p>';
  box.insertAdjacentHTML('beforeend', '<p class="notice" style="margin-top:8px">レーティングは証券会社のアナリストの意見で、当たるとは限りません。参考の一つにしてください。</p>');
}

export async function updateRatings(st, mode) {
  if (mode === 'fx') return;
  const key = `${st.symbol}|${st.name}`;
  if (key === lastKey) return;
  lastKey = key;
  const box = $('rating-box');
  box.innerHTML = '<p class="small muted"><span class="spinner"></span> 読み込み中…</p>';
  try {
    const d = await api(`/api/ratings?symbol=${encodeURIComponent(st.symbol)}&name=${encodeURIComponent(st.name || '')}`);
    if (key === lastKey) render(d, mode === 'us');
  } catch (e) {
    if (key === lastKey) box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ---------------- PTS ----------------
// ジャパンネクスト証券の取引時間（デイタイム 8:20〜16:00 / ナイトタイム 16:30〜23:59）
export function ptsSession(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = jst.getUTCDay();
  const m = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  if (day === 0 || day === 6) return { open: false, label: '土日はお休みです' };
  if (m >= 8 * 60 + 20 && m < 16 * 60) return { open: true, label: 'デイタイム取引中（8:20〜16:00）' };
  if (m >= 16 * 60 + 30) return { open: true, label: 'ナイトタイム取引中（16:30〜23:59）' };
  return { open: false, label: m < 8 * 60 + 20 ? '朝8:20から取引できます' : '16:30からナイトタイムが始まります' };
}

export function updatePts(st, mode) {
  if (mode !== 'stock') return;
  const box = $('pts-box');
  const code = (st.symbol || '').replace(/\.T$/, '');
  if (!/^[0-9][0-9A-Z]{3}$/.test(code)) {
    box.innerHTML = '<p class="small muted">個別の会社の株を表示すると、PTSの値段を確認できます（指数にはPTSはありません）。</p>';
    return;
  }
  const s = ptsSession();
  box.innerHTML = `
    <div class="li-head" style="margin-bottom:8px"><span class="name small">今のPTS</span><span class="badge ${s.open ? 'ok' : 'neutral'}">${esc(s.label)}</span></div>
    <div class="stack">
      <a class="btn block" href="https://kabutan.jp/stock/?code=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer">株探でPTSの値段を見る ↗</a>
      <a class="btn block" href="https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T" target="_blank" rel="noopener noreferrer">Yahoo!ファイナンスで見る ↗</a>
    </div>
    <p class="small muted" style="margin:8px 0 0">PTSの値段は無料で自動取得できる公式の仕組みがないため、ボタンから各サイトのページを開いて確認します。iSPEED でも「PTS」の値段を確認できます。</p>`;
}
