import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { DocContent } from '../DocRenderer';
import { fmtDateTime } from '../labels';
import { AiBadge, Badge, ChangeBadge, Icon, Loaded, Modal, PageHead, Tabs, useAction, useLoad, VerStatus } from '../ui';
import { useDirectory } from './common';

export function Diff({ versionId, against }: { versionId: string; against?: string }) {
  const st = useLoad(() => api.get(`/api/versions/${versionId}/diff${against ? `?against=${against}` : ''}`), [versionId, against]);
  return <Loaded state={st}>{(d: any) => (
    <div>
      <p className="subtle">{d.base ? `v${d.base} との差分（緑：追加、赤：削除）` : '初版のため全文が追加です'}</p>
      <div className="diff" role="region" aria-label="差分">{d.lines.map((l: any, i: number) => <div key={i} className={l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}><span aria-hidden>{l.op === ' ' ? '  ' : l.op + ' '}</span>{l.op !== ' ' && <span className="sr-only">{l.op === '+' ? '追加' : '削除'}</span>}{l.text || ' '}</div>)}</div>
    </div>
  )}</Loaded>;
}

export default function Review() {
  const { id, versionId } = useParams();
  const { can } = useAuth();
  const v = useLoad(() => api.get(`/api/versions/${versionId}`), [versionId]);
  const wf = useLoad(() => api.get(`/api/versions/${versionId}/workflow`), [versionId]);
  const [tab, setTab] = useState<'content' | 'diff' | 'comments'>('content');
  const [comment, setComment] = useState('');
  const [section, setSection] = useState('');
  const [decide, setDecide] = useState<null | { kind: 'review' | 'approve'; decision: string }>(null);
  const [reassign, setReassign] = useState<string | null>(null);
  const { busy, run } = useAction();
  const reload = () => { v.reload(); wf.reload(); };
  return (
    <Loaded state={v}>{(ver: any) => (
      <>
        <PageHead title={<>レビュー・承認：{ver.title} <span className="subtle">v{ver.version}</span></>} sub={<span className="row"><VerStatus s={ver.status} /><ChangeBadge c={ver.change_type} />{ver.ai_generated && <AiBadge />}<span className="subtle">作成 {ver.authorName} ・ 提出 {fmtDateTime(ver.submitted_at)}</span></span>}>
          <Link className="btn" to={`/documents/${id}`}>文書へ</Link>
        </PageHead>
        <Loaded state={wf}>{(w: any) => (
          <>
            {(w.myReview || w.myApproval) && (
              <div className="card" style={{ borderColor: '#bfdbfe', background: 'var(--blue-50)', marginBottom: 12 }}>
                <strong>{w.myApproval ? 'あなたの承認を待っています' : 'あなたのレビューを待っています'}</strong>
                <p className="small" style={{ margin: '4px 0 8px' }}>内容と差分を確認してください。{w.myApproval && `承認は、今表示している内容（ハッシュ ${w.contentHash.slice(0, 12)}…）に対して記録されます。`}</p>
                <div className="row">
                  {w.myReview && <><button className="btn primary" onClick={() => setDecide({ kind: 'review', decision: 'approved' })}><Icon name="check" />確認完了</button><button className="btn" onClick={() => setDecide({ kind: 'review', decision: 'changes_requested' })}>修正を依頼</button></>}
                  {w.myApproval && <><button className="btn primary" onClick={() => setDecide({ kind: 'approve', decision: 'approved' })}><Icon name="check" />承認する</button><button className="btn" onClick={() => setDecide({ kind: 'approve', decision: 'changes_requested' })}>修正を依頼</button><button className="btn danger" onClick={() => setDecide({ kind: 'approve', decision: 'rejected' })}>却下</button></>}
                </div>
              </div>
            )}
            {ver.status === 'approved' && can('doc.admin') && <div className="alert ok" style={{ marginBottom: 12 }}>承認済みです（公開方法：手動）。<button className="btn sm primary" disabled={busy} onClick={() => void run(async () => { await api.post(`/api/versions/${versionId}/publish`); reload(); }, '公開しました')}>今すぐ公開</button></div>}
            {ver.status === 'scheduled' && <div className="alert info" style={{ marginBottom: 12 }}>{fmtDateTime(w.scheduledPublishAt)} に自動で公開されます。</div>}
            <div className="grid review-grid">
              <div>
                <Tabs tabs={[['content', '内容'], ['diff', '変更点'], ['comments', `コメント（${w.comments.length}）`]]} value={tab} onChange={setTab} />
                {tab === 'content' && <div className="card">{ver.change_summary && <div className="alert info" style={{ marginBottom: 12 }}><strong>変更内容：</strong>{ver.change_summary}</div>}<h1>{ver.title}</h1><DocContent content={ver.content} /></div>}
                {tab === 'diff' && <div className="card"><Diff versionId={ver.id} /></div>}
                {tab === 'comments' && (
                  <div className="card">
                    <ul className="list">{w.comments.map((c: any) => <li key={c.id}><div className="row between"><strong>{c.author_name}</strong><span className="subtle">{fmtDateTime(c.created_at)} ・ ラウンド{c.round}{c.content_hash !== w.contentHash && ' ・ 以前の内容へのコメント'}</span></div>{c.section && <span className="chip">{c.section}</span>}<div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>{c.resolved_at && <Badge tone="ok">対応済み</Badge>}</li>)}</ul>
                    {!w.comments.length && <p className="subtle">コメントはまだありません。</p>}
                    <div className="divider" />
                    <div className="field"><label htmlFor="sec">箇所（任意）</label><input id="sec" type="text" value={section} onChange={(e) => setSection(e.target.value)} placeholder="例：手順2" maxLength={200} /></div>
                    <div className="field"><label htmlFor="cm">コメント</label><textarea id="cm" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} /></div>
                    <button className="btn" disabled={busy || !comment.trim()} onClick={() => void run(async () => { await api.post(`/api/versions/${versionId}/comments`, { section, body: comment }); setComment(''); setSection(''); wf.reload(); })}>コメントする</button>
                    <p className="subtle">コメントはこの版（v{ver.version}）と現在の内容に紐づけて記録されます。</p>
                  </div>
                )}
              </div>
              <aside className="card" aria-label="進捗">
                <h2>進捗</h2>
                {w.reviews.map((r: any) => (
                  <div key={r.id} style={{ marginBottom: 10 }}><strong className="small">レビュー（ラウンド{r.round}）</strong>
                    <ul className="list small">{(r.reviewers ?? []).map((x: any) => <li key={x.reviewerId} className="row between"><span>{x.name}</span><Badge tone={x.status === 'approved' ? 'ok' : x.status === 'pending' ? 'neutral' : 'warn'}>{x.status === 'approved' ? '確認完了' : x.status === 'pending' ? '未対応' : '修正依頼'}</Badge></li>)}</ul></div>
                ))}
                {w.steps.filter((s: any) => s.round === w.round).map((s: any) => (
                  <div key={s.id} style={{ marginBottom: 10 }}><strong className="small">承認ステップ{s.step_no}（{s.mode === 'all' ? '全員' : '誰か1人'}）</strong> <Badge tone={s.status === 'approved' ? 'ok' : s.status === 'active' ? 'info' : s.status === 'waiting' ? 'neutral' : 'warn'}>{({ waiting: '待機', active: '承認待ち', approved: '承認済み', rejected: '却下', changes_requested: '修正依頼', cancelled: '中止' } as any)[s.status]}</Badge>
                    <ul className="list small">{(s.approvers ?? []).filter((a: any) => a.active).map((a: any) => {
                      const dcs = (s.decisions ?? []).find((x: any) => x.approverId === a.approverId);
                      return <li key={a.approverId}><div className="row between"><span>{a.name}</span>{dcs ? <Badge tone={dcs.decision === 'approved' ? 'ok' : 'warn'}>{dcs.decision === 'approved' ? '承認' : dcs.decision === 'rejected' ? '却下' : '修正依頼'}</Badge> : <span className="subtle">未対応</span>}</div>
                        {dcs?.comment && <div className="subtle">「{dcs.comment}」</div>}{dcs && <div className="subtle">{fmtDateTime(dcs.at)}</div>}
                        {!dcs && can('doc.admin') && ['waiting', 'active'].includes(s.status) && <button className="btn ghost sm" onClick={() => setReassign(a.approverId)}>承認者を変更</button>}</li>;
                    })}</ul>
                    {(s.approvers ?? []).filter((a: any) => !a.active).map((a: any) => <div key={a.approverId + 'x'} className="subtle">↪ {a.name} から再割当（{a.reason}）</div>)}
                  </div>
                ))}
                {!w.steps.length && !w.reviews.length && <p className="subtle">まだ提出されていません。</p>}
              </aside>
            </div>
            {decide && <DecisionModal kind={decide.kind} decision={decide.decision} versionId={ver.id} contentHash={w.contentHash} onClose={() => setDecide(null)} onDone={() => { setDecide(null); reload(); }} />}
            {reassign && <ReassignModal versionId={ver.id} from={reassign} onClose={() => setReassign(null)} onDone={() => { setReassign(null); reload(); }} />}
          </>
        )}</Loaded>
      </>
    )}</Loaded>
  );
}

