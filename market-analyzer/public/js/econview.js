// 重要な経済指標の予定（為替が大きく動く発表）と、その前後の注意
import { api, $, esc } from './util.js';

let econ = null, econAt = 0;
export async function loadEcon() {
  if (econ && Date.now() - econAt < 60 * 60 * 1000) return econ;
  try { econ = await api('/api/econ'); econAt = Date.now(); } catch { econ = econ || { items: [] }; }
  return econ;
}
export const econCached = () => econ;

const fmt = (t) => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });

// その通貨ペア（または株の国）に関係する、これから36時間以内の発表
export function econSoon(symbol, mode, hours = 36) {
  if (!econ?.items) return [];
  const now = Date.now();
  const code = String(symbol).replace(/=X$/, '').toUpperCase();
  const ccys = mode === 'fx' ? [code.slice(0, 3), code.slice(3, 6)] : mode === 'us' ? ['USD'] : ['JPY', 'USD'];
  return econ.items.filter((e) => e.time > now - 3600e3 && e.time < now + hours * 3600e3 && ccys.includes(e.ccy));
}
export function econWarnHtml(symbol, mode) {
  const ev = econSoon(symbol, mode);
  if (!ev.length) return '';
  return `<div class="small" style="color:var(--warn);margin:2px 0">⚠ ${ev.slice(0, 2).map((e) => `${esc(fmt(e.time))} ${esc(e.country)}の${esc(e.title)}`).join('／')}：発表の前後は大きく動きやすいので、${mode === 'fx' ? 'ロット数を減らすか、発表が終わってから入る' : '量を減らすか、発表が終わってから入る'}のがおすすめです。</div>`;
}

export async function renderEconCard() {
  const el = $('econ-box');
  if (!el) return;
  const d = await loadEcon();
  const now = Date.now();
  const list = (d.items || []).filter((e) => e.time > now - 6 * 3600e3).slice(0, 25);
  el.innerHTML = list.length ? `<ul class="list">${list.map((e) => `<li><div class="li-head"><span class="name small">${esc(fmt(e.time))}</span><span class="badge warn">${esc(e.country)}</span></div>
      <div class="small"><b>${esc(e.title)}</b>${e.forecast || e.previous ? `<span class="muted">（予想 ${esc(e.forecast || '—')}・前回 ${esc(e.previous || '—')}）</span>` : ''}${e.rough ? '<span class="muted">（日にちは目安）</span>' : ''}</div></li>`).join('')}</ul>
    <p class="small muted" style="margin:6px 0 0">為替が大きく動きやすい発表だけを出しています（データ：${esc(d.source || '')}）。発表の前後はスプレッドが広がったり、急に動いたりするので、ロット数を減らすか、発表が終わってから入るのがおすすめです。</p>`
    : '<p class="small muted">今週・来週の重要な発表の予定が取れませんでした。</p>';
}
