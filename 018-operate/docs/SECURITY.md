# SECURITY.md

## 認証・セッション
- パスワード: scrypt (N=32768, r=8, p=1, 16B salt)。10 文字以上。未知ユーザーでも同等の計算時間。
- ログイン失敗 10 回で 15 分ロック（`users.locked_until`）。IP あたり 30 回/分・アカウントあたり 8 回/分のレート制限（プロセス内。複数インスタンス時は前段 WAF/LB でも制限すること）。エラーメッセージは存在有無を区別しない。
- セッション: 32 バイト乱数トークンを HttpOnly / SameSite=Lax / 本番 Secure Cookie に格納。DB には sha256 のみ。既定 12 時間（利用中は延長）。ログアウト・無効化・パスワード変更（他端末）・外部共有停止で失効し、`revoked_reason` を記録。
- CSRF: 状態変更リクエストは `x-csrf-token`（セッションごとの乱数、定数時間比較）必須。本番は Origin ヘッダーも `PUBLIC_URL` と照合。
- SSO/SAML・MFA は Pro 版候補（初版未実装）。

## 認可
docs/RBAC_ABAC.md。全 API でサーバー側判定。見えない資源は 404（存在を隠す）。ID を書き換えても他テナント・権限外の Document / Version / Course / Quiz / Attempt / Audit にアクセスできないことを API テストで確認（server/test/integrity.test.ts）。

## テナント分離
PostgreSQL RLS（`org_id = app_org()`）+ アプリ側 org 条件の二重防御。アプリ DB ロールは NOSUPERUSER / NOBYPASSRLS / 非 owner。監査ログは UPDATE/DELETE 権限なし。

## 入力・出力
- すべての API 入力を zod で検証（型・長さ・列挙）。SQL はタグ付きテンプレート `sql\`\`` で常にバインド変数（文字列連結なし）。
- リッチテキスト: ProseMirror JSON をサーバーで whitelist 正規化（許可ノード・マーク・属性のみ保存。`javascript:` 等のリンクは除去、画像は自組織の添付 URL のみ）。表示は React 要素として描画し `dangerouslySetInnerHTML` を使わない。貼り付け HTML もエディタのスキーマでパースされ未知要素は落ちる。
- アップロード: 10MB 上限。種別はマジックバイトで判定（PNG/JPEG/GIF/WebP、PDF、docx/xlsx/pptx、テキスト）。SVG/HTML 不可。配信時 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、非画像は `attachment`。毎回 ACL 判定。
- ダウンロード（エクスポート）: 本人限定・10 分・1 回限りのトークン URL（DB は sha256 のみ保持）。
- CSV: BOM 付き UTF-8、formula injection 無害化。ZIP: 安全なファイル名のみ。

## HTTP ヘッダー
`Content-Security-Policy`（default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; style は TipTap のため 'unsafe-inline'）、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`、`Permissions-Policy`、本番 `Strict-Transport-Security`、API は `Cache-Control: no-store`。

## 秘密情報
環境変数のみ（`APP_SECRET`, `DATABASE_URL`, `DATABASE_ADMIN_URL`, `ANTHROPIC_API_KEY`）。本番で `APP_SECRET` が既定値なら起動しない。ログで Cookie・CSRF ヘッダーを redact。AI キーはクライアントに送らない。

## AI
docs/AI_RAG_SECURITY.md。

## オフライン
Service Worker は API 応答をキャッシュしない。オフライン保存は許可区分のみ IndexedDB に明示保存。再接続時に再検証し、廃止・権限外は削除。ログアウトで全消去。共有端末では「端末に保存」を使わない運用を説明書で案内。

## プライバシー
- ユーザー無効化 → セッション失効、未完了の研修割当・確認依頼を取消（履歴は保持）。
- 匿名化 → 表示名「退職者-xxxx」、メールを無効化、パスワード削除。承認・受講・監査の記録は整合性維持のため保持（監査ログの actor_label には当時の表示名が残る。完全削除が必要な場合はテナント単位の削除で対応）。
- 検索分析は利用者 ID を保存しない。保存期間設定（既定 180 日）。AI 利用ログは本文を保存しない。
- 法令（個人情報保護法等）への準拠を自動保証しない。データ取扱いの説明は manual/注意事項.txt・AI利用時の注意.txt。

## 既知の制限（販売前に説明）
- レート制限はプロセス内メモリ（複数台構成では共有されない）。
- ウイルススキャンは未実装（アップロードはマジックバイト検証のみ）。必要なら前段で ClamAV 等を追加。
- MFA / SSO 未実装。
- 実機（iPhone Safari / Android Chrome / iPad）での確認は本セッションでは Chromium のデバイスエミュレーションのみ（TEST_REPORT.md）。
