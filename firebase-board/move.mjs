// やることボード専用の Firebase（FIREBASE_SA_BOARD）を使う準備（GitHub Actions から動かす。何度動かしても大丈夫）
// machino-crm と同じ Firebase だと、1日の無料の回数を取り合って止まるため、データとログインだけ別の Firebase に分ける
// （サイトの住所 machino-yarukoto.web.app と公開先は今のまま）
//  1. ログインを許すドメインに machino-yarukoto.web.app を足し、メールのリンクでのログインをオンにする
//  2. Firestore のルール（yarukoto は OWNER_EMAIL だけ）を入れる
//  3. ページに入れる設定（apiKey など。公開してよいもの）を取り出して BOARD_CONFIG に入れる
//  4. 新しい Firebase にまだないデータだけ、前の Firebase（FIREBASE_SA）から写す（あるものは上書きしない）
import admin from 'firebase-admin';
import { GoogleAuth } from 'google-auth-library';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const { SA_OLD, SA_NEW, SITE, OWNER_EMAIL, GITHUB_ENV } = process.env;
const saNew = JSON.parse(SA_NEW), saOld = JSON.parse(SA_OLD);
const P = saNew.project_id;
const DOCS = ['tasks', 'schedule', 'fixed', 'checks', 'settings'];
console.log(`やることボード専用の Firebase: ${P}`);
const client = await new GoogleAuth({ credentials: saNew, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
const call = (url, opt = {}) => client.request({ url, ...opt, headers: { 'x-goog-user-project': P, ...(opt.headers || {}) } });

// 1. ログインの設定
const cfgUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/config`;
try {
  const { data } = await call(cfgUrl);
  const have = data.authorizedDomains || [];
  const want = [`${SITE}.web.app`, `${SITE}.firebaseapp.com`].filter((d) => !have.includes(d));
  if (want.length) { await call(`${cfgUrl}?updateMask=authorizedDomains`, { method: 'PATCH', data: { authorizedDomains: [...have, ...want] } }); console.log('ログインを許すドメインに足しました:', want.join(', ')); }
  if (!data.signIn?.email?.enabled || data.signIn?.email?.passwordRequired !== false) {
    await call(`${cfgUrl}?updateMask=signIn.email.enabled,signIn.email.passwordRequired`, { method: 'PATCH', data: { signIn: { email: { enabled: true, passwordRequired: false } } } });
    console.log('メールのリンクでのログインをオンにしました');
  }
} catch (e) {
  console.log(`::warning::ログインの設定を自動でできませんでした（${e.response?.data?.error?.message || e.message}）。Authentication を「始める」を押したか確かめてください`);
}
try {
  const { data } = await call(`https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/defaultSupportedIdpConfigs/google.com`);
  console.log(`Google ログイン: ${data.enabled ? 'オン' : 'オフ'}`);
  if (!data.enabled) console.log('::warning::Authentication → ログイン方法 で Google を「有効」にしてください');
} catch { console.log('::warning::Google ログインがまだオンになっていません（Authentication → ログイン方法 → Google → 有効）'); }

// 2. Firestore のルール
fs.writeFileSync('board.rules', `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // やることボード：${OWNER_EMAIL} だけが読み書きできる
    match /yarukoto/{doc} {
      allow read, write: if request.auth != null && request.auth.token.email_verified == true
        && request.auth.token.email == '${OWNER_EMAIL}';
    }
  }
}
`);
fs.writeFileSync('firebase-rules.json', JSON.stringify({ firestore: { rules: 'board.rules' } }));
fs.writeFileSync(`${process.env.RUNNER_TEMP || '.'}/sa-new.json`, SA_NEW);
try {
  execFileSync('npx', ['firebase', 'deploy', '--only', 'firestore:rules', '--config', 'firebase-rules.json', '--project', P, '--non-interactive'], {
    stdio: 'inherit', env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: `${process.env.RUNNER_TEMP || '.'}/sa-new.json` },
  });
} catch {
  console.log('::error::Firestore のルールを入れられませんでした（Firestore Database を「作成」したか確かめてください）');
  process.exit(1);
}

// 3. ページに入れる設定
let config = null;
try {
  const base = `https://firebase.googleapis.com/v1beta1/projects/${P}/webApps`;
  let { data } = await call(base);
  let app = (data.apps || []).find((a) => a.state !== 'DELETED');
  if (!app) {
    console.log('ウェブアプリを登録します');
    const { data: op } = await call(base, { method: 'POST', data: { displayName: 'やることボード' } });
    for (let i = 0; i < 20 && !app; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const { data: o } = await call(`https://firebase.googleapis.com/v1beta1/${op.name}`);
      if (o.done) app = o.response;
    }
  }
  ({ data: config } = await call(`https://firebase.googleapis.com/v1beta1/${app.name}/config`));
  console.log('ページに入れる設定を取り出しました');
} catch (e) {
  console.log(`::error::ページに入れる設定を取り出せませんでした（${e.response?.data?.error?.message || e.message}）`);
  process.exit(1);
}

// 4. データを写す（新しいほうにまだない種類だけ）
const appNew = admin.initializeApp({ credential: admin.credential.cert(saNew) }, 'new');
const appOld = admin.initializeApp({ credential: admin.credential.cert(saOld) }, 'old');
const dbNew = appNew.firestore(), dbOld = appOld.firestore();
const have = new Set((await dbNew.collection('yarukoto').get()).docs.map((d) => d.id));
console.log('新しい Firebase にあるもの:', [...have].join(', ') || 'なし');
const missing = DOCS.filter((n) => !have.has(n));
if (missing.length) {
  const old = await dbOld.collection('yarukoto').get();
  let n = 0;
  for (const d of old.docs) {
    if (!missing.includes(d.id)) continue;
    await dbNew.doc(`yarukoto/${d.id}`).set(d.data()); n++;
    console.log(`写しました: ${d.id}`);
  }
  console.log(`前の Firebase から ${n}種類のデータを写しました`);
}

if (GITHUB_ENV) fs.appendFileSync(GITHUB_ENV, `BOARD_CONFIG=${JSON.stringify(config)}\n`);
console.log('準備ができました');
