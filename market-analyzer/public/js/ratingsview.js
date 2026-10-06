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

function firmTable(rows, isUs) {
  if (!rows?.length) return '';
  const tp = (r) => {
    if (r.targetTo == null) return '<span class="muted">—</span>';
    const from = r.targetFrom != null && r.targetFrom !== r.targetTo ? `<span class="muted">${money(r.targetFrom, isUs)} → </span>` : '';
    return `${from}<b class="${r.up ? 'plus' : r.down ? 'minus' : ''}">${money(r.targetTo, isUs)}</b>`;
  };
  return `<h3>各社の評価と${term('target', '目標株価')}</h3>
    <div class="tbl-wrap"><table class="tbl rating-tbl"><thead><tr><th>日付</th><th>証券会社</th><th>評価</th><th class="r">目標株価</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td class="small">${esc((r.date || '').slice(5).replace('-', '/'))}</td>
      <td class="small">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--text)">${esc(r.firm)}</a>` : esc(r.firm)}</td>
      <td class="small"><span class="badge ${r.up ? 'buy' : r.down ? 'sell' : 'neutral'}">${esc(r.to || r.action || '—')}</span>${r.to && r.action ? `<div class="muted" style="font-size:11px">${esc(r.action)}</div>` : ''}</td>
      <td class="r small">${tp(r)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function render(d, isUs) {
  const s = d.summary;
  const box = $('rating-box');
  let html = '';
  if (s && (s.consensus || s.target?.mean)) {
    const upside = s.target?.mean && s.price ? (s.target.mean / s.price - 1) * 100 : null;
    html += `
      ${s.consensus ? `<div class="li-head" style="margin-bottom:4px"><span class="name">アナリスト${s.analysts ? `${s.analysts}人` : ''}の${term('consensus', '平均の評価')}</span>
        <span class="badge ${/買い/.test(s.consensus) ? 'buy' : /売り/.test(s.consensus) ? 'sell' : 'neutral'}">${esc(s.consensus)}</span></div>` : ''}
      ${s.counts ? countsBar(s.counts) : ''}
      ${s.target?.mean ? `<div class="grid2" style="margin-top:10px">
        <div class="stat"><div class="label">目標株価の平均</div><div class="value">${money(s.target.mean, isUs)}</div></div>
        <div class="stat"><div class="label">今の値段との差</div><div class="value ${upside >= 0 ? 'plus' : 'minus'}">${upside == null ? '—' : `${upside >= 0 ? '+' : ''}${upside.toFixed(1)}%`}</div></div>
        <div class="stat"><div class="label">一番高い目標</div><div class="value small num">${money(s.target.high, isUs)}</div></div>
        <div class="stat"><div class="label">一番低い目標</div><div class="value small num">${money(s.target.low, isUs)}</div></div>
      </div>` : ''}`;
  }
  html += firmTable(d.table, isUs);
  box.innerHTML = html || '<p class="small muted">この銘柄のレーティング情報は見つかりませんでした（アナリストが評価していない銘柄もあります）。</p>';
  box.insertAdjacentHTML('beforeend', `<p class="notice" style="margin-top:8px">${isUs ? '' : '日本株の各社の評価は、ニュースの見出しから自動で読み取っています（証券会社名をタップすると元の記事が開きます）。'}レーティングはアナリストの意見で、当たるとは限りません。</p>`);
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
// ジャパンネクスト証券の取引時間（デイタイム 8:20〜16:00 / ナイトタイム 17:00〜翌6:00）
export function ptsSession(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = jst.getUTCDay();
  const m = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const weekday = (d) => d >= 1 && d <= 5;
  if (weekday(day) && m >= 8 * 60 + 20 && m < 16 * 60) return { open: true, label: 'デイタイム取引中（8:20〜16:00）' };
  if (weekday(day) && m >= 17 * 60) return { open: true, label: 'ナイトタイム取引中（17:00〜翌6:00）' };
  // 夜中〜朝6時は前の日のナイトタイムの続き（月曜の朝は休み）
  if (m < 6 * 60 && weekday(day - 1 < 0 ? 6 : day - 1) && day !== 1) return { open: true, label: 'ナイトタイム取引中（17:00〜翌6:00）' };
  if (!weekday(day)) return { open: false, label: '土日はお休みです' };
  return { open: false, label: m < 8 * 60 + 20 ? '朝8:20から取引できます' : '17:00からナイトタイムが始まります' };
}

export function updatePts(st, mode) {
  if (mode !== 'stock') return;
  const box = $('pts-box');
  const code = (st.symbol || '').replace(/\.T$/, '');
  const s = ptsSession();
  const rankings = `
    <h3>今夜のPTSで動いている株（ランキング）</h3>
    <div class="stack">
      <a class="btn block" href="https://kabutan.jp/warning/pts_night_trading_value_ranking" target="_blank" rel="noopener noreferrer">売買の金額が多い株の一覧 ↗</a>
      <a class="btn block" href="https://kabutan.jp/warning/pts_night_volume_ranking" target="_blank" rel="noopener noreferrer">たくさん売買された株の一覧 ↗</a>
    </div>`;
  if (!/^[0-9][0-9A-Z]{3}$/.test(code)) {
    box.innerHTML = `<div class="li-head" style="margin-bottom:8px"><span class="name small">今のPTS</span><span class="badge ${s.open ? 'ok' : 'neutral'}">${esc(s.label)}</span></div>
      <p class="small muted">個別の会社の株を表示すると、その株のPTSの値段のページを開けます（指数にはPTSはありません）。</p>${rankings}`;
    return;
  }
  box.innerHTML = `
    <div class="li-head" style="margin-bottom:8px"><span class="name small">今のPTS</span><span class="badge ${s.open ? 'ok' : 'neutral'}">${esc(s.label)}</span></div>
    <div class="stack">
      <a class="btn primary block" href="https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T" target="_blank" rel="noopener noreferrer">${esc(st.name || code)} のPTSの値段を見る ↗</a>
      <a class="btn block" href="https://kabutan.jp/stock/?code=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer">株探で見る ↗</a>
    </div>
    ${rankings}
    <p class="small muted" style="margin:8px 0 0">PTSの値段を載せているサイトは、どこも利用規約でプログラムによる自動取得を禁止しているため、このサイトの中には直接表示できません。ボタンを押すと、その株のページ（PTSの値段が載っている場所）がすぐ開きます。</p>`;
}
