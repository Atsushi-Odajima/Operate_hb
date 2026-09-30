import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDate } from '../labels';
import { Empty, Icon, Loaded, PageHead, Progress, TrainingBadge, useLoad } from '../ui';

export default function MyTraining() {
  const st = useLoad(() => api.get('/api/training/mine'));
  const certs = useLoad(() => api.get('/api/certificates'));
  return (
    <>
      <PageHead title="研修" sub="割り当てられた研修を、決められた順番で受講します。" />
      <Loaded state={st}>{(rows: any[]) => rows.length ? (
        <div className="grid cols-2">{rows.map((t) => (
          <Link key={t.id} to={`/training/${t.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="row between"><h2 style={{ margin: 0 }}>{t.title}</h2>{t.overdue ? <span className="badge danger">期限超過</span> : <TrainingBadge s={t.status} />}</div>
            <p className="small muted" style={{ margin: '6px 0' }}>{t.description}</p>
            <div className="row small"><div style={{ flex: 1 }}><Progress value={(t.done_count / Math.max(1, t.module_count)) * 100} label="進捗" /></div><span>{t.done_count}/{t.module_count}</span></div>
            <div className="subtle" style={{ marginTop: 6 }}>{t.status === 'completed' ? `修了 ${fmtDate(t.completed_at)}` : t.due_date ? `期限 ${fmtDate(t.due_date)}` : '期限なし'} ・ v{t.version_no}</div>
          </Link>
        ))}</div>
      ) : <Empty>割り当てられた研修はありません</Empty>}</Loaded>
      <section className="card" style={{ marginTop: 14 }}>
        <h2>研修完了記録</h2>
        <p className="subtle">社内研修の完了記録です。公的な資格・認証を示すものではありません。</p>
        <Loaded state={certs}>{(cs: any[]) => cs.length ? <ul className="list">{cs.map((c) => <li key={c.id} className="row between"><span>{c.title}（v{c.version_no}）・ 修了 {fmtDate(c.completed_at)}{c.expires_at && ` ・ 有効期限 ${fmtDate(c.expires_at)}`}<span className="subtle"> 照合コード {c.verification_code}</span></span><a className="btn sm" href={`/api/certificates/${c.id}/pdf`}><Icon name="download" size={16} />PDF</a></li>)}</ul> : <Empty>まだありません</Empty>}</Loaded>
      </section>
    </>
  );
}
