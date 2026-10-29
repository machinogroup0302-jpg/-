# 復活の手順書（新しい Claude に渡す用）

このサイト（相場分析ノート）を、何かあったときに作り直すための手順です。
新しく Claude を始めたら、このフォルダ（market-analyzer）一式を渡して
「HANDOVER.md を読んで、このサイトを Render で復活させて」と頼んでください。

> パスワードや鍵の「中身」はこのファイルに書いていません（GitHub は公開なので）。
> 中身は自分のパソコンのメモやパスワード管理アプリに控えておき、チャットには貼らないでください。

## 1. 全体の作り

| もの | 場所 | 中身 |
|---|---|---|
| サイト本体 | GitHub `machinogroup0302-jpg/-` の `market-analyzer/`（ブランチ `claude/trusting-planck-dsasvf`） | Node 22。`server.js` が入口。ライブラリなし（`npm install` は試験用だけ） |
| 公開先 | Render（無料プラン）`https://wataru-lupe.onrender.com` | Root Directory `market-analyzer` / Build `npm install` / Start `npm start` |
| 自動の仕事 | GitHub Actions（`.github/workflows/`）。控えは `ops/workflows/` | 売買サインのメール・見張り・Render への反映 |
| 自分のドライブの控え | Google Apps Script（`ops/drive-backup.gs`）。1時間ごとにこのブランチの ZIP をドライブの「相場分析サイト_控え」に保存（新しい3つ） | パソコン版 Google ドライブでパソコンにも自動で入る |
| 寝かせない | cron-job.org（5分ごとにサイトを開く） | 無料。アカウントは自分で作ったもの |
| 利用者のデータ | サーバーの中 ＋ 同じブランチの `alerts/prefs.json`（**暗号化した控え**。Actions の keepalive がサイトから受け取って保存） | 持っている株・予算・取引の記録など。サーバーは起動時にこれを読み戻す |

## 2. 必要な設定の名前（中身は自分の控えを見る）

Render の「Environment」に入れるもの：

- `SITE_PASSWORD` … サイトに入るパスワード。**データの控えの暗号の鍵とスマホ通知の鍵も兼ねている**ので、前と同じものを入れること（変えると控えが読めなくなる）
- `SESSION_SECRET` … 長い適当な文字列
- `PREFS_REPO` / `PREFS_BRANCH` … 省略可（`machinogroup0302-jpg/-` / `claude/trusting-planck-dsasvf`）

GitHub の「Settings → Secrets and variables → Actions」に入れるもの：

- `SITE_PASSWORD`（上と同じ）
- `MAIL_USER` / `MAIL_PASS` / `MAIL_TO` … 通知メールの送り元（Gmail とアプリパスワード）と送り先
- `RENDER_DEPLOY_HOOK_URL` … Render の「Deploy Hook」の URL

## 3. 作り直す順番

1. GitHub にこのフォルダを置く（リポジトリが消えていたら新しく作って入れる）
2. `ops/workflows/` の中身を、リポジトリの**いちばん初めのブランチ**の `.github/workflows/` に置く（`render-deploy.yml` はサイトのブランチにも置く）。URL が変わったら中の `wataru-lupe.onrender.com` を新しい URL に書き換える
3. Render で Web Service を作る（上の設定）。Environment を入れる
4. GitHub の Secrets を入れる
5. cron-job.org で `https://（新しいURL）/api/status` を5分ごとに開く設定をする
6. サイトに入って、設定（⚙）→「📤 ファイルから戻す」で、自分のパソコンに取っておいたデータ（JSON）を読み込む

## 4. 動作の確かめ方

- `npm test` … 計算のテスト
- Actions の health を手で動かす … 本物のサイトが動いているか、エラーが出ていないか
