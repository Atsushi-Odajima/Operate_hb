import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, downloadExport, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime, TRAINING } from '../labels';
import { Badge, Empty, Icon, Loaded, Modal, PageHead, Tabs, TrainingBadge, useAction, useLoad } from '../ui';
import { useDirectory, UserSelect } from './common';

type Tab = 'courses' | 'quizzes' | 'onboarding' | 'report' | 'skills' | 'grading';

export default function TrainingAdmin() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const manage = can('training.manage');
  const tab = (sp.get('tab') as Tab) ?? (manage ? 'courses' : 'report');
  const tabs: Array<[Tab, string]> = manage
    ? [['courses', 'コース'], ['quizzes', 'テスト'], ['onboarding', '新人オンボーディング'], ['report', '受講状況'], ['skills', 'スキルマップ'], ['grading', '記述採点']]
    : [['report', '受講状況'], ['skills', 'スキルマップ']];
  return (
    <>
      <PageHead title="研修管理" sub="マニュアルをもとに研修・テストを作り、部署や役割ごとに割り当てます。" />
      <Tabs tabs={tabs} value={tab} onChange={(t) => setSp({ tab: t })} />
      {tab === 'courses' && <Courses />}
      {tab === 'quizzes' && <Quizzes />}
      {tab === 'onboarding' && <Onboarding />}
      {tab === 'report' && <Report />}
      {tab === 'skills' && <Skills />}
      {tab === 'grading' && <Grading />}
    </>
  );
}

function Courses() {
  const st = useLoad(() => api.get('/api/courses'));
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const { busy, run } = useAction();
  return (
    <>
      <div className="card row">
        <input type="text" aria-label="新しいコース名" placeholder="新しいコース名（例：CS新人研修）" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !title.trim()} onClick={() => void run(async () => { const c = await api.post('/api/courses', { title }); nav(`/manage/courses/${c.id}`); })}><Icon name="plus" size={18} />作成</button>
      </div>
      <Loaded state={st}>{(rows: any[]) => rows.length ? (
        <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>コース</th><th>状態</th><th>版</th><th>モジュール</th><th>修了/割当</th><th>更新</th></tr></thead><tbody>
          {rows.map((c) => <tr key={c.id}><td><Link to={`/manage/courses/${c.id}`}>{c.title}</Link>{c.has_draft && <span className="chip" style={{ marginLeft: 6 }}>下書きあり</span>}</td><td>{c.status === 'published' ? <Badge tone="ok">公開中</Badge> : <Badge>下書き</Badge>}</td><td>{c.version_no ? `v${c.version_no}` : '—'}</td><td>{c.module_count}</td><td>{c.completed}/{c.assigned}</td><td className="small">{fmtDate(c.updated_at)}</td></tr>)}
        </tbody></table></div>
      ) : <Empty>コースはまだありません</Empty>}</Loaded>
    </>
  );
}

function Quizzes() {
  const st = useLoad(() => api.get('/api/quizzes'));
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const { busy, run } = useAction();
  return (
    <>
      <div className="card row">
        <input type="text" aria-label="新しいテスト名" placeholder="新しいテスト名（例：返金対応 理解度テスト）" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !title.trim()} onClick={() => void run(async () => { const q = await api.post('/api/quizzes', { title }); nav(`/manage/quizzes/${q.id}`); })}><Icon name="plus" size={18} />作成</button>
      </div>
      <Loaded state={st}>{(rows: any[]) => rows.length ? (
        <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>テスト</th><th>状態</th><th>版</th><th>問題数</th><th>更新</th></tr></thead><tbody>
          {rows.map((q) => <tr key={q.id}><td><Link to={`/manage/quizzes/${q.id}`}>{q.title}</Link>{q.has_draft && <span className="chip" style={{ marginLeft: 6 }}>下書きあり</span>}</td><td>{q.status === 'published' ? <Badge tone="ok">公開中</Badge> : <Badge>下書き</Badge>}</td><td>{q.version_no ? `v${q.version_no}` : '—'}</td><td>{q.question_count ?? 0}</td><td className="small">{fmtDate(q.updated_at)}</td></tr>)}
        </tbody></table></div>
      ) : <Empty>テストはまだありません</Empty>}</Loaded>
    </>
  );
}

