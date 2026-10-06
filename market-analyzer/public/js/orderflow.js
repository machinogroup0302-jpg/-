// 注文・約定分析（株）：買いと売り・積極的な買いと売り・大口の買いと売りを円グラフで表示
import { api, $, esc } from './util.js';
import { term } from './glossary.js';
import { flowBreakdown, lastSession } from './volume.js';

let lastKey = '';

// ドーナツ形の円グラフ
function donut(parts, center) {
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = parts.filter((p) => p.value > 0).map((p) => {
    const len = p.value * C;
    const arc = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.color}" stroke-width="22" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"/>`;
    offset += len;
    return arc;
  }).join('');
  return `<svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${Math.round(p.value * 100)}%`).join('、'))}">
    <circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--surface-2)" stroke-width="22"/>${arcs}
    <text x="70" y="66" text-anchor="middle" font-size="13" font-weight="800" fill="var(--text)">${esc(center[0])}</text>
    <text x="70" y="84" text-anchor="middle" font-size="12" fill="var(--muted)">${esc(center[1])}</text></svg>`;
}

function legend(parts) {
  return `<div class="small" style="display:grid;gap:2px">${parts.map((p) => `<div><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${p.color};margin-right:6px;vertical-align:-1px"></i>${esc(p.label)} <b class="num">${Math.round(p.value * 100)}%</b></div>`).join('')}</div>`;
}

function block(title, parts, center) {
  return `<div class="flow-item"><h3>${title}</h3><div class="flow-row">${donut(parts, center)}${legend(parts)}</div></div>`;
}

function verdict(a, b) {
  if (a >= 0.55) return ['買いが優勢', 'plus'];
  if (b >= 0.55) return ['売りが優勢', 'minus'];
  return ['ほぼ互角', ''];
}

export function renderFlow(f) {
  const BUY = 'var(--buy)', SELL = 'var(--sell)', GRAY = 'var(--neutral)';
  const [v1, c1] = verdict(f.buySell.buy, f.buySell.sell);
  const aggTotal = f.aggressive.buy + f.aggressive.sell || 1;
  const [v2] = verdict(f.aggressive.buy / aggTotal, f.aggressive.sell / aggTotal);
  const bigTotal = f.big.buy + f.big.sell;
  const [v3] = bigTotal > 0.02 ? verdict(f.big.buy / bigTotal, f.big.sell / bigTotal) : ['大口は少ない'];
  const time = (t) => new Date(t * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return `
    <div class="li-head" style="margin-bottom:6px"><span class="name">今日の売買のまとめ</span><span class="badge ${c1 === 'plus' ? 'buy' : c1 === 'minus' ? 'sell' : 'neutral'}">${v1}</span></div>
    <p class="small muted" style="margin:0 0 8px">${time(f.from)}〜${time(f.to)} の5分ごとの売買から推定</p>
    <div class="flow-grid">
      ${block('買いと売り', [{ label: '買い', value: f.buySell.buy, color: BUY }, { label: '売り', value: f.buySell.sell, color: SELL }], [`買い${Math.round(f.buySell.buy * 100)}%`, v1])}
      ${block(term('aggressive', '積極買い・積極売り'), [{ label: '積極買い', value: f.aggressive.buy, color: BUY }, { label: '積極売り', value: f.aggressive.sell, color: SELL }, { label: '値段変わらず', value: f.aggressive.flat, color: GRAY }], [`積極買い${Math.round(f.aggressive.buy * 100)}%`, v2])}
      ${block(term('bigTrade', '大口の買い・売り'), [{ label: '大口の買い', value: f.big.buy, color: BUY }, { label: '大口の売り', value: f.big.sell, color: SELL }, { label: '小口（ふつうの量）', value: f.big.small, color: GRAY }], [`大口${Math.round(bigTotal * 100)}%`, v3])}
    </div>
    <p class="notice" style="margin-top:8px">証券会社の板や歩み値（1件ごとの売買の記録）は無料では手に入らないため、5分ごとの値動きと売買の量から推定しています。正確な数字ではなく「傾向」として見てください。</p>`;
}

export async function updateOrderflow(st, mode) {
  const box = $('orderflow-box');
  if (mode === 'fx') return;
  const key = st.symbol;
  if (key === lastKey && box.dataset.loaded) return;
  lastKey = key;
  box.dataset.loaded = '';
  box.innerHTML = '<p class="small muted"><span class="spinner"></span> 読み込み中…</p>';
  try {
    const data = await api(`/api/chart?symbol=${encodeURIComponent(st.symbol)}&tf=5m`);
    if (key !== lastKey) return;
    const f = flowBreakdown(lastSession(data.candles));
    box.innerHTML = f ? renderFlow(f) : '<p class="small muted">売買の量のデータがありません（指数や、取引が少ない銘柄では表示できません）。</p>';
    box.dataset.loaded = '1';
  } catch (e) {
    if (key === lastKey) box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// 自動更新のときに、もう一度読み込めるようにする
export function resetOrderflow() {
  lastKey = '';
}
