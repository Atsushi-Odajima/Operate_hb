import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useOnline } from '../Layout';
import { fmtDate, MODULE } from '../labels';
import { Badge, Icon, Loaded, PageHead, Progress, TrainingBadge, useAction, useLoad } from '../ui';

export default function AssignmentPage() {
  const { id } = useParams();
  const st = useLoad(() => api.get(`/api/assignments/${id}`), [id]);
  const [openQuiz, setOpenQuiz] = useState<any>(null);
  const { busy, run } = useAction();
  const online = useOnline();
  const complete = (m: any) => run(async () => { await api.post(`/api/assignments/${id}/modules/${m.id}/complete`); st.reload(); }, `「${m.title}」を完了しました`);
  return (
    <Loaded state={st}>{(a: any) => {
      const done = a.modules.filter((m: any) => m.done).length;
      return (
        <>
          <PageHead title={a.title} sub={<span className="row">{a.overdue ? <Badge tone="danger">期限超過</Badge> : <TrainingBadge s={a.status} />}<span className="subtle">v{a.version} ・ 期限 {fmtDate(a.dueDate)}{!a.mine && ` ・ 受講者 ${a.userName}`}</span></span>}>
            <Link to="/training" className="btn">研修一覧へ</Link>
          </PageHead>
          <div className="card" style={{ marginBottom: 12 }}>
            <p className="muted">{a.description}</p>
            <div className="row small"><div style={{ flex: 1 }}><Progress value={(done / Math.max(1, a.modules.length)) * 100} label="受講の進捗" /></div><span>{done}/{a.modules.length}</span></div>
            {a.sequential && <p className="subtle" style={{ marginTop: 6 }}>このコースは上から順番に受講します。</p>}
            {a.certificate && <div className="alert ok" style={{ marginTop: 10 }}>修了しました（{fmtDate(a.certificate.completed_at)}）。<a className="btn sm" href={`/api/certificates/${a.certificate.id}/pdf`}><Icon name="download" size={16} />完了証PDF</a></div>}
          </div>
          <ol className="steps">
            {a.modules.map((m: any) => (
              <li key={m.id} style={{ opacity: m.locked ? 0.6 : 1 }}>
                <div className="row between"><span className="st-title">{m.title}</span><span className="row"><span className="chip">{MODULE[m.type]}</span>{!m.required && <span className="chip">任意</span>}{m.done ? <Badge tone="ok">完了</Badge> : m.locked ? <Badge tone="neutral">🔒 前のモジュールを完了してください</Badge> : null}</span></div>
                {m.type === 'text' && <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{m.text}</p>}
                {m.type === 'acknowledgement' && <div className="alert info" style={{ margin: '6px 0' }}>{m.text}</div>}
                {m.type === 'document' && (m.document ? <p style={{ margin: '6px 0' }}><Link to={`/documents/${m.document.id}`} target="_blank">📄 {m.document.title}（v{m.document.major}.{m.document.minor}）を開く</Link></p> : <p className="subtle">文書を閲覧する権限がありません。研修担当者に連絡してください。</p>)}
                {m.type === 'video' && m.url && <p style={{ margin: '6px 0' }}><a href={m.url} target="_blank" rel="noopener noreferrer">▶ 動画を開く（外部サイト）</a></p>}
                {m.type === 'quiz' && !!m.attempts.length && <p className="small">受験履歴：{m.attempts.map((t: any) => t.status === 'in_progress' ? '受験中' : `${t.result === 'pass' ? '合格' : t.result === 'fail' ? '不合格' : '採点待ち'}（${t.score}/${t.max_score}）`).join('、')}</p>}
                {a.mine && !m.done && !m.locked && ['not_started', 'in_progress'].includes(a.status) && (
                  <div className="row" style={{ marginTop: 6 }}>
                    {m.type === 'quiz' ? <button className="btn primary" disabled={!online} onClick={() => setOpenQuiz(m)}>{online ? 'テストを受ける' : 'オンラインで受験できます'}</button> :
                      <button className="btn primary" disabled={busy || !online || (m.type === 'document' && !m.document)} onClick={() => void complete(m)}>{m.type === 'acknowledgement' ? '確認しました' : m.type === 'document' ? '読みました' : '完了'}</button>}
                  </div>
                )}
              </li>
            ))}
          </ol>
          {openQuiz && <QuizTake assignmentId={a.id} module={openQuiz} onClose={() => { setOpenQuiz(null); st.reload(); }} />}
        </>
      );
    }}</Loaded>
  );
}

