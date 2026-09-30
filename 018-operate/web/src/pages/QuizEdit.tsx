import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { AiBadge, Badge, Icon, Loaded, Modal, PageHead, useAction, useLoad } from '../ui';
import { QuizTake } from './Assignment';

const TYPES: Record<string, string> = { single: '単一選択', multiple: '複数選択', truefalse: '○×', short: '記述（手動採点）' };
const blank = (): any => ({ id: `q${Date.now().toString(36)}`, type: 'single', prompt: '', choices: [{ id: 'c1', text: '' }, { id: 'c2', text: '' }], correct: [], explanation: '', sourceSection: '', points: 1, aiGenerated: false, reviewed: true });

export default function QuizEdit() {
  const { id } = useParams();
  const { me } = useAuth();
  const st = useLoad(() => api.get(`/api/quizzes/${id}`), [id]);
  const [qs, setQs] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [title, setTitle] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!st.data) return;
    const v = st.data.versions.find((x: any) => x.status === 'draft') ?? st.data.versions[0];
    setQs(v?.questions ?? []); setSettings(v?.settings ?? {}); setTitle(st.data.quiz.title);
  }, [st.data]);
  const set = (i: number, p: any) => setQs(qs.map((q, j) => (j === i ? { ...q, ...p } : q)));
  const save = () => api.put(`/api/quizzes/${id}/draft`, { title, questions: qs.map(({ reviewedBy: _a, reviewedAt: _b, ...q }) => q), settings });
  const unreviewed = qs.filter((q) => q.aiGenerated && !q.reviewed).length;
  return (
    <Loaded state={st}>{(d: any) => settings && (
      <>
        <PageHead title={title} sub={<span className="row">{d.quiz.status === 'published' ? <Badge tone="ok">公開中</Badge> : <Badge>下書き</Badge>}<span className="subtle">公開済みの版は変更されません。編集すると新しい版になり、過去の受験結果はそのまま残ります。</span></span>}>
          <Link className="btn" to="/manage/training?tab=quizzes">一覧へ</Link>
          {d.quiz.status === 'published' && <button className="btn" onClick={() => setPreview(true)}>受験プレビュー</button>}
          <button className="btn" disabled={busy} onClick={() => void run(save, '保存しました')}>下書き保存</button>
          <button className="btn primary" disabled={busy || unreviewed > 0} title={unreviewed ? 'AI生成の未確認問題があります' : undefined} onClick={() => void run(async () => { await save(); await api.post(`/api/quizzes/${id}/publish`); st.reload(); }, '公開しました')}>公開する</button>
        </PageHead>
        {unreviewed > 0 && <div className="alert warn" style={{ marginBottom: 12 }}>AIが作成した問題のうち {unreviewed} 問が未確認です。問題文・正解・根拠を確認し「確認しました」にチェックするまで公開できません。</div>}
        <div className="card">
          <div className="grid cols-4">
            <div className="field"><label htmlFor="ps">合格点（%）</label><input id="ps" type="number" min={0} max={100} value={settings.passScore} onChange={(e) => setSettings({ ...settings, passScore: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="ma">受験回数の上限（0=無制限）</label><input id="ma" type="number" min={0} value={settings.maxAttempts} onChange={(e) => setSettings({ ...settings, maxAttempts: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="cd">再受験までの待ち時間（分）</label><input id="cd" type="number" min={0} value={settings.cooldownMinutes} onChange={(e) => setSettings({ ...settings, cooldownMinutes: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="se">解説の表示</label><select id="se" value={settings.showExplanation} onChange={(e) => setSettings({ ...settings, showExplanation: e.target.value })}><option value="after_submit">提出後すぐ</option><option value="after_pass">合格した後</option><option value="never">表示しない</option></select></div>
          </div>
          <div className="row"><label className="check"><input type="checkbox" checked={settings.shuffleQuestions} onChange={(e) => setSettings({ ...settings, shuffleQuestions: e.target.checked })} />問題の順番をシャッフル</label><label className="check"><input type="checkbox" checked={settings.shuffleChoices} onChange={(e) => setSettings({ ...settings, shuffleChoices: e.target.checked })} />選択肢をシャッフル</label></div>
        </div>
        {qs.map((q, i) => (
          <div key={q.id} className="card" style={{ borderColor: q.aiGenerated && !q.reviewed ? '#ddd6fe' : undefined }}>
            <div className="row between"><strong>問{i + 1}</strong><div className="row">{q.aiGenerated && <AiBadge />}<select aria-label="形式" value={q.type} onChange={(e) => set(i, { type: e.target.value, correct: [], choices: e.target.value === 'truefalse' ? [{ id: 'true', text: '正しい' }, { id: 'false', text: '誤り' }] : e.target.value === 'short' ? [] : q.choices.length ? q.choices : blank().choices })} style={{ width: 'auto' }}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <label className="small" style={{ margin: 0 }}>配点 <input type="number" min={0} max={100} value={q.points} onChange={(e) => set(i, { points: Number(e.target.value) })} style={{ width: 70, display: 'inline-block' }} /></label>
              <button className="btn sm danger" onClick={() => setQs(qs.filter((_, j) => j !== i))}>削除</button></div></div>
            <div className="field" style={{ marginTop: 8 }}><label htmlFor={`qp${i}`}>問題文</label><textarea id={`qp${i}`} style={{ minHeight: 60 }} value={q.prompt} onChange={(e) => set(i, { prompt: e.target.value })} /></div>
            {q.type !== 'short' ? (
              <div className="stack" role="group" aria-label="選択肢と正解">
                {q.choices.map((c: any, k: number) => (
                  <div key={c.id} className="row" style={{ flexWrap: 'nowrap' }}>
                    <label className="check" title="正解"><input type={q.type === 'multiple' ? 'checkbox' : 'radio'} name={`cor-${q.id}`} checked={q.correct.includes(c.id)} onChange={() => set(i, { correct: q.type === 'multiple' ? (q.correct.includes(c.id) ? q.correct.filter((x: string) => x !== c.id) : [...q.correct, c.id]) : [c.id] })} /><span className="sr-only">正解</span></label>
                    <input type="text" aria-label={`選択肢${k + 1}`} value={c.text} disabled={q.type === 'truefalse'} onChange={(e) => set(i, { choices: q.choices.map((x: any) => (x.id === c.id ? { ...x, text: e.target.value } : x)) })} />
                    {q.type !== 'truefalse' && q.choices.length > 2 && <button className="btn sm" onClick={() => set(i, { choices: q.choices.filter((x: any) => x.id !== c.id), correct: q.correct.filter((x: string) => x !== c.id) })} aria-label="選択肢を削除">×</button>}
                  </div>
                ))}
                {q.type !== 'truefalse' && q.choices.length < 8 && <button className="btn sm" onClick={() => set(i, { choices: [...q.choices, { id: `c${Date.now().toString(36)}`, text: '' }] })}>＋ 選択肢</button>}
                <span className="subtle">左の丸／四角で正解を選びます。</span>
              </div>
            ) : <div className="field"><label htmlFor={`qa${i}`}>自動採点する正解（任意・1行に1つ。空欄なら手動採点）</label><textarea id={`qa${i}`} style={{ minHeight: 50 }} value={q.correct.join('\n')} onChange={(e) => set(i, { correct: e.target.value.split('\n').filter(Boolean) })} /></div>}
            <div className="grid cols-2" style={{ marginTop: 8 }}>
              <div className="field"><label htmlFor={`qe${i}`}>解説</label><input id={`qe${i}`} type="text" value={q.explanation} onChange={(e) => set(i, { explanation: e.target.value })} /></div>
              <div className="field"><label htmlFor={`qs${i}`}>根拠（マニュアルの箇所）</label><input id={`qs${i}`} type="text" value={q.sourceSection ?? ''} onChange={(e) => set(i, { sourceSection: e.target.value })} />{q.sourceVersionId && <div className="hint"><Link to={`/documents/${q.sourceDocumentId}`} target="_blank">根拠の文書を開く</Link>（版ID {q.sourceVersionId.slice(0, 8)}）</div>}</div>
            </div>
            {q.aiGenerated && <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={q.reviewed} onChange={(e) => set(i, { reviewed: e.target.checked })} /><strong>問題文・正解・誤答選択肢・根拠を確認しました</strong>{q.reviewedBy && <span className="subtle">（{q.reviewedBy}）</span>}</label>}
          </div>
        ))}
        <div className="row"><button className="btn" onClick={() => setQs([...qs, blank()])}><Icon name="plus" size={16} />問題を追加</button>
          {me?.policy.ai.quizDraft && <button className="btn cta" onClick={() => setAiOpen(true)}><Icon name="sparkle" size={16} />マニュアルからAIで問題案を作る</button>}</div>
        {aiOpen && <AiQuizModal quizId={id!} onClose={() => setAiOpen(false)} onAdd={(x) => { setQs([...qs, ...x]); setAiOpen(false); }} />}
        {preview && <QuizTake assignmentId={null} module={{ id: 'preview', quizId: id!, title: `${title}（プレビュー）` }} onClose={() => setPreview(false)} />}
      </>
    )}</Loaded>
  );
}

function AiQuizModal({ quizId, onClose, onAdd }: { quizId: string; onClose: () => void; onAdd: (q: any[]) => void }) {
  const docs = useLoad(() => api.get('/api/documents?view=published&limit=200'));
  const [doc, setDoc] = useState('');
  const [count, setCount] = useState(5);
  const { busy, run } = useAction();
  return (
    <Modal title="AIで問題案を作る" onClose={onClose}>
      <p className="muted">公開中のマニュアルの記載内容だけから問題案を作ります。作成された問題は「未確認」として追加され、あなたが確認するまで公開できません。</p>
      <Loaded state={docs}>{(ds: any) => <div className="field"><label htmlFor="qd">元にするマニュアル</label><select id="qd" value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">選択</option>{ds.items.map((x: any) => <option key={x.id} value={x.id}>{x.doc_number} {x.title}（v{x.version}）</option>)}</select></div>}</Loaded>
      <div className="field"><label htmlFor="qc">問題数</label><input id="qc" type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button>
        <button className="btn cta" disabled={busy || !doc} onClick={() => void run(async () => {
          const d = await api.get(`/api/documents/${doc}`);
          const r = await api.post(`/api/quizzes/${quizId}/ai-draft`, { versionId: d.current.id, count });
          if (!r.questions.length) throw new Error('問題案を作成できませんでした');
          onAdd(r.questions);
        })}>{busy ? '作成中…' : '問題案を作成'}</button></div>
    </Modal>
  );
}
