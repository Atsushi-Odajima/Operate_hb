# RBAC_ABAC.md

実装: `server/src/lib/authz.ts`（権限表 `PERMS`、可視性 SQL `docReadable` / `docEditable` / `docAccessible`）。
UI の表示制御は利便性のためだけで、**すべてサーバー側で判定**する。

## 1. ロール（RBAC）
| 権限キー | owner | knowledge_admin | approver | editor | trainer | member | auditor |
|---|---|---|---|---|---|---|---|
| org.settings / ai.settings / user.manage / backup | ● | | | | | | |
| dept.manage / doc.admin / template.manage / external.manage / feedback.manage / attestation.manage / analytics.read | ● | ● | | | | | |
| doc.readAll（全文書・全版の閲覧） | ● | ● | | | | | ● |
| doc.create / import | ● | ● | | ● | | | |
| doc.approve | ● | ● | ●（範囲内） | | | | |
| doc.review（レビュー担当になれる） | ● | ● | ● | ● | ● | | |
| training.manage | ● | ● | | | ● | | |
| training.report | ● | ● | | | ● | | ● |
| attestation.report / health.read / ai.historical | ● | ● | | | | | ● |
| audit.read / audit.export | ● | | | | | | ● |
外部メンバー（external）は管理権限を一切持たない（`has()` が常に false）。

## 2. 属性（ABAC）: 文書の閲覧
現在の公開版を読めるのは次のいずれか（`docReadable`）:
1. `doc.readAll`（Owner / Knowledge Admin / Auditor）
2. 社内ユーザー: 文書が `published` かつ
   - `audience_all`（全社）で、機密区分が `restricted`（極秘）でない、または
   - 担当者（owner_id）本人、または
   - 配布先に一致（所属部署 / チーム / ロール / 個人）
3. 外部メンバー: `published` かつ機密区分が組織設定 `externalAllowed`（既定: 社内公開・社内限定）かつ **個人指定または許可部署の配布先** に一致。全社配布は外部を含まない。共有期限切れは全リクエストで 401。

編集（`docEditable`）: KA/Owner は全文書、editor は「担当者 / 作成者 / 所属部署の文書」。
ワークフロー参加者（レビュー担当・承認者）は担当中の版だけ閲覧可。
過去の版（superseded）や下書きは閲覧権限＋編集権限（または readAll）が必要。Member には現在の公開版のみ。

## 3. 機密区分ごとの扱い（組織設定）
| 区分 | 既定のオフライン保存 | 既定のダウンロード(PDF/添付) | 外部共有 | AI 対象(既定) |
|---|---|---|---|---|
| 社内公開 public_internal | 可 | 可 | 可 | 可 |
| 社内限定 internal | 可 | 可 | 可 | 可 |
| 機密 confidential | 不可 | 可 | 不可 | 不可 |
| 極秘 restricted | 不可 | 不可 | **常に不可** | 不可 |

## 4. どこで ACL を適用しているか
| 経路 | 適用箇所 |
|---|---|
| 文書一覧・閲覧・版・差分 | `getDoc` / `versionForActor`（見えない場合は 404 で存在も隠す） |
| 全文検索 | `searchDocuments` の WHERE（index に ACL を持たない） |
| AI retrieval | `retrieve` の WHERE（ACL + 機密区分 + 現行公開版）。生成後のフィルタは行わない |
| 通知・確認依頼の対象者 | `audienceUserIds`（docReadable と同じ規則の逆引き） |
| 添付・画像 | `/api/attachments/:id/content` で毎回 `docAccessible` + ダウンロード可否 |
| エクスポート / 監査パッケージ | 権限チェック + テナント内 SQL + 部署条件 |
| オフライン | 保存時に区分判定、再接続時に `offline/check` で再判定 |
| 検索分析のクリック記録 | 読める文書のみ記録 |

## 5. 権限変更の反映
- セッションに権限を持たせないため、変更は **次のリクエストから** 反映（検索・AI 含む）。キャッシュ無効化は不要。
- ユーザー無効化・外部共有停止・パスワード変更ではセッションを失効（`revoked_reason` を記録）。
- 必須テスト 9（同一セッションで権限剥奪後に閲覧・検索・retrieval 不可）で検証。