export function QuizTake({ assignmentId, module, onClose }: { assignmentId: string | null; module: { id: string; quizId: string; title: string }; onClose: () => void }) {
  const st = useLoad(() => api.post(`/api/quizzes/${module.quizId}/attempts`, { assignmentId, moduleId: module.id }), [module.quizId]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  if (st.error) return <div className="modal-back"><div className="modal"><div className="alert danger">{st.error.message}</div><button className="btn" style={{ marginTop: 10 }} onClick={onClose}>閉じる</button></div></div>;
  return (
    <div className="modal-back"><div className="modal wide" role="dialog" aria-modal="true" aria-label={module.title}>
      <h2>{module.title}</h2>
      <Loaded state={st}>{(at: any) => {
        const r = result ?? (at.status !== 'in_progress' ? at : null);
        if (r) {
          const reviewMap = Object.fromEntries((r.review ?? []).map((x: any) => [x.id, x]));
          return (
            <>
              <div className={`alert ${r.result === 'pass' ? 'ok' : r.result === 'fail' ? 'danger' : 'info'}`} role="status"><strong>{r.result === 'pass' ? '合格' : r.result === 'fail' ? '不合格' : '採点待ち'}</strong>　{r.score} / {r.maxScore} 点（{r.percent}%）・ 合格ライン {r.passScore}%</div>
              <ol style={{ paddingLeft: '1.2em' }}>{r.questions.map((q: any) => { const rv = reviewMap[q.id]; return (
                <li key={q.id} style={{ marginTop: 10 }}><strong>{q.prompt}</strong> {rv?.correct === true ? <Badge tone="ok">正解</Badge> : rv?.correct === false ? <Badge tone="danger">不正解</Badge> : <Badge tone="neutral">採点待ち</Badge>}
                  {rv?.explanation !== undefined && <div className="small muted">正解：{(rv.correctAnswer ?? []).map((c: string) => q.choices.find((x: any) => x.id === c)?.text ?? c).join('、')}{rv.explanation && ` ／ ${rv.explanation}`}{rv.sourceSection && `（根拠：${rv.sourceSection}）`}</div>}
                </li>); })}</ol>
              <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>閉じる</button></div>
            </>
          );
        }
        const unanswered = at.questions.filter((q: any) => answers[q.id] === undefined || (Array.isArray(answers[q.id]) && !answers[q.id].length) || answers[q.id] === '').length;
        return (
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => setResult(await api.post(`/api/attempts/${at.id}/submit`, { answers }))); }}>
            <p className="subtle">全 {at.questions.length} 問 ・ 合格ライン {at.passScore}%</p>
            <ol style={{ paddingLeft: '1.2em' }}>{at.questions.map((q: any) => (
              <li key={q.id} style={{ marginBottom: 16 }}>
                <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend style={{ fontWeight: 700, marginBottom: 6 }}>{q.prompt} {q.type === 'multiple' && <span className="subtle">（当てはまるものをすべて）</span>}</legend>
                  {q.type === 'short' ? <input type="text" aria-label="回答" value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} /> :
                    <div className="stack" style={{ gap: 6 }}>{q.choices.map((c: any) => {
                      const multi = q.type === 'multiple';
                      const checked = multi ? (answers[q.id] ?? []).includes(c.id) : answers[q.id] === c.id;
                      return <label key={c.id} className={`big-check ${checked ? 'checked' : ''}`} style={{ minHeight: 48 }}><input type={multi ? 'checkbox' : 'radio'} name={q.id} checked={checked}
                        onChange={() => setAnswers({ ...answers, [q.id]: multi ? (checked ? answers[q.id].filter((x: string) => x !== c.id) : [...(answers[q.id] ?? []), c.id]) : c.id })} />{c.text}</label>;
                    })}</div>}
                </fieldset>
              </li>
            ))}</ol>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="subtle">{unanswered ? `未回答 ${unanswered} 問` : 'すべて回答しました'}</span>
              <div className="row"><button type="button" className="btn" onClick={onClose}>あとで受ける</button><button className="btn primary" disabled={busy}>{busy ? '送信中…' : '提出する'}</button></div></div>
          </form>
        );
      }}</Loaded>
    </div></div>
  );
}
