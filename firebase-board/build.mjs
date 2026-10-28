// todo/index.html から Firebase 用のページ（dist/index.html）を作る
// Firebase の設定は、公開先が自動で用意する /__/firebase/init.js（init.json）から読む（設定を書き写さなくてよい）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FB = '10.14.1';
const body = await fs.readFile(path.join(here, '..', 'todo', 'index.html'), 'utf8');
const ICONS = ['icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const manifest = {
  name: 'やることボード', short_name: 'やること', start_url: '/', display: 'standalone',
  background_color: '#0d1b2a', theme_color: '#0d1b2a',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
// AUTH_SELF=1（setup.mjs が確かめた）なら、ログインもこのサイトの住所で行う（iPhone でログインが続くように）
const init = process.env.AUTH_SELF
  ? `<script>(function(){var x=new XMLHttpRequest();x.open('GET','/__/firebase/init.json',false);x.send();var c=JSON.parse(x.responseText);if(/\\.web\\.app$/.test(location.hostname))c.authDomain=location.host;firebase.initializeApp(c);})();</script>`
  : '<script src="/__/firebase/init.js"></script>';
console.log(process.env.AUTH_SELF ? 'ログイン: このサイトの住所' : 'ログイン: いつもの住所');
const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1b2a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="やることボード">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="manifest" href="/manifest.webmanifest">
<script src="/__/firebase/${FB}/firebase-app-compat.js"></script>
<script src="/__/firebase/${FB}/firebase-auth-compat.js"></script>
<script src="/__/firebase/${FB}/firebase-firestore-compat.js"></script>
${init}
<script>window.BOARD_FIREBASE = true;</script>
<style>:root{padding-top:env(safe-area-inset-top,0px)}</style>
</head>
<body>
${body}
</body>
</html>
`;
await fs.mkdir(path.join(here, 'dist'), { recursive: true });
await fs.writeFile(path.join(here, 'dist', 'index.html'), html);
// ホーム画面のアイコン（icons/ の中身をそのまま置く）
for (const f of ICONS) await fs.copyFile(path.join(here, 'icons', f), path.join(here, 'dist', f));
await fs.writeFile(path.join(here, 'dist', 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
console.log('dist/index.html を作りました');
