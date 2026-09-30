# AUDIT_MODEL.md

## audit_events
`id(bigserial), org_id, actor_id, actor_label(操作時の表示名), action, target_type, target_id, summary, detail(jsonb), ip, created_at`

- 追記専用: app ロールから UPDATE / DELETE / TRUNCATE 権限を剥奪し、さらにトリガーで UPDATE/DELETE を拒否（組織の完全削除のみ `app.allow_purge`）。
- 記録しないもの: 文書本文全文、パスワード、トークン、AI の質問・回答本文。detail は ID と変更メタデータの最小限の before/after。
- actor_label を保存するため、後で表示名が匿名化されても当時の操作者表示は監査記録として残る（匿名化の範囲は docs/SECURITY.md「プライバシー」）。

## 主な action
| 分類 | action |
|---|---|
| 認証 | auth.login, auth.login_failed（理由）, auth.logout, auth.password_changed |
| ユーザー・権限 | user.create, user.update（before/after roles）, user.disable/enable, user.reset_password, user.anonymize, department.*, team.create |
| 外部メンバー | external.create, external.update, external.revoke, external.expired（ワーカー） |
| 文書 | document.create, document.update, document.acl_change（配布先・区分変更 before/after）, document.retire, document.archive, document.review_confirmed, document.offline_saved, attachment.upload/download, relation.create/delete, template.* |
| 版・承認 | version.create, version.save, version.submit（contentHash）, review.decision, review.comment, approval.decision（contentHash）, approval.reassign, version.withdraw, version.publish, job.publish |
| 確認 | attestation.campaign, attestation.acknowledge, attestation.waive |
| 研修 | course.create/update/publish, training.assign, training.module_complete, training.completed, training.waive, quiz.create/publish/submit/grade, onboarding.* |
| AI | ai.settings（before/after）, ai.draft, ai.quiz_draft |
| 出力 | export.audit_package, export.audit_log, export.attestations, export.training, export.document_list, export.document_pdf, export.certificate, backup.create |
| 設定 | settings.update, org.provision |
| 取り込み | import.preview, import.commit |

## Audit Package
`POST /api/exports {kind:'audit-package', params:{from,to,departmentId?,documentIds?,includePdf}}` → 1 回限り・10 分・本人限定のダウンロード URL。
中身: README.txt（生成日時・生成者・範囲・保証しない旨）/ manifest.json（件数、各ファイルの bytes と SHA-256）/ 01_現行SOP一覧 / 02_version履歴 / 03_承認履歴（承認時ハッシュと現行一致）/ 04_レビュー履歴 / 05_重要文書の確認記録 / 06_研修受講記録 / 07_改訂期限 / 08_監査ログ抜粋（範囲内の対象文書・版に関するもの）/ SOP/*.pdf
- すべてテナントトランザクション内（RLS）で取得し、部署・文書の範囲条件を SQL で適用。
- ZIP 内パスは固定名と `safeName()`（英数・かな漢字・_- のみ、`..`/区切り文字不可）で構成（必須テスト 30）。
- 生成は監査ログに記録。法令・規格準拠の自動保証はしない旨を README と画面に明記。

## CSV
UTF-8 BOM、全セル引用符、`= + - @ TAB CR` で始まるセルは先頭に `'` を付与（formula injection 無害化、必須テスト 29）。
