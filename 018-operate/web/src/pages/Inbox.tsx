import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDateTime } from '../labels';
import { AiBadge, Empty, Loaded, PageHead, useLoad, VerStatus } from '../ui';

export default function Inbox() {
  const st = useLoad(() => api.get('/api/inbox'));
  return (
    <>
      <PageHead title="レビュー・承認" sub="あなたに依頼されているレビューと承認です。" />
      <Loaded state={st}>{(d: any) => (
        <div className="stack" style={{ gap: 14 }}>
          <section className="card"><h2>承認待ち（{d.approvals.length}）</h2>
            {d.approvals.length ? <ul className="list">{d.approvals.map((a: any) => <li key={a.version_id} className="row between"><span><Link className="title" to={`/documents/${a.document_id}/review/${a.version_id}`}>{a.title}</Link> <span className="subtle">v{a.version} ・ ステップ{a.step_no}</span> {a.ai_generated && <AiBadge />}</span><span className="subtle">{fmtDateTime(a.created_at)}</span></li>)}</ul> : <Empty>承認待ちはありません</Empty>}</section>
          <section className="card"><h2>レビュー依頼（{d.reviews.length}）</h2>
            {d.reviews.length ? <ul className="list">{d.reviews.map((a: any) => <li key={a.version_id} className="row between"><span><Link className="title" to={`/documents/${a.document_id}/review/${a.version_id}`}>{a.title}</Link> <span className="subtle">v{a.version} ・ 依頼 {a.requested_by}</span></span><span className="subtle">{fmtDateTime(a.created_at)}</span></li>)}</ul> : <Empty>レビュー依頼はありません</Empty>}</section>
          <section className="card"><h2>自分の下書き・修正依頼</h2>
            {d.drafts.length ? <ul className="list">{d.drafts.map((a: any) => <li key={a.version_id} className="row between"><span><Link className="title" to={`/documents/${a.document_id}/edit`}>{a.title}</Link> <span className="subtle">v{a.version}</span> <VerStatus s={a.status} /></span><span className="subtle">{fmtDateTime(a.updated_at)}</span></li>)}</ul> : <Empty>下書きはありません</Empty>}</section>
        </div>
      )}</Loaded>
    </>
  );
}