function Onboarding() {
  const tpls = useLoad(() => api.get('/api/onboarding/templates'));
  const runs = useLoad(() => api.get('/api/onboarding/runs'));
  const courses = useLoad(() => api.get('/api/courses'));
  const { users, deps } = useDirectory();
  const [edit, setEdit] = useState<any>(null);
  const [start, setStart] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <>
      <div className="card">
        <div className="row between"><h2>テンプレート</h2><button className="btn primary sm" onClick={() => setEdit({ name: '', role: 'member', departmentId: '', items: [] })}><Icon name="plus" size={16} />テンプレートを作成</button></div>
        <p className="subtle">「入社日から何日後までに、どの研修を終えるか」をまとめたものです。テンプレートを変更しても、開始済みの新人の割り当ては変わりません。</p>
        <Loaded state={tpls}>{(rows: any[]) => rows.length ? <ul className="list">{rows.map((t) => <li key={t.id} className="row between"><span><strong>{t.name}</strong> <span className="subtle">{t.items.map((i: any) => `${i.label}(+${i.offsetDays}日)`).join(' → ')} ・ 開始 {t.runs}名</span></span>
          <span className="row"><button className="btn sm" onClick={() => setEdit(t)}>編集</button><button className="btn sm primary" onClick={() => setStart(t)}>新人に適用</button></span></li>)}</ul> : <Empty>テンプレートはありません</Empty>}</Loaded>
      </div>
      <div className="card"><h2>進行中のオンボーディング</h2>
        <Loaded state={runs}>{(rows: any[]) => rows.length ? <table className="tbl"><thead><tr><th>新人</th><th>テンプレート</th><th>開始日</th><th>修了/全体</th><th>期限超過</th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.id}><td>{r.user_name}</td><td>{r.template_name}</td><td>{fmtDate(r.start_date)}</td><td>{r.completed}/{r.total}</td><td>{r.overdue ? <Badge tone="danger">{r.overdue}件</Badge> : '—'}</td></tr>)}
        </tbody></table> : <Empty>まだありません</Empty>}</Loaded></div>
      {edit && <Modal title="オンボーディングテンプレート" onClose={() => setEdit(null)} wide>
        <div className="grid cols-2">
          <div className="field"><label htmlFor="on">名前</label><input id="on" type="text" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="od">対象部署（任意）</label><select id="od" value={edit.departmentId ?? edit.department_id ?? ''} onChange={(e) => setEdit({ ...edit, departmentId: e.target.value })}><option value="">指定なし</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        </div>
        <Loaded state={courses}>{(cs: any[]) => (
          <div className="stack">
            {edit.items.map((it: any, i: number) => <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
              <input type="text" aria-label="ラベル" value={it.label} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} style={{ width: 110 }} />
              <select aria-label="コース" value={it.courseId} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x: any, j: number) => (j === i ? { ...x, courseId: e.target.value } : x)) })}>{cs.filter((c) => c.status === 'published').map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
              <label className="small" style={{ whiteSpace: 'nowrap', margin: 0 }}>入社日から<input type="number" min={0} max={365} value={it.offsetDays} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x: any, j: number) => (j === i ? { ...x, offsetDays: Number(e.target.value) } : x)) })} style={{ width: 80, display: 'inline-block', margin: '0 4px' }} />日後まで</label>
              <button className="btn sm danger" onClick={() => setEdit({ ...edit, items: edit.items.filter((_: any, j: number) => j !== i) })}>削除</button></div>)}
            <div className="row"><button className="btn sm" onClick={() => setEdit({ ...edit, items: [...edit.items, { label: 'Day1', courseId: cs.find((c) => c.status === 'published')?.id ?? '', offsetDays: 1 }] })}>Day1</button>
              <button className="btn sm" onClick={() => setEdit({ ...edit, items: [...edit.items, { label: 'Week1', courseId: cs.find((c) => c.status === 'published')?.id ?? '', offsetDays: 7 }] })}>Week1</button>
              <button className="btn sm" onClick={() => setEdit({ ...edit, items: [...edit.items, { label: 'Month1', courseId: cs.find((c) => c.status === 'published')?.id ?? '', offsetDays: 30 }] })}>Month1</button></div>
          </div>
        )}</Loaded>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button className="btn" onClick={() => setEdit(null)}>キャンセル</button>
          <button className="btn primary" disabled={busy || !edit.name.trim()} onClick={() => void run(async () => {
            const body = { name: edit.name, role: edit.role ?? null, departmentId: (edit.departmentId ?? edit.department_id) || null, items: edit.items };
            if (edit.id) await api.put(`/api/onboarding/templates/${edit.id}`, body); else await api.post('/api/onboarding/templates', body);
            setEdit(null); tpls.reload();
          }, '保存しました')}>保存</button></div>
      </Modal>}
      {start && <Modal title={`「${start.name}」を新人に適用`} onClose={() => setStart(null)}>
        <StartOnboarding tpl={start} users={users} onDone={() => { setStart(null); runs.reload(); tpls.reload(); }} />
      </Modal>}
    </>
  );
}

