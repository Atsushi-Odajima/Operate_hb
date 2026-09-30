# DECISIONS.md — 設計判断の記録

各判断は「決定 / 理由 / 代替案 / 影響」で記録する。新しい判断は末尾に追記する。

## D-01 単一 PostgreSQL に集約（業務データ・全文検索・vector・添付・ジョブ）
- 決定: PostgreSQL 16 + `pg_trgm` + `pgvector` を唯一のデータストアとする。添付ファイルも `bytea`（1ファイル 10MB 上限）。ジョブキューもテーブル（`jobs`, `FOR UPDATE SKIP LOCKED`）。
- 理由: 5〜200名規模の顧客で運用対象を 1 つにし、**ACL・テナント条件を検索／AI retrieval と同じ SQL で評価できる**（外部検索エンジンや vector DB に ACL を複製しない）。バックアップが 1 系統で完結する。
- 代替案: OpenSearch / Meilisearch、専用 vector DB（Pinecone 等）、S3。→ ACL の二重管理とインデックス遅延による漏洩リスク、運用費増のため不採用。
- 影響: 超大規模（数百万文書／テナント）では検索性能の見直しが必要（docs/SEARCH_ARCHITECTURE.md「拡張方針」）。添付が多い顧客は DB 容量が増える（運用費に反映）。

## D-02 テナント分離は Row Level Security + 非 owner ロール
- 決定: すべての業務テーブルに `org_id` と RLS ポリシー `org_id = app_org()`。アプリは `operate_app`（NOSUPERUSER / NOBYPASSRLS、テーブル owner ではない）で接続し、1 リクエスト = 1 トランザクションの先頭で `set_config('app.org_id', …, true)`。
- 理由: アプリの WHERE 句漏れがあっても他テナント行は DB が返さない二重防御。
- 補足: FORCE RLS は使わない（owner ロールによる migration / backup / SECURITY DEFINER の事前認証関数のため）。owner は常に `org_id` を明示して絞り込む。
- ログイン前の組織解決・セッション照合は `SECURITY DEFINER` 関数（最小列のみ返す）で行う。

## D-03 権限は「毎リクエスト DB から再評価」
- 決定: セッションには user_id と CSRF トークンだけを持ち、ロール・所属・承認範囲・外部共有期限はリクエストごとに DB から読む。検索・AI retrieval は ACL を index に複製せずクエリ時に JOIN。
- 理由: 権限変更・退職・外部共有期限切れを「次のリクエストから即時」反映でき、キャッシュ無効化の仕様が不要になる。
- 影響: リクエストごとに 1 クエリ（数 ms）増える。負荷試験で問題ないことを確認（TEST_REPORT.md）。

## D-04 Document と DocumentVersion を分離し、確定した版は DB トリガーで不変
- 決定: 本文・タイトル・contentHash は `draft` / `changes_requested` の版でのみ更新可能。`published` / `superseded` の版は DELETE 不可、内容 UPDATE 不可（`protect_version_content` トリガー）。
- 理由: 「公開済み version を直接上書きしない」をアプリのバグや直接 SQL でも破れないようにする。
- 版番号: 初版 1.0。改訂時に 軽微/通常 → minor+1、重要 → major+1.0。却下・取り下げた版の番号は再利用しない。

## D-05 承認は contentHash に束縛
- 決定: 提出時点の `content_hash = sha256(canonical JSON of {title, content, changeSummary, changeType})` を承認ステップに記録。承認 API はクライアントが表示していたハッシュを必須にし、公開処理は全ステップの承認ハッシュと現在の版ハッシュの一致を再検証する。
- 理由: 承認後の改ざん（API・DB 直接いずれも）で承認が無効になることを保証（必須テスト 2）。
- 作成者本人は承認不可（職務分掌）。承認者は担当部署スコープが必要。

## D-06 AI は「補助」。既定 OFF、外部送信は Owner の明示設定のみ
- 決定: 新規組織は AI OFF。Provider は `local`（外部送信なし・抽出型回答）と `anthropic`（公式 SDK `@anthropic-ai/sdk`）。モデル既定 `claude-opus-5-5`、Owner が Sonnet 5.5 / Haiku 4.5 を選択可能。
- Embedding は **ローカルの hashing embedding（256 次元）** をサーバー内で計算し pgvector に保存。文書本文を embedding のために外部送信しない。
- 回答は retrieval で得た（ACL・機密区分・公開状態で SQL 絞り込み済みの）チャンクだけを根拠にし、`[n]` 引用がない回答・根拠スコア不足は「承認済み手順を確認できません。」に置換。
- AI 下書き（SOP / Quiz）は必ず Draft／未確認で保存。AI 生成版は文書種別設定に関わらず承認必須。AI で承認・公開する API は存在しない。
- Anthropic 呼び出しは server-side fallback（`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`）を有効化し、`stop_reason: refusal` は回答なし扱い。

## D-07 検索は pg_trgm（日本語 trigram）+ クエリ時 ACL
- 決定: `search_index` は現在の公開版のみ。公開・廃止・メタデータ変更と**同じトランザクション**で更新（反映遅延 0）。キーワード検索は全語 LIKE（trigram GIN）、全語一致が 0 件なら要素語（助詞を除く 2-gram）の被覆率 50% 以上で近似検索。
- 理由: 形態素解析器を DB に入れずに日本語を扱え、マネージド PostgreSQL（Supabase / Neon / RDS / Render）で動く。

## D-08 Service Worker は API をキャッシュしない
- 決定: SW はアプリシェルのみキャッシュ。オフライン文書は利用者の「端末に保存」操作で IndexedDB に保存し、サーバーが機密区分ポリシーで許可した場合のみ取得可能。再接続時に全件再検証（置換→更新、廃止/権限外→削除）。ログアウトで消去。
- 承認・確認・Quiz 提出・チェックリスト完了はオンライン必須。チェック項目の ON/OFF のみオフラインキュー（サーバー状態が優先）。

## D-09 監査ログは追記専用
- 決定: `audit_events` は app ロールから UPDATE/DELETE 権限を剥奪 + トリガーで拒否。本文全文・パスワード・トークンは記録しない。

## D-10 バックアップはテナント単位の JSON（gzip）＋チェックサム
- 決定: 全テーブルを `row_to_json` で出力し、テーブル毎に件数・SHA-256 を持つ。復元は単一トランザクション、復元後に件数・currentVersion・承認ハッシュ・修了記録の整合性を検証してからコミット。
- 理由: マネージド DB の PITR とは別に、顧客自身が取得・検証・持ち出しできる形式が必要。

## D-11 研修・Quiz も版管理
- 決定: Course / Quiz は版（course_versions / quiz_versions）を持ち、公開済みの版は DB トリガーで不変。Attempt は quiz_version_id を保持し、採点は提出時のスナップショットで行う（後から問題を直しても過去スコアは不変）。
- Course の改訂時は「旧版の修了を維持」か「全員に新版を再割当」を選択。旧版の修了を新版の修了として扱わない。

## D-12 フォント・ロゴ
- Web UI: Plus Jakarta Sans（SIL OFL 1.1, @fontsource-variable で自己ホスト）+ OS の日本語フォント。
- ワードマーク: Plus Jakarta Sans ExtraBold のアウトラインをパス化した自作 SVG（OFL はロゴ用途のアウトライン化を妨げない。フォントそのものは再配布しない）。"O" マークは独自ベクター。
- PDF: Noto Sans JP（SIL OFL 1.1）を同梱。
