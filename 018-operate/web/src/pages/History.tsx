import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadExport } from '../api';
import { useAuth } from '../auth';
import { DocContent } from '../DocRenderer';
import { fmtDateTime } from '../labels';
import { AiBadge, ChangeBadge, Loaded, Modal, PageHead, useAction, useLoad, VerStatus } from '../ui';
import { Diff } from './Review';

export default function History() {
  const { id } = useParams();
  const { me } = useAuth();
  const doc = useLoad(() => api.get(`/api/documents/${id}`), [id]);
  const st = useLoad(() => api.get(`/api/documents/${id}/versions`), [id]);
  const [view, setView] = useState<any>(null);
  const [diff, setDiff] = useState<any>(null);
  const { run } = useAction();
  return (
    <>
      <PageHead title={`版の履歴：${doc.data?.document.title ?? ''}`} sub="公開済みの版は書き換えられず、すべて履歴として残ります。通常の利用者には現在の公開版だけが表示されます。"><Link className="btn" to={`/documents/${id}`}>文書へ</Link></PageHead>
      <Loaded state={st}>{(rows: any[]) => (
        <div className="card pad-0 table-wrap">
          <table className="tbl">
            <thead><tr><th>版</th><th>状態</th><th>変更</th><th>作成者</th><th>承認</th><th>公開</th><th></th></tr></thead>
            <tbody>{rows.map((v) => (
              <tr key={v.id}>
                <td><strong>v{v.version}</strong> {v.ai_generated && <AiBadge />}</td>
                <td><VerStatus s={v.status} /></td>
                <td><ChangeBadge c={v.change_type} /><div className="small">{v.change_summary}</div></td>
                <td className="small">{v.author_name}</td>
                <td className="small">{(v.approvals ?? []).map((a: any, i: number) => <div key={i}>{a.approver}：{a.decision === 'approved' ? '承認' : a.decision === 'rejected' ? '却下' : '修正依頼'}（{fmtDateTime(a.at)}）</div>)}</td>
                <td className="small">{fmtDateTime(v.published_at)}{v.superseded_at && <div className="subtle">〜{fmtDateTime(v.superseded_at)}</div>}</td>
                <td><div className="row"><button className="btn sm" onClick={() => setView(v)}>表示</button><button className="btn sm" onClick={() => setDiff(v)}>差分</button>
                  {me?.policy.downloadAllowed.includes(doc.data?.document.classification) && ['published', 'superseded'].includes(v.status) && <button className="btn sm" onClick={() => void run(() => downloadExport('document-pdf', { documentId: id, versionId: v.id }))}>PDF</button>}</div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}</Loaded>
      {view && <VersionModal id={view.id} onClose={() => setView(null)} />}
      {diff && <Modal title={`v${diff.version} の変更点`} onClose={() => setDiff(null)} wide><Diff versionId={diff.id} /></Modal>}
    </>
  );
}

function VersionModal({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useLoad(() => api.get(`/api/versions/${id}`), [id]);
  return <Modal title="版の内容" onClose={onClose} wide><Loaded state={st}>{(v: any) => <><div className="alert warn" style={{ marginBottom: 10 }}>v{v.version}（<VerStatus s={v.status} />）を表示しています。{v.status !== 'published' && '現在の公開版ではありません。'}</div><h1>{v.title}</h1><DocContent content={v.content} /></>}</Loaded></Modal>;
}
