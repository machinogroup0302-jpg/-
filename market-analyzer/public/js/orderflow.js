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
    const arc = `<circle r="${R}" cx="70" cy="70" fill="none" style="stroke:${p.color}" stroke-width="22" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"/>`;
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
      ${block(term('bigTrade', '大口・中口・小口'), [
        { label: '大口の買い', value: f.size.bigBuy, color: BUY }, { label: '中口の買い', value: f.size.midBuy, color: 'color-mix(in srgb, var(--buy) 55%, transparent)' },
        { label: '大口の売り', value: f.size.bigSell, color: SELL }, { label: '中口の売り', value: f.size.midSell, color: 'color-mix(in srgb, var(--sell) 55%, transparent)' },
        { label: '小口（ふつうの量）', value: f.size.small, color: GRAY }], [`大口${Math.round(bigTotal * 100)}%`, v3])}
    </div>
    <p class="notice" style="margin-top:8px">証券会社の板や歩み値（1件ごとの売買の記録）は無料では手に入らないため、5分ごとの値動きと売買の量から推定しています。正確な数字ではなく「傾向」として見てください。</p>`;
}

const shares = (v) => (v >= 1e8 ? `${(v / 1e8).toFixed(2)}億株` : v >= 1e4 ? `${(v / 1e4).toFixed(1)}万株` : `${Math.round(v).toLocaleString()}株`);
const diff = (v) => (v == null ? '' : `<span class="${v >= 0 ? 'plus' : 'minus'}">（前日比 ${v >= 0 ? '+' : '−'}${shares(Math.abs(v))}）</span>`);

// 信用取引の残り（日本取引所が毎日公表している銘柄別の残高）
export function renderMargin(m, date, todayVolume) {
  if (!m) return '<p class="small muted">この銘柄の信用取引の残高データはありません（信用取引ができない銘柄や、ETFなど）。</p>';
  const ratio = m.sell > 0 ? m.buy / m.sell : null;
  const BUY = 'var(--buy)', SELL = 'var(--sell)';
  const total = m.buy + m.sell || 1;
  const days = todayVolume > 0 ? m.buy / todayVolume : null;
  const d = date ? `${date.slice(4, 6)}/${date.slice(6, 8)}` : '';
  return `
    <div class="flow-item"><div class="flow-row">${donut([{ label: '信用買い残', value: m.buy / total, color: BUY }, { label: '信用売り残', value: m.sell / total, color: SELL }], [ratio == null ? '—' : `${ratio.toFixed(1)}倍`, '信用倍率'])}
      <div class="small" style="display:grid;gap:4px">
        <div><b>${term('marginBuy', '信用買い残')}</b> ${shares(m.buy)}${diff(m.buyChg)}</div>
        <div><b>信用売り残</b> ${shares(m.sell)}${diff(m.sellChg)}</div>
        <div><b>${term('marginRatio', '信用倍率')}</b> ${ratio == null ? '売り残なし' : `${ratio.toFixed(2)}倍`}</div>
        ${days != null ? `<div class="muted">信用買い残は、今日の売買量の${days.toFixed(1)}日分</div>` : ''}
      </div></div></div>
    <p class="small muted" style="margin:6px 0 0">${d ? `${d}時点・` : ''}日本取引所の公表データ（${esc(m.type || '')}）。信用買い残が多いほど「あとで売られる株」が多く、上値が重くなりやすいと言われます。</p>
    <p class="notice" style="margin-top:6px">「今日の売買のうち、信用買いと現物買いがそれぞれ何%か」は、どこからも公表されていないため出せません。代わりに、信用取引で買われてまだ残っている株数を表示しています。</p>`;
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
    const code = /\.T$/.test(st.symbol) ? st.symbol.replace(/\.T$/, '') : null;
    const [data, mg] = await Promise.all([
      api(`/api/chart?symbol=${encodeURIComponent(st.symbol)}&tf=5m`),
      code ? api(`/api/stocks/margin?code=${encodeURIComponent(code)}`).catch(() => null) : null,
    ]);
    if (key !== lastKey) return;
    const session = lastSession(data.candles);
    const f = flowBreakdown(session);
    const vol = session.reduce((a, c) => a + (c.volume || 0), 0);
    box.innerHTML = (f ? renderFlow(f) : '<p class="small muted">売買の量のデータがありません（指数や、取引が少ない銘柄では表示できません）。</p>')
      + (code ? `<h3>${term('margin', '信用取引の残り')}</h3>${renderMargin(mg?.item, mg?.date, vol)}` : '');
    box.dataset.loaded = '1';
  } catch (e) {
    if (key === lastKey) box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// 自動更新のときに、もう一度読み込めるようにする
export function resetOrderflow() {
  lastKey = '';
}
