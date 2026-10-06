// 注文・約定分析（株）：価格帯別出来高・買いと売りの勢い・板と歩み値
import { api, $, esc, fmtPrice, loadImage, imageToDataUrl, toast } from './util.js';
import { term } from './glossary.js';
import { volumeProfile, buySellPressure, volumeSpikes, summarizeTicks } from './volume.js';

const fmtVol = (v) => (v >= 1e8 ? `${(v / 1e8).toFixed(1)}億` : v >= 1e4 ? `${(v / 1e4).toFixed(1)}万` : Math.round(v).toLocaleString('ja-JP'));

// 価格帯別出来高（横向きの棒グラフ。赤=買い、青=売り）
function profileSvg(p, price, digits) {
  const rows = p.rows.slice().reverse(); // 上が高い値段
  const W = 340, rowH = 13, labelW = 74, H = rows.length * rowH + 4;
  const max = Math.max(...rows.map((r) => r.total), 1);
  const barW = W - labelW - 8;
  const y = (pr) => 2 + ((p.rows[p.rows.length - 1].to - pr) / (p.rows[p.rows.length - 1].to - p.rows[0].from)) * (rows.length * rowH);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="価格帯別出来高">
    <rect x="${labelW}" y="${y(p.valueHigh)}" width="${barW}" height="${y(p.valueLow) - y(p.valueHigh)}" fill="var(--accent)" opacity=".08"/>
    ${rows.map((r, i) => {
      const top = 2 + i * rowH;
      const wb = (r.buy / max) * barW, ws = (r.sell / max) * barW;
      const isPoc = r === p.poc;
      return `<text x="${labelW - 6}" y="${top + 10}" text-anchor="end" font-size="9" fill="${isPoc ? 'var(--text)' : 'var(--muted)'}" font-weight="${isPoc ? 700 : 400}">${fmtPrice(r.mid, digits)}</text>
        <rect x="${labelW}" y="${top + 1}" width="${wb}" height="${rowH - 3}" rx="2" fill="var(--buy)" opacity="${isPoc ? 1 : 0.75}"/>
        <rect x="${labelW + wb}" y="${top + 1}" width="${ws}" height="${rowH - 3}" rx="2" fill="var(--sell)" opacity="${isPoc ? 1 : 0.75}"/>`;
    }).join('')}
    <line x1="${labelW}" x2="${W}" y1="${y(price)}" y2="${y(price)}" stroke="var(--text)" stroke-dasharray="3 3"/>
    <text x="${W - 2}" y="${y(price) - 3}" text-anchor="end" font-size="9" fill="var(--text)">現在値</text>
  </svg>`;
}

// 買いと売りの勢い（足ごとの差＋積み上げ線）
function pressureSvg(pr) {
  const list = pr.slice(-40);
  const W = 340, H = 140, mid = 70;
  const maxD = Math.max(...list.map((p) => Math.abs(p.delta)), 1);
  const cums = list.map((p) => p.cum);
  const cmin = Math.min(...cums), cmax = Math.max(...cums);
  const bw = W / list.length;
  const cy = (v) => 10 + (1 - (v - cmin) / (cmax - cmin || 1)) * (H - 20);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="買いと売りの勢い">
    <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="var(--border)"/>
    ${list.map((p, i) => {
      const h = (Math.abs(p.delta) / maxD) * (mid - 6);
      return `<rect x="${i * bw + 1}" y="${p.delta >= 0 ? mid - h : mid}" width="${Math.max(bw - 2, 1)}" height="${h}" rx="1" fill="${p.delta >= 0 ? 'var(--buy)' : 'var(--sell)'}" opacity=".7"/>`;
    }).join('')}
    <path d="${list.map((p, i) => `${i ? 'L' : 'M'}${(i * bw + bw / 2).toFixed(1)},${cy(p.cum).toFixed(1)}`).join('')}" fill="none" stroke="var(--warn)" stroke-width="2"/>
  </svg>`;
}

