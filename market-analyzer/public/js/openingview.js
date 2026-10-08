// 寄り付きのくせ（日本株）：朝9時の寄り付きが、その日の一番高いところ（寄り天）か一番安いところ（寄り底）になりやすいか
// PTS（夜間取引）などで前の日の終わりより上か下で始まりそうなときに、過去の同じような日がどうだったかを出す
import { api, $, esc, fmtPrice } from './util.js';

const BUCKETS = [
  ['大きく上で始まる（+2%以上）', (g) => g >= 0.02],
  ['少し上で始まる（+0.5〜2%）', (g) => g >= 0.005 && g < 0.02],
  ['ほぼ同じ（±0.5%）', (g) => g > -0.005 && g < 0.005],
  ['少し下で始まる（−0.5〜−2%）', (g) => g <= -0.005 && g > -0.02],
  ['大きく下で始まる（−2%以下）', (g) => g <= -0.02],
];

/**
 * 日足から、寄り付きのくせを数える
 * tol：高値（安値）との差がこの割合以内なら「寄り付きが一番高かった（安かった）」とみなす
 */
export function openingStats(candles, { tol = 0.002 } = {}) {
  const days = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1].close;
    if (!(prev > 0) || !(c.open > 0)) continue;
    days.push({
      gap: c.open / prev - 1,
      top: (c.high - c.open) / c.open <= tol,
      bottom: (c.open - c.low) / c.open <= tol,
      up: c.close > c.open,
      move: c.close / c.open - 1,
    });
  }
  const sum = (list) => ({
    n: list.length,
    top: list.length ? list.filter((d) => d.top).length / list.length : null,
    bottom: list.length ? list.filter((d) => d.bottom).length / list.length : null,
    up: list.length ? list.filter((d) => d.up).length / list.length : null,
    move: list.length ? list.reduce((a, d) => a + d.move, 0) / list.length : null,
  });
  return { all: sum(days), buckets: BUCKETS.map(([label, fn]) => ({ label, ...sum(days.filter((d) => fn(d.gap))) })), days: days.length };
}

export function bucketOf(gap) {
  return BUCKETS.findIndex(([, fn]) => fn(gap));
}

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

// その日の動きの見込みを一言で
export function openingVerdict(b) {
  if (!b || b.n < 5) return '過去に同じような日が少なく、はっきり言えません。';
  const parts = [];
  if (b.top >= 0.3) parts.push(`寄り天（朝9時が一番高い）になりやすい（${pct(b.top)}）`);
  if (b.bottom >= 0.3) parts.push(`寄り底（朝9時が一番安い）になりやすい（${pct(b.bottom)}）`);
  parts.push(b.up >= 0.55 ? `寄り付きより上がって終わりやすい（${pct(b.up)}）` : b.up <= 0.45 ? `寄り付きより下がって終わりやすい（上がって終わるのは${pct(b.up)}）` : `寄り付きのあと上がるか下がるかは五分五分（上がって終わる${pct(b.up)}）`);
  return parts.join('・');
}

let lastKey = '', stats = null, lastClose = null, today = null;

