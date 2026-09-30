import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import type { Content } from '../DocRenderer';
import { ChecklistEditor, RichEditor, StepsEditor } from '../Editor';
import { CHANGE, DOC_TYPES, fmtDateTime } from '../labels';
import { AiBadge, ClassBadge, Icon, Loaded, Modal, PageHead, Spinner, useAction, useLoad, useToast, VerStatus } from '../ui';
import { useDirectory, UserSelect } from './common';

export default function DocumentEdit() {
  const { id } = useParams();
  const nav = useNavigate();
  const doc = useLoad(() => api.get(`/api/documents/${id}`), [id]);
  const wid = doc.data?.working?.id;
  if (doc.error) return <Loaded state={doc}>{() => null}</Loaded>;
  if (!doc.data) return <Spinner />;
  if (!wid) {
    return (
      <div className="card">
        <p>編集中の版はありません。</p>
        <div className="row"><Link className="btn" to={`/documents/${id}`}>文書に戻る</Link>{doc.data.can.edit && doc.data.current && <button className="btn primary" onClick={() => api.post(`/api/documents/${id}/revisions`, { changeType: 'normal' }).then(() => doc.reload())}>改訂版を作成</button>}</div>
      </div>
    );
  }
  return <VersionEditor key={wid} docData={doc.data} versionId={wid} onChanged={doc.reload} onLeave={() => nav(`/documents/${id}`)} />;
}

