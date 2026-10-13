// スマホ・パソコンへの通知（Web Push）に使う鍵
// サイトのパスワード（SITE_PASSWORD）から毎回同じ鍵を作るので、新しく登録するものはない
// （サーバーは「公開鍵」だけを画面に渡し、通知を送る GitHub Actions は同じパスワードから同じ鍵を作る）
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let cached = null;
export function vapidKeys(secret = process.env.PREFS_KEY || process.env.SITE_PASSWORD || '') {
  if (!secret) return null;
  if (cached?.secret === secret) return cached.keys;
  // 秘密の数を作って、楕円曲線（P-256）の鍵にする（まれに使えない数になるので、そのときは作り直す）
  for (let i = 0; i < 10; i++) {
    const d = crypto.createHash('sha256').update(`ma-vapid-v1:${i}:${secret}`).digest();
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(d);
      const keys = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(d) };
      cached = { secret, keys };
      return keys;
    } catch { /* 次の数で */ }
  }
  return null;
}
