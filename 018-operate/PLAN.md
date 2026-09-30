# Operate — 開発計画 (PLAN.md)

商品 #018 **Operate** — 「会社のマニュアル・新人教育・ルール変更を、ひとつにまとめる。」

組織内の「仕事のやり方」を資産化する SaaS。
SOP 作成 → レビュー → 承認 → 公開 → 権限別配布 → 検索 → 研修 → 理解度テスト → 読了/合格記録 →
改訂期限 → 新 version → 再承認 → 重要変更の再確認 → 監査証跡 までを一元管理する。

> 既存商品との境界: #012 案件/見積/請求、#013 在庫、#014 顧客との制作物承認、#015 予約、
> #016 サービス事業運営、#017 EC 出荷。#018 は **組織内の業務知識・標準手順・教育・理解確認・改訂・監査** のみを扱う。
> 注文/在庫/予約/請求/決済/給与/勤怠/ATS/CRM/汎用チャット/ビデオ会議は実装しない。

## 1. 技術構成（概要。詳細は DECISIONS.md）

| 層 | 採用 | 理由 |
|---|---|---|
| API | Node.js 22 + TypeScript + Fastify 5 | 型安全・高速・依存が少ない |
| DB | PostgreSQL 16 + pgvector + pg_trgm | RLS による tenant 分離、全文(日本語 trigram)検索、vector 検索を 1 つの DB で ACL 付き実行 |
| 入力検証 | zod | 全 API の body/query を schema 検証 |
| Web | React 19 + Vite + TypeScript + React Router | PWA / SPA |
| Editor | TipTap 3 (ProseMirror) | MIT、schema 型エディタ。保存は JSON、サーバーで whitelist 検証 |
| PWA | 自作 Service Worker + IndexedDB | 機密分類に応じた offline 制御を明示的に実装するため |
| AI | Provider 抽象化: `off` / `local`(外部送信なし) / `anthropic` | AI OFF 可能、外部送信は管理者設定のみ |
| Embedding | ローカル hashing embedding (256 次元, 外部送信なし) → pgvector | 社内文書を embedding 目的で外部送信しない |
| PDF | pdfkit + Noto Sans JP (OFL) | 研修完了証・SOP PDF |
| Test | Vitest (API 統合 / 権限 / AI) + Playwright (E2E, PC/iPhone/Android/iPad エミュレーション) | |

## 2. マルチテナント
* 全業務テーブルに `org_id`。アプリは **非 owner の DB ロール**（NOBYPASSRLS）で接続し、全テーブルの **Row Level Security** (`org_id = app_org()`) の対象になる。
* 1 リクエスト = 1 トランザクション、`set_config('app.org_id', …, true)` を最初に実行。アプリの WHERE 句の付け忘れがあっても他 tenant 行は DB が返さない（二重防御）。
* 監査ログは INSERT/SELECT 権限のみ（UPDATE/DELETE 不可 + trigger）。

## 3. Phase 計画と状態

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 技術/料金/license 調査、multi-tenant/RBAC 方針、Editor/Search/AI PoC、PWA 方針 | PROGRESS.md 参照 |
| 1 | Organization / Department / Team / User / RBAC / ABAC / Classification | |
| 2 | Document / Version / Editor / Template / Step SOP / Attachment | |
| 3 | Review / Approval / 多段承認 / Publish / Audience | |
| 4 | 全文検索 / Relation / Review Cycle / Feedback | |
| 5 | Checklist Run / Attestation / 重要変更の再確認 | |
| 6 | Course / Module / Assignment / Quiz / Attempt / Completion / Onboarding / Certificate / Skill Matrix | |
| 7 | AI retrieval / citation / AI Draft / AI Quiz Draft / AI Security / Cost | |
| 8 | Dashboard / Knowledge Health / Search Analytics / External Member | |
| 9 | Audit Package / Export / Import / Audit Log | |
| 10 | Backup / Restore / Privacy / Offline / Security | |
| 11 | 権限 / AI / 並行 / 負荷 / E2E / 端末 / Accessibility テスト | |
| 12 | 購入者資料 / Deploy / 運用費 / 販売前チェック | |

各 Phase の実際の完了状況は **PROGRESS.md** が正。未完了 Phase があれば全体完成と報告しない。

## 4. ディレクトリ

```
018-operate/
  server/        API・DB migration・job worker・CLI(backup/restore/seed)
  web/           React PWA
  e2e/           Playwright E2E
  load/          負荷試験 (データ生成 + 計測スクリプト)
  docs/          設計資料 (DATA_MODEL.md など)
  manual/        購入者向け説明書 (日本語 .txt)
  sales/         販売コピー・LP 文言
  brand/         ロゴ・アイコン・ブランドボード
```