function VersionEditor({ docData, versionId, onChanged, onLeave }: { docData: any; versionId: string; onChanged: () => void; onLeave: () => void }) {
  const { me } = useAuth();
  const { push } = useToast();
  const vst = useLoad(() => api.get(`/api/versions/${versionId}`), [versionId]);
  const wf = useLoad(() => api.get(`/api/versions/${versionId}/workflow`), [versionId]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState<Content | null>(null);
  const [changeSummary, setChangeSummary] = useState('');
  const [changeType, setChangeType] = useState('normal');
  const [reattest, setReattest] = useState(false);
  const [seq, setSeq] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [submit, setSubmit] = useState(false);
  const { busy, run } = useAction();
  const timer = useRef<number | undefined>(undefined);
  const v = vst.data;
  const editable = v && ['draft', 'changes_requested'].includes(v.status) && docData.can.edit;

  useEffect(() => {
    if (!v) return;
    setTitle(v.title); setContent(v.content); setChangeSummary(v.change_summary); setChangeType(v.change_type); setReattest(v.require_reattestation); setSeq(v.edit_seq);
  }, [v?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    if (!content) return true;
    setSaving('saving');
    try {
      const r = await api.put(`/api/versions/${versionId}`, { title, content, changeSummary, changeType, editSeq: seq, requireReattestation: reattest });
      setSeq(r.editSeq); setDirty(false); setSaving('saved'); setSavedAt(r.updatedAt);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setSaving('conflict'); else setSaving('error');
      push(e instanceof ApiError ? e.message : '保存できませんでした', true);
      return false;
    }
  }, [content, title, changeSummary, changeType, seq, reattest, versionId, push]);

  useEffect(() => {
    if (!dirty || !editable || saving === 'conflict') return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 2500); // autosave
    return () => window.clearTimeout(timer.current);
  }, [dirty, title, content, changeSummary, changeType, reattest, editable, saving, save]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (!v || !content) return <Spinner />;
  const mark = () => setDirty(true);
  const isRevision = !!v.based_on_version_id;
  const needSummary = me?.policy.requireChangeSummary && isRevision;
  const openComments = (wf.data?.comments ?? []).filter((c: any) => !c.resolved_at);

  return (
    <>
      <PageHead title={<>{docData.document.docNumber && <span className="subtle">{docData.document.docNumber} </span>}編集：v{v.version}</>} sub={<span className="row"><VerStatus s={v.status} /><span className="chip">{DOC_TYPES[docData.document.type]}</span><ClassBadge c={docData.document.classification} />{v.ai_generated && <AiBadge />}</span>}>
        <span className="subtle" aria-live="polite">{saving === 'saving' ? '保存中…' : saving === 'saved' ? `自動保存しました ${fmtDateTime(savedAt)}` : saving === 'conflict' ? '他の人が更新しました' : dirty ? '未保存の変更あり' : ''}</span>
        <Link className="btn" to={`/documents/${docData.document.id}`}>閲覧に戻る</Link>
        {editable && <button className="btn" disabled={busy || !dirty} onClick={() => void save()}>保存</button>}
        {editable && <button className="btn primary" disabled={busy} onClick={() => void (async () => { if (await save()) setSubmit(true); })()}>レビュー・承認に提出</button>}
      </PageHead>

      {v.ai_generated && <div className="alert info" style={{ marginBottom: 12 }}><Icon name="sparkle" /> この下書きはAIが作成した候補です。「【要確認】」や「確認事項（TODO）」を必ず埋めてください。AI生成の文書は、文書の種類に関わらず承認が必要です。</div>}
      {saving === 'conflict' && <div className="alert danger" style={{ marginBottom: 12 }} role="alert">他の人がこの下書きを更新しました。あなたの変更は保存されていません。<button className="btn sm" onClick={() => window.location.reload()}>最新の内容を読み込む</button></div>}
      {!editable && <div className="alert info" style={{ marginBottom: 12 }}>この版は <VerStatus s={v.status} /> のため編集できません。{['in_review', 'pending_approval', 'approved', 'scheduled'].includes(v.status) && docData.can.edit && <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.post(`/api/versions/${versionId}/withdraw`); vst.reload(); wf.reload(); onChanged(); }, '取り下げました。再度編集できます')}>取り下げて編集に戻す</button>}
        <Link className="btn sm" to={`/documents/${docData.document.id}/review/${versionId}`}>レビュー・承認の状況</Link></div>}
      {v.status === 'changes_requested' && !!openComments.length && (
        <div className="card" style={{ borderColor: '#fde68a', marginBottom: 12 }}>
          <h2>修正依頼のコメント</h2>
          <ul className="list">{openComments.map((c: any) => <li key={c.id}><strong>{c.author_name}</strong>{c.section && <span className="chip">{c.section}</span>}<div>{c.body}</div>
            <button className="btn ghost sm" onClick={() => void run(async () => { await api.post(`/api/comments/${c.id}/resolve`); wf.reload(); })}>対応済みにする</button></li>)}</ul>
        </div>
      )}

      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="card">
          <div className="field"><label htmlFor="t">タイトル</label><input id="t" type="text" value={title} maxLength={200} onChange={(e) => { setTitle(e.target.value); mark(); }} /></div>
          {isRevision && (
            <div className="grid cols-2">
              <div className="field"><label htmlFor="ct">変更の大きさ</label>
                <select id="ct" value={changeType} onChange={(e) => { setChangeType(e.target.value); if (e.target.value === 'major') setReattest(true); mark(); }}>{Object.entries(CHANGE).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}</select>
                {changeType === 'major' && <label className="check small" style={{ marginTop: 6 }}><input type="checkbox" checked={reattest} onChange={(e) => { setReattest(e.target.checked); mark(); }} />公開時に対象者へ再確認（読んで確認しました）を依頼する</label>}
              </div>
              <div className="field"><label htmlFor="cs">変更内容{needSummary && '（必須）'}</label><textarea id="cs" style={{ minHeight: 70 }} value={changeSummary} maxLength={2000} onChange={(e) => { setChangeSummary(e.target.value); mark(); }} placeholder="何を、なぜ変えたか" /></div>
            </div>
          )}
        </div>
        <div className="card">
          <h2>本文</h2>
          <RichEditor value={content.body} documentId={docData.document.id} onChange={(b) => { setContent((c) => ({ ...c!, body: b })); mark(); }} />
        </div>
        <div className="card">
          <h2>手順（ステップ）</h2>
          <p className="subtle">スマートフォンでは1ステップずつ大きく表示されます。現場で使う手順はここに入力してください。</p>
          <StepsEditor steps={content.steps} documentId={docData.document.id} onChange={(s) => { setContent((c) => ({ ...c!, steps: s })); mark(); }} />
        </div>
        {(docData.document.type === 'checklist' || content.checklistItems.length > 0) && (
          <div className="card">
            <h2>チェック項目</h2>
            <ChecklistEditor items={content.checklistItems} onChange={(x) => { setContent((c) => ({ ...c!, checklistItems: x })); mark(); }} />
          </div>
        )}
      </fieldset>
      {editable && !docData.current && <div className="row" style={{ marginTop: 14 }}><button className="btn danger" onClick={() => { if (confirm('この下書きをアーカイブしますか？')) void run(async () => { await api.post(`/api/documents/${docData.document.id}/archive`); onLeave(); }); }}>下書きをアーカイブ</button></div>}
      {submit && <SubmitModal docData={docData} version={v} onClose={() => setSubmit(false)} onDone={() => { setSubmit(false); vst.reload(); wf.reload(); onChanged(); }} />}
    </>
  );
}

