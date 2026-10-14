// スマホ・パソコンへの通知（Web Push）を使えるようにする
import { api, $, esc, toast } from './util.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const toKey = (b64) => { const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };

// 通知を受け取る係（Service Worker）：まだ入っていなければ入れる
async function registration() {
  const r = await navigator.serviceWorker.getRegistration('/');
  return r || navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function renderPush() {
  const el = $('push-box');
  if (!el) return;
  if (!supported()) {
    el.innerHTML = `<p class="small muted">${isIos() && !standalone() ? 'iPhoneで通知を受け取るには、Safariの共有ボタン →「ホーム画面に追加」でこのサイトをホーム画面に入れて、<b>ホーム画面のアイコンから開いて</b>ここを押してください（iOS 16.4以上）。' : 'このブラウザは通知に対応していません。'}</p>`;
    return;
  }
  let info = { publicKey: null, count: 0 };
  try { info = await api('/api/push/key'); } catch { /* 続ける */ }
  const reg = await registration().catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  const on = !!sub && Notification.permission === 'granted';
  el.innerHTML = `<p class="small" style="margin:0 0 6px">${on ? '✅ <b>この端末に通知が届きます</b>' : '📲 この端末にはまだ通知が届きません'}（通知を受け取る端末：${info.count}台）</p>
    <div class="row">${on ? '<button type="button" class="btn grow" id="push-test">テスト通知を送る</button><button type="button" class="btn grow" id="push-off">この端末の通知を止める</button>' : `<button type="button" class="btn primary block" id="push-on" ${info.publicKey ? '' : 'disabled'}>この端末に通知を出す</button>`}</div>
    <p class="small muted" style="margin:6px 0 0">メールと同じタイミング（売買のサイン・持っている株・今日のプラン・今週のまとめ）で、スマホやパソコンに通知も出します。${isIos() ? 'iPhoneは、ホーム画面に追加したアイコンから開いたときだけ使えます。' : ''}</p>`;
  $('push-on')?.addEventListener('click', async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('通知が許可されませんでした（端末の設定で許可してください）'); return; }
      await registration();
      const r = await navigator.serviceWorker.ready;
      const s = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(info.publicKey) });
      await api('/api/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
      toast('この端末に通知が届くようになりました');
    } catch (e) { toast(`通知を設定できませんでした：${e.message}`); }
    renderPush();
  });
  $('push-off')?.addEventListener('click', async () => {
    try { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); } catch { /* 続ける */ }
    toast('この端末の通知を止めました');
    renderPush();
  });
  $('push-test')?.addEventListener('click', async () => {
    try { const r = await api('/api/push/test', { method: 'POST', body: {} }); toast(r.sent ? 'テスト通知を送りました' : `送れませんでした：${r.error || ''}`); } catch (e) { toast(`送れませんでした：${e.message}`); }
  });
}
