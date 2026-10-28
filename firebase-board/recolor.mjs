// 一度だけ：スクリーンショット（前のアプリ）と同じ色を、ToDo の行につける
// 色がもう付いている行はそのまま。名前の一部で探す
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();
const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '');
const COLORS = {
  blue: ['RX距離', 'RX値段', '0570550011', 'バックカメラ見積', 'トラック1.5', 'RXFスポーツ', '神谷さん', '株式会社Z5052', '三船さん', 'ズキコーティング', '森山見積', 'Zタイヤ', '法人板金メール'],
  green: ['中西ミツモア時間変更', 'お金計算', '関東自動車交通', 'LP作成', 'Z確認後各社メール', 'パスワード変更', 'たく投稿', 'SNS運用'],
  pink: ['クリッパークラッ', 'マイカーローン', 'エリア関東神奈川以外', 'アクサ生命'],
};
const ref = db.doc('yarukoto/tasks');
await db.runTransaction(async (tx) => {
  const snap = await tx.get(ref);
  const cur = snap.data();
  const list = cur.value.list || [];
  const found = new Set();
  let n = 0;
  for (const t of list) {
    const title = norm(t.title);
    for (const [color, keys] of Object.entries(COLORS)) {
      const k = keys.find((k) => title.includes(norm(k)));
      if (!k) continue;
      found.add(k);
      if (!t.color) { t.color = color; n++; console.log(`${color}: ${t.title}`); }
    }
  }
  const missing = Object.values(COLORS).flat().filter((k) => !found.has(k));
  if (missing.length) console.log('見つからなかった:', missing.join(' / '));
  tx.set(ref, { value: { ...cur.value, list }, ts: Math.max(Date.now(), (cur.ts || 0) + 1) });
  console.log(`${n}件に色をつけました`);
});
