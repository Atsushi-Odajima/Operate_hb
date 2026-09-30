export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'ai';

export const DOC_TYPES: Record<string, string> = { sop: '手順書（SOP）', policy: '社内規程', guide: 'ガイド', faq: 'FAQ', checklist: 'チェックリスト', template: 'テンプレート', reference: '参考資料' };
export const CLASS: Record<string, { label: string; tone: Tone; hint: string }> = {
  public_internal: { label: '社内公開', tone: 'neutral', hint: '外部メンバーにも共有できる' },
  internal: { label: '社内限定', tone: 'info', hint: '社内の対象者のみ' },
  confidential: { label: '機密', tone: 'warn', hint: 'オフライン保存不可（初期設定）' },
  restricted: { label: '極秘', tone: 'danger', hint: '明示した対象者のみ・外部共有不可・ダウンロード不可' },
};
export const DOC_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: '下書き', tone: 'neutral' }, in_review: { label: 'レビュー中', tone: 'info' }, changes_requested: { label: '修正依頼', tone: 'warn' },
  approved: { label: '承認済み', tone: 'ok' }, scheduled: { label: '公開予約', tone: 'info' }, published: { label: '公開中', tone: 'ok' },
  superseded: { label: '置換済み', tone: 'neutral' }, archived: { label: 'アーカイブ', tone: 'neutral' }, retired: { label: '廃止', tone: 'danger' },
};
export const VER_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: '下書き', tone: 'neutral' }, in_review: { label: 'レビュー中', tone: 'info' }, changes_requested: { label: '修正依頼', tone: 'warn' },
  pending_approval: { label: '承認待ち', tone: 'info' }, approved: { label: '承認済み（公開待ち）', tone: 'ok' }, scheduled: { label: '公開予約', tone: 'info' },
  published: { label: '公開中', tone: 'ok' }, superseded: { label: '過去の版', tone: 'neutral' }, rejected: { label: '却下', tone: 'danger' }, withdrawn: { label: '取り下げ', tone: 'neutral' },
};
export const CHANGE: Record<string, { label: string; tone: Tone }> = { minor: { label: '軽微な修正', tone: 'neutral' }, normal: { label: '通常の改訂', tone: 'info' }, major: { label: '重要な変更', tone: 'danger' } };
export const ROLES: Record<string, string> = { owner: 'オーナー', knowledge_admin: 'ナレッジ管理者', approver: '承認者', editor: '編集者', trainer: '研修担当', member: 'メンバー', auditor: '監査担当', external: '外部メンバー' };
export const TRAINING: Record<string, { label: string; tone: Tone }> = {
  not_started: { label: '未着手', tone: 'neutral' }, in_progress: { label: '受講中', tone: 'info' }, completed: { label: '修了', tone: 'ok' },
  waived: { label: '免除', tone: 'neutral' }, cancelled: { label: '取消', tone: 'neutral' }, overdue: { label: '期限超過', tone: 'danger' },
  expired: { label: '有効期限切れ', tone: 'warn' }, not_assigned: { label: '未割当', tone: 'neutral' },
};
export const ATTEST: Record<string, { label: string; tone: Tone }> = { pending: { label: '未確認', tone: 'warn' }, acknowledged: { label: '確認済み', tone: 'ok' }, waived: { label: '免除', tone: 'neutral' }, cancelled: { label: '取消', tone: 'neutral' } };
export const FEEDBACK: Record<string, string> = { helpful: '役に立った', outdated: '情報が古い', unclear: '分かりにくい', suggestion: '修正提案' };
export const FB_STATUS: Record<string, { label: string; tone: Tone }> = { open: { label: '未対応', tone: 'warn' }, reviewing: { label: '確認中', tone: 'info' }, resolved: { label: '対応済み', tone: 'ok' }, dismissed: { label: '見送り', tone: 'neutral' } };
export const REL: Record<string, string> = { related: '関連', dependsOn: '前提として参照', replaces: '置き換える', derivedFrom: '元にした' };
export const MODULE: Record<string, string> = { document: 'マニュアルを読む', text: '説明', video: '動画', quiz: 'テスト', acknowledgement: '確認' };

export const fmtDate = (s?: string | null) => (s ? new Date(s.length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export const fmtDateTime = (s?: string | null) => (s ? new Date(s).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const today = () => new Date().toISOString().slice(0, 10);
