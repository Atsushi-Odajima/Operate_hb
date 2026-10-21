# Operate — マニュアル・教育・ルール変更をまとめる

社内文書の版・承認・研修・確認記録を管理し、承認済みの情報を検索できる組織向けWebアプリです。

実装ブランチ：`claude/operate-018`。アプリ本体は `018-operate/`。

## できること

- 文書・SOPの版管理、レビュー・承認、定期更新
- 新人研修、クイズ、版ごとの確認記録
- 部署・役割・機密区分に基づくアクセス制御、引用付き検索・AI回答

## 現在の範囲・制限

- 外部AIは任意の設定です。実プロバイダの規約・送信設定を確認して利用します。
- SSO・ディレクトリ同期・Slack / Teams通知・MFA・実メール送信等は将来候補です。実機と本番配備の確認は別途必要です。

## 実装の見どころ

**構成：** React / TypeScript / Vite / TipTap、Fastify、PostgreSQL（RLS / pg_trgm / pgvector）。

- [018-operate/server/src](./018-operate/server/src)
- [018-operate/web/src](./018-operate/web/src)
- [018-operate/e2e](./018-operate/e2e)

## ローカルで試す

Node.js 22以上、PostgreSQLとpgvector / pg_trgm。初期DB・アプリ用ロールが必要です。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/operate-018 https://github.com/Atsushi-Odajima/Operate_hb.git
cd Operate_hb/018-operate
npm install
```

開発手順で専用DB・環境変数・マイグレーションを設定し、npm run dev:server と npm run dev:web を別ターミナルで実行します。

環境設定・初期化の詳細：[セットアップ手順](./018-operate/docs/DEVELOPMENT.md)。

## 検証方法

`018-operate/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
npm run typecheck
npm run test
npm run e2e
npm run build
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [018-operate/docs/DEVELOPMENT.md](./018-operate/docs/DEVELOPMENT.md)
- [018-operate/NEXT_STEPS.txt](./018-operate/NEXT_STEPS.txt)
- [018-operate/README.md](./018-operate/README.md)
- [018-operate/TEST_REPORT.md](./018-operate/TEST_REPORT.md)
- [018-operate/RELEASE_CHECKLIST.md](./018-operate/RELEASE_CHECKLIST.md)
- [018-operate/docs/DATA_MODEL.md](./018-operate/docs/DATA_MODEL.md)
- [018-operate/DECISIONS.md](./018-operate/DECISIONS.md)
- [018-operate/docs/SECURITY.md](./018-operate/docs/SECURITY.md)
- [018-operate/docs/OPERATIONS.md](./018-operate/docs/OPERATIONS.md)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
