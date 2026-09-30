import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadExport, qs } from '../api';
import { useAuth } from '../auth';
import { CLASS, DOC_STATUS, DOC_TYPES, fmtDate } from '../labels';
import { ClassBadge, DocStatus, Empty, Icon, Loaded, PageHead, Tabs, useAction, useLoad, VerStatus } from '../ui';

export default function Documents() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as 'published' | 'work' | 'all') ?? 'published';
  const [type, setType] = useState(sp.get('type') ?? '');
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [cls, setCls] = useState('');
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const reviewDue = sp.get('reviewDue') ?? '';
  const deps = useLoad(() => api.get('/api/departments'));
  const st = useLoad(() => api.get(`/api/documents${qs({ view: reviewDue && view === 'published' ? (can('doc.readAll') ? 'all' : 'published') : view, type, status, classification: cls, q, departmentId: dept, reviewDue, limit: 200 })}`), [view, type, status, cls, q, dept, reviewDue]);
  const { run } = useAction();
  const tabs: Array<['published' | 'work' | 'all', string]> = [['published', '公開中のマニュアル']];
  if (can('doc.create')) tabs.push(['work', '作成・編集']);
  if (can('doc.readAll')) tabs.push(['all', 'すべて（管理）']);
  return (
    <>
      <PageHead title="マニュアル" sub={view === 'published' ? 'あなたが閲覧できる、現在使うべき最新版のマニュアルです。' : view === 'work' ? 'あなたが編集できる文書と、作業中の版です。' : '組織のすべての文書（下書き・廃止を含む）'}>
        {can('health.read') && <button className="btn" onClick={() => void run(() => downloadExport('document-list', { departmentId: dept || null }))}><Icon name="download" size={18} />一覧をCSV出力</button>}
        {can('doc.create') && <Link className="btn primary" to="/documents/new"><Icon name="plus" size={18} />新しいマニュアル</Link>}
      </PageHead>
      <Tabs tabs={tabs} value={view} onChange={(v) => setSp(v === 'published' ? {} : { view: v })} />
      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" aria-label="タイトル・文書番号で絞り込み" placeholder="タイトル・文書番号で絞り込み" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        <select aria-label="種別" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }}><option value="">すべての種別</option>{Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <Loaded state={deps}>{(d: any[]) => d.length ? <select aria-label="部署" value={dept} onChange={(e) => setDept(e.target.value)} style={{ width: 'auto' }}><option value="">すべての部署</option>{d.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select> : null}</Loaded>
        {view !== 'published' && <select aria-label="状態" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">すべての状態</option>{Object.entries(DOC_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>}
        <select aria-label="機密区分" value={cls} onChange={(e) => setCls(e.target.value)} style={{ width: 'auto' }}><option value="">すべての区分</option>{Object.entries(CLASS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        {reviewDue && <span className="badge danger">定期レビュー{reviewDue === 'overdue' ? '期限切れ' : 'まもなく'}のみ <button className="btn ghost sm" onClick={() => setSp(view === 'published' ? {} : { view })} aria-label="絞り込み解除">×</button></span>}
      </div>
      <Loaded state={st}>{(d: any) => d.items.length ? (
        <div className="card pad-0 table-wrap">
          <table className="tbl">
            <thead><tr><th>文書</th><th>種別</th><th>部署</th><th>区分</th><th>版</th><th>状態</th><th>次回レビュー</th></tr></thead>
            <tbody>{d.items.map((x: any) => {
              const overdue = x.status === 'published' && x.next_review_date && x.next_review_date < new Date().toISOString().slice(0, 10);
              return (
                <tr key={x.id}>
                  <td><Link to={`/documents/${x.id}`} style={{ fontWeight: 700 }}>{x.title}</Link>{x.doc_number && <div className="subtle">{x.doc_number}</div>}</td>
                  <td className="small">{DOC_TYPES[x.type]}</td>
                  <td className="small">{x.department_name ?? '—'}</td>
                  <td><ClassBadge c={x.classification} /></td>
                  <td className="small">{x.version ? `v${x.version}` : '—'}{x.workingVersion && <div><Link to={`/documents/${x.id}/edit`} className="small">v{x.workingVersion.version} <VerStatus s={x.workingVersion.status} /></Link></div>}</td>
                  <td><DocStatus s={x.status} /></td>
                  <td className="small">{x.next_review_date ? <span className={overdue ? 'badge danger' : ''}>{fmtDate(x.next_review_date)}{overdue && ' 期限切れ'}</span> : '—'}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <Empty>{view === 'published' ? '閲覧できる公開中のマニュアルはまだありません。' : '該当する文書はありません。'}</Empty>}</Loaded>
    </>
  );
}
