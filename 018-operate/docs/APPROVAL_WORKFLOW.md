# APPROVAL_WORKFLOW.md

実装: `server/src/services/documents.ts`（submitVersion / reviewDecision / approvalDecision / reassignApprover / withdrawVersion / publishVersion）

## 提出（submit）
入力: レビュー担当（0 人以上）、承認ステップ（1〜3 段、各段 `any`=誰か1人 / `all`=全員）、公開方法（immediate / scheduled + 日時 / manual）、施行日。
検証:
- 版が draft / changes_requested であること、編集権限があること
- 改訂時は変更内容（changeSummary）必須（組織設定）
- 承認が必要な文書（種別設定、または AI 生成）では、種別設定の段数以上の承認ステップ
- 承認者は active な社内ユーザーで、`approver`（担当部署スコープ内）か KA / Owner。**作成者本人は不可**
- レビュー担当は editor / approver / KA / owner / trainer
提出時点の `content_hash` を承認ステップに記録し、以後内容は編集不可（取り下げで編集可に戻る）。

## レビュー
- レビュー担当はコメント（版とハッシュに固定）と「確認完了」/「修正を依頼」。
- 1 人でも修正依頼 → 版は changes_requested、予定していた承認ステップは cancelled。
- 全員確認完了 → 承認ステップ 1 を開始。

## 承認
- `POST /api/versions/:id/approve { decision, comment, contentHash }`
- 表示していたハッシュ ≠ 現在の版ハッシュ → 409（承認できない）
- 同じ承認者の再送 → 既存の承認を返す（`UNIQUE(step_id, approver_id)`、必須テスト 11）
- `any`: 1 人の承認で次のステップへ。`all`: 有効な承認者全員の承認で次へ
- 却下（rejected）→ 版は終了。修正依頼 → changes_requested。理由コメント必須
- 最終ステップ承認 → approved → 公開方法に従い即時公開 / 公開予約ジョブ / 手動待ち

## 承認者の再割当
KA / Owner のみ。旧承認者の行を `active=false` にし、`reassigned_to/by/at/reason` を保存、新承認者を追加（進行中のステップなら通知）。監査ログ `approval.reassign`。

## 公開予約
`jobs(type='publish', idempotency_key='publish:{versionId}', run_at)`。ワーカーは `FOR UPDATE SKIP LOCKED` で取得し、失敗時は指数バックオフで最大 5 回。公開処理自体が冪等なので再実行・二重実行でも重複しない。

## 承認不要の種別
組織設定で `requireApproval=false` の種別（既定: FAQ / テンプレート / 参考資料）は、提出→（レビューがあれば完了後）→即公開。ただし **AI 生成の版は常に承認必須**。

## 監査に残る記録
version.submit（ラウンド・レビュー担当・段数・公開方法・contentHash）、review.decision、review.comment、approval.decision（段・ラウンド・contentHash・判断）、approval.reassign、version.withdraw、version.publish（前の版・contentHash）。
監査パッケージの「承認履歴」には承認時ハッシュと現行ハッシュの一致/不一致を出力する。
