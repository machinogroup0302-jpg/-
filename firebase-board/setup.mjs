// 公開の前の準備（GitHub Actions から動かす。何度動かしても大丈夫）
//  1. 新しいサイトの住所で Google ログインができるように「ログインを許すドメイン」に足す
//  2. メールアドレスとパスワードのログインをオンにして、使う人（OWNER_EMAIL）を登録する
//  3. Firebase にまだデータがなければ、Render のやることボードから中身を写す
// 使うもの: GOOGLE_APPLICATION_CREDENTIALS（Firebase の秘密鍵）, PROJECT, SITE
//           BOARD_URL・BOARD_PASSWORD（Render のやることボード。なければ 2 はしない）
import admin from 'firebase-admin';
import { GoogleAuth } from 'google-auth-library';

const { PROJECT, SITE, BOARD_URL, BOARD_PASSWORD, OWNER_EMAIL } = process.env;
const DOCS = ['tasks', 'schedule', 'fixed', 'checks', 'settings'];

// 1. ログインを許すドメイン
try {
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;
  const { data } = await client.request({ url, headers: { 'x-goog-user-project': PROJECT } });
  const have = data.authorizedDomains || [];
  const want = [`${SITE}.web.app`, `${SITE}.firebaseapp.com`].filter((d) => !have.includes(d));
  if (want.length) {
    await client.request({ url: `${url}?updateMask=authorizedDomains`, method: 'PATCH', headers: { 'x-goog-user-project': PROJECT }, data: { authorizedDomains: [...have, ...want] } });
    console.log('ログインを許すドメインに足しました:', want.join(', '));
  } else console.log('ログインを許すドメインは設定済みです');
} catch (e) {
  console.log(`::warning::ログインを許すドメインを自動で足せませんでした（${e.message}）。Firebase の Authentication → 設定 → 承認済みドメイン に ${SITE}.web.app を足してください`);
}

admin.initializeApp({ projectId: PROJECT });

// 2. メールアドレスとパスワードのログイン
try {
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;
  const { data } = await client.request({ url, headers: { 'x-goog-user-project': PROJECT } });
  if (!data.signIn?.email?.enabled || !data.signIn?.email?.passwordRequired) {
    await client.request({ url: `${url}?updateMask=signIn.email.enabled,signIn.email.passwordRequired`, method: 'PATCH', headers: { 'x-goog-user-project': PROJECT }, data: { signIn: { email: { enabled: true, passwordRequired: true } } } });
    console.log('メールアドレスとパスワードのログインをオンにしました');
  }
} catch (e) {
  console.log(`::warning::メールアドレスのログインを自動でオンにできませんでした（${e.message}）。Firebase の Authentication → ログイン方法 で「メール/パスワード」を有効にしてください`);
}
if (OWNER_EMAIL) {
  try { await admin.auth().getUserByEmail(OWNER_EMAIL); console.log('使う人は登録済みです'); }
  catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    // パスワードはまだ決めない（画面の「メールで設定」から本人が決める）
    await admin.auth().createUser({ email: OWNER_EMAIL, emailVerified: true });
    console.log(`使う人を登録しました: ${OWNER_EMAIL}`);
  }
}

// 3. Render から写す（Firebase にまだない種類だけ。あるものは上書きしない）
const db = admin.firestore();
const existing = await db.collection('yarukoto').get();
const have = new Set(existing.docs.map((d) => d.id));
console.log('Firebase にあるもの:', [...have].join(', ') || 'なし');
if (DOCS.every((n) => have.has(n))) {
  console.log('全部そろっているので、写しません');
  process.exit(0);
}
if (!BOARD_URL || !BOARD_PASSWORD) {
  console.log('BOARD_URL・BOARD_PASSWORD がないので、Render からは写しません（画面の「設定」→「ファイルから読み込む」でも入れられます）');
  process.exit(0);
}
const exportUrl = BOARD_URL.replace(/\/+$/, '') + '/api/export';
let docs = null;
// Render は眠っていたり、新しい版に入れ替え中だったりするので、何度か聞く
for (let i = 0; i < 12 && !docs; i++) {
  try {
    const res = await fetch(exportUrl, { headers: { 'x-board-key': BOARD_PASSWORD }, signal: AbortSignal.timeout(90000) });
    if (res.status === 401) { console.log('::warning::BOARD_PASSWORD が違うため、Render から写せませんでした'); process.exit(0); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    docs = (await res.json()).docs;
  } catch (e) {
    console.log(`Render の返事待ち（${i + 1}回目）: ${e.message}`);
    await new Promise((r) => setTimeout(r, 30000));
  }
}
if (!docs) { console.log('::warning::Render から写せませんでした（画面の「設定」→「ファイルから読み込む」で入れてください）'); process.exit(0); }
let n = 0;
for (const name of DOCS) {
  const d = docs[name];
  if (have.has(name)) continue;
  if (d && d.value) { await db.doc(`yarukoto/${name}`).set({ value: d.value, ts: d.ts || Date.now() }); n++; console.log(`写しました: ${name}`); }
}
console.log(`Render から ${n}種類のデータを写しました`);
