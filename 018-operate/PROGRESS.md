# PROGRESS.md（最終更新 2026-09-30）

凡例: ✅ 完了（実装＋自動テストで検証） / ⚠ 完了だが一部未検証（理由を記載） / ❌ 未完了

| Phase | 内容 | 状態 | 根拠・備考 |
|---|---|---|---|
| 0 | 技術・料金・license、multi-tenant/RBAC、Editor/Search/AI PoC、PWA | ⚠ | 技術選定・PoC は完了（DECISIONS.md）。**料金は公式サイトが本環境から遮断されたため二次情報で算出**（docs/OPERATING_COSTS.md）。ライセンスは THIRD_PARTY_NOTICES.txt |
| 1 | Organization / Department / Team / User / RBAC / ABAC / Classification | ✅ | RLS、権限表、可視性 SQL、ID 書換えテスト |
| 2 | Document / Version / Editor / Template / Step SOP / Attachment | ✅ | DB トリガーで版不変、TipTap + whitelist 正規化、マジックバイト検証 |
| 3 | Review / Approval / 多段承認 / Publish / Audience | ✅ | contentHash 束縛、冪等承認・公開、指定日時公開（E2E-1） |
| 4 | 全文検索 / Relation / Review Cycle / Feedback | ✅ | ACL クエリ時適用・同一 tx 更新、循環検知、影響範囲、近似検索 |
| 5 | Checklist Run / Attestation / 重要変更の再確認 | ✅ | 版固定、末尾到達、オフラインキュー（チェックのみ） |
| 6 | Course / Module / Assignment / Quiz / Attempt / Completion / Onboarding / Certificate / Skill Matrix | ✅ | 版スナップショット、冪等提出、再割当ポリシー、完了証 PDF + 照合 |
| 7 | AI retrieval / citation / AI Draft / AI Quiz Draft / AI Security / Cost | ✅ | ACL + 区分を SQL WHERE で適用、引用必須、モック API で送信内容を検証。**実 Anthropic API への送信は未実施（方針により）** |
| 8 | Dashboard / Knowledge Health / Search Analytics / External Member | ✅ | ロール別、事実指標のみ、利用者 ID なし分析、外部期限で即時失効（E2E-5） |
| 9 | Audit Package / Export / Import / Audit Log | ✅ | ZIP + SHA-256 manifest、安全なパス、CSV 無害化、追記専用ログ（E2E-9） |
| 10 | Backup / Restore / Privacy / Offline / Security | ✅ | 単一 tx 復元 + 事後検証（E2E-10）、匿名化、区分別オフライン、CSP/CSRF/ロック |
| 11 | 権限 / AI / 並行 / 負荷 / E2E / 端末 / Accessibility | ⚠ | 自動テストはすべて実施（TEST_REPORT.md）。**実機（iPhone/Android/iPad）は未確認**、Chromium のデバイスエミュレーションで代替。負荷は仕様規模の一部スケールで実測 |
| 12 | 購入者資料 / Deploy / 運用費 / 販売前チェック | ⚠ | 資料・Dockerfile・render.yaml・販売前チェックリスト完了。**本番公開は未実施（人間判断事項）** |

## 全体判定
機能要件（完成条件 1〜37）は実装・自動検証済み。ただし次の項目は本セッションの制約により **未検証** のため、全体を「販売可能な完成」とは判定しない:
1. iPhone / Android / iPad / Windows の **実機** での PWA インストール・表示確認
2. 公式料金ページでの運用費の再確認
3. 本番環境へのデプロイ（有料契約を伴うため未実施）
これらは RELEASE_CHECKLIST.md の人間確認事項。
