// やることボードのデータが Firebase にちゃんと入っているかを見る（中身は出さず、件数と最後に保存した時刻だけ）
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const jst = (ms) => ms ? new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : 'なし';
const snaps = await admin.firestore().collection('yarukoto').get();
for (const s of snaps.docs) {
  const { value = {}, ts } = s.data();
  const n = s.id === 'tasks' ? `ToDo ${value.list?.filter((t) => !t.deletedAt).length ?? 0}件（削除したもの ${value.list?.filter((t) => t.deletedAt).length ?? 0}件）`
    : s.id === 'schedule' ? `予定 ${value.list?.length ?? 0}件`
    : s.id === 'fixed' ? `支払先 ${value.payees?.length ?? 0}件・1回だけの支払い ${value.oneoffs?.length ?? 0}件`
    : s.id === 'checks' ? `チェック項目 ${value.items?.length ?? 0}件`
    : s.id === 'settings' ? `メール通知 ${value.notify ? 'オン' : 'オフ'}` : '';
  console.log(`${s.id}: ${n} / 最後に保存: ${jst(ts)}（日本時間）`);
}
