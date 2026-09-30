# QUIZ_RULES.md

## 問題形式
| type | 正解の持ち方 | 採点 |
|---|---|---|
| single（単一選択） | 選択肢 ID 1 つ | 完全一致 |
| multiple（複数選択） | 選択肢 ID 1 つ以上 | 集合が完全一致した場合のみ得点（部分点なし） |
| truefalse（○×） | `true` / `false` | 完全一致 |
| short（記述） | 任意の正解文字列リスト | リストあり: NFKC・大小無視の完全一致で自動採点。リストなし: 手動採点（pending_review） |
各問題: id, prompt, choices, correct, explanation, sourceDocumentId, sourceVersionId, sourceSection, points, aiGenerated, reviewed, reviewedBy, reviewedAt。

## Quiz 設定
passScore（合格点 %）, maxAttempts（0=無制限）, cooldownMinutes（再受験待ち）, shuffleQuestions, shuffleChoices, showExplanation（after_submit / after_pass / never）。

## 版とスナップショット
- 編集は常に下書き版に対して行い、公開すると新しい quiz_version になる。公開済みの版は DB トリガーで不変。
- Attempt 開始時に quiz_version_id と出題順・選択肢順（question_order）を保存。採点はその版の questions で行う。
- **問題を後から編集しても過去 Attempt の score/result は変わらない**（必須テスト 16）。

## Attempt
- 開始: コースの割当（assignmentId + moduleId）経由のみ。単独受験は研修担当のプレビューのみ。
- 同じ割当の受験中 Attempt があればそれを返す（二重開始しない）。合格済みなら 409。
- 上限回数・待ち時間を超える場合 409（残り待ち時間を表示）。
- 受験中のレスポンスには **正解・解説を含めない**。
- 提出: `UPDATE ... WHERE status='in_progress' RETURNING` で最初の 1 回だけ採点。再送・同時送信は保存済みの結果を返す（Attempt・監査ログ・module_progress が二重にならない、必須テスト 17）。
- 合格 → module_progress 作成 → コース完了判定。
- 手動採点（記述）: 研修担当が正誤を付けて確定（自分の回答は採点不可）→ 合否確定 → 完了判定。

## AI 問題案
- 公開中・閲覧可能な版からのみ生成。問題ごとに根拠の版・セクションを保持。
- すべて `aiGenerated=true, reviewed=false` で追加。研修担当が問題文・正解・誤答選択肢・根拠を確認してチェックするまで公開不可。
- local provider は本文の記載文を正解、同じ文書の別の記載を誤答とする穴埋め型。誤答が紛らわしい/不適切な場合は人が修正する前提（自動で本番化しない）。
