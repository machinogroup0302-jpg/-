#!/bin/sh
# todo/index.html から、相場分析サイト（Render）用の /board/ ページを作る
# 使い方: sh todo/build-board.sh <相場分析サイトの market-analyzer フォルダ>
#   → <フォルダ>/public/board/index.html を書き出す
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="${1:?market-analyzer フォルダを指定してください}/public/board/index.html"
mkdir -p "$(dirname "$out")"
{
  cat <<'EOF'
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1b2a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="やることボード">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<!-- このファイルは todo/index.html（claude/jolly-goldberg-1a7dqb）から todo/build-board.sh で作っています。直すときはそちらを直して作り直してください -->
<script>window.BOARD_SERVER = true;</script>
<style>:root{padding-top:env(safe-area-inset-top,0px)}</style>
</head>
<body>
EOF
  cat "$here/index.html"
  printf '\n</body>\n</html>\n'
} > "$out"
echo "書き出しました: $out"
