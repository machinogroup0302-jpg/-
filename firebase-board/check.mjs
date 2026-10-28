// 公開したサイトを、iPhone のふりをして開いてみる（エラーが出ていないか確かめる）
import { chromium, devices } from 'playwright';
const url = `https://${process.env.SITE}.web.app/`;
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const log = [];
p.on('pageerror', (e) => log.push('ページのエラー: ' + e.message));
p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) log.push(`console.${m.type()}: ${m.text()}`); });
p.on('requestfailed', (r) => log.push(`読めなかった: ${r.url()} (${r.failure()?.errorText})`));
p.on('response', (r) => { if (r.status() >= 400) log.push(`HTTP ${r.status()}: ${r.url()}`); });
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(4000);
const info = await p.evaluate(() => ({
  firebase: !!window.firebase?.apps?.length,
  authDomain: window.firebase?.apps?.[0]?.options?.authDomain,
  dialog: document.getElementById('login-dialog')?.open,
  status: document.getElementById('sync')?.textContent,
  err: document.getElementById('login-err')?.textContent,
  text: document.body.innerText.slice(0, 300),
}));
console.log(JSON.stringify(info, null, 2));
// Google ログインのボタンを押すと、何が起きるか
const popup = p.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
await p.click('#google-btn').catch((e) => log.push('ボタンが押せない: ' + e.message));
const w = await popup;
if (w) { await w.waitForLoadState().catch(() => {}); await w.waitForTimeout(3000); console.log('ログインの窓:', w.url().slice(0, 200)); console.log((await w.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 300)); }
else console.log('ログインの窓が開かなかった。いまの住所:', p.url());
console.log('login-err:', await p.textContent('#login-err').catch(() => ''));
console.log(log.length ? log.join('\n') : 'エラーなし');
await b.close();
