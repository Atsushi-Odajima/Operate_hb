import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadExport } from '../api';
import { fmtDate, fmtDateTime } from '../labels';
import { AttestBadge, Badge, ChangeBadge, Empty, Icon, Loaded, Modal, PageHead, Progress, useAction, useLoad } from '../ui';

export default function Attestations() {
  const st = useLoad(() => api.get('/api/attestations/campaigns'));
  const [open, setOpen] = useState<string | null>(null);
  const { run } = useAction();
  return (
    <>
      <PageHead title="重要文書の確認状況" sub="ルール変更などで「読んで確認しました」を依頼した文書ごとの状況です。版ごとに記録され、前の版の確認は引き継がれません。">
        <button className="btn" onClick={() => void run(() => downloadExport('attestations', {}))}><Icon name="download" size={18} />CSV</button>
      </PageHead>
      <Loaded state={st}>{(rows: any[]) => rows.length ? (
        <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>文書</th><th>版</th><th>理由</th><th>期限</th><th>確認率</th><th>未確認</th><th></th></tr></thead><tbody>
          {rows.map((c) => { const rate = c.total ? ((c.acknowledged + c.waived) / c.total) * 100 : 0; return (
            <tr key={c.id}><td><Link to={`/documents/${c.document_id}`}>{c.title}</Link></td><td>v{c.major}.{c.minor} <ChangeBadge c={c.change_type} /></td><td className="small">{c.reason}</td><td className="small">{fmtDate(c.due_date)}</td>
              <td style={{ minWidth: 140 }}><Progress value={rate} label="確認率" /><span className="subtle">{c.acknowledged}/{c.total}（{Math.round(rate)}%）</span></td>
              <td>{c.overdue ? <Badge tone="danger">期限超過 {c.overdue}</Badge> : c.pending ? <Badge tone="warn">{c.pending}</Badge> : <Badge tone="ok">0</Badge>}</td>
              <td><button className="btn sm" onClick={() => setOpen(c.id)}>詳細</button></td></tr>); })}
        </tbody></table></div>
      ) : <Empty>確認依頼はまだありません。文書の「管理」から配布できます。</Empty>}</Loaded>
      {open && <CampaignModal id={open} onClose={() => { setOpen(null); st.reload(); }} />}
    </>
  );
}

function CampaignModal({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useLoad(() => api.get(`/api/attestations/campaigns/${id}`), [id]);
  const [waive, setWaive] = useState<any>(null);
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title="確認状況の詳細" onClose={onClose} wide>
      <Loaded state={st}>{(d: any) => (
        <>
          <p><strong>{d.campaign.title}</strong> v{d.campaign.major}.{d.campaign.minor} ・ 期限 {fmtDate(d.campaign.due_date)}</p>
          <div className="table-wrap"><table className="tbl"><thead><tr><th>対象者</th><th>部署</th><th>状態</th><th>閲覧</th><th>最後まで表示</th><th>確認</th><th></th></tr></thead><tbody>
            {d.users.map((u: any) => <tr key={u.id}><td>{u.name}</td><td className="small">{u.departments}</td><td>{u.overdue ? <Badge tone="danger">期限超過</Badge> : <AttestBadge s={u.status} />}{u.waived_reason && <div className="subtle">{u.waived_reason}</div>}</td>
              <td className="small">{fmtDateTime(u.viewed_at)}</td><td className="small">{fmtDateTime(u.reached_end_at)}</td><td className="small">{fmtDateTime(u.acknowledged_at)}</td>
              <td>{d.canWaive && u.status === 'pending' && <button className="btn sm" onClick={() => setWaive(u)}>免除</button>}</td></tr>)}
          </tbody></table></div>
          <p className="subtle">「確認」は本人が内容を読んだと記録したものです。理解の度合いを保証するものではありません。</p>
          {waive && <div className="card" style={{ marginTop: 10 }}><strong>{waive.name} さんを免除</strong>
            <div className="field"><label htmlFor="wv">理由（必須）</label><input id="wv" type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <div className="row"><button className="btn" onClick={() => setWaive(null)}>キャンセル</button><button className="btn primary" disabled={busy || !reason.trim()} onClick={() => void run(async () => { await api.post(`/api/attestations/${waive.id}/waive`, { reason }); setWaive(null); setReason(''); st.reload(); }, '免除しました')}>免除する</button></div></div>}
        </>
      )}</Loaded>
    </Modal>
  );
}
