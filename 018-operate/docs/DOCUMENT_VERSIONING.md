# DOCUMENT_VERSIONING.md

## 版のライフサイクル
```
draft ──submit──▶ in_review ──(全員確認)──▶ pending_approval ──(全ステップ承認)──▶ approved ──▶ published ──(次の版公開)──▶ superseded
  ▲                   │                            │                                  │ scheduled(指定日時)
  └──changes_requested◀┴────────────修正依頼────────┘                                  │
  withdraw（取り下げ）: in_review/pending_approval/approved/scheduled → changes_requested
  rejected（却下）: 終了。作り直しは新しい版
```
- 文書ごとに「作業中の版」は 1 つ（部分 UNIQUE インデックス）。
- 公開版を編集しようとすると 409。改訂は `POST /api/documents/:id/revisions` で公開版のコピーから新しい draft を作る。

## 版番号
| 変更の大きさ | 例 |
|---|---|
| 初版 | 1.0 |
| minor（軽微）/ normal（通常） | 1.0 → 1.1 → 1.2 |
| major（重要な変更） | 1.2 → 2.0 |
番号は `(document_id, major, minor)` で一意。却下・取り下げた版の番号は再利用しない（次の番号を採番）。

## 不変性の保証
- `protect_version_content` トリガー: status が draft/changes_requested 以外の版の title / content / body_text / content_hash / 版番号の UPDATE を拒否。確定状態（published/superseded/rejected/withdrawn）から戻す UPDATE も拒否。
- `forbid_delete` トリガー: published/superseded の版は DELETE 不可（組織の完全削除時のみ `app.allow_purge`）。
- 公開処理は承認ハッシュを再検証（APPROVAL_WORKFLOW.md）。

## 内容ハッシュ
`contentHash = sha256(canonicalJson({ title, content, changeSummary, changeType }))`（キーをソートした JSON）。本文・手順・チェック項目・タイトル・変更内容のどれが変わってもハッシュが変わる。

## 公開時の処理（`publishVersion`、冪等）
1. 版が approved/scheduled であること、承認ハッシュが全ステップで一致すること
2. 旧公開版 → superseded、新版 → published、`documents.current_version_id` 更新、施行日、次回レビュー日 = 今日 + 周期
3. 検索インデックス・AI チャンクを同一トランザクションで更新（旧版チャンクは is_current=false）
4. `replaces` 関係の文書を superseded にし検索から除外、参照元オーナーへ警告
5. 配布先へ通知（dedupe_key `publish:{versionId}:{userId}`）
6. 確認依頼: 初回公開で requires_attestation、または `require_reattestation`（Major の既定 ON）なら版固定の確認依頼を作成。旧版の未確認依頼は取消
7. 監査ログ `version.publish`
同じ版に対して 2 回目以降の呼び出しは `{ alreadyPublished: true }` を返し副作用なし（必須テスト 12）。

## 編集競合
Google Docs 型の同時編集は初版対象外。`edit_seq` による楽観ロックで、古い画面からの保存は 409（誰が更新したかを返す）。自動保存は 2.5 秒間隔。

## 廃止・アーカイブ
- 廃止（retire）: 公開済み文書を検索・AI・一覧から外す。履歴・承認・確認記録は保持。参照元オーナーへ通知。
- アーカイブ: 一度も公開していない下書きを一覧から外す。