function renderDyn() {
  const input = Number(String($('opening-pts')?.value || '').normalize('NFKC').replace(/[,\s円]/g, ''));
  const gap = input > 0 && lastClose ? input / lastClose - 1 : (today ? today.gap : null);
  const idx = gap != null ? bucketOf(gap) : -1;
  const pick = idx >= 0 ? stats.buckets[idx] : null;
  $('opening-dyn').innerHTML = `
    ${pick ? `<div class="notice" style="margin:0 0 8px">${input > 0 ? `前の日の終わり（${fmtPrice(lastClose, 1)}円）から <b>${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(2)}%</b> で始まる場合` : `今日は前の日の終わりから <b>${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(2)}%</b> で始まりました`}（${esc(pick.label)}・過去${pick.n}日）：<br><b>${esc(openingVerdict(pick))}</b></div>` : ''}
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>朝9時の始まり方</th><th class="r">日数</th><th class="r">寄り天</th><th class="r">寄り底</th><th class="r">上で終わる</th></tr></thead><tbody>
      ${stats.buckets.map((bk, i) => `<tr${i === idx ? ' class="best"' : ''}><td class="small">${esc(bk.label)}</td><td class="r small">${bk.n}</td><td class="r small">${pct(bk.top)}</td><td class="r small">${pct(bk.bottom)}</td><td class="r small">${pct(bk.up)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function render() {
  const box = $('opening-box');
  if (!stats) return;
  box.innerHTML = `
    <p class="small muted" style="margin:0 0 6px">過去${stats.days}日分（約2年）の日足から数えています。</p>
    <div class="grid2" style="margin-bottom:8px">
      <div class="stat"><div class="label">寄り天（朝9時が一番高い）</div><div class="value">${pct(stats.all.top)}</div></div>
      <div class="stat"><div class="label">寄り底（朝9時が一番安い）</div><div class="value">${pct(stats.all.bottom)}</div></div>
      <div class="stat"><div class="label">寄り付きより上で終わる</div><div class="value ${stats.all.up >= 0.5 ? 'plus' : 'minus'}">${pct(stats.all.up)}</div></div>
      <div class="stat"><div class="label">寄り付きからの平均の動き</div><div class="value ${stats.all.move >= 0 ? 'plus' : 'minus'}">${stats.all.move >= 0 ? '+' : ''}${(stats.all.move * 100).toFixed(2)}%</div></div>
    </div>
    <label class="small" for="opening-pts"><b>PTSの値段（または朝の気配値）を入れると、今日の見込みを出します</b></label>
    <div class="row" style="margin:4px 0 8px"><input class="input grow" id="opening-pts" inputmode="decimal" placeholder="例: ${lastClose ? fmtPrice(lastClose * 1.01, 1) : '3000'}"><span class="small">円</span></div>
    <div id="opening-dyn"></div>
    <p class="small muted" style="margin:6px 0 0">「寄り天」は、朝9時の始まりの値段がその日の一番高い値段（の0.2%以内）だった日です。PTSの値段そのものは自動では取れないため、PTSのボタンから見た値段を入れてください。過去のくせで、当たる保証はありません。</p>`;
  $('opening-pts').addEventListener('input', renderDyn);
  renderDyn();
}

export async function updateOpening(st, mode) {
  if (mode !== 'stock') return;
  const box = $('opening-box');
  const code = (st.symbol || '').replace(/\.T$/, '');
  if (!/^[0-9][0-9A-Z]{3}$/.test(code)) { box.innerHTML = '<p class="small muted">個別の会社の株を表示すると出ます（指数には寄り付きのくせはありません）。</p>'; lastKey = ''; return; }
  if (lastKey === st.symbol) return;
  lastKey = st.symbol;
  box.innerHTML = '<p class="small muted"><span class="spinner"></span> 読み込み中…</p>';
  try {
    const d = await api(`/api/chart?symbol=${encodeURIComponent(st.symbol)}&tf=1d`);
    if (lastKey !== st.symbol) return;
    let cs = d.candles;
    // 今日の足（取引中）があれば、今日の始まり方として別に扱い、くせの計算には入れない
    const todayKey = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const lastKeyDay = new Date((cs[cs.length - 1].time + 9 * 3600) * 1000).toISOString().slice(0, 10);
    today = null;
    if (lastKeyDay === todayKey && cs.length > 2) {
      today = { gap: cs[cs.length - 1].open / cs[cs.length - 2].close - 1 };
      lastClose = cs[cs.length - 2].close;
      cs = cs.slice(0, -1);
    } else lastClose = cs[cs.length - 1].close;
    stats = openingStats(cs);
    render();
  } catch (e) {
    if (lastKey === st.symbol) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; lastKey = ''; }
  }
}
