# ATTESTATION_RULES.md（重要文書の「確認しました」）

実装: `server/src/services/attestations.ts`

## データ
- attestation_campaigns: 文書の **版ごとに 1 つ**（`UNIQUE(version_id)`）。due_date, reason, require_scroll。
- user_attestations: campaign × user（一意）。assigned_at, viewed_at, reached_end_at, acknowledged_at, status（pending / acknowledged / waived / cancelled）, waived_by/reason。

## 依頼が作られるとき
1. `requires_attestation` の文書が **初めて** 公開されたとき
2. 改訂版が `require_reattestation`（重要な変更では既定 ON、編集者が OFF にできる）で公開されたとき
3. ナレッジ管理者が文書画面から手動で「確認依頼を配布」したとき（期限・理由・個別ユーザー指定可）
対象者 = 公開版の閲覧者（`audienceUserIds`、外部は許可された場合のみ）。

## 版固定
- 確認は版に紐づく。**v1 の確認は v2 に引き継がない**（必須テスト 3）。
- 新しい版の依頼作成時、同じ文書の旧版の未確認依頼は cancelled（確認済みの記録は残る）。
- 確認時点でその版が現行公開版でなければ 409（最新版を確認するよう案内）。

## 「読んだ」の条件
- ページを開いただけでは確認扱いにしない。
- `viewed_at`: 文書を開いたとき記録。`reached_end_at`: 文書末尾の要素が画面に表示されたとき記録（IntersectionObserver）。
- require_scroll=true（組織既定）では末尾到達前の確認は 400。最後に明示ボタン「確認しました」。
- UI と説明書で「確認は読んだことの自己申告の記録であり、理解を保証しない」と明示。

## 免除
attestation.manage 権限 + 理由必須。監査ログ `attestation.waive`。

## 期限・督促
期限超過（pending かつ due_date < 今日）は週 1 回まで督促通知（dedupe キー `attover:{id}:{週}`）。ダッシュボード・確認状況画面に期限超過件数を表示。

## 監査
依頼作成（attestation.campaign）、確認（attestation.acknowledge）、免除を監査ログに記録。監査パッケージ「05_重要文書の確認記録.csv」に 閲覧/末尾到達/確認 日時を出力。
