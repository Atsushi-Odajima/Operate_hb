# SEARCH_ARCHITECTURE.md

実装: `server/src/services/search.ts`

## インデックス
- `search_index`: 文書 1 件につき 1 行。**現在の公開版のみ**（下書き・過去版・廃止・置換済みは入らない）。
  - 列: title, summary, body_text, tags, category, doc_number, owner_name, related_titles, `search_text`（NFKC + 小文字化した連結テキスト）
  - `search_text` と `title` に `gin_trgm_ops`（pg_trgm）。データベースは `C.UTF-8` ロケールで作成し日本語の trigram を有効にする。
- 更新タイミング: 公開 / 廃止 / 置換 / 配布先・区分・メタデータ変更 / 関連文書変更と **同じトランザクション内** で `reindexDocument()`。
  → **反映遅延は 0**（コミットと同時に検索結果が変わる）。廃止文書が古いインデックスから見える時間帯は存在しない（必須テスト 14）。
- **ACL はインデックスに持たない**。検索クエリで `documents` / `document_audiences` / 所属 / ロールを JOIN して毎回評価する。権限変更は即時反映（必須テスト 9）。

## クエリ
1. 入力を NFKC・小文字化し、空白・句読点で語に分割（最大 8 語）
2. 全語を `search_text LIKE '%語%'`（ワイルドカードはエスケープ）で AND 検索 + ACL 条件 + フィルタ（種別・部署・区分・更新日・カテゴリ・タグ）
3. スコア = タイトル類似度×2 + word_similarity + タイトル部分一致ボーナス。同点は更新日降順
4. 全語一致が 0 件の場合（文章で質問した場合など）: 助詞を除いた 2-gram と英数語を「要素語」とし、被覆率 50% 以上の文書を被覆率順に返す（`fuzzy: true` を UI で表示）
5. スニペットは **ACL 済みの行の本文からのみ** 生成（権限外文書のタイトル・スニペットは結果に一切含まれない、必須テスト 7）

## 検索分析
- `search_queries` に検索語・件数・クリック文書・滞在時間を保存。**利用者 ID は保存しない**。保存期間は組織設定（既定 180 日、ワーカーが毎時削除）。
- 0 件の検索語（2 回以上）を FAQ/SOP 作成候補として KA に提示。自動作成・自動公開はしない。

## AI 用チャンク（knowledge_chunks）
- 公開時に版をセクション（見出し・手順・チェック項目）単位、約 700 文字以内に分割し、`embedding vector(256)`（ローカル hashing embedding）を付与。
- 同じテキスト（sha256）の embedding は `embedding_cache` から再利用（版を改訂しても変わらない段落は再計算しない）。
- **ANN（HNSW）インデックスは使わない**。ANN はテナント・ACL で絞る前に全体の近傍を返すため、多テナント環境では対象テナントの結果が欠落し得る。retrieval は org_id + ACL で絞り込んだ集合に対して正確な距離計算（recall 100%）を行う。1 テナント数万チャンクまでは数十 ms 以内（TEST_REPORT.md）。
- 旧版チャンクは `is_current=false` で残し、管理者の「過去の版を含める」モードのみで使用。

## 性能（実測は TEST_REPORT.md）
- テナント条件（`org_id` の B-tree）→ trigram GIN のビットマップ AND で絞り込む。数千〜数万文書/テナントでは数十 ms 以内。
- 拡張方針（数十万文書/テナント超）: `search_text` を `(org_id, …)` でパーティション化、または外部検索エンジンへ移行する場合も「ACL はクエリ時に DB で評価し、検索エンジンからは ID のみ受け取る」構成を維持すること。
