// 画面で起きたエラーを、サーバーに知らせる（持ち主にあとでメールで届く）
// ・同じエラーは1回だけ・1回開いている間に10件まで
// ・持っている株の名前や金額などは送らない（エラーの文と、どの画面かだけ）
let version = '';
let page = '';
let sent = 0;
const seen = new Set();
export const setReportVersion = (v) => { version = String(v || ''); };
export const setReportPage = (p) => { page = String(p || ''); };

export function report(where, err) {
  try {
    const message = String(err?.message || err || '').slice(0, 300);
    // 「Script error.」はサイトの外（ブラウザの拡張機能・翻訳・アプリ内ブラウザなど）で起きた、中身の分からないエラーなので数えない
    if (/^Script error\.?$/i.test(message.trim()) && !err?.stack) return;
    if (!message || /Failed to fetch|fetch failed|NetworkError|Load failed|通信エラー|ログインしてください|AbortError|timeout|HTTP 429|HTTP 5\d\d/i.test(message)) return; // 電波の具合などは数えない
    const k = `${where}|${message}`;
    if (seen.has(k) || sent >= 10) return;
    seen.add(k); sent++;
    fetch('/api/report', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ where, message, stack: String(err?.stack || '').slice(0, 1200), version, page, ua: navigator.userAgent.slice(0, 120) }),
    }).catch(() => {});
  } catch { /* 知らせられなくても画面は続ける */ }
}

export function initReport() {
  window.addEventListener('error', (e) => report('画面', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => report('画面（あとから動く処理）', e.reason));
}

// エラーの文を画面に出すときに使う：知らせてから、文を返す
export const errText = (where, e) => { report(where, e); return e?.message || String(e); };
