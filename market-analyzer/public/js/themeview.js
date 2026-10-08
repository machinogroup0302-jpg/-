// ニュース画面「今ニュースで増えているテーマ」：話題と、その話題で上がりやすい銘柄（確率つき）
import { api, $, esc } from './util.js';

const H = 10; // 何営業日後に上がっていたかで見る（約2週間）

// 今と似た形（ここ20日の上がり方と、出来高の増え方が同じグループ）だった日のうち、
// その10営業日後に値段が上がっていた割合。回数が少ないときは全体の割合に寄せる
export function themeOdds(candles) {
  const c = candles.map((x) => x.close);
  const v = candles.map((x) => x.volume || 0);
  const n = c.length;
  if (n < 120) return null;
  const avg = (a, i, k) => { let s = 0; for (let j = i - k + 1; j <= i; j++) s += a[j]; return s / k; };
  const state = (i) => {
    const r20 = c[i] / c[i - 20] - 1;
    const v60 = avg(v, i, 60);
    const vr = v60 > 0 ? avg(v, i, 5) / v60 : 1;
    return { mom: r20 > 0.08 ? 2 : r20 > 0 ? 1 : r20 > -0.08 ? 0 : -1, vol: vr > 1.3 ? 1 : 0, r20, vr };
  };
  const now = state(n - 1);
  let all = 0, allUp = 0, hit = 0, hitUp = 0, sum = 0;
  for (let i = 60; i < n - H; i++) {
    const s = state(i);
    const up = c[i + H] > c[i];
    all++; if (up) allUp++;
    if (s.mom === now.mom && s.vol === now.vol) { hit++; if (up) hitUp++; sum += c[i + H] / c[i] - 1; }
  }
  if (!all) return null;
  const base = allUp / all;
  const k = 15;
  const p = (hitUp + k * base) / (hit + k);
  return {
    p, hits: hit, avgRet: hit ? sum / hit : 0,
    r5: c[n - 1] / c[n - 6] - 1, r20: now.r20, vr: now.vr,
  };
}

const pct = (x, d = 0) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const oddsBadge = (p) => (p >= 0.6 ? 'buy' : p >= 0.5 ? 'neutral' : 'sell');
const heatBadge = (l) => (l === '急に増えている' ? 'bad' : l === '増えている' || l === 'たくさん出ている' ? 'warn' : 'neutral');

let data = null;
let loadedAt = 0;
const oddsCache = new Map(); // `${symbol}` → odds
const open = new Set();
let touched = false;
let modeNow = 'stock';

function stockLine(sym, name, o, dir = 1) {
  if (!o) return `<li class="small muted">${esc(name)}：データが足りないので計算できませんでした</li>`;
  const notes = [];
  const p = dir > 0 ? o.p : 1 - o.p;
  if (dir > 0 && o.r20 > 0.25) notes.push('この1か月でもう大きく上がっているので、高値づかみに注意');
  if (dir < 0 && o.r20 < -0.2) notes.push('この1か月でもう大きく下がっているので、下げすぎの反発に注意');
  if (dir < 0) notes.push('持っていたら損切りの線を確認／空売りするなら信用で');
  if (o.vr > 1.3) notes.push(`出来高がふだんの${o.vr.toFixed(1)}倍（注目が集まっている）`);
  return `<li><div class="li-head"><span class="name"><a href="#" class="sym-link theme-sym" data-symbol="${esc(sym)}" data-name="${esc(name)}">${esc(name)}</a></span>
    <span class="badge ${dir > 0 ? oddsBadge(p) : p >= 0.6 ? 'sell' : p >= 0.5 ? 'neutral' : 'buy'}">${dir > 0 ? '上がる' : '下がる'}確率 ${Math.round(p * 100)}%</span></div>
    <div class="small muted">5日 ${pct(o.r5, 1)}・20日 ${pct(o.r20, 1)}・似た形${o.hits}回の10日後の平均 ${pct(o.avgRet, 1)}</div>
    ${notes.length ? `<div class="small" style="color:var(--warn)">${esc(notes.join('／'))}</div>` : ''}</li>`;
}

function listFor(t) {
  if (modeNow === 'us') return t.us.map(([c, n]) => [c, n]);
  return t.stock.map(([c, n]) => [`${c}.T`, n]);
}

