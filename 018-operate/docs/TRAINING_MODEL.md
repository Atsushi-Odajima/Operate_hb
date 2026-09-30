# TRAINING_MODEL.md

実装: `server/src/services/training.ts`, `server/src/routes/training.ts`

## Course / Course Version
- Course: title, description, owner, due_days（割当時の標準期限）, validity_days（修了の有効期間）。
- Course Version: modules（JSON スナップショット）, sequential（順序制御）, completion_policy, change_note。公開後は DB トリガーで不変。
- Module 種別: `document`（公開中マニュアルを読む）/ `text`（説明）/ `video`（https リンク）/ `quiz`（公開済みテスト）/ `acknowledgement`（確認文への同意）。各 module に required（必須/任意）。
- 公開時の検証: 必須モジュール 1 つ以上、文書は公開中、Quiz は公開済み、動画は URL 必須。

## 改訂時の既存修了の扱い（明文化）
| completion_policy | 挙動 |
|---|---|
| keep（既定） | 旧版の割当・修了はそのまま。旧版を受講中の人は旧版のまま受講を続ける。新しく割り当てる人から新版 |
| reassign | 旧版を割り当てていた有効ユーザー全員に新版の割当を新規作成。**旧版の修了は旧版の修了として残り、新版の修了にはならない**（必須テスト 20） |

## Assignment
- 対象: 個人 / 部署 / チーム / ロール（無効ユーザー・外部は部署等の一括指定から除外）。`(course_version_id, user_id)` 一意で重複割当しない。
- 状態: not_started → in_progress → completed / waived / cancelled。期限超過は `due_date < 今日` の派生状態（overdue）。
- 免除（waive）: training.manage 権限 + 理由必須。操作者・日時・理由を記録し監査ログへ（必須テスト 19）。
- 退職・無効化: 未完了の割当は cancelled（履歴は保持）。修了記録・完了証は残る。匿名化後も記録は保持（表示名のみ匿名）。

## 完了判定（evaluateAssignment）
必須モジュールすべてに module_progress がある時のみ completed。Quiz モジュールは **合格した attempt** によってのみ progress が作られる（不合格・採点待ちでは完了しない、必須テスト 18）。
順序制御 ON の場合、前の必須モジュール未完了の module は完了/受験できない（409）。

## 完了証（Certificate）
- 修了時に自動発行: verification_code（照合コード）、HMAC 署名、course_version、completed_at、Quiz スコア要約、有効期限（validity_days）。
- PDF 出力（Noto Sans JP）。文言は「社内研修の完了記録であり、公的な資格・認証を証明するものではありません」。
- 照合: `/api/certificates/verify/:code`（社内ユーザーのみ）で署名を再計算して有効性を表示。

## Skill Matrix
ユーザー × コースで 未割当 / 受講中 / 修了 / 期限超過 / 有効期限切れ / 免除 を表示。研修・手順習得状況の可視化のみで、人事評価・AI 評価は行わない。

## Onboarding Path
- テンプレート: items = [{courseId, offsetDays, label(Day1/Week1/Month1 等)}]、対象ロール・部署（任意）。
- 実行: 開始日（入社日）+ offsetDays で期限を計算して各コースを割当。テンプレート内容は run にスナップショット保存。**テンプレートを後で変更しても既存の割当は変わらない**。同じ人に同じテンプレートは 1 回まで。
