# DEVELOPMENT.md

## 前提
Node.js 22, PostgreSQL 16 + pgvector（Debian/Ubuntu: `apt install postgresql-16-pgvector`）, Chromium（E2E）

## セットアップ
```bash
cd 018-operate
npm install
./server/scripts/setup-local-db.sh operate      # operate_app ロール作成 + DB 作成（C.UTF-8）
cp server/.env.example server/.env              # 値を確認
cd server && DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/operate npm run seed   # migration + サンプル組織
npm run dev            # API :8080（tsx watch）
cd ../web && npm run dev   # Vite :5173（/api は 8080 にプロキシ）
```
ログイン: 組織ID `sample-works` / `member-cs@sample-works.example` など / `Operate-Demo-2026!`

## 構成
```
server/src/
  app.ts, index.ts, http.ts(api() ルート定義・認証・CSRF・エラー), config.ts
  db/ (pool: tx(orgId) で RLS 設定, migrate, migrations/*.sql)
  lib/ (sql タグ, authz, content 正規化/ハッシュ, settings, crypto, csv, pdf, docpdf, markdown, ratelimit)
  services/ (documents, attestations, training, search, audit, notify, jobs, worker, backup, provision, seed)
  ai/ (embed: ローカル embedding, provider: Anthropic SDK, service: retrieval/回答/下書き)
  routes/ (auth, admin, documents, files, search, feedback, attestations, checklists, training, dashboard, audit, importexport, backup)
  cli/ (migrate, seed, create-org, backup, restore, worker)
web/src/
  App.tsx(ルーティング), Layout.tsx, auth.tsx, api.ts, offline.ts(IndexedDB), Editor.tsx(TipTap), DocRenderer.tsx, ui.tsx, labels.ts, pages/*
web/public/ (manifest.webmanifest, sw.js, アイコン)
```
規約: 新しい API は `api(app, method, url, { body, query, params }, fn)` で定義する（zod 検証・認証・テナント tx・CSRF が自動）。文書の可視性は必ず `docReadable/docEditable/docAccessible` の SQL 断片を使う。

## テスト
```bash
cd server && npx vitest run            # API 統合テスト（operate_test DB を毎回作り直す）
cd web && npx vite build               # E2E は本番ビルドを使う
cd e2e && npx playwright test -c playwright.config.ts   # 全デバイス。--project=desktop / iphone / android / ipad
```
E2E はポート 8090 でサーバーを起動し `operate_e2e` DB を作り直す（start-server.sh）。
負荷試験: load/README（docs/../TEST_REPORT.md 参照）。

## ブランド資産の再生成
```bash
cd brand/src && python3 make_logo.py && cd ../.. && node brand/src/render.mjs
```