function StartOnboarding({ tpl, users, onDone }: { tpl: any; users: any[]; onDone: () => void }) {
  const [user, setUser] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const { busy, run } = useAction();
  return (
    <>
      <div className="field"><label htmlFor="su">新人</label><select id="su" value={user} onChange={(e) => setUser(e.target.value)}><option value="">選択</option>{users.filter((u) => !u.is_external).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      <div className="field"><label htmlFor="sd">入社日（起算日）</label><input id="sd" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <ul className="small">{tpl.items.map((i: any, k: number) => <li key={k}>{i.label}：期限 {fmtDate(new Date(new Date(date + 'T00:00:00Z').getTime() + i.offsetDays * 86400000).toISOString().slice(0, 10))}</li>)}</ul>
      <button className="btn primary" disabled={busy || !user} onClick={() => void run(async () => { await api.post('/api/onboarding/runs', { templateId: tpl.id, userId: user, startDate: date }); onDone(); }, '研修を割り当てました')}>開始する</button>
    </>
  );
}

function Report() {
  const courses = useLoad(() => api.get('/api/courses'));
  const { deps } = useDirectory();
  const { can } = useAuth();
  const [f, setF] = useState({ courseId: '', departmentId: '', status: '' });
  const st = useLoad(() => api.get(`/api/training/report${qs(f)}`), [f.courseId, f.departmentId, f.status]);
  const [waive, setWaive] = useState<any>(null);
  const { run } = useAction();
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <Loaded state={courses}>{(cs: any[]) => <select aria-label="コース" value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })} style={{ width: 'auto' }}><option value="">すべてのコース</option>{cs.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>}</Loaded>
        <select aria-label="部署" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })} style={{ width: 'auto' }}><option value="">すべての部署</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select aria-label="状態" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={{ width: 'auto' }}><option value="">すべての状態</option>{['not_started', 'in_progress', 'completed', 'overdue', 'waived'].map((k) => <option key={k} value={k}>{TRAINING[k].label}</option>)}</select>
        <button className="btn" onClick={() => void run(() => downloadExport('training', { courseId: f.courseId || null }))}><Icon name="download" size={18} />CSV</button>
      </div>
      <Loaded state={st}>{(rows: any[]) => rows.length ? (
        <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>受講者</th><th>部署</th><th>コース</th><th>状態</th><th>期限</th><th>修了</th><th></th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.id}><td><Link to={`/training/${r.id}`}>{r.user_name}</Link></td><td className="small">{r.departments}</td><td>{r.title} <span className="subtle">v{r.version_no}</span></td><td>{r.overdue ? <Badge tone="danger">期限超過</Badge> : <TrainingBadge s={r.status} />}{r.waived_reason && <div className="subtle">{r.waived_reason}</div>}</td><td className="small">{fmtDate(r.due_date)}</td><td className="small">{fmtDate(r.completed_at)}</td>
            <td>{can('training.manage') && ['not_started', 'in_progress'].includes(r.status) && <button className="btn sm" onClick={() => setWaive(r)}>免除</button>}</td></tr>)}
        </tbody></table></div>
      ) : <Empty>該当する受講記録はありません</Empty>}</Loaded>
      {waive && <WaiveModal row={waive} onClose={() => setWaive(null)} onDone={() => { setWaive(null); st.reload(); }} />}
    </>
  );
}

function WaiveModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title={`${row.user_name} さんの「${row.title}」を免除`} onClose={onClose}>
      <p className="muted">免除は理由・操作者とともに記録され、監査資料に出力されます。</p>
      <div className="field"><label htmlFor="wr">理由（必須）</label><input id="wr" type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button><button className="btn primary" disabled={busy || !reason.trim()} onClick={() => void run(async () => { await api.post(`/api/assignments/${row.id}/waive`, { reason }); onDone(); }, '免除しました')}>免除する</button></div>
    </Modal>
  );
}

function Skills() {
  const { deps } = useDirectory();
  const [dept, setDept] = useState('');
  const st = useLoad(() => api.get(`/api/training/skills${qs({ departmentId: dept })}`), [dept]);
  const tone: Record<string, any> = { completed: 'ok', in_progress: 'info', overdue: 'danger', expired: 'warn', waived: 'neutral' };
  return (
    <>
      <p className="subtle">研修・手順の習得状況を一覧にしたものです。人事評価には使用しません。</p>
      <select aria-label="部署" value={dept} onChange={(e) => setDept(e.target.value)} style={{ width: 'auto', marginBottom: 10 }}><option value="">すべての部署</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <Loaded state={st}>{(d: any) => (
        <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>メンバー</th>{d.courses.map((c: any) => <th key={c.id}>{c.title}</th>)}</tr></thead><tbody>
          {d.users.map((u: any) => <tr key={u.id}><td>{u.name}</td>{d.courses.map((c: any) => { const s = d.matrix[u.id]?.[c.id] ?? 'not_assigned'; return <td key={c.id}>{s === 'not_assigned' ? <span className="subtle">—</span> : <Badge tone={tone[s]}>{TRAINING[s].label}</Badge>}</td>; })}</tr>)}
        </tbody></table></div>
      )}</Loaded>
    </>
  );
}

