負荷試験の手順

1. データ生成（別 DB。既定: 背景テナント 1,000 組織 × 100 ユーザー × 200 文書 + 計測用テナント t10/t50/t200/t1000）
   cd 018-operate && DB=operate_load BG_ORGS=1000 npx tsx load/generate.ts
   ※ 規模は環境変数で調整: BG_ORGS, BG_USERS, BG_DOCS, AUDIT_PER_ORG, COURSES_PER_ORG, SIZES
2. サーバー起動（負荷 DB を向ける）
   cd server && DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/operate_load \
     DATABASE_URL=postgres://operate_app:operate_app@127.0.0.1:5432/operate_load PORT=8095 RUN_WORKER=false npx tsx src/index.ts
3. 計測
   cd 018-operate && BASE=http://localhost:8095 REQUESTS=200 CONCURRENCY=10 npx tsx load/bench.ts > load/out/result.json
結果の読み方と実測値は TEST_REPORT.md。数値は試験環境での実測で、販売時の保証値ではない。
