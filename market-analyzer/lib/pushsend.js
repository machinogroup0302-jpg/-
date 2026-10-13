// 通知を送る（Web Push）。外の部品を使わず、Node.js の暗号の機能だけで作る
// ・RFC 8291（中身の暗号化：aes128gcm）と RFC 8292（送り主の証明：VAPID）のとおり
import crypto from 'node:crypto';
import { vapidKeys } from './vapid.js';

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// 中身を暗号化する（受け取る端末の鍵 p256dh・auth で、その端末だけが読めるように）
export function encryptPayload(payload, p256dh, auth, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const as = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// 送り主の証明（VAPID の JWT）
export function vapidHeader(endpoint, keys, subject = 'https://wataru-lupe.onrender.com') {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const pub = unb64u(keys.publicKey);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** subs：通知を送る先のリスト、payload：{ title, body, url, tag } → 送れた数と、もう使えない送り先 */
export async function sendPush(subs, payload) {
  if (!subs?.length) return { sent: 0, gone: [] };
  const keys = vapidKeys();
  if (!keys) throw new Error('SITE_PASSWORD がないので通知の鍵を作れません');
  let sent = 0;
  const gone = [];
  for (const s of subs) {
    try {
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: { Authorization: vapidHeader(s.endpoint, keys), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '21600', Urgency: 'normal' },
        body: encryptPayload(JSON.stringify(payload), s.keys.p256dh, s.keys.auth),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 410) gone.push(s.endpoint); // 通知をやめた端末
    } catch { /* 次の端末へ */ }
  }
  return { sent, gone };
}
