# DATA_MODEL.md

正は `server/src/db/migrations/001_init.sql`。ここでは主要エンティティと不変条件を説明する。
全業務テーブルは `org_id` を持ち RLS (`org_id = app_org()`) の対象。

## 組織・人
| テーブル | 主な列 | 備考 |
|---|---|---|
| organizations | id, slug(組織ID), name, settings(jsonb), is_sample | settings は `lib/settings.ts` の zod スキーマで検証・既定値マージ |
| departments / teams | name, code / department_id | Organization → Department → Team |
| users | email(組織内一意), name, password_hash(scrypt), status, is_external, external_expires_at, external_allow_download/ai, hire_date, anonymized_at, failed_logins, locked_until | 外部メンバーも同じ表（is_external） |
| user_roles | (user_id, role) | 複数ロール可。owner/knowledge_admin/approver/editor/trainer/member/auditor/external |
| memberships | user_id, department_id, team_id | 1 ユーザー複数所属 |
| approver_scopes | user_id, department_id(NULL=全社) | 承認できる部署 |
| sessions | id=sha256(token), csrf_token, expires_at, revoked_at, revoked_reason | Cookie には生トークンのみ |

## 文書
| テーブル | 主な列 | 不変条件 |
|---|---|---|
| documents | doc_number, type, title, summary, purpose, scope, owner_id, department_id, category, tags[], classification, status, current_version_id, audience_all, requires_attestation, review_cycle_days, next_review_date, last_reviewed_at, effective_date, retire_date | status は版の状態から導出（`syncDocStatus`）。current_version_id は必ず published の版 |
| document_audiences | kind(department/team/role/user), target | 配布先。全社は documents.audience_all |
| document_versions | major, minor, status, change_type, change_summary, title, content(jsonb), body_text, content_hash, ai_generated, require_reattestation, author_id, based_on_version_id, review_round, edit_seq, publish_mode, scheduled_publish_at, effective_date, submitted/approved/published/superseded_at | 作業中の版は文書ごとに 1 つ（部分 UNIQUE）。draft/changes_requested 以外は内容変更不可、published/superseded は削除不可（トリガー） |
| attachments | kind(image/attachment/import_source), filename, mime(マジックバイト判定), size, sha256, data(bytea) | 取得時に毎回 ACL 判定 |
| templates | name, doc_type, content | 作成時にコピー（以後リンクしない） |

`content` = `{ body: ProseMirror JSON(whitelist), steps: Step[], checklistItems: Item[] }`（`lib/content.ts`）。

## ワークフロー
| テーブル | 主な列 |
|---|---|
| review_requests / review_assignments | version_id, round / reviewer_id, status, comment |
| review_comments | version_id, **content_hash**, round, section, body, resolved_at |
| approval_steps | version_id, round, step_no(1-3), mode(any/all), status, **content_hash** |
| approval_step_approvers | step_id, approver_id, active, reassigned_to/by/at, reassign_reason |
| approvals | step_id, approver_id(UNIQUE per step), decision, comment, **content_hash** |

## ナレッジ運用
document_relations(kind: related/dependsOn/replaces/derivedFrom), feedback(version_id 固定, status), improvement_tickets, checklist_runs(items スナップショット, client_key 一意=オフライン再送の冪等性), attestation_campaigns(version_id 一意), user_attestations(campaign_id+user_id 一意, viewed_at, reached_end_at, acknowledged_at)

## 研修
quizzes / quiz_versions(questions, settings, 公開後不変) / courses / course_versions(modules, sequential, completion_policy, 公開後不変) / training_assignments(course_version_id+user_id 一意) / module_progress / quiz_attempts(quiz_version_id, question_order, answers, score, result) / certificates(verification_code, HMAC signature) / onboarding_templates / onboarding_runs(template_snapshot)

## 検索・AI
search_index(現行公開版のみ, search_text に trigram GIN) / knowledge_chunks(version_id, is_current, section, text, embedding vector(256), HNSW) / embedding_cache(text_hash, model) / search_queries(利用者 ID を持たない) / ai_usage(件数・トークン・費用のみ)

## 運用
notifications(dedupe_key 一意 = 冪等) / jobs(idempotency_key 一意) / audit_events(追記専用) / import_batches / download_tokens(sha256, 10 分, 1 回限り)

## 規模の想定とインデックス
- 1 テナント 1,000 ユーザー・数万文書までを主対象。全テーブル `(org_id, …)` 先頭の複合インデックス、または org 単位の小さい集合への JOIN。
- 大テーブル（audit_events, training_assignments, quiz_attempts, search_queries）は `(org_id, created_at DESC)` 等でテナント内に閉じたページング。
- 1 億件級の audit_events は月次パーティション化を推奨（docs/OPERATIONS.md）。
