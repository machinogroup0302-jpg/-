// 公開の前の準備（GitHub Actions から動かす。何度動かしても大丈夫）
//  1. 新しいサイトの住所で Google ログインができるように「ログインを許すドメイン」に足す
//  2. Google ログインをこのサイトの住所のままでできるか確かめる（できれば AUTH_SELF=1）
//  3. Firebase にまだデータがなければ、Render のやることボードから中身を写す
// 使うもの: GOOGLE_APPLICATION_CREDENTIALS（Firebase の秘密鍵）, PROJECT, SITE
//           BOARD_URL・BOARD_PASSWORD（Render のやることボード。なければ 2 はしない）
import admin from 'firebase-admin';
import { GoogleAuth } from 'google-auth-library';

const { PROJECT, SITE, BOARD_URL, BOARD_PASSWORD } = process.env;
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

// 2. Google ログインを、このサイトの住所のままでできるか確かめる
//    （iPhone の Safari・ホーム画面のアプリは、別の住所を通すログインだと失敗したり、すぐ忘れたりする）
//    Google Cloud の「OAuth クライアント」に https://SITE.web.app/__/auth/handler が入っていれば、このサイトの住所でログインする
try {
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const { data } = await client.request({ url: `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/defaultSupportedIdpConfigs/google.com`, headers: { 'x-goog-user-project': PROJECT } });
  const probe = async (redirect) => {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({ client_id: data.clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid email' });
    const res = await fetch(u, { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    return { status: res.status, ok: res.status >= 300 && res.status < 400 && !/error|authError/i.test(loc) };
  };
  const mine = await probe(`https://${SITE}.web.app/__/auth/handler`);
  const bad = await probe('https://example.invalid/__/auth/handler');
  const base = await probe(`https://${PROJECT}.firebaseapp.com/__/auth/handler`);
  console.log(`ログインの住所の確認: このサイト ${mine.ok ? 'OK' : 'まだ'} / いつもの住所 ${base.ok ? 'OK' : 'まだ'} / でたらめな住所 ${bad.ok ? 'OK' : 'まだ'}`);
  if (mine.ok && !bad.ok) {
    console.log('このサイトの住所でログインします');
    if (process.env.GITHUB_ENV) await import('node:fs').then((fs) => fs.appendFileSync(process.env.GITHUB_ENV, 'AUTH_SELF=1\n'));
  } else {
    console.log(`::warning::iPhone でログインしやすくするには、Google Cloud の「APIとサービス」→「認証情報」→「Web client (auto created by Google Service)」の「承認済みのリダイレクト URI」に https://${SITE}.web.app/__/auth/handler を足してください`);
  }
} catch (e) {
  console.log(`::warning::ログインの住所を確かめられませんでした（${e.message}）`);
}

// 2b. メールのリンクでのログイン（パスワードなし）を使えるようにする
try {
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;
  const { data } = await client.request({ url, headers: { 'x-goog-user-project': PROJECT } });
  if (!data.signIn?.email?.enabled || data.signIn?.email?.passwordRequired !== false) {
    await client.request({ url: `${url}?updateMask=signIn.email.enabled,signIn.email.passwordRequired`, method: 'PATCH', headers: { 'x-goog-user-project': PROJECT }, data: { signIn: { email: { enabled: true, passwordRequired: false } } } });
    console.log('メールのリンクでのログインをオンにしました');
  } else console.log('メールのリンクでのログインはオンです');
} catch (e) {
  console.log(`::warning::メールのリンクでのログインをオンにできませんでした（${e.message}）`);
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
