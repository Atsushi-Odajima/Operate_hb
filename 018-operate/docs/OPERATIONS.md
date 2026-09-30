# OPERATIONS.md — 運用・デプロイ手順

## 1. 必要環境
- Node.js 22 以上、npm 10 以上
- PostgreSQL 16（拡張: `pgvector`, `pg_trgm`, `pgcrypto`）。データベースは **`LC_CTYPE`/`LC_COLLATE` = `C.UTF-8`（または ja_JP.UTF-8）** で作成（日本語 trigram 検索のため）
- 2 つの DB 接続:
  - `DATABASE_ADMIN_URL`: テーブル owner（migration / バックアップ / 復元 / CLI 用）
  - `DATABASE_URL`: アプリ用ロール `operate_app`（`NOSUPERUSER NOBYPASSRLS`、owner ではない）

```sql
CREATE ROLE operate_app LOGIN PASSWORD '<強いパスワード>' NOSUPERUSER NOBYPASSRLS;
-- migration 実行時に必要な GRANT は自動で付与される（APP_DB_ROLE=operate_app）
```

## 2. 環境変数
| 変数 | 例 | 説明 |
|---|---|---|
| NODE_ENV | production | production で Secure Cookie・HSTS・Origin 検査 |
| PORT / HOST | 8080 / 0.0.0.0 | |
| DATABASE_URL | postgres://operate_app:…@host/operate | アプリ接続 |
| DATABASE_ADMIN_URL | postgres://owner:…@host/operate | migration・バックアップ |
| APP_DB_ROLE | operate_app | GRANT 付与先 |
| APP_SECRET | 64 文字以上の乱数 | 完了証署名。本番で既定値だと起動しない |
| PUBLIC_URL | https://operate.example.co.jp | Origin 検査 |
| WEB_DIST | /app/web/dist | 同一オリジンで SPA を配信 |
| RUN_WORKER | true / false | Web プロセス内でワーカーを動かすか |
| MIGRATE_ON_START | true | 起動時に migration |
| ANTHROPIC_API_KEY | (任意) | AI provider=anthropic のときのみ |
| EMAIL_MODE | log / off | 初版は log（送信内容の宛先を伏せてログ出力）。off の場合は通知メールを送らず保留のまま（アプリ内通知は通常どおり）。実送信は SMTP/送信サービス連携を追加実装 |
| SESSION_HOURS | 12 | |
| MAX_UPLOAD_BYTES | 10485760 | |

## 3. ビルドと起動
```bash
cd 018-operate
npm ci
npm run build                 # server/dist と web/dist
cd server && npm run migrate  # DATABASE_ADMIN_URL
node dist/index.js            # WEB_DIST=../web/dist
# ワーカーを分離する場合: RUN_WORKER=false で Web、別プロセスで `npm run worker`
```
Docker: `018-operate/Dockerfile`（マルチステージ、非 root 実行）。Render: `018-operate/render.yaml`（Web + Postgres の Blueprint 例）。

## 4. 顧客組織の開設
```bash
cd server && npm run create-org -- <組織ID> "<組織名>" <owner-email> "<Owner 氏名>"
# 出力の temporaryPassword を Owner に安全に渡す。初回ログイン後に変更してもらう
```
デモ: `npm run seed`（sample-works、全員 `Operate-Demo-2026!`）。**本番 DB にはサンプルを入れない**。`--reset` はサンプル組織以外を削除しない。

## 5. ジョブ（ワーカー）
- 15 秒ごと: 実行時刻の来たジョブ（指定日時公開）を `FOR UPDATE SKIP LOCKED` で処理。失敗は指数バックオフで最大 5 回。
- 毎時: 組織ごとの sweep（定期レビュー期限・確認依頼期限・研修期限の通知、外部共有期限切れのセッション失効と監査記録、検索分析の保持期間削除、期限切れトークン・セッション削除）。通知は dedupe キーで重複しない。
- 複数台で動かしても SKIP LOCKED と冪等キーで二重処理しない。

## 6. バックアップと復元
1. マネージド DB の自動バックアップ / PITR を必ず有効化（日次以上）。
2. テナント単位: Owner が画面から、または `npm run backup -- <組織ID> [出力先]`。`.json.gz` にはパスワードハッシュ・機密文書が含まれるため暗号化保管。
3. 復元（サーバー管理者）:
```bash
npm run restore -- backup.json.gz --dry-run   # 検証のみ（形式・スキーマ・件数・SHA-256・他組織データ混入）
npm run restore -- backup.json.gz             # 空の環境へ復元（同じ組織が存在すればエラー）
npm run restore -- backup.json.gz --replace   # 既存の同組織を置き換え（単一トランザクション）
```
本番イメージ（devDependencies なし）では `node dist/cli/backup.js`, `node dist/cli/restore.js`, `node dist/cli/create-org.js`, `node dist/cli/migrate.js` を使う（引数は同じ）。
復元は 1 トランザクションで行い、復元後に件数・currentVersion・承認ハッシュ・修了記録を検証してからコミット。失敗時は何も変更されない。
4. 年 2 回以上、空環境への復元リハーサルを行い結果を記録する。

## 7. 監視
- `GET /api/health`（DB 非依存の死活）。DB 接続はアプリログのエラーで監視。
- 見るべき指標: 5xx 率、p95 応答時間、jobs の failed 件数（`SELECT count(*) FROM jobs WHERE status='failed'`）、DB 容量、AI 月額（管理画面 > ナレッジ状況 > AI の利用状況）。

## 8. 大規模化の指針（負荷試験結果に基づく）
- 1 テナント 1,000 名までは単一 DB インスタンスで十分（TEST_REPORT.md）。
- audit_events が数千万行を超える場合、`created_at` 月次パーティション化を推奨。
- 多テナント SaaS として運用する場合、DB コネクション数（`DB_POOL_MAX`）と PgBouncer（transaction モード。`set_config(..., true)` はトランザクション内なので互換）を検討。

## 9. アップデート
1. バックアップ取得 → 2. `npm run migrate`（追加のみの migration）→ 3. アプリ入替 → 4. `/api/health` とスモークテスト（ログイン・検索・文書表示）。
Service Worker はキャッシュ名 `operate-shell-v1` を変更すると旧キャッシュを削除する。