async function fillStocks(t, el) {
  const list = listFor(t);
  if (!list.length) { el.innerHTML = '<p class="small muted">このテーマは米国株の代表的な銘柄を入れていません。日本株に切り替えると見られます。</p>'; return; }
  const need = list.filter(([s]) => !oddsCache.has(s));
  if (need.length) el.innerHTML = '<p class="small muted"><span class="spinner"></span> 関係する銘柄の値動きを計算しています…</p>';
  await Promise.all(need.map(async ([s]) => {
    try {
      const d = await api(`/api/chart?symbol=${encodeURIComponent(s)}&tf=1d`);
      oddsCache.set(s, themeOdds(d.candles));
    } catch { oddsCache.set(s, null); }
  }));
  const dir = t.dir || 1;
  const pv = (o) => (o ? (dir > 0 ? o.p : 1 - o.p) : -1);
  const rows = list.map(([s, n]) => ({ s, n, o: oddsCache.get(s) })).sort((a, b) => pv(b.o) - pv(a.o));
  const ok = rows.filter((r) => r.o);
  const avgP = ok.length ? ok.reduce((a, r) => a + pv(r.o), 0) / ok.length : null;
  el.innerHTML = `${avgP != null ? `<p class="small" style="margin:6px 0">このテーマの銘柄の平均：<b>10営業日後に${dir > 0 ? '上がって' : '下がって'}いる確率 ${Math.round(avgP * 100)}%</b></p>` : ''}
    <ul class="list">${rows.map((r) => stockLine(r.s, r.n, r.o, dir)).join('')}</ul>`;
}

function themeBlock(t, i) {
  const isOpen = open.has(t.id) || (!touched && (i === 0 || i === 100));
  if (isOpen) open.add(t.id);
  const heads = t.headlines.map((h) => `<li class="small"><a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--text)">${esc(h.title)}</a> <span class="muted">${esc(h.source)}</span></li>`).join('');
  return `<details class="more-box theme-box" data-id="${esc(t.id)}" ${isOpen ? 'open' : ''}>
    <summary><span style="color:var(--text)">${esc(t.name)}</span> <span class="badge ${heatBadge(t.label)}">${esc(t.label)}</span>
      <span class="small muted">直近2日 ${t.recent}件${t.before ? `（前の5日の${t.heat}倍のペース）` : ''}</span></summary>
    <p class="small" style="margin:6px 0">${esc(t.why)}</p>
    ${heads ? `<ul style="margin:4px 0 8px;padding-left:18px">${heads}</ul>` : ''}
    <div class="theme-stocks"></div>
  </details>`;
}

function render() {
  const out = $('theme-list');
  if (!data) return;
  const list = data.themes;
  if (!list.some((t) => t.recent + t.before)) { out.innerHTML = '<p class="small muted">ニュースを取得できませんでした。少し時間をおいて開き直してください。</p>'; return; }
  // 上がりやすいテーマと、下がりやすいテーマに分けて出す
  const group = (items, title, offset) => {
    const top = items.slice(0, 4), rest = items.slice(4);
    return `<h3 style="margin:10px 0 6px">${title}</h3>` + top.map((t, i) => themeBlock(t, i + offset)).join('') +
      (rest.length ? `<details class="more-box"><summary>ほかのテーマ（${rest.length}）</summary>${rest.map((t, i) => themeBlock(t, i + offset + 4)).join('')}</details>` : '');
  };
  const ups = list.filter((t) => (t.dir || 1) > 0), downs = list.filter((t) => t.dir < 0);
  out.innerHTML = group(ups, '📈 ニュースが増えると上がりやすいテーマ', 0) + group(downs, '📉 ニュースが増えると下がりやすいテーマ', 100);
  out.querySelectorAll('.theme-box').forEach((d) => {
    const t = list.find((x) => x.id === d.dataset.id);
    const load = () => fillStocks(t, d.querySelector('.theme-stocks'));
    if (d.open) load();
    d.addEventListener('toggle', () => { touched = true; if (d.open) { open.add(t.id); load(); } else open.delete(t.id); });
  });
  $('theme-time').textContent = `${new Date(data.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}時点`;
}

export async function updateThemes(mode, { silent = false } = {}) {
  const changed = mode !== modeNow;
  modeNow = mode;
  if (data && !changed && Date.now() - loadedAt < 30 * 60 * 1000) { if (!silent) render(); return; }
  if (!data) $('theme-list').innerHTML = '<p class="small muted"><span class="spinner"></span> いろいろなテーマのニュースを数えています…</p>';
  try {
    if (!data || Date.now() - loadedAt >= 30 * 60 * 1000) {
      data = await api('/api/themes');
      loadedAt = Date.now();
      oddsCache.clear();
    }
    render();
  } catch (e) {
    if (!data) $('theme-list').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

export function initThemes(openChart) {
  $('theme-list').addEventListener('click', (e) => {
    const a = e.target.closest('.theme-sym');
    if (!a) return;
    e.preventDefault();
    openChart(a.dataset.symbol, a.dataset.name);
  });
}