export function renderOrderflow(data) {
  const box = $('orderflow-box');
  const candles = data.candles;
  const p = volumeProfile(candles.slice(-200));
  if (!p) {
    box.innerHTML = '<p class="small muted">為替には出来高のデータがないため、この分析は株（日本株・指数）で使えます。板・歩み値のスクリーンショットからの分析は下から使えます。</p>';
    return;
  }
  const price = candles[candles.length - 1].close;
  const digits = 1; // 株の値段は小数点1桁まで
  const pr = buySellPressure(candles);
  const recent = pr.slice(-20);
  const buy = recent.reduce((s, x) => s + x.buy, 0), sell = recent.reduce((s, x) => s + x.sell, 0);
  const buyPct = Math.round((buy / (buy + sell || 1)) * 100);
  const spikes = volumeSpikes(candles).slice(-5).reverse();
  const where = price > p.valueHigh ? '出来高が多い価格帯より上にあり、上値が軽い状態です' : price < p.valueLow ? '出来高が多い価格帯より下にあり、戻ると売られやすい状態です' : '出来高が多い価格帯の中にあり、もみ合いやすい状態です';
  box.innerHTML = `
    <div class="grid2">
      <div class="stat"><div class="label">直近20本の買いの割合（推定）</div><div class="value ${buyPct >= 50 ? 'plus' : 'minus'}">${buyPct}%</div></div>
      <div class="stat"><div class="label">${term('poc', 'いちばん売買が多い値段')}</div><div class="value">${fmtPrice(p.poc.mid, digits)}</div></div>
    </div>
    <p class="small" style="margin:8px 0">現在値は${where}。</p>
    <h3>${term('profile', '値段ごとの売買の量（価格帯別出来高）')}</h3>
    <p class="small muted" style="margin:0 0 4px">棒が長い値段ほど、たくさん売買された＝意識されやすい値段です。<span class="plus">■</span>買い <span class="minus">■</span>売り（推定）。薄い帯は出来高の70%が集まる範囲です。</p>
    ${profileSvg(p, price, digits)}
    <h3>${term('pressure', '買いと売りの勢い')}（最近40本）</h3>
    <p class="small muted" style="margin:0 0 4px">棒が上なら買い優勢、下なら売り優勢。黄色の線は積み上げで、右上がりなら買いが続いています。</p>
    ${pressureSvg(pr)}
    ${spikes.length ? `<h3>${term('volume', '売買の量（出来高）')}が急に増えた日・時間</h3><ul class="list">${spikes.map((s) => `<li class="small"><span class="badge ${s.up ? 'buy' : 'sell'}">${s.up ? '上げ' : '下げ'}</span> ${new Date(s.time * 1000).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　平均の${s.ratio.toFixed(1)}倍</li>`).join('')}</ul>` : ''}
    <p class="notice" style="margin-top:8px">買い・売りの量は、ローソク足の形からの推定です。正確な内訳は下の「板・歩み値」で確認できます。</p>`;
}

