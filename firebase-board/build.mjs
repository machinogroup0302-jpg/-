// todo/index.html から Firebase 用のページ（dist/index.html）を作る
// Firebase の設定は、公開先が自動で用意する /__/firebase/init.js から読む（設定を書き写さなくてよい）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FB = '10.14.1';
const body = await fs.readFile(path.join(here, '..', 'todo', 'index.html'), 'utf8');
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1b2a"/><rect x="14" y="16" width="36" height="34" rx="5" fill="#fff"/><rect x="14" y="16" width="36" height="9" rx="4" fill="#4bb5a6"/><path d="M22 37l5 5 11-12" stroke="#0d1b2a" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
<link rel="apple-touch-icon" href="/icon.svg">
<script src="/__/firebase/${FB}/firebase-app-compat.js"></script>
<script src="/__/firebase/${FB}/firebase-auth-compat.js"></script>
<script src="/__/firebase/${FB}/firebase-firestore-compat.js"></script>
<script src="/__/firebase/init.js"></script>
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
await fs.writeFile(path.join(here, 'dist', 'icon.svg'), icon);
console.log('dist/index.html を作りました');
