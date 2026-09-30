import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { CLASS, DOC_TYPES, fmtDate } from '../labels';
import { ClassBadge, Empty, Icon, PageHead, Spinner, useAction } from '../ui';

interface Citation { n: number; documentId: string; title: string; docNumber: string | null; version: string; section: string; updatedAt: string; publishedAt: string }

export default function Search() {
  const { me, can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [type, setType] = useState(sp.get('type') ?? '');
  const [dept, setDept] = useState(sp.get('departmentId') ?? '');
  const [cls, setCls] = useState(sp.get('classification') ?? '');
  const [res, setRes] = useState<any>(null);
  const [deps, setDeps] = useState<any[]>([]);
  const [ai, setAi] = useState<{ answer: string; grounded: boolean; citations: Citation[]; provider: string } | null>(null);
  const [historical, setHistorical] = useState(false);
  const { busy, run } = useAction();
  const opened = useRef<{ queryId: number; at: number } | null>(null);

  useEffect(() => { api.get('/api/departments').then(setDeps).catch(() => undefined); }, []);
  useEffect(() => {
    if (!q && !type && !dept && !cls) { setRes(null); return; }
    setRes(undefined);
    api.get(`/api/search${qs({ q, type, departmentId: dept, classification: cls })}`).then(setRes).catch(() => setRes({ items: [], total: 0 }));
  }, [q, type, dept, cls]);
  useEffect(() => () => {
    const o = opened.current;
    if (o) void api.post('/api/search/dwell', { queryId: o.queryId, ms: Date.now() - o.at }).catch(() => undefined);
  }, []);

  const submit = (e?: React.FormEvent) => { e?.preventDefault(); setAi(null); setSp({ ...(input ? { q: input } : {}), ...(type ? { type } : {}), ...(dept ? { departmentId: dept } : {}), ...(cls ? { classification: cls } : {}) }); };
  const ask = () => run(async () => setAi(await api.post('/api/ai/ask', { question: input || q, historical })));
  const click = (id: string) => { if (res?.queryId) { opened.current = { queryId: res.queryId, at: Date.now() }; void api.post('/api/search/click', { queryId: res.queryId, documentId: id }).catch(() => undefined); } };

  return (
    <>
      <PageHead title="検索・AIに質問" sub="承認済みのマニュアルだけを検索します。見られる範囲はあなたの部署・役割によって決まります。" />
      <form className="card" onSubmit={submit} role="search">
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input type="search" aria-label="検索語または質問" value={input} onChange={(e) => setInput(e.target.value)} placeholder="例：返金 本人確認 ／ 返金問い合わせの最初の手順は？" style={{ flex: 1 }} autoFocus />
          <button className="btn primary"><Icon name="search" size={18} />検索</button>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <select aria-label="種別" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }}><option value="">すべての種別</option>{Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          {!!deps.length && <select aria-label="部署" value={dept} onChange={(e) => setDept(e.target.value)} style={{ width: 'auto' }}><option value="">すべての部署</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
          <select aria-label="機密区分" value={cls} onChange={(e) => setCls(e.target.value)} style={{ width: 'auto' }}><option value="">すべての区分</option>{Object.entries(CLASS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          {me?.policy.ai.enabled && <button type="button" className="btn cta" onClick={() => void ask()} disabled={busy || !(input || q).trim()}><Icon name="sparkle" size={18} />{busy ? '回答を作成中…' : 'AIに質問する'}</button>}
          {me?.policy.ai.enabled && can('ai.historical') && <label className="check small"><input type="checkbox" checked={historical} onChange={(e) => setHistorical(e.target.checked)} />過去の版も含める（管理者モード）</label>}
        </div>
      </form>

      {ai && (
        <section className="card" aria-live="polite" aria-labelledby="ai-h" style={{ marginTop: 14, borderColor: '#c7d2fe' }}>
          <div className="row between"><h2 id="ai-h" style={{ margin: 0 }}><Icon name="sparkle" /> AIの回答</h2><span className="badge ai">承認済み文書のみ参照{ai.provider === 'local' ? '・社外送信なし' : ''}</span></div>
          {ai.grounded ? (
            <>
              <div style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>{ai.answer}</div>
              <h3 style={{ marginTop: 14 }}>根拠</h3>
              <ol className="small">{ai.citations.map((c) => (
                <li key={c.n}><Link to={`/documents/${c.documentId}`}>[{c.n}] {c.docNumber} {c.title}</Link> — v{c.version} ・ {c.section} ・ 公開 {fmtDate(c.publishedAt)}</li>
              ))}</ol>
              <p className="subtle">AIの回答は要約です。作業の前に必ず根拠のマニュアルを確認してください。</p>
            </>
          ) : (
            <div className="alert info" style={{ marginTop: 10 }}><div><strong>{ai.answer}</strong><br />該当する承認済みの手順が見つかりませんでした。担当部署に確認するか、「フィードバック」からマニュアル作成を依頼してください。</div></div>
          )}
        </section>
      )}

      <section style={{ marginTop: 14 }} aria-live="polite">
        {res === undefined ? <Spinner /> : res === null ? <Empty>キーワードを入力して検索してください。質問文で「AIに質問する」こともできます。</Empty> : (
          <div className="card pad-0">
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)' }} className="subtle">{res.total} 件{res.fuzzy && '（すべての言葉を含む文書がないため、近い文書を表示しています）'}</div>
            {res.items.length ? <ul className="list" style={{ padding: '0 18px' }}>{res.items.map((d: any) => (
              <li key={d.id}>
                <Link to={`/documents/${d.id}`} className="title" onClick={() => click(d.id)}>{d.doc_number && <span className="subtle">{d.doc_number} </span>}{d.title}</Link>
                <div className="small muted" style={{ margin: '2px 0 4px' }}>{d.snippet}</div>
                <div className="row small"><span className="chip">{DOC_TYPES[d.type]}</span><ClassBadge c={d.classification} /><span className="subtle">{d.department_name} ・ v{d.version} ・ 更新 {fmtDate(d.updated_at)}</span></div>
              </li>
            ))}</ul> : <Empty>該当するマニュアルがありません。言葉を変えるか、AIに質問してみてください。</Empty>}
          </div>
        )}
      </section>
    </>
  );
}
