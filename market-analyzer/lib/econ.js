// 重要な経済指標の予定（為替が大きく動く発表）
// ・Forex Factory が公開している今週・来週の予定（無料のデータ）から、影響が大きいものだけ
// ・取れないときは、毎月決まっている目安（米国の雇用統計＝第1金曜日など）で代わりに出す
const FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];

// よく出る指標の名前を日本語に（分からないものは英語のまま）
const NAMES = [
  [/Non-Farm Employment Change|Nonfarm Payrolls/i, '雇用統計（アメリカの働く人の数）'],
  [/Unemployment Rate/i, '失業率'],
  [/Core CPI|CPI/i, '消費者物価指数（物価の上がり方）'],
  [/Core PCE|PCE Price/i, 'PCE物価指数（物価の上がり方）'],
  [/FOMC|Federal Funds Rate|Fed Chair/i, 'FOMC・FRB（アメリカの金利の発表）'],
  [/BOJ|Bank of Japan|Monetary Policy Statement.*JPY/i, '日銀（日本の金利の発表）'],
  [/ECB|Main Refinancing Rate/i, 'ECB（ユーロの金利の発表）'],
  [/BOE|Official Bank Rate/i, 'イングランド銀行（ポンドの金利の発表）'],
  [/RBA|Cash Rate/i, 'オーストラリアの金利の発表'],
  [/RBNZ|Official Cash Rate/i, 'ニュージーランドの金利の発表'],
  [/BOC|Overnight Rate/i, 'カナダの金利の発表'],
  [/GDP/i, 'GDP（国の景気の大きさ）'],
  [/Retail Sales/i, '小売売上高（買い物の多さ）'],
  [/ISM .*PMI|PMI/i, '景気の体感（PMI）'],
  [/Employment Change/i, '雇用者数'],
  [/Tankan/i, '日銀短観（日本の会社の景気の体感）'],
];
export const jaTitle = (t) => { for (const [re, ja] of NAMES) if (re.test(t)) return ja; return t; };
const CCY_JA = { USD: 'アメリカ', JPY: '日本', EUR: 'ユーロ圏', GBP: 'イギリス', AUD: 'オーストラリア', NZD: 'ニュージーランド', CAD: 'カナダ', CHF: 'スイス', CNY: '中国' };

export function parseFeed(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => /high/i.test(x.impact || '') && x.date)
    .map((x) => ({ time: Date.parse(x.date), ccy: x.country, country: CCY_JA[x.country] || x.country, title: jaTitle(x.title || ''), en: x.title || '', forecast: x.forecast || '', previous: x.previous || '' }))
    .filter((x) => Number.isFinite(x.time))
    .sort((a, b) => a.time - b.time);
}

// データが取れないときの目安：アメリカの雇用統計（第1金曜日 日本時間21:30〜22:30）
export function fallbackEvents(now = Date.now(), days = 14) {
  const out = [];
  const d0 = new Date(now);
  for (let m = 0; m < 2; m++) {
    const y = d0.getUTCFullYear(), mo = d0.getUTCMonth() + m;
    const first = new Date(Date.UTC(y, mo, 1));
    const fri = 1 + ((5 - first.getUTCDay() + 7) % 7);
    const t = Date.UTC(y, mo, fri, 12, 30); // 12:30 UTC（夏時間）＝日本時間21:30
    if (t >= now - 86400000 && t <= now + days * 86400000) out.push({ time: t, ccy: 'USD', country: 'アメリカ', title: '雇用統計（アメリカの働く人の数）', en: 'Non-Farm Employment Change', forecast: '', previous: '', rough: true });
  }
  return out;
}

let cache = null;
export async function getEcon() {
  if (cache && Date.now() - cache.at < 3 * 3600 * 1000) return cache.data;
  const items = [];
  let ok = false;
  for (const url of FEEDS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      items.push(...parseFeed(await res.json()));
      ok = true;
    } catch { /* 次へ */ }
  }
  const seen = new Set();
  const list = (ok ? items : fallbackEvents()).filter((x) => { const k = `${x.time}|${x.en}`; return seen.has(k) ? false : seen.add(k); });
  const data = { at: Date.now(), source: ok ? 'Forex Factory' : '目安（データが取れなかったので、毎月決まっている発表だけ）', items: list };
  cache = { at: Date.now(), data };
  return data;
}

// その通貨ペアに関係する発表か
export const affects = (pair, ev) => String(pair).replace(/=X$/, '').toUpperCase().includes(ev.ccy);