function SubmitModal({ docData, version, onClose, onDone }: { docData: any; version: any; onClose: () => void; onDone: () => void }) {
  const { me } = useAuth();
  const { users } = useDirectory();
  const cfg = me?.policy.docTypes[docData.document.type] ?? { requireApproval: true, approvalSteps: 1, approvalMode: 'any' };
  const required = cfg.requireApproval || version.ai_generated;
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [steps, setSteps] = useState<Array<{ mode: 'any' | 'all'; approvers: string[] }>>(Array.from({ length: cfg.approvalSteps ?? 1 }, () => ({ mode: cfg.approvalMode ?? 'any', approvers: [] })));
  const [mode, setMode] = useState<'immediate' | 'scheduled' | 'manual'>('immediate');
  const [at, setAt] = useState('');
  const [eff, setEff] = useState('');
  const { busy, run } = useAction();
  const approverOk = (u: any) => u.id !== version.author_id && u.roles.some((r: string) => ['approver', 'knowledge_admin', 'owner'].includes(r));
  const reviewerOk = (u: any) => u.id !== me?.id && u.roles.some((r: string) => ['editor', 'approver', 'knowledge_admin', 'owner', 'trainer'].includes(r));
  const valid = (!required || (steps.length >= (cfg.approvalSteps ?? 1) && steps.every((s) => s.approvers.length))) && (mode !== 'scheduled' || at);
  return (
    <Modal title="レビュー・承認に提出" onClose={onClose} wide>
      <p className="muted">提出すると内容は固定されます（修正依頼・取り下げで再び編集できます）。承認者は、提出時点の内容（contentHash）に対して承認します。</p>
      <div className="field"><label>レビュー担当（任意）</label><div className="hint" style={{ marginBottom: 6 }}>承認の前に内容を確認してもらう人。コメントや修正依頼ができます。</div>
        <UserSelect id="rv" label="レビュー担当" users={users} value={reviewers} onChange={setReviewers} filter={reviewerOk} /></div>
      {required ? (
        <div className="field"><label>承認者</label>
          {steps.map((s, i) => (
            <div key={i} className="card" style={{ marginBottom: 8 }}>
              <div className="row between"><strong>承認ステップ {i + 1}</strong>
                <div className="row"><select aria-label={`ステップ${i + 1}の方式`} value={s.mode} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, mode: e.target.value as 'any' | 'all' } : x)))} style={{ width: 'auto' }}><option value="any">誰か1人の承認で次へ</option><option value="all">全員の承認が必要</option></select>
                  {steps.length > (cfg.approvalSteps ?? 1) && <button className="btn sm danger" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>削除</button>}</div></div>
              <UserSelect id={`ap${i}`} label={`ステップ${i + 1}の承認者`} users={users} value={s.approvers} onChange={(a) => setSteps(steps.map((x, j) => (j === i ? { ...x, approvers: a } : x)))} filter={approverOk} />
            </div>
          ))}
          {steps.length < 3 && <button className="btn sm" onClick={() => setSteps([...steps, { mode: 'any', approvers: [] }])}>＋ 承認ステップを追加（最大3段）</button>}
          <div className="hint">作成者本人は承認者になれません。承認者の担当範囲（部署）外の文書は承認できません。</div>
        </div>
      ) : <div className="alert info" style={{ marginBottom: 12 }}>この種類の文書は承認なしで公開できます（レビュー担当を指定した場合はレビュー完了後に公開）。</div>}
      <div className="grid cols-2">
        <div className="field"><label htmlFor="pm">公開のタイミング</label><select id="pm" value={mode} onChange={(e) => setMode(e.target.value as any)}><option value="immediate">承認されたらすぐ公開</option><option value="scheduled">指定した日時に公開</option><option value="manual">承認後、管理者が手動で公開</option></select></div>
        {mode === 'scheduled' && <div className="field"><label htmlFor="pa">公開日時</label><input id="pa" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></div>}
        <div className="field"><label htmlFor="ef">施行日（任意）</label><input id="ef" type="date" value={eff} onChange={(e) => setEff(e.target.value)} /></div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button>
        <button className="btn primary" disabled={busy || !valid} onClick={() => void run(async () => {
          await api.post(`/api/versions/${version.id}/submit`, { reviewers, approvalSteps: required ? steps : undefined, publishMode: mode, publishAt: mode === 'scheduled' && at ? new Date(at).toISOString() : null, effectiveDate: eff || null });
          onDone();
        }, '提出しました')}>提出する</button></div>
    </Modal>
  );
}
