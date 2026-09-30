import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { DOC_TYPES, fmtDate, fmtDateTime } from '../labels';
import { AttestBadge, ChangeBadge, Empty, Icon, Loaded, PageHead, Progress, Stat, useLoad, VerStatus } from '../ui';

export default function Home() {
  const { me, can } = useAuth();
  const st = useLoad(() => api.get('/api/dashboard'));
  const hour = new Date().getHours();
  return (
    <>
      <PageHead title={`${hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'おつかれさまです'}、${me?.name.split(/[ （(]/)[0]} さん`} sub="今日も、いい仕事を。" >
        {can('doc.create') && <Link className="btn primary" to="/documents/new"><Icon name="plus" size={18} />マニュアルを作る</Link>}
      </PageHead>
      <Loaded state={st}>{(d) => (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid cols-4">
            <Stat label="確認が必要な文書" value={d.attestations.length} tone={d.attestations.some((a: any) => a.overdue) ? 'red' : d.attestations.length ? 'amber' : undefined} to="#attest" />
            {me?.isExternal ? null : <Stat label="受講中の研修" value={d.training.length} tone="blue" to="/training" />}
            {(d.reviewCount > 0 || can('doc.review')) && <Stat label="レビュー依頼" value={d.reviewCount} to="/inbox" />}
            {d.approvalCount !== undefined && <Stat label="承認待ち" value={d.approvalCount} tone={d.approvalCount ? 'amber' : undefined} to="/inbox" />}
            {d.knowledge && <Stat label="定期レビュー期限切れ" value={d.knowledge.review_overdue} tone={d.knowledge.review_overdue ? 'red' : undefined} to="/documents?reviewDue=overdue" />}
            {d.trainingStats && <Stat label="研修の期限超過" value={d.trainingStats.overdue} tone={d.trainingStats.overdue ? 'red' : undefined} to="/manage/training" />}
          </div>

          <div className="grid cols-2">
            <section className="card" id="attest" aria-labelledby="h-att">
              <h2 id="h-att">確認が必要なルール変更</h2>
              {d.attestations.length ? (
                <ul className="list">{d.attestations.map((a: any) => (
                  <li key={a.id}><Link to={`/documents/${a.document_id}`} className="title">{a.title}</Link> <span className="subtle">v{a.major}.{a.minor}</span>
                    <div className="row small" style={{ marginTop: 4 }}><ChangeBadge c={a.change_type} />{a.overdue ? <span className="badge danger">期限超過</span> : <AttestBadge s="pending" />}<span className="subtle">期限 {fmtDate(a.due_date)}</span></div></li>
                ))}</ul>
              ) : <Empty>確認が必要な文書はありません 🎉</Empty>}
            </section>
            {!me?.isExternal && (
              <section className="card" aria-labelledby="h-tr">
                <h2 id="h-tr">受講中の研修</h2>
                {d.training.length ? (
                  <ul className="list">{d.training.map((t: any) => (
                    <li key={t.id}><Link to={`/training/${t.id}`} className="title">{t.title}</Link>
                      <div className="row small" style={{ marginTop: 6 }}><div style={{ flex: 1 }}><Progress value={(t.done_count / Math.max(1, t.module_count)) * 100} label={`${t.title}の進捗`} /></div><span className="subtle">{t.done_count}/{t.module_count}</span>
                        {t.overdue ? <span className="badge danger">期限超過</span> : t.due_date && <span className="subtle">期限 {fmtDate(t.due_date)}</span>}</div></li>
                  ))}</ul>
                ) : <Empty>受講中の研修はありません</Empty>}
              </section>
            )}
          </div>

          {d.myWork && (
            <section className="card" aria-labelledby="h-work">
              <div className="row between"><h2 id="h-work">作業中の文書</h2><Link to="/documents?view=work" className="small">すべて見る</Link></div>
              {d.myWork.length ? <div className="table-wrap"><table className="tbl"><thead><tr><th>文書</th><th>版</th><th>状態</th><th>更新</th></tr></thead><tbody>
                {d.myWork.map((w: any) => <tr key={w.version_id}><td><Link to={`/documents/${w.document_id}/edit`}>{w.title}</Link></td><td>v{w.major}.{w.minor}</td><td><VerStatus s={w.status} /></td><td className="subtle">{fmtDateTime(w.updated_at)}</td></tr>)}
              </tbody></table></div> : <Empty>作業中の文書はありません</Empty>}
            </section>
          )}

          {d.knowledge && (
            <section className="card" aria-labelledby="h-kn">
              <div className="row between"><h2 id="h-kn">ナレッジの状態</h2><Link to="/health" className="small">詳しく見る</Link></div>
              <div className="grid cols-4">
                <div className="stat"><span className="label">期限切れ</span><span className="value red">{d.knowledge.review_overdue}</span></div>
                <div className="stat"><span className="label">まもなく期限</span><span className="value amber">{d.knowledge.review_soon}</span></div>
                <div className="stat"><span className="label">担当者不在</span><span className="value">{d.knowledge.no_owner}</span></div>
                <div className="stat"><span className="label">参照切れ</span><span className="value">{d.knowledge.broken_relations}</span></div>
              </div>
              {!!d.overdueDocs?.length && <ul className="list" style={{ marginTop: 8 }}>{d.overdueDocs.map((o: any) => <li key={o.id} className="row between"><Link to={`/documents/${o.id}`}>{o.doc_number} {o.title}</Link><span className="subtle">担当 {o.owner_name ?? '未設定'} ・ 期限 {fmtDate(o.next_review_date)}</span></li>)}</ul>}
            </section>
          )}

          <div className="grid cols-2">
            <section className="card" aria-labelledby="h-up">
              <h2 id="h-up">最近更新されたマニュアル</h2>
              {d.recentUpdates.length ? <ul className="list">{d.recentUpdates.map((u: any) => (
                <li key={u.id}><Link to={`/documents/${u.id}`} className="title">{u.doc_number && <span className="subtle">{u.doc_number} </span>}{u.title}</Link>
                  <div className="row small"><span className="chip">{DOC_TYPES[u.type]}</span><span className="subtle">v{u.major}.{u.minor} ・ {fmtDate(u.published_at)}</span>{u.change_type === 'major' && <ChangeBadge c="major" />}</div></li>
              ))}</ul> : <Empty>まだ公開されたマニュアルはありません</Empty>}
            </section>
            <section className="card" aria-labelledby="h-pop">
              <h2 id="h-pop">よく使われているマニュアル</h2>
              {d.popular.length ? <ul className="list">{d.popular.map((u: any) => <li key={u.id}><Link to={`/documents/${u.id}`}>{u.doc_number} {u.title}</Link> <span className="subtle">（{u.clicks}回）</span></li>)}</ul> : <Empty>データがまだありません</Empty>}
            </section>
          </div>
        </div>
      )}</Loaded>
    </>
  );
}