function DecisionModal({ kind, decision, versionId, contentHash, onClose, onDone }: { kind: 'review' | 'approve'; decision: string; versionId: string; contentHash: string; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const { busy, run } = useAction();
  const label = decision === 'approved' ? (kind === 'review' ? '確認完了' : '承認') : decision === 'rejected' ? '却下' : '修正依頼';
  const needComment = decision !== 'approved';
  return (
    <Modal title={label} onClose={onClose}>
      {kind === 'approve' && decision === 'approved' && <p className="small">承認は、この内容（{contentHash.slice(0, 16)}…）に対して記録されます。承認後に内容が変わった場合、この承認は無効になり公開されません。</p>}
      {decision === 'rejected' && <p className="small">却下するとこの版は終了します（作成者は新しい版を作り直します）。</p>}
      <div className="field"><label htmlFor="dc">コメント{needComment && '（必須）'}</label><textarea id="dc" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button>
        <button className={`btn ${decision === 'rejected' ? 'danger solid' : 'primary'}`} disabled={busy || (needComment && !comment.trim())} onClick={() => void run(async () => {
          if (kind === 'review') await api.post(`/api/versions/${versionId}/review`, { decision, comment });
          else await api.post(`/api/versions/${versionId}/approve`, { decision, comment, contentHash });
          onDone();
        }, `${label}を記録しました`)}>{label}する</button></div>
    </Modal>
  );
}

function ReassignModal({ versionId, from, onClose, onDone }: { versionId: string; from: string; onClose: () => void; onDone: () => void }) {
  const { users } = useDirectory();
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title="承認者を変更" onClose={onClose}>
      <div className="field"><label htmlFor="to">新しい承認者</label><select id="to" value={to} onChange={(e) => setTo(e.target.value)}><option value="">選択</option>{users.filter((u) => u.id !== from && u.roles.some((r) => ['approver', 'knowledge_admin', 'owner'].includes(r))).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      <div className="field"><label htmlFor="rs">理由（履歴に残ります）</label><input id="rs" type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="例：長期休暇のため" /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button><button className="btn primary" disabled={busy || !to || !reason.trim()} onClick={() => void run(async () => { await api.post(`/api/versions/${versionId}/reassign`, { from, to, reason }); onDone(); }, '承認者を変更しました')}>変更</button></div>
    </Modal>
  );
}
