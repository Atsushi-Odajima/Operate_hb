import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { Content, Step } from '../DocRenderer';
import { useOnline } from '../Layout';
import { enqueue, getOffline } from '../offline';
import { Icon, Loaded, Progress, Spinner, useAction, useLoad, useToast } from '../ui';

interface RunItem { id: string; text: string; required: boolean; stepId: string | null; checked: boolean; checkedAt: string | null; checkedBy: string | null; note: string }

/** /documents/:id/run -> starts a run (online) or shows the offline copy; /checklists/:runId -> executes a run. */
export default function StepRun() {
  const { id, runId } = useParams();
  if (runId) return <RunView runId={runId} />;
  return <StartRun docId={id!} />;
}

function StartRun({ docId }: { docId: string }) {
  const online = useOnline();
  const nav = useNavigate();
  const [offline, setOffline] = useState<{ title: string; content: Content; version: string } | null | undefined>(undefined);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (online) {
      const key = `run-${docId}-${crypto.randomUUID()}`;
      api.post(`/api/documents/${docId}/checklist-runs`, { clientKey: key }).then((r) => nav(`/checklists/${r.id}`, { replace: true })).catch((e) => setErr(e.message));
    } else {
      void getOffline(docId).then((d) => setOffline(d ? { title: d.title, content: d.content, version: d.version } : null));
    }
  }, [online, docId, nav]);
  if (err) return <div className="alert danger">{err}</div>;
  if (!online) {
    if (offline === undefined) return <Spinner />;
    if (!offline) return <div className="alert warn">オフラインです。この文書は端末に保存されていないため表示できません。</div>;
    return (
      <div className="run">
        <div className="alert warn" style={{ marginBottom: 10 }}>オフライン表示中（v{offline.version}）。実行記録はオンライン時のみ保存されます。</div>
        <StepPager title={offline.title} steps={offline.content.steps} items={[]} onToggle={() => undefined} />
      </div>
    );
  }
  return <Spinner />;
}

function StepPager({ title, steps, items, onToggle, footer }: { title: string; steps: Step[]; items: RunItem[]; onToggle: (it: RunItem) => void; footer?: React.ReactNode }) {
  const [i, setI] = useState(0);
  const s = steps[i];
  const stepItems = items.filter((x) => x.stepId === s?.id);
  useEffect(() => { window.scrollTo(0, 0); }, [i]);
  if (!s) return <>{footer}</>;
  return (
    <>
      <div className="row between" style={{ marginBottom: 8 }}><strong>{title}</strong><span className="subtle">手順 {i + 1} / {steps.length}</span></div>
      <Progress value={((i + 1) / steps.length) * 100} label="手順の進み具合" />
      <section className="card step-card" style={{ marginTop: 12 }} aria-live="polite" aria-label={`手順${i + 1}`}>
        <h2>{i + 1}. {s.title}</h2>
        <div style={{ whiteSpace: 'pre-wrap' }}>{s.instruction}</div>
        {s.imageId && <img src={`/api/attachments/${s.imageId}/content`} alt={s.title} style={{ maxWidth: '100%', borderRadius: 10, marginTop: 10 }} />}
        {s.warning && <div className="callout warning" role="alert"><span className="ttl">⚠ 注意</span><div>{s.warning}</div></div>}
        {s.expectedResult && <p><strong>こうなればOK：</strong>{s.expectedResult}</p>}
        <div className="stack" style={{ marginTop: 10 }}>
          {stepItems.map((it) => (
            <label key={it.id} className={`big-check ${it.checked ? 'checked' : ''}`}><input type="checkbox" checked={it.checked} onChange={() => onToggle(it)} />{it.stepId === it.id ? 'この手順を完了した' : it.text}</label>
          ))}
          {!items.length && s.checklist.map((c, k) => <div key={k} className="big-check">□ {c}</div>)}
        </div>
      </section>
      <div className="nav-btns">
        <button className="btn lg" style={{ flex: 1 }} disabled={i === 0} onClick={() => setI(i - 1)}><Icon name="back" />前へ</button>
        {i < steps.length - 1 ? <button className="btn primary lg" style={{ flex: 2 }} onClick={() => setI(i + 1)}>次へ<Icon name="next" /></button> : <div style={{ flex: 2 }}>{footer}</div>}
      </div>
    </>
  );
}

function RunView({ runId }: { runId: string }) {
  const st = useLoad(() => api.get(`/api/checklist-runs/${runId}`), [runId]);
  const online = useOnline();
  const { push } = useToast();
  const { busy, run } = useAction();
  const [items, setItems] = useState<RunItem[]>([]);
  useEffect(() => { if (st.data) setItems(st.data.items); }, [st.data]);
  const done = useMemo(() => items.filter((x) => x.checked).length, [items]);
  const missing = items.filter((x) => x.required && !x.checked).length;

  const toggle = async (it: RunItem) => {
    const next = !it.checked;
    const at = new Date().toISOString();
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, checked: next, checkedAt: next ? at : null } : x)));
    const body = { items: [{ id: it.id, checked: next, note: it.note, at }] };
    if (!online) {
      await enqueue({ key: `${runId}:${it.id}:${Date.now()}`, method: 'PATCH', url: `/api/checklist-runs/${runId}`, body, label: it.text, createdAt: at });
      push('オフラインのため、接続後に送信します');
      return;
    }
    try { await api.patch(`/api/checklist-runs/${runId}`, body); } catch (e: any) { push(e.message, true); st.reload(); }
  };

  return (
    <Loaded state={st}>{(r: any) => {
      const completed = r.status === 'completed';
      const footer = completed ? <div className="alert ok">完了済み</div> : (
        <button className="btn primary lg block" disabled={busy || missing > 0 || !online} onClick={() => void run(async () => { await api.post(`/api/checklist-runs/${runId}/complete`); st.reload(); }, '完了を記録しました')}>
          <Icon name="check" />{!online ? 'オンラインで完了できます' : missing ? `必須項目があと${missing}件` : '完了として記録する'}</button>
      );
      return (
        <div className="run">
          <div className="row between" style={{ marginBottom: 8 }}><Link to={`/documents/${r.document_id}`} className="small">← {r.title}（v{r.version}）</Link><span className="subtle">{done}/{items.length} 完了</span></div>
          {completed && <div className="alert ok" style={{ marginBottom: 10 }}>{new Date(r.completed_at).toLocaleString('ja-JP')} に完了しました（担当：{r.assignee_name ?? '—'}）。</div>}
          {r.steps?.length ? <StepPager title={r.title} steps={r.steps} items={items} onToggle={completed ? () => undefined : (it) => void toggle(it)} footer={footer} /> : (
            <>
              <h1>{r.title}</h1>
              <Progress value={(done / Math.max(1, items.length)) * 100} label="チェックの進み具合" />
              <div className="stack" style={{ marginTop: 12 }}>
                {items.map((it) => <label key={it.id} className={`big-check ${it.checked ? 'checked' : ''}`}><input type="checkbox" checked={it.checked} disabled={completed} onChange={() => void toggle(it)} /><span>{it.text}{!it.required && <span className="subtle">（任意）</span>}{it.checkedBy && it.checked && <span className="subtle" style={{ display: 'block' }}>{it.checkedBy} ・ {it.checkedAt && new Date(it.checkedAt).toLocaleTimeString('ja-JP')}</span>}</span></label>)}
              </div>
              <div className="nav-btns">{footer}</div>
            </>
          )}
        </div>
      );
    }}</Loaded>
  );
}
