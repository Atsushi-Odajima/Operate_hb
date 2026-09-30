<p><img src="brand/logo-horizontal.svg" alt="Operate" height="56"></p>

# Operate

**会社のマニュアル・新人教育・ルール変更を、ひとつにまとめる。**
仕事のやり方が、会社の力になる。

- 古いマニュアル、危険です⚠️
- “それ、○○さんしか分からない”をなくす。
- 新人に同じ説明、何回していますか？

## こんなことができます
- 会社のマニュアルを最新版にそろえる（古い版は履歴に残し、使うべき版だけを見せる）
- 新人が何を覚えたか確認する（研修・テスト・完了記録）
- 重要なルール変更を全員が読んだか確認する（「確認しました」を版ごとに記録）
- 「誰に聞けばいい？」を社内検索で減らす（承認済みの手順だけを検索・AI が根拠付きで回答）
- 退職者しか知らない仕事を会社に残す（手順を1ステップずつ残し、スマホで見ながら作業）
- 古くなった手順を見つけて更新する（定期レビューの期限・現場からのフィードバック）

使い方の説明は [`manual/`](manual/)（購入者向け・日本語）、販売用の文章は [`sales/`](sales/)、ブランドは [`brand/`](brand/)（[ブランドボード](brand/brand-board.png)）。

---

## 開発者・技術担当者向け

| 項目 | 内容 |
|---|---|
| 主な専門機能 | SOP・ドキュメント管理 / Version 管理 / Review・Approval（最大3段・contentHash 束縛）/ RBAC・ABAC（部署・チーム・ロール・機密区分）/ 研修（Course・Module・Assignment・Onboarding）/ Quiz / Attestation / AI Knowledge Search（ACL 適用済み retrieval・引用必須）/ Audit Log・Audit Package / Review Cycle / External Member / PWA・Offline 制御 / Import・Export / Backup・Restore |
| 構成 | Node.js 22 + TypeScript + Fastify 5 / PostgreSQL 16（RLS・pg_trgm・pgvector）/ React 19 + Vite + TipTap 3（PWA）/ Anthropic 公式 SDK（任意） |
| テナント分離 | PostgreSQL Row Level Security + 非 owner のアプリ用ロール |
| テスト | Vitest（API 統合・必須 30 項目・権限・AI セキュリティ）、Playwright（E2E-1〜10、PC / iPhone / Android / iPad エミュレーション、axe アクセシビリティ）、負荷試験 |

- 計画・進捗: [PLAN.md](PLAN.md) / [PROGRESS.md](PROGRESS.md) / [DECISIONS.md](DECISIONS.md) / [NEXT_STEPS.txt](NEXT_STEPS.txt)
- 設計資料: [docs/](docs/)（DATA_MODEL, RBAC_ABAC, DOCUMENT_VERSIONING, APPROVAL_WORKFLOW, SEARCH_ARCHITECTURE, AI_RAG_SECURITY, TRAINING_MODEL, QUIZ_RULES, ATTESTATION_RULES, AUDIT_MODEL, SECURITY, OPERATIONS, OPERATING_COSTS, DEVELOPMENT）
- 試験結果: [TEST_REPORT.md](TEST_REPORT.md)、販売前チェック: [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)

### クイックスタート（ローカル）
```bash
npm install
./server/scripts/setup-local-db.sh operate
cd server && DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/operate npm run seed
npm run dev                      # API :8080
cd ../web && npm run dev         # http://localhost:5173
```
組織ID `sample-works` / 例 `member-cs@sample-works.example` / パスワード `Operate-Demo-2026!`（サンプル組織専用。本番には入れない）