function Grading() {
  const st = useLoad(() => api.get('/api/attempts?status=pending_review'));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Loaded state={st}>{(rows: any[]) => rows.length ? (
      <>
        <ul className="list card">{rows.map((r) => <li key={r.id} className="row between"><span>{r.title} ・ {r.user_name} <span className="subtle">{fmtDateTime(r.submitted_at)}</span></span><button className="btn sm" onClick={() => setOpen(r.id)}>採点する</button></li>)}</ul>
        {open && <GradeModal attemptId={open} onClose={() => { setOpen(null); st.reload(); }} />}
      </>
    ) : <Empty>採点待ちの記述回答はありません</Empty>}</Loaded>
  );
}

function GradeModal({ attemptId, onClose }: { attemptId: string; onClose: () => void }) {
  const st = useLoad(() => api.get(`/api/attempts/${attemptId}`), [attemptId]);
  const [g, setG] = useState<Record<string, boolean>>({});
  const { busy, run } = useAction();
  return (
    <Modal title="記述回答の採点" onClose={onClose} wide>
      <Loaded state={st}>{(a: any) => {
        const pending = a.questions.filter((q: any) => q.type === 'short' && (a.review ?? []).find((r: any) => r.id === q.id)?.correct === null);
        return (
          <>
            {pending.map((q: any) => <div key={q.id} className="card"><strong>{q.prompt}</strong><p>回答：{a.answers?.[q.id] || '（無回答）'}</p>
              <div className="row"><label className="check"><input type="radio" name={q.id} checked={g[q.id] === true} onChange={() => setG({ ...g, [q.id]: true })} />正解</label><label className="check"><input type="radio" name={q.id} checked={g[q.id] === false} onChange={() => setG({ ...g, [q.id]: false })} />不正解</label></div></div>)}
            <button className="btn primary" disabled={busy || pending.some((q: any) => g[q.id] === undefined)} onClick={() => void run(async () => { await api.post(`/api/attempts/${attemptId}/grade`, { grades: g }); onClose(); }, '採点しました')}>採点を確定</button>
          </>
        );
      }}</Loaded>
    </Modal>
  );
}

export function AssignModal({ courseId, onClose }: { courseId: string; onClose: () => void }) {
  const { deps, users } = useDirectory();
  const [f, setF] = useState<{ userIds: string[]; departmentIds: string[]; teamIds: string[]; roles: string[]; dueDate: string }>({ userIds: [], departmentIds: [], teamIds: [], roles: [], dueDate: '' });
  const { busy, run } = useAction();
  const toggle = (k: 'departmentIds' | 'teamIds' | 'roles', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  return (
    <Modal title="研修を割り当てる" onClose={onClose} wide>
      <div className="field"><label>部署・チーム</label><div className="chips">{deps.map((d) => <span key={d.id} className="row" style={{ gap: 4 }}><label className="check chip"><input type="checkbox" checked={f.departmentIds.includes(d.id)} onChange={() => toggle('departmentIds', d.id)} />{d.name}</label>{d.teams.map((t) => <label key={t.id} className="check chip"><input type="checkbox" checked={f.teamIds.includes(t.id)} onChange={() => toggle('teamIds', t.id)} />{d.name}/{t.name}</label>)}</span>)}</div></div>
      <div className="field"><label>役割</label><div className="chips">{['member', 'editor', 'approver', 'trainer'].map((r) => <label key={r} className="check chip"><input type="checkbox" checked={f.roles.includes(r)} onChange={() => toggle('roles', r)} />{({ member: 'メンバー', editor: '編集者', approver: '承認者', trainer: '研修担当' } as any)[r]}</label>)}</div></div>
      <div className="field"><label>個人</label><UserSelect id="au" label="個人" users={users} value={f.userIds} onChange={(v) => setF({ ...f, userIds: v })} /></div>
      <div className="field"><label htmlFor="dd">期限（空欄ならコースの標準日数）</label><input id="dd" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button>
        <button className="btn primary" disabled={busy || !(f.userIds.length || f.departmentIds.length || f.teamIds.length || f.roles.length)} onClick={() => void run(async () => {
          const r = await api.post(`/api/courses/${courseId}/assign`, { ...f, dueDate: f.dueDate || null });
          onClose();
          return r;
        }, '割り当てました（既に割り当て済みの人は除外）')}>割り当てる</button></div>
    </Modal>
  );
}
