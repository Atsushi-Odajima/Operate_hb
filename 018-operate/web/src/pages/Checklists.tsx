import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime } from '../labels';
import { Badge, Empty, Icon, Loaded, PageHead, Tabs, useAction, useLoad } from '../ui';

export default function Checklists() {
  const { can } = useAuth();
  const nav = useNavigate();
  const manager = can('doc.admin') || can('audit.read') || can('training.report');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const docs = useLoad(() => api.get('/api/documents?type=checklist&limit=100'));
  const runs = useLoad(() => api.get(`/api/checklist-runs?scope=${scope}`), [scope]);
  const { busy, run } = useAction();
  return (
    <>
      <PageHead title="チェックリスト" sub="開店作業・月末締め・アカウント発行など、決まった作業を記録しながら実行します。" />
      <section className="card">
        <h2>チェックリストを始める</h2>
        <Loaded state={docs}>{(d: any) => d.items.length ? <ul className="list">{d.items.map((x: any) => (
          <li key={x.id} className="row between"><span><Link to={`/documents/${x.id}`} className="title">{x.doc_number} {x.title}</Link> <span className="subtle">v{x.version}</span></span>
            <button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post(`/api/documents/${x.id}/checklist-runs`, { clientKey: `run-${x.id}-${crypto.randomUUID()}` }); nav(`/checklists/${r.id}`); })}><Icon name="play" size={16} />開始</button></li>
        ))}</ul> : <Empty>閲覧できるチェックリストはありません。手順書（SOP）の「ステップ表示で実行」からも記録できます。</Empty>}</Loaded>
      </section>
      <section className="card">
        <h2>実行記録</h2>
        {manager && <Tabs tabs={[['mine', '自分の記録'], ['all', 'すべての記録']]} value={scope} onChange={setScope} />}
        <Loaded state={runs}>{(rs: any[]) => rs.length ? <div className="table-wrap"><table className="tbl"><thead><tr><th>チェックリスト</th><th>担当</th><th>進捗</th><th>開始</th><th>完了</th></tr></thead><tbody>
          {rs.map((r) => <tr key={r.id}><td><Link to={`/checklists/${r.id}`}>{r.title}</Link> <span className="subtle">v{r.major}.{r.minor}</span></td><td>{r.assignee_name}</td><td>{r.checked_count}/{r.item_count}</td><td className="small">{fmtDateTime(r.started_at)}</td><td>{r.status === 'completed' ? <Badge tone="ok">完了 {fmtDateTime(r.completed_at)}</Badge> : <Badge tone="info">実行中</Badge>}</td></tr>)}
        </tbody></table></div> : <Empty>記録はまだありません</Empty>}</Loaded>
      </section>
    </>
  );
}