// ---------- 板・歩み値（スクリーンショット→AI） ----------
function boardSvg(board) {
  const rows = board.slice(0, 20);
  const W = 340, rowH = 16, H = rows.length * rowH + 4, mid = W / 2;
  const max = Math.max(...rows.map((r) => Math.max(r.sell_qty, r.buy_qty)), 1);
  const half = mid - 40;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="板の厚さ">
    ${rows.map((r, i) => {
      const top = 2 + i * rowH;
      const ws = (r.sell_qty / max) * half, wb = (r.buy_qty / max) * half;
      return `<rect x="${mid - 36 - ws}" y="${top + 2}" width="${ws}" height="${rowH - 4}" rx="2" fill="var(--sell)" opacity=".8"/>
        <text x="${mid}" y="${top + 12}" text-anchor="middle" font-size="10" fill="var(--text)">${fmtPrice(r.price, 0)}</text>
        <rect x="${mid + 36}" y="${top + 2}" width="${wb}" height="${rowH - 4}" rx="2" fill="var(--buy)" opacity=".8"/>
        ${r.sell_qty ? `<text x="${mid - 40 - ws}" y="${top + 12}" text-anchor="end" font-size="9" fill="var(--muted)">${fmtVol(r.sell_qty)}</text>` : ''}
        ${r.buy_qty ? `<text x="${mid + 40 + wb}" y="${top + 12}" font-size="9" fill="var(--muted)">${fmtVol(r.buy_qty)}</text>` : ''}`;
    }).join('')}
  </svg>`;
}

function renderBook(r) {
  const s = summarizeTicks(r.ticks);
  const sellTotal = r.board.reduce((a, b) => a + b.sell_qty, 0), buyTotal = r.board.reduce((a, b) => a + b.buy_qty, 0);
  const tickMax = Math.max(...s.rows.map((x) => x.buy + x.sell + x.other), 1);
  $('book-result').innerHTML = `
    <p class="small" style="margin:10px 0">${esc(r.comment)}</p>
    ${r.board.length ? `<h3>${term('board', '板')}の厚さ（注文がたまっている量）</h3>
      <div class="grid2" style="margin-bottom:6px">
        <div class="stat"><div class="label">売り注文の合計</div><div class="value minus">${fmtVol(sellTotal)}株</div></div>
        <div class="stat"><div class="label">買い注文の合計</div><div class="value plus">${fmtVol(buyTotal)}株</div></div>
      </div>
      <p class="small muted" style="margin:0 0 4px">左が売り注文、右が買い注文。長い棒の値段は「壁」になりやすいです。</p>
      ${boardSvg(r.board)}` : ''}
    ${s.rows.length ? `<h3>${term('ticks', '歩み値')}（実際に売買が成立した記録）の集計</h3>
      <div class="grid2" style="margin-bottom:6px">
        <div class="stat"><div class="label">買いの約定</div><div class="value plus">${fmtVol(s.buy)}株</div></div>
        <div class="stat"><div class="label">売りの約定</div><div class="value minus">${fmtVol(s.sell)}株</div></div>
      </div>
      <div class="bars">${s.rows.slice(0, 15).map((x) => {
        const t = x.buy + x.sell + x.other;
        return `<div class="bar"><span>${fmtPrice(x.price, 0)}</span>
          <span class="track"><span class="fill" style="left:0;width:${(x.buy / tickMax) * 100}%;background:var(--buy)"></span><span class="fill" style="left:${(x.buy / tickMax) * 100}%;width:${(x.sell / tickMax) * 100}%;background:var(--sell)"></span></span>
          <span class="val">${fmtVol(t)}株</span></div>`;
      }).join('')}</div>
      ${s.big.length ? `<h3>大口の売買（ふつうの5倍以上の株数）</h3><ul class="list">${s.big.slice(0, 8).map((t) => `<li class="small"><span class="badge ${t.side === '買い' ? 'buy' : t.side === '売り' ? 'sell' : 'neutral'}">${esc(t.side)}</span> ${esc(t.time)}　${fmtPrice(t.price, 0)}　<b>${fmtVol(t.qty)}株</b></li>`).join('')}</ul>` : ''}` : ''}`;
}

export function initOrderflow() {
  $('book-img').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const label = $('book-label');
    label.classList.add('busy');
    $('book-result').innerHTML = '<p class="small muted" style="margin-top:10px"><span class="spinner"></span> AIが板・歩み値を読み取っています…</p>';
    try {
      const img = await loadImage(f);
      const r = await api('/api/ai/orderbook-image', { method: 'POST', body: { image: imageToDataUrl(img) } });
      renderBook(r);
    } catch (err) {
      $('book-result').innerHTML = '';
      toast(err.message);
    } finally {
      label.classList.remove('busy');
    }
  });
}

