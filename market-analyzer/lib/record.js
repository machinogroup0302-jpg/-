// メールでお知らせした売買の記録（GitHub Actions が alerts/state.json に書いている）を読む
import fs from 'node:fs/promises';
const REPO = process.env.PREFS_REPO || 'machinogroup0302-jpg/-';
const BRANCH = process.env.PREFS_BRANCH || 'claude/trusting-planck-dsasvf';
let cache = null;
export async function getRecord(uid) {
  if (!cache || Date.now() - cache.at > 10 * 60 * 1000) {
    let state = null;
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(BRANCH)}/alerts/state.json?t=${Date.now()}`, { signal: AbortSignal.timeout(12000) });
      if (res.ok) state = await res.json();
    } catch { /* 次へ */ }
    if (!state) { try { state = JSON.parse(await fs.readFile(new URL('../../alerts/state.json', import.meta.url), 'utf8')); } catch { state = {}; } }
    cache = { at: Date.now(), state };
  }
  const b = cache.state.book?.[uid] || {};
  return { log: b.log || [], open: Object.values(b.open || {}), at: cache.at };
}
