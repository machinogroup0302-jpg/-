// 画像分析画面：チャートのスクリーンショットをAIで分析し、線を書き込む
import { api, $, esc, busy, loadImage, imageToDataUrl, fmtPrice, signalClass, toast } from './util.js';

let img = null;
let result = null;
const show = { resistance: true, support: true, trend: true, label: true };

// 価格目盛りの読み取り結果から「価格 → 縦位置」の変換式を作る
export function axisFit(ticks) {
  const pts = (ticks || []).filter((t) => Number.isFinite(t.price) && Number.isFinite(t.y) && t.y >= 0 && t.y <= 1);
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.price, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of pts) { sxx += (p.price - mx) ** 2; sxy += (p.price - mx) * (p.y - my); }
  if (!sxx) return null;
  const a = sxy / sxx, b = my - a * mx;
  if (a >= 0) return null; // 価格が高いほど上（yが小さい）でなければおかしい
  const err = Math.max(...pts.map((p) => Math.abs(a * p.price + b - p.y)));
  if (err > 0.03) return null;
  return (price) => a * price + b;
}

function draw() {
  const c = $('img-canvas');
  if (!c || !img) return;
  const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, W, H);
  if (!result) return;

  const lw = Math.max(2, W / 380);
  const fs = Math.max(12, Math.round(W / 42));
  const fit = axisFit(result.axis_ticks);
  const yOf = (lv) => {
    const y = fit ? fit(lv.price) : lv.y;
    return Math.min(1, Math.max(0, y)) * H;
  };
  const label = (text, x, y, color) => {
    if (!show.label) return;
    g.font = `bold ${fs}px -apple-system, "Hiragino Sans", sans-serif`;
    const w = g.measureText(text).width + fs * 0.8;
    const top = Math.min(H - fs * 1.6, Math.max(0, y - fs * 1.7));
    g.fillStyle = color;
    g.globalAlpha = 0.9;
    g.beginPath();
    g.roundRect ? g.roundRect(x, top, w, fs * 1.5, fs * 0.3) : g.rect(x, top, w, fs * 1.5);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#fff';
    g.fillText(text, x + fs * 0.4, top + fs * 1.1);
  };

  for (const lv of result.levels) {
    if (!show[lv.kind]) continue;
    const color = lv.kind === 'resistance' ? '#ff7a1a' : '#00b894';
    const y = yOf(lv);
    g.strokeStyle = color;
    g.lineWidth = lv.strength === '強' ? lw * 1.6 : lw;
    g.setLineDash(lv.strength === '弱' ? [lw * 2, lw * 3] : lv.strength === '中' ? [lw * 6, lw * 3] : []);
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    label(`${lv.kind === 'resistance' ? 'レジスタンス' : 'サポート'} ${fmtPrice(lv.price)}`, fs * 0.5, y, color);
  }
  g.setLineDash([]);
  if (show.trend) {
    for (const t of result.trendlines) {
      const color = /上昇|下限/.test(t.kind) ? '#00b894' : '#ff7a1a';
      const ext = Math.min(0.99, t.x2 + (t.x2 - t.x1) * 0.25);
      const slope = t.x2 !== t.x1 ? (t.y2 - t.y1) / (t.x2 - t.x1) : 0;
      g.strokeStyle = color;
      g.lineWidth = lw * 1.3;
      g.beginPath();
      g.moveTo(t.x1 * W, t.y1 * H);
      g.lineTo(ext * W, (t.y1 + slope * (ext - t.x1)) * H);
      g.stroke();
    }
  }
}

