import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { MODULE } from '../labels';
import { Badge, Icon, Loaded, PageHead, useAction, useLoad } from '../ui';
import { AssignModal } from './TrainingAdmin';

export default function CourseEdit() {
  const { id } = useParams();
  const st = useLoad(() => api.get(`/api/courses/${id}`), [id]);
  const docs = useLoad(() => api.get('/api/documents?view=published&limit=200'));
  const quizzes = useLoad(() => api.get('/api/quizzes'));
  const [meta, setMeta] = useState<any>(null);
  const [modules, setModules] = useState<any[]>([]);
  const [seq, setSeq] = useState(true);
  const [policy, setPolicy] = useState('keep');
  const [note, setNote] = useState('');
  const [assign, setAssign] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!st.data) return;
    const c = st.data.course;
    setMeta({ title: c.title, description: c.description, dueDays: c.due_days ?? '', validityDays: c.validity_days ?? '' });
    const draft = st.data.versions.find((v: any) => v.status === 'draft') ?? st.data.versions.find((v: any) => v.id === c.current_version_id);
    setModules(draft?.modules ?? []); setSeq(draft?.sequential ?? true); setPolicy(draft?.completion_policy ?? 'keep'); setNote(draft?.change_note ?? '');
  }, [st.data]);
  const setM = (i: number, p: any) => setModules(modules.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const move = (i: number, d: number) => { const a = [...modules]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); setModules(a); };
  const add = (type: string) => setModules([...modules, { id: `m${Date.now().toString(36)}`, type, title: MODULE[type], required: true, ...(type === 'acknowledgement' ? { text: '私は本コースの内容を確認しました。' } : {}) }]);
  const saveDraft = () => api.put(`/api/courses/${id}/draft`, { modules: modules.map((m) => ({ ...m, url: m.url || null, documentId: m.documentId || null, quizId: m.quizId || null })), sequential: seq, completionPolicy: policy, changeNote: note });
  return (
    <Loaded state={st}>{(d: any) => {
      const c = d.course;
      const published = !!c.current_version_id;
      const hasDraft = d.versions.some((v: any) => v.status === 'draft');
      return meta && (
        <>
          <PageHead title={c.title} sub={<span className="row">{c.status === 'published' ? <Badge tone="ok">公開中 v{d.versions.find((v: any) => v.id === c.current_version_id)?.version_no}</Badge> : <Badge>下書き</Badge>}{hasDraft && published && <Badge tone="info">改訂の下書きあり</Badge>}</span>}>
            <Link className="btn" to="/manage/training">一覧へ</Link>
            {published && <button className="btn" onClick={() => setAssign(true)}>割り当てる</button>}
            <button className="btn" disabled={busy} onClick={() => void run(saveDraft, '下書きを保存しました')}>下書き保存</button>
            <button className="btn primary" disabled={busy} onClick={() => void run(async () => { await saveDraft(); const r = await api.post(`/api/courses/${id}/publish`); st.reload(); return r; }, '公開しました')}>公開する</button>
          </PageHead>
          <div className="card">
            <div className="grid cols-2">
              <div className="field"><label htmlFor="ct">コース名</label><input id="ct" type="text" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} /></div>
              <div className="grid cols-2"><div className="field"><label htmlFor="cd">標準の期限（日）</label><input id="cd" type="number" min={1} value={meta.dueDays} onChange={(e) => setMeta({ ...meta, dueDays: e.target.value })} /></div>
                <div className="field"><label htmlFor="cv">修了の有効期間（日）</label><input id="cv" type="number" min={1} value={meta.validityDays} onChange={(e) => setMeta({ ...meta, validityDays: e.target.value })} /></div></div>
            </div>
            <div className="field"><label htmlFor="cds">説明</label><textarea id="cds" value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></div>
            <button className="btn sm" disabled={busy} onClick={() => void run(() => api.patch(`/api/courses/${id}`, { title: meta.title, description: meta.description, dueDays: meta.dueDays ? Number(meta.dueDays) : null, validityDays: meta.validityDays ? Number(meta.validityDays) : null }), '保存しました')}>基本情報を保存</button>
          </div>
          <div className="card">
            <h2>モジュール</h2>
            <label className="check" style={{ marginBottom: 10 }}><input type="checkbox" checked={seq} onChange={(e) => setSeq(e.target.checked)} />上から順番に受講させる（前の必須モジュールが終わるまで次に進めない）</label>
            <ol className="steps">{modules.map((m, i) => (
              <li key={m.id}>
                <div className="row between"><span className="chip">{MODULE[m.type]}</span><div className="row">
                  <label className="check small"><input type="checkbox" checked={m.required} onChange={(e) => setM(i, { required: e.target.checked })} />必須</label>
                  <button className="btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="上へ">↑</button><button className="btn sm" disabled={i === modules.length - 1} onClick={() => move(i, 1)} aria-label="下へ">↓</button>
                  <button className="btn sm danger" onClick={() => setModules(modules.filter((_, j) => j !== i))}>削除</button></div></div>
                <div className="field" style={{ marginTop: 8 }}><label htmlFor={`mt${i}`}>タイトル</label><input id={`mt${i}`} type="text" value={m.title} onChange={(e) => setM(i, { title: e.target.value })} /></div>
                {m.type === 'document' && <Loaded state={docs}>{(ds: any) => <div className="field"><label htmlFor={`md${i}`}>マニュアル</label><select id={`md${i}`} value={m.documentId ?? ''} onChange={(e) => setM(i, { documentId: e.target.value })}><option value="">選択</option>{ds.items.map((x: any) => <option key={x.id} value={x.id}>{x.doc_number} {x.title}（v{x.version}）</option>)}</select><div className="hint">受講時点の最新版を読みます。</div></div>}</Loaded>}
                {m.type === 'quiz' && <Loaded state={quizzes}>{(qs: any[]) => <div className="field"><label htmlFor={`mq${i}`}>テスト</label><select id={`mq${i}`} value={m.quizId ?? ''} onChange={(e) => setM(i, { quizId: e.target.value })}><option value="">選択</option>{qs.filter((q) => q.status === 'published').map((q) => <option key={q.id} value={q.id}>{q.title}（v{q.version_no}）</option>)}</select></div>}</Loaded>}
                {(m.type === 'text' || m.type === 'acknowledgement') && <div className="field"><label htmlFor={`mx${i}`}>{m.type === 'text' ? '説明文' : '確認する内容'}</label><textarea id={`mx${i}`} value={m.text ?? ''} onChange={(e) => setM(i, { text: e.target.value })} /></div>}
                {m.type === 'video' && <div className="field"><label htmlFor={`mu${i}`}>動画URL（https）</label><input id={`mu${i}`} type="url" value={m.url ?? ''} onChange={(e) => setM(i, { url: e.target.value })} /></div>}
              </li>
            ))}</ol>
            <div className="row">{Object.entries(MODULE).map(([k, v]) => <button key={k} className="btn sm" onClick={() => add(k)}><Icon name="plus" size={14} />{v}</button>)}</div>
          </div>
          {published && (
            <div className="card">
              <h2>改訂の扱い</h2>
              <p className="subtle">公開済みコースを変更すると新しい版（v{Math.max(...d.versions.map((v: any) => v.version_no)) + (hasDraft ? 0 : 1)}）になります。</p>
              <label className="check"><input type="radio" name="pol" checked={policy === 'keep'} onChange={() => setPolicy('keep')} />旧版の修了はそのまま。新しく割り当てる人から新版</label>
              <label className="check"><input type="radio" name="pol" checked={policy === 'reassign'} onChange={() => setPolicy('reassign')} />旧版を割り当てた全員に新版を再受講させる（旧版の修了記録は旧版のまま残ります）</label>
              <div className="field" style={{ marginTop: 8 }}><label htmlFor="cn">変更メモ</label><input id="cn" type="text" value={note} onChange={(e) => setNote(e.target.value)} /></div>
            </div>
          )}
          {assign && <AssignModal courseId={c.id} onClose={() => setAssign(false)} />}
        </>
      );
    }}</Loaded>
  );
}
