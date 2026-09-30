import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDateTime } from '../labels';
import { Empty, Loaded, PageHead, useAction, useLoad } from '../ui';

export default function Notifications() {
  const st = useLoad(() => api.get('/api/notifications'));
  const { run } = useAction();
  return (
    <>
      <PageHead title="通知"><button className="btn" onClick={() => void run(async () => { await api.post('/api/notifications/read', { all: true }); st.reload(); })}>すべて既読にする</button></PageHead>
      <Loaded state={st}>{(rows: any[]) => rows.length ? (
        <ul className="list card">{rows.map((n) => (
          <li key={n.id} style={{ fontWeight: n.read_at ? 400 : 700 }} className="row between">
            <Link to={n.link || '/'} onClick={() => void api.post('/api/notifications/read', { ids: [n.id] }).catch(() => undefined)}>{!n.read_at && <span className="sr-only">未読：</span>}{n.title}</Link>
            <span className="subtle">{fmtDateTime(n.created_at)}</span>
          </li>
        ))}</ul>
      ) : <Empty>通知はありません</Empty>}</Loaded>
    </>
  );
}