function renderResult() {
  const r = result;
  const fit = axisFit(r.axis_ticks);
  const lv = r.levels.slice().sort((a, b) => b.price - a.price);
  $('img-result').innerHTML = `
    <div class="card">
      <h2>線を引いた画像</h2>
      <div class="chips" id="img-layers" style="margin-bottom:8px">
        ${[['resistance', 'レジスタンス'], ['support', 'サポート'], ['trend', 'トレンドライン'], ['label', '価格ラベル']].map(([k, v]) => `<button class="chip" data-k="${k}" aria-pressed="${show[k]}">${v}</button>`).join('')}
      </div>
      <div class="canvas-wrap"><canvas id="img-canvas"></canvas></div>
      ${fit ? '' : '<p class="notice" style="margin-top:8px">価格の目盛りが読み取りにくかったため、線の位置は目安です。下の価格の数字を優先してください。</p>'}
      <button class="btn primary block" id="img-save" style="margin-top:10px">画像を保存する</button>
    </div>
    <div class="card">
      <h2>分析結果<span class="sub">${esc(r.symbol)}・${esc(r.timeframe)}</span></h2>
      <div class="li-head" style="margin-bottom:6px"><span class="name">トレンド</span><span class="badge ${signalClass(r.trend)}">${esc(r.trend)}</span></div>
      <p class="small">${esc(r.summary)}</p>
      <h3>引いた線の価格</h3>
      <ul class="list">${lv.map((l) => `<li class="lv-row"><span class="badge ${l.kind === 'resistance' ? 'warn' : 'ok'}">${l.kind === 'resistance' ? 'レジスタンス' : 'サポート'}</span><span class="num" style="font-weight:700">${fmtPrice(l.price)}</span><span class="small muted">強さ:${esc(l.strength)}</span></li>
        ${l.note ? `<li class="small muted" style="border-top:0;padding-top:0">${esc(l.note)}</li>` : ''}`).join('')}</ul>
      ${r.trendlines.length ? `<h3>トレンドライン</h3><ul class="list">${r.trendlines.map((t) => `<li class="small"><b>${esc(t.kind)}</b> ${esc(t.note)}</li>`).join('')}</ul>` : ''}
      ${r.patterns.length ? `<h3>チャートパターン</h3><ul class="list">${r.patterns.map((p) => `<li class="small"><b>${esc(p.name)}</b> ${esc(p.meaning)}</li>`).join('')}</ul>` : ''}
      ${r.signals.length ? `<h3>サイン一覧</h3><ul class="list">${r.signals.map((s) => `<li><div class="li-head"><span class="name small">${esc(s.name)}</span><span class="badge ${signalClass(s.direction)}">${esc(s.direction)}</span></div><div class="small muted">${esc(s.detail)}</div></li>`).join('')}</ul>` : ''}
      <h3>シナリオ</h3>
      <p class="small"><b class="plus">上がる場合:</b> ${esc(r.scenario.bullish)}</p>
      <p class="small"><b class="minus">下がる場合:</b> ${esc(r.scenario.bearish)}</p>
      <p class="small"><b>戦略の例:</b> ${esc(r.scenario.plan)}</p>
      <p class="notice">AIによる読み取りのため、価格が少しずれることがあります。売買の前に必ずアプリのチャートで確認してください。</p>
    </div>`;
  draw();
  $('img-layers').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    show[b.dataset.k] = !show[b.dataset.k];
    b.setAttribute('aria-pressed', String(show[b.dataset.k]));
    draw();
  });
  $('img-save').addEventListener('click', saveImage);
}

function saveImage() {
  $('img-canvas').toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], `chart-lines-${Date.now()}.png`, { type: 'image/png' });
    // スマホは共有メニュー（「画像を保存」）を使う
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'チャート分析' }); return; } catch { /* キャンセル */ return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

export function initImageView() {
  $('chart-img').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      img = await loadImage(f);
      result = null;
      $('img-result').innerHTML = '<div class="card"><h2>選んだ画像</h2><div class="canvas-wrap"><canvas id="img-canvas"></canvas></div></div>';
      draw();
      $('img-run').disabled = false;
    } catch (err) {
      toast(err.message);
    }
  });
  $('img-run').addEventListener('click', async () => {
    if (!img) return;
    const btn = $('img-run');
    busy(btn, true, 'AIが分析しています（30秒〜1分）…');
    try {
      result = await api('/api/ai/chart-image', { method: 'POST', body: { image: imageToDataUrl(img), memo: $('img-memo').value } });
      renderResult();
      $('img-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast(err.message);
    } finally {
      busy(btn, false);
    }
  });
}
