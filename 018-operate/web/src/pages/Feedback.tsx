import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { FB_STATUS, FEEDBACK, fmtDateTime } from '../labels';
import { Badge, Empty, Icon, Loaded, Modal, PageHead, Tabs, useAction, useLoad } from '../ui';
import { useDirectory } from './common';

export default function Feedback() {
  const loc = useLocation();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const tab = loc.pathname === '/improvements' ? 'improvements' : 'feedback';
  const [status, setStatus] = useState('open');
  const fb = useLoad(() => api.get(`/api/feedback${qs({ status, documentId: sp.get('documentId') })}`), [status, sp.get('documentId')]);
  const imp = useLoad(() => api.get('/api/improvements'), [tab]);
  const { users } = useDirectory();
  const [handle, setHandle] = useState<any>(null);
  const [newT, setNewT] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <>
      <PageHead title="フィードバック・改善" sub="現場から届いた「古い」「分かりにくい」などの声と、トラブルから生まれた改善チケットです。フィードバックで本文が直接変わることはありません。">
        {tab === 'improvements' && <button className="btn primary" onClick={() => setNewT({ title: '', summary: '', priority: 'normal', ownerId: '', documentId: null })}><Icon name="plus" size={18} />改善チケット</button>}
      </PageHead>
      <Tabs tabs={[['feedback', 'フィードバック'], ['improvements', '改善チケット']]} value={tab} onChange={(t) => nav(t === 'feedback' ? '/feedback' : '/improvements')} />
      {tab === 'feedback' ? (
        <>
          <select aria-label="状態" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto', marginBottom: 10 }}><option value="">すべて</option>{Object.entries(FB_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          <Loaded state={fb}>{(rows: any[]) => rows.length ? <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>文書</th><th>種類</th><th>内容</th><th>送信者</th><th>状態</th><th></th></tr></thead><tbody>
            {rows.map((f) => <tr key={f.id}><td><Link to={`/documents/${f.document_id}`}>{f.title}</Link> <span className="subtle">v{f.major}.{f.minor}</span></td><td><span className="chip">{FEEDBACK[f.kind]}</span></td><td className="small" style={{ maxWidth: 360 }}>{f.body}</td><td className="small">{f.user_name}<div className="subtle">{fmtDateTime(f.created_at)}</div></td>
              <td><Badge tone={FB_STATUS[f.status].tone}>{FB_STATUS[f.status].label}</Badge>{f.resolution && <div className="subtle">{f.resolution}</div>}</td><td>{f.kind !== 'helpful' && <button className="btn sm" onClick={() => setHandle(f)}>対応</button>}</td></tr>)}
          </tbody></table></div> : <Empty>該当するフィードバックはありません</Empty>}</Loaded>
        </>
      ) : (
        <Loaded state={imp}>{(rows: any[]) => rows.length ? <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>件名</th><th>対象文書</th><th>優先度</th><th>担当</th><th>状態</th></tr></thead><tbody>
          {rows.map((t) => <tr key={t.id}><td><strong>{t.title}</strong><div className="small muted">{t.summary}</div></td><td className="small">{t.document_id ? <Link to={`/documents/${t.document_id}`}>{t.document_title}</Link> : '—'}</td>
            <td><Badge tone={t.priority === 'high' ? 'danger' : t.priority === 'normal' ? 'info' : 'neutral'}>{({ high: '高', normal: '中', low: '低' } as any)[t.priority]}</Badge></td><td className="small">{t.owner_name ?? '—'}</td>
            <td><select aria-label="状態" value={t.status} onChange={(e) => void run(async () => { await api.patch(`/api/improvements/${t.id}`, { status: e.target.value }); imp.reload(); })} style={{ width: 'auto' }}>{Object.entries({ open: '未着手', in_progress: '対応中', done: '完了', dismissed: '見送り' }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td></tr>)}
        </tbody></table></div> : <Empty>改善チケットはありません</Empty>}</Loaded>
      )}
      {handle && <HandleModal f={handle} onClose={() => setHandle(null)} onDone={() => { setHandle(null); fb.reload(); }} />}
      {newT && <Modal title="改善チケットを作成" onClose={() => setNewT(null)}>
        <div className="field"><label htmlFor="it">件名</label><input id="it" type="text" value={newT.title} onChange={(e) => setNewT({ ...newT, title: e.target.value })} placeholder="例：チャット問い合わせの本人確認手順を追加" /></div>
        <div className="field"><label htmlFor="is">内容（何が起きたか・何を直すか）</label><textarea id="is" value={newT.summary} onChange={(e) => setNewT({ ...newT, summary: e.target.value })} /></div>
        <div className="grid cols-2"><div className="field"><label htmlFor="ip">優先度</label><select id="ip" value={newT.priority} onChange={(e) => setNewT({ ...newT, priority: e.target.value })}><option value="high">高</option><option value="normal">中</option><option value="low">低</option></select></div>
          <div className="field"><label htmlFor="io">担当</label><select id="io" value={newT.ownerId} onChange={(e) => setNewT({ ...newT, ownerId: e.target.value })}><option value="">未定</option>{users.filter((u) => !u.is_external).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div></div>
        <button className="btn primary" disabled={busy || !newT.title.trim()} onClick={() => void run(async () => { await api.post('/api/improvements', { ...newT, ownerId: newT.ownerId || null }); setNewT(null); imp.reload(); }, '作成しました')}>作成</button>
      </Modal>}
    </>
  );
}

function HandleModal({ f, onClose, onDone }: { f: any; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState(f.status === 'open' ? 'reviewing' : f.status);
  const [resolution, setResolution] = useState(f.resolution ?? '');
  const { busy, run } = useAction();
  return (
    <Modal title="フィードバックへの対応" onClose={onClose}>
      <p className="muted">「{f.body}」</p>
      <div className="field"><label htmlFor="hs">状態</label><select id="hs" value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(FB_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
      <div className="field"><label htmlFor="hr">対応内容・理由{status === 'dismissed' && '（必須）'}</label><textarea id="hr" value={resolution} onChange={(e) => setResolution(e.target.value)} /></div>
      <div className="row" style={{ justifyContent: 'space-between' }}><Link className="btn ghost" to={`/documents/${f.document_id}`}>文書を開いて改訂する</Link>
        <button className="btn primary" disabled={busy || (status === 'dismissed' && !resolution.trim())} onClick={() => void run(async () => { await api.patch(`/api/feedback/${f.id}`, { status, resolution }); onDone(); }, '更新しました')}>保存</button></div>
    </Modal>
  );
}
