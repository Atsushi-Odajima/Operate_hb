# RELEASE_CHECKLIST.md — 販売前チェック

凡例: [x] このセッションで確認済み / [ ] 人間の確認・判断が必要

## A. 製品・機能（完成条件 52 章）
- [x] 1 PC / iPhone / Android / iPad の主要操作（Playwright デバイスエミュレーション。実機は未確認 → H）
- [x] 2 PWA（manifest・アイコン・maskable・Service Worker・オフライン閲覧）
- [x] 3 Multi-tenant 分離（RLS + ID 書換えテスト）
- [x] 4 RBAC / ABAC
- [x] 5 Document / Version 分離（DB トリガーで不変）
- [x] 6 Rich Editor / Template / Step SOP
- [x] 7 Review / Approval / 多段承認
- [x] 8 contentHash による承認整合性
- [x] 9 Scheduled Publish / Effective Date
- [x] 10 Audience / Classification
- [x] 11 ACL を守る全文検索
- [x] 12 Document Relation / 改訂期限
- [x] 13 Feedback
- [x] 14 Checklist Run
- [x] 15 version 固定 Attestation
- [x] 16 Major 変更の再確認
- [x] 17 Course / Module / Assignment
- [x] 18 Quiz / Attempt / Completion
- [x] 19 Onboarding Path
- [x] 20 External Member
- [x] 21 AI OFF 可能
- [x] 22 ACL 適用済み AI retrieval
- [x] 23 source / version citation 付き AI 回答
- [x] 24 根拠なし hallucination 抑制
- [x] 25 AI Draft は Draft のみ
- [x] 26 AI Quiz は人間確認必須
- [x] 27 AI cost / rate control
- [x] 28 Dashboard / Knowledge Health
- [x] 29 Search Analytics
- [x] 30 Audit Log
- [x] 31 Audit Package
- [x] 32 Import / Export
- [x] 33 Backup / Restore
- [x] 34 Offline classification 制御
- [x] 35 必須 / E2E / 権限 / AI / 負荷テスト（実機テストは H を参照）
- [x] 36 運用費資料（docs/OPERATING_COSTS.md、料金は二次情報 → B）
- [x] 37 購入者向け説明書（manual/）

## B. 料金・ライセンス（人間確認）
- [ ] Render / Supabase / Neon 等の **公式料金ページ** で docs/OPERATING_COSTS.md の数値を再確認（本セッションは公式サイトへのアクセスが遮断され、二次情報で算出）
- [ ] Anthropic の商用利用規約・データ保持設定（ZDR 可否など）を確認し、manual/AI利用時の注意.txt の記述と一致させる
- [ ] 依存パッケージのライセンス最終確認（`npx license-checker --production`）と manual/THIRD_PARTY_NOTICES.txt の更新
- [ ] フォント（Plus Jakarta Sans / Noto Sans JP, OFL 1.1）の同梱方法が販売形態と整合しているか

## C. ブランド・販売表現（人間確認）
- [x] 製品名は全ファイルで「Operate」
- [x] ブランドボード（brand/brand-board.png）: ロゴ → 1行説明 → 困りごと3つ → 利用シーン4つ → 主な機能5つ → PWA アイコン、人物写真なし
- [ ] ロゴの商標調査（「Operate」は一般名詞。商標登録・類似商標の確認）。支給ブランドボードのロゴを参考にした自作ベクターであることの権利確認
- [ ] 「◯万人対応」「法令準拠を保証」「資格」等の表現を使っていないか販売ページ最終確認（sales/ は使わない方針で作成）
- [ ] 価格（79,800〜149,800 円）とホスティング・保守費の請求方法（買い手環境 or 月額）を決定

## D. セキュリティ・運用（人間確認）
- [ ] 本番 `APP_SECRET` を十分な長さの乱数で設定、`DATABASE_URL` は非 owner ロール
- [ ] PostgreSQL の自動バックアップ / PITR を有効化、復元リハーサルを実施
- [ ] 複数インスタンス構成の場合、前段（WAF / LB）でログインのレート制限を追加
- [ ] アップロードのウイルススキャンが必要な顧客には前段スキャンを追加
- [ ] メール通知を使う場合の送信サービス設定（初版は EMAIL_MODE=log のみ実装）
- [ ] 第三者によるペネトレーションテスト（推奨）

## E. データ
- [x] サンプル組織は `sample-works`（is_sample=true）で本番組織と分離。`seed --reset` はサンプル以外を削除しない
- [ ] 実企業データ・実ユーザーへのメール送信・外部 AI への実機密情報送信は、このセッションでは一切行っていない。導入時に顧客の同意と設定で行う

## F. デプロイ
- [x] 本番ビルド（`npm run build`）と起動を確認（HSTS・CSP・Secure Cookie）
- [x] Dockerfile / render.yaml を用意
- [ ] 実際のクラウドへの本番公開（このセッションでは行っていない：有料契約・本番公開は人間判断）

## G. テスト結果
TEST_REPORT.md を参照。

## H. 実機確認（人間が実施）
- [ ] iPhone（iOS Safari）: ホーム画面に追加 → standalone 起動・セーフエリア・アイコン表示・オフライン閲覧
- [ ] Android（Chrome）: インストール → maskable アイコン・オフライン
- [ ] iPad（Safari）: 横/縦表示、ステップ実行
- [ ] Windows / macOS（Chrome / Edge）: PWA インストール
- [ ] 小サイズ（16/32px favicon、ホーム画面アイコン）で "O" マークが潰れないこと
