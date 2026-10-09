# まちの顧客台帳（machino-crm）

https://machino-crm.web.app/ で公開中の顧客台帳アプリのソースです。

- `index.html` … アプリ本体（画面・処理・Firebase の接続設定をすべて含む1ファイル）
- データは Firebase（プロジェクト `machino-crm`）の Firestore に保存され、ログインは Firebase Authentication を使用しています。
- 公開中のサイトは `manifest.json` と `icon.png` も読み込んでいますが、まだこのフォルダにはありません。

## 公開（デプロイ）について
このフォルダを編集しても、自動では本番サイトに反映されません。
反映には Firebase プロジェクト `machino-crm` の権限を持つアカウントでのデプロイが必要です。
