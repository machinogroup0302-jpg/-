// 日本株の業績（Yahoo!ファイナンス日本版のページから）
// ・業績ページ：通期の売上・利益と前年比（netSalesYoy・operatingIncomeYoy・ordinaryIncomeYoy・netIncomeYoy など）
// ・トップページ：「決算短信AI要約」（直近の決算のまとめの文章）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ページの中に埋め込まれている "performance":{"performance":[ ... ]} を取り出す（\" のようにエスケープされていても読める）
export function parsePerformance(html) {
  const marks = ['\\"performance\\":{\\"performance\\":[', '"performance":{"performance":['];
  for (const m of marks) {
    const i = html.indexOf(m);
    if (i < 0) continue;
    const start = i + m.length - 1;
    let depth = 0, end = -1;
    for (let j = start; j < html.length && j < start + 200000; j++) {
      const c = html[j];
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    let s = html.slice(start, end + 1);
    if (m.startsWith('\\')) s = s.replace(/\\\\"/g, '"').replace(/\\"/g, '"');
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr;
    } catch { /* 次の書き方を試す */ }
  }
  return [];
}

const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").trim();
export function parseTanshin(html) {
  const m = html.match(/PressRelease__summaryMessage[^>]*>([\s\S]*?)<\/p>/);
  return m ? strip(m[1]).slice(0, 400) : '';
}

// 決算短信の要約の言葉から、良い決算か悪い決算か
const GOOD = ['増収増益', '大幅な増益', '大幅増益', '増益', '上方修正', '過去最高', '最高益', '増配', '黒字転換', '好調', '前年同期を上回', '前年を上回', '急拡大'];
const BAD = ['減収減益', '大幅な減益', '大幅減益', '減益', '下方修正', '赤字', '減配', '損失', '不振', '悪化', '前年同期を下回', '前年を下回', '落ち込'];
export function tanshinTone(text) {
  if (!text) return 0;
  let g = 0, b = 0;
  for (const w of GOOD) if (text.includes(w)) g++;
  for (const w of BAD) if (text.includes(w)) b++;
  return g > b ? 1 : b > g ? -1 : 0;
}

async function page(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

const cache = new Map();
export async function getJpPerformance(code) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.data;
  const [perfHtml, topHtml] = await Promise.all([
    page(`https://finance.yahoo.co.jp/quote/${code}.T/performance`).catch(() => ''),
    page(`https://finance.yahoo.co.jp/quote/${code}.T`).catch(() => ''),
  ]);
  const rows = parsePerformance(perfHtml).filter((x) => x && x.endDate).sort((a, b) => String(a.endDate).localeCompare(String(b.endDate)));
  const latest = rows[rows.length - 1] || null;
  const data = { latest, rows: rows.slice(-4), tanshin: parseTanshin(topHtml) };
  cache.set(code, { at: Date.now(), data });
  return data;
}
