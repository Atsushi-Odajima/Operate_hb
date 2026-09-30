import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, getCsrf } from '../api';
import { useAuth } from '../auth';
import type { Content } from '../DocRenderer';
import { ChecklistEditor, RichEditor, StepsEditor } from '../Editor';
import { CLASS, DOC_TYPES, fmtDate, fmtDateTime, ROLES } from '../labels';
import { Badge, Empty, Icon, Loaded, Modal, PageHead, Tabs, useAction, useLoad } from '../ui';

type Tab = 'users' | 'depts' | 'externals' | 'settings' | 'ai' | 'templates' | 'backup';

export default function Admin() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tabs: Array<[Tab, string]> = [];
  if (can('user.manage')) tabs.push(['users', 'ユーザー']);
  if (can('dept.manage')) tabs.push(['depts', '部署・チーム']);
  if (can('external.manage')) tabs.push(['externals', '外部メンバー']);
  if (can('template.manage')) tabs.push(['templates', 'テンプレート']);
  if (can('org.settings')) tabs.push(['settings', '運用ルール'], ['ai', 'AI設定']);
  if (can('backup')) tabs.push(['backup', 'バックアップ']);
  const tab = (sp.get('tab') as Tab) ?? tabs[0]?.[0];
  return (
    <>
      <PageHead title="組織・ユーザー設定" />
      <Tabs tabs={tabs} value={tab} onChange={(t) => setSp({ tab: t })} />
      {tab === 'users' && <Users />}
      {tab === 'depts' && <Depts />}
      {tab === 'externals' && <Externals />}
      {tab === 'templates' && <Templates />}
      {tab === 'settings' && <Settings />}
      {tab === 'ai' && <AiSettings />}
      {tab === 'backup' && <Backup />}
    </>
  );
}

function Users() {
  const st = useLoad(() => api.get('/api/admin/users?external=false'));
  const deps = useLoad(() => api.get('/api/departments'));
  const [edit, setEdit] = useState<any>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const { busy, run } = useAction();
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" aria-label="名前・メールで絞り込み" placeholder="名前・メールで絞り込み" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} />
        <button className="btn primary" onClick={() => setEdit({ name: '', email: '', roles: ['member'], memberships: [], approverScopes: [], hireDate: '' })}><Icon name="plus" size={18} />ユーザーを追加</button>
      </div>
      <Loaded state={st}>{(rows: any[]) => (
        <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>名前</th><th>役割</th><th>所属</th><th>状態</th><th></th></tr></thead><tbody>
          {rows.filter((u) => !q || u.name.includes(q) || u.email.includes(q)).map((u) => (
            <tr key={u.id}><td><strong>{u.name}</strong><div className="subtle">{u.email}</div></td><td className="small">{u.roles.map((r: string) => ROLES[r]).join('、')}</td>
              <td className="small">{u.memberships.map((m: any) => deps.data?.find((d: any) => d.id === m.departmentId)?.name).filter(Boolean).join('、')}</td>
              <td>{u.status === 'active' ? <Badge tone="ok">有効</Badge> : <Badge>無効</Badge>}{u.anonymized_at && <Badge>匿名化済み</Badge>}{u.locked_until && new Date(u.locked_until) > new Date() && <Badge tone="warn">ロック中</Badge>}</td>
              <td><div className="row">
                {!u.anonymized_at && <button className="btn sm" onClick={() => setEdit({ ...u, hireDate: u.hire_date ?? '', approverScopes: u.approver_scopes })}>編集</button>}
                {u.status === 'active' ? <button className="btn sm" onClick={() => void run(async () => { const r = await api.post(`/api/admin/users/${u.id}/reset-password`); setSecret(r.temporaryPassword); })}>PW再発行</button> : null}
                {u.status === 'active' ? <button className="btn sm danger" onClick={() => { if (confirm(`${u.name} さんを無効化しますか？（ログインできなくなり、未完了の研修・確認依頼は取り消されます。履歴は残ります）`)) void run(async () => { await api.post(`/api/admin/users/${u.id}/status`, { status: 'disabled' }); st.reload(); }, '無効化しました'); }}>無効化</button>
                  : !u.anonymized_at && <><button className="btn sm" onClick={() => void run(async () => { await api.post(`/api/admin/users/${u.id}/status`, { status: 'active' }); st.reload(); })}>有効化</button>
                    <button className="btn sm danger" onClick={() => { if (confirm('表示名とメールアドレスを匿名化します。元に戻せません。')) void run(async () => { await api.post(`/api/admin/users/${u.id}/anonymize`); st.reload(); }, '匿名化しました'); }}>匿名化</button></>}
              </div></td></tr>
          ))}
        </tbody></table></div>
      )}</Loaded>
      {edit && <UserModal u={edit} deps={deps.data ?? []} onClose={() => setEdit(null)} onDone={(pw) => { setEdit(null); st.reload(); if (pw) setSecret(pw); }} />}
      {secret && <Modal title="仮パスワード" onClose={() => setSecret(null)}><p>次の仮パスワードを本人に安全な方法で伝えてください。この画面を閉じると再表示できません。</p><p style={{ fontFamily: 'monospace', fontSize: '1.3rem', background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}>{secret}</p><p className="subtle">本人はログイン後「アカウント」から変更できます。</p></Modal>}
    </>
  );
}

function UserModal({ u, deps, onClose, onDone }: { u: any; deps: any[]; onClose: () => void; onDone: (pw?: string) => void }) {
  const [f, setF] = useState(u);
  const { busy, run } = useAction();
  const toggleRole = (r: string) => setF({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r] });
  const hasM = (d: string, t: string | null) => f.memberships.some((m: any) => m.departmentId === d && (m.teamId ?? null) === t);
  const toggleM = (d: string, t: string | null) => setF({ ...f, memberships: hasM(d, t) ? f.memberships.filter((m: any) => !(m.departmentId === d && (m.teamId ?? null) === t)) : [...f.memberships, { departmentId: d, teamId: t }] });
  return (
    <Modal title={u.id ? 'ユーザーを編集' : 'ユーザーを追加'} onClose={onClose} wide>
      <div className="grid cols-2">
        <div className="field"><label htmlFor="un">名前</label><input id="un" type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="ue">メールアドレス</label><input id="ue" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      </div>
      <div className="field"><label>役割（複数可）</label><div className="chips">{Object.entries(ROLES).filter(([k]) => k !== 'external').map(([k, v]) => <label key={k} className="check chip"><input type="checkbox" checked={f.roles.includes(k)} onChange={() => toggleRole(k)} />{v}</label>)}</div>
        <div className="hint">オーナー＝全体設定・ユーザー・監査／ナレッジ管理者＝文書の構成・公開・改訂／承認者＝担当範囲の承認／編集者＝下書き作成／研修担当＝コース・テスト／メンバー＝閲覧・受講／監査担当＝読み取り専用の監査</div></div>
      <div className="field"><label>所属（複数可）</label><div className="chips">{deps.map((d) => <span key={d.id} className="row" style={{ gap: 4 }}><label className="check chip"><input type="checkbox" checked={hasM(d.id, null)} onChange={() => toggleM(d.id, null)} />{d.name}</label>{d.teams.map((t: any) => <label key={t.id} className="check chip"><input type="checkbox" checked={hasM(d.id, t.id)} onChange={() => toggleM(d.id, t.id)} />{d.name}/{t.name}</label>)}</span>)}</div></div>
      {f.roles.includes('approver') && <div className="field"><label>承認できる範囲</label><div className="chips"><label className="check chip"><input type="checkbox" checked={f.approverScopes.includes(null)} onChange={() => setF({ ...f, approverScopes: f.approverScopes.includes(null) ? f.approverScopes.filter((x: any) => x !== null) : [...f.approverScopes, null] })} />全社</label>
        {deps.map((d) => <label key={d.id} className="check chip"><input type="checkbox" checked={f.approverScopes.includes(d.id)} onChange={() => setF({ ...f, approverScopes: f.approverScopes.includes(d.id) ? f.approverScopes.filter((x: any) => x !== d.id) : [...f.approverScopes, d.id] })} />{d.name}</label>)}</div></div>}
      <div className="field"><label htmlFor="uh">入社日（任意）</label><input id="uh" type="date" value={f.hireDate ?? ''} onChange={(e) => setF({ ...f, hireDate: e.target.value })} style={{ maxWidth: 200 }} /></div>
      <p className="subtle">権限の変更は、本人の次の操作から即座に反映されます（検索・AI検索を含む）。</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button>
        <button className="btn primary" disabled={busy || !f.name || !f.email || !f.roles.length} onClick={() => void run(async () => {
          const body = { name: f.name, email: f.email, roles: f.roles, memberships: f.memberships, approverScopes: f.approverScopes, hireDate: f.hireDate || null };
          if (u.id) { await api.patch(`/api/admin/users/${u.id}`, body); onDone(); } else { const r = await api.post('/api/admin/users', body); onDone(r.temporaryPassword); }
        }, '保存しました')}>保存</button></div>
    </Modal>
  );
}

function Depts() {
  const st = useLoad(() => api.get('/api/departments'));
  const [n, setN] = useState({ name: '', code: '' });
  const [team, setTeam] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  return (
    <>
      <div className="card row"><input type="text" aria-label="部署名" placeholder="部署名（例：営業部）" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} style={{ flex: 2 }} /><input type="text" aria-label="部署コード" placeholder="コード（例：SALES）" value={n.code} onChange={(e) => setN({ ...n, code: e.target.value })} style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !n.name || !n.code} onClick={() => void run(async () => { await api.post('/api/departments', n); setN({ name: '', code: '' }); st.reload(); }, '部署を追加しました')}>部署を追加</button></div>
      <Loaded state={st}>{(rows: any[]) => rows.map((d) => (
        <div key={d.id} className="card"><div className="row between"><h3 style={{ margin: 0 }}>{d.name} <span className="subtle">{d.code} ・ {d.member_count}名</span></h3></div>
          <div className="chips" style={{ margin: '8px 0' }}>{d.teams.map((t: any) => <span key={t.id} className="chip">{t.name}</span>)}</div>
          <div className="row"><input type="text" aria-label={`${d.name}にチームを追加`} placeholder="チーム名" value={team[d.id] ?? ''} onChange={(e) => setTeam({ ...team, [d.id]: e.target.value })} style={{ maxWidth: 240 }} />
            <button className="btn sm" disabled={busy || !team[d.id]} onClick={() => void run(async () => { await api.post('/api/teams', { departmentId: d.id, name: team[d.id] }); setTeam({ ...team, [d.id]: '' }); st.reload(); })}>チームを追加</button></div></div>
      ))}</Loaded>
    </>
  );
}

function Externals() {
  const st = useLoad(() => api.get('/api/admin/users?external=true'));
  const deps = useLoad(() => api.get('/api/departments'));
  const docs = useLoad(() => api.get('/api/documents?view=published&limit=200'));
  const { me } = useAuth();
  const [edit, setEdit] = useState<any>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const { busy, run } = useAction();
  return (
    <>
      <div className="alert info" style={{ marginBottom: 10 }}>業務委託先・取引先に、期間を決めて特定のマニュアルだけを共有します。外部メンバーは社内の名簿や他の文書を見ることはできず、「全社」向け文書・機密/極秘文書も表示されません。</div>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setEdit({ name: '', email: '', expiresAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), departmentIds: [], documentIds: [], allowDownload: false, allowAi: false })}><Icon name="plus" size={18} />外部メンバーを招待</button>
      <Loaded state={st}>{(rows: any[]) => rows.length ? (
        <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>名前</th><th>共有文書</th><th>期限</th><th>権限</th><th></th></tr></thead><tbody>
          {rows.map((u) => { const active = u.external_expires_at && new Date(u.external_expires_at) > new Date(); return (
            <tr key={u.id}><td><strong>{u.name}</strong><div className="subtle">{u.email}</div></td><td className="small">{(u.shared_documents ?? []).map((d: any) => d.title).join('、') || '—'}</td>
              <td>{active ? fmtDate(u.external_expires_at) : <Badge tone="danger">期限切れ・停止</Badge>}</td><td className="small">{u.external_allow_download ? 'DL可' : 'DL不可'}／{u.external_allow_ai ? 'AI可' : 'AI不可'}</td>
              <td><div className="row"><button className="btn sm" onClick={() => setEdit({ ...u, expiresAt: (u.external_expires_at ?? '').slice(0, 10), departmentIds: u.memberships.map((m: any) => m.departmentId), documentIds: (u.shared_documents ?? []).map((d: any) => d.documentId), allowDownload: u.external_allow_download, allowAi: u.external_allow_ai })}>編集</button>
                {active && <button className="btn sm danger" onClick={() => void run(async () => { await api.post(`/api/admin/externals/${u.id}/revoke`); st.reload(); }, 'アクセスを停止しました')}>今すぐ停止</button>}</div></td></tr>); })}
        </tbody></table></div>
      ) : <Empty>外部メンバーはいません</Empty>}</Loaded>
      {edit && <Modal title={edit.id ? '共有設定を変更' : '外部メンバーを招待'} onClose={() => setEdit(null)} wide>
        {!edit.id && <div className="grid cols-2"><div className="field"><label htmlFor="xn">名前</label><input id="xn" type="text" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div><div className="field"><label htmlFor="xe">メール</label><input id="xe" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div></div>}
        <div className="field"><label htmlFor="xx">共有期限</label><input id="xx" type="date" value={edit.expiresAt} onChange={(e) => setEdit({ ...edit, expiresAt: e.target.value })} style={{ maxWidth: 200 }} /><div className="hint">期限を過ぎると即座にアクセスできなくなります。</div></div>
        <div className="field"><label>共有するマニュアル（{me?.policy && '社内公開・社内限定のみ'}）</label>
          <Loaded state={docs}>{(ds: any) => <div className="chips">{ds.items.filter((d: any) => ['public_internal', 'internal'].includes(d.classification)).map((d: any) => <label key={d.id} className="check chip"><input type="checkbox" checked={edit.documentIds.includes(d.id)} onChange={() => setEdit({ ...edit, documentIds: edit.documentIds.includes(d.id) ? edit.documentIds.filter((x: string) => x !== d.id) : [...edit.documentIds, d.id] })} />{d.doc_number} {d.title}</label>)}</div>}</Loaded></div>
        <div className="field"><label>部署単位で共有（その部署向けの文書を閲覧可能にする）</label><Loaded state={deps}>{(ds: any[]) => <div className="chips">{ds.map((d) => <label key={d.id} className="check chip"><input type="checkbox" checked={edit.departmentIds.includes(d.id)} onChange={() => setEdit({ ...edit, departmentIds: edit.departmentIds.includes(d.id) ? edit.departmentIds.filter((x: string) => x !== d.id) : [...edit.departmentIds, d.id] })} />{d.name}</label>)}</div>}</Loaded></div>
        <div className="row"><label className="check"><input type="checkbox" checked={edit.allowDownload} onChange={(e) => setEdit({ ...edit, allowDownload: e.target.checked })} />PDF・オフライン保存を許可</label><label className="check"><input type="checkbox" checked={edit.allowAi} onChange={(e) => setEdit({ ...edit, allowAi: e.target.checked })} />AI検索を許可</label></div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button className="btn" onClick={() => setEdit(null)}>キャンセル</button>
          <button className="btn primary" disabled={busy || (!edit.id && (!edit.name || !edit.email)) || !edit.expiresAt} onClick={() => void run(async () => {
            const body = { expiresAt: new Date(edit.expiresAt + 'T23:59:59+09:00').toISOString(), departmentIds: edit.departmentIds, documentIds: edit.documentIds, allowDownload: edit.allowDownload, allowAi: edit.allowAi };
            if (edit.id) await api.patch(`/api/admin/externals/${edit.id}`, body); else { const r = await api.post('/api/admin/externals', { ...body, name: edit.name, email: edit.email }); setSecret(r.temporaryPassword); }
            setEdit(null); st.reload();
          }, '保存しました')}>保存</button></div>
      </Modal>}
      {secret && <Modal title="仮パスワード" onClose={() => setSecret(null)}><p>外部メンバーに、組織ID・メールアドレスとあわせて安全な方法で伝えてください。</p><p style={{ fontFamily: 'monospace', fontSize: '1.3rem' }}>{secret}</p></Modal>}
    </>
  );
}

function useSettings() {
  const st = useLoad(() => api.get('/api/admin/settings'));
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (st.data) setS(structuredClone(st.data.settings)); }, [st.data]);
  return { st, s, setS };
}

function Settings() {
  const { st, s, setS } = useSettings();
  const { refresh } = useAuth();
  const { busy, run } = useAction();
  if (!s) return <Loaded state={st}>{() => null}</Loaded>;
  const setType = (t: string, k: string, v: any) => setS({ ...s, docTypes: { ...s.docTypes, [t]: { ...s.docTypes[t], [k]: v } } });
  const toggleCls = (group: string, c: string) => setS({ ...s, classification: { ...s.classification, [group]: s.classification[group].includes(c) ? s.classification[group].filter((x: string) => x !== c) : [...s.classification[group], c] } });
  return (
    <div className="stack" style={{ gap: 14 }}>
      <section className="card"><h2>文書の種類ごとのルール</h2>
        <div className="table-wrap"><table className="tbl"><thead><tr><th>種類</th><th>承認</th><th>承認の段数</th><th>方式</th><th>定期レビュー</th><th>公開時の確認依頼</th></tr></thead><tbody>
          {Object.keys(DOC_TYPES).map((t) => <tr key={t}><td>{DOC_TYPES[t]}</td>
            <td><label className="check"><input type="checkbox" checked={s.docTypes[t].requireApproval} onChange={(e) => setType(t, 'requireApproval', e.target.checked)} />必要</label></td>
            <td><select aria-label={`${DOC_TYPES[t]}の承認段数`} value={s.docTypes[t].approvalSteps} onChange={(e) => setType(t, 'approvalSteps', Number(e.target.value))} style={{ width: 'auto' }}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}段</option>)}</select></td>
            <td><select aria-label={`${DOC_TYPES[t]}の承認方式`} value={s.docTypes[t].approvalMode} onChange={(e) => setType(t, 'approvalMode', e.target.value)} style={{ width: 'auto' }}><option value="any">誰か1人</option><option value="all">全員</option></select></td>
            <td><select aria-label={`${DOC_TYPES[t]}のレビュー周期`} value={s.docTypes[t].reviewCycleDays ?? ''} onChange={(e) => setType(t, 'reviewCycleDays', e.target.value ? Number(e.target.value) : null)} style={{ width: 'auto' }}><option value="">なし</option>{[30, 90, 180, 365].map((n) => <option key={n} value={n}>{n}日</option>)}</select></td>
            <td><label className="check"><input type="checkbox" checked={s.docTypes[t].requireAttestation} onChange={(e) => setType(t, 'requireAttestation', e.target.checked)} />依頼する</label></td></tr>)}
        </tbody></table></div>
        <p className="subtle">AIが作成した下書きは、この設定に関わらず必ず承認が必要です。</p>
      </section>
      <section className="card"><h2>改訂・レビュー</h2>
        <label className="check"><input type="checkbox" checked={s.requireChangeSummary} onChange={(e) => setS({ ...s, requireChangeSummary: e.target.checked })} />改訂時に「変更内容」の入力を必須にする</label>
        <div className="grid cols-2" style={{ marginTop: 10 }}>
          <div className="field"><label htmlFor="due">「まもなく期限」とする日数</label><input id="due" type="number" min={1} max={90} value={s.reviewDueSoonDays} onChange={(e) => setS({ ...s, reviewDueSoonDays: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="op">期限切れの文書の扱い</label><select id="op" value={s.overduePolicy} onChange={(e) => setS({ ...s, overduePolicy: e.target.value })}><option value="banner">公開のまま、利用者に「確認中」の注意を表示</option><option value="flag">公開のまま、管理画面でのみ表示</option></select><div className="hint">期限切れで自動的に非公開になることはありません。</div></div>
        </div>
        <div className="grid cols-2"><div className="field"><label htmlFor="ad">確認依頼の標準期限（日）</label><input id="ad" type="number" min={1} value={s.attestation.defaultDueDays} onChange={(e) => setS({ ...s, attestation: { ...s.attestation, defaultDueDays: Number(e.target.value) } })} /></div>
          <div className="field"><label>&nbsp;</label><label className="check"><input type="checkbox" checked={s.attestation.requireScroll} onChange={(e) => setS({ ...s, attestation: { ...s.attestation, requireScroll: e.target.checked } })} />最後まで表示しないと「確認しました」を押せない</label></div></div>
      </section>
      <section className="card"><h2>機密区分ごとの扱い</h2>
        <table className="tbl"><thead><tr><th>区分</th><th>オフライン保存</th><th>PDF・添付のダウンロード</th><th>外部メンバーへの共有</th></tr></thead><tbody>
          {Object.entries(CLASS).map(([k, v]) => <tr key={k}><td><Badge tone={v.tone}>{v.label}</Badge></td>
            {(['offlineAllowed', 'downloadAllowed', 'externalAllowed'] as const).map((g) => <td key={g}><label className="check"><input type="checkbox" checked={s.classification[g].includes(k)} disabled={g === 'externalAllowed' && k === 'restricted'} onChange={() => toggleCls(g, k)} />許可</label></td>)}</tr>)}
        </tbody></table>
      </section>
      <section className="card"><h2>通知・検索分析</h2>
        <label className="check"><input type="checkbox" checked={s.email.enabled} onChange={(e) => setS({ ...s, email: { enabled: e.target.checked } })} />アプリ内通知に加えてメールでも通知する（件名とリンクのみ。本文は送りません）</label>
        <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={s.searchAnalytics.enabled} onChange={(e) => setS({ ...s, searchAnalytics: { ...s.searchAnalytics, enabled: e.target.checked } })} />検索語を記録して分析する（利用者IDとは紐づけません）</label>
        <div className="field" style={{ marginTop: 8, maxWidth: 260 }}><label htmlFor="rd">検索語の保存期間（日）</label><input id="rd" type="number" min={7} max={730} value={s.searchAnalytics.retentionDays} onChange={(e) => setS({ ...s, searchAnalytics: { ...s.searchAnalytics, retentionDays: Number(e.target.value) } })} /></div>
      </section>
      <div><button className="btn primary lg" disabled={busy} onClick={() => void run(async () => { await api.put('/api/admin/settings', { settings: s }); await refresh(); st.reload(); }, '保存しました')}>保存</button></div>
    </div>
  );
}

function AiSettings() {
  const { st, s, setS } = useSettings();
  const { refresh } = useAuth();
  const { busy, run } = useAction();
  if (!s) return <Loaded state={st}>{() => null}</Loaded>;
  const ai = s.ai;
  const set = (k: string, v: any) => setS({ ...s, ai: { ...ai, [k]: v } });
  return (
    <div className="stack" style={{ gap: 14 }}>
      <section className="card">
        <h2>AI機能</h2>
        <label className="check"><input type="checkbox" checked={ai.enabled} onChange={(e) => set('enabled', e.target.checked)} /><strong>AI機能を使う</strong>（OFFにすると、AIへの送信は一切行われません。通常の検索・閲覧・研修はそのまま使えます）</label>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="check"><input type="checkbox" checked={ai.answerEnabled} onChange={(e) => set('answerEnabled', e.target.checked)} />AI検索（質問に回答）</label>
          <label className="check"><input type="checkbox" checked={ai.draftEnabled} onChange={(e) => set('draftEnabled', e.target.checked)} />SOP下書き</label>
          <label className="check"><input type="checkbox" checked={ai.quizDraftEnabled} onChange={(e) => set('quizDraftEnabled', e.target.checked)} />テスト問題案</label>
        </div>
      </section>
      <section className="card">
        <h2>AIの提供元</h2>
        <label className="check"><input type="radio" name="prov" checked={ai.provider === 'local'} onChange={() => set('provider', 'local')} /><span><strong>社内処理のみ（外部送信なし）</strong><br /><span className="subtle">承認済み文書から該当箇所を抜き出して引用付きで表示します。文章の要約・言い換えはしません。</span></span></label>
        <label className="check" style={{ marginTop: 8 }}><input type="radio" name="prov" checked={ai.provider === 'anthropic'} onChange={() => set('provider', 'anthropic')} /><span><strong>Anthropic Claude（外部サービス）</strong><br /><span className="subtle">検索でヒットした文書の該当箇所（許可した機密区分のみ）と質問文を Anthropic API に送信します。{st.data.aiKeyConfigured ? 'APIキー設定済み' : '⚠ サーバーにAPIキー（ANTHROPIC_API_KEY）が設定されていません'}</span></span></label>
        {ai.provider === 'anthropic' && <div className="field" style={{ marginTop: 10, maxWidth: 360 }}><label htmlFor="md">モデル</label><select id="md" value={ai.model || 'claude-opus-5-5'} onChange={(e) => set('model', e.target.value)}><option value="claude-opus-5-5">Claude Opus 5.5（高精度）</option><option value="claude-sonnet-5-5">Claude Sonnet 5.5（標準）</option><option value="claude-haiku-4-5">Claude Haiku 4.5（低コスト）</option></select></div>}
      </section>
      <section className="card">
        <h2>AIに渡してよい機密区分</h2>
        <div className="row">{Object.entries(CLASS).map(([k, v]) => <label key={k} className="check chip"><input type="checkbox" checked={ai.allowedClassifications.includes(k)} onChange={() => set('allowedClassifications', ai.allowedClassifications.includes(k) ? ai.allowedClassifications.filter((x: string) => x !== k) : [...ai.allowedClassifications, k])} />{v.label}</label>)}</div>
        <p className="subtle">チェックしていない区分の文書は、AI検索の根拠にも、外部AIへの送信対象にもなりません。どの設定でも、利用者が閲覧権限を持たない文書は使われません。</p>
      </section>
      <section className="card">
        <h2>利用量の上限</h2>
        <div className="grid cols-4">
          <div className="field"><label htmlFor="pm">1人あたり（回/分）</label><input id="pm" type="number" min={1} max={120} value={ai.userPerMinute} onChange={(e) => set('userPerMinute', Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="pd">組織全体（回/日）</label><input id="pd" type="number" min={1} value={ai.orgPerDay} onChange={(e) => set('orgPerDay', Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="mb">月の予算上限（USD）</label><input id="mb" type="number" min={0} step={1} value={ai.monthlyBudgetUsd} onChange={(e) => set('monthlyBudgetUsd', Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="ms">根拠の最低スコア</label><input id="ms" type="number" min={0} max={1} step={0.01} value={ai.minScore} onChange={(e) => set('minScore', Number(e.target.value))} /><div className="hint">高いほど「確認できません」が増えます</div></div>
        </div>
      </section>
      <div><button className="btn primary lg" disabled={busy} onClick={() => void run(async () => { await api.put('/api/admin/settings', { settings: s }); await refresh(); st.reload(); }, 'AI設定を保存しました（変更は監査ログに記録されます）')}>保存</button></div>
    </div>
  );
}

function Templates() {
  const st = useLoad(() => api.get('/api/templates'));
  const [edit, setEdit] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <>
      <p className="subtle">新しい文書を作るときの雛形です。テンプレートを変更しても、既に作成された文書は変わりません。</p>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setEdit({ name: '', doc_type: 'sop', content: { body: { type: 'doc', content: [{ type: 'paragraph' }] }, steps: [], checklistItems: [] } })}><Icon name="plus" size={18} />テンプレートを作成</button>
      <Loaded state={st}>{(rows: any[]) => <ul className="list card">{rows.map((t) => <li key={t.id} className="row between"><span><strong>{t.name}</strong> <span className="chip">{DOC_TYPES[t.doc_type]}</span>{t.is_default && <Badge tone="info">標準</Badge>}</span><button className="btn sm" onClick={() => setEdit(t)}>編集</button></li>)}</ul>}</Loaded>
      {edit && <Modal title="テンプレート" onClose={() => setEdit(null)} wide>
        <div className="grid cols-2"><div className="field"><label htmlFor="tn">名前</label><input id="tn" type="text" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="tt">種類</label><select id="tt" value={edit.doc_type} onChange={(e) => setEdit({ ...edit, doc_type: e.target.value })}>{Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div></div>
        <TemplateBody content={edit.content} onChange={(c) => setEdit({ ...edit, content: c })} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}><button className="btn" onClick={() => setEdit(null)}>キャンセル</button>
          <button className="btn primary" disabled={busy || !edit.name} onClick={() => void run(async () => { const b = { name: edit.name, docType: edit.doc_type, content: edit.content }; if (edit.id) await api.put(`/api/templates/${edit.id}`, b); else await api.post('/api/templates', b); setEdit(null); st.reload(); }, '保存しました')}>保存</button></div>
      </Modal>}
    </>
  );
}

function TemplateBody({ content, onChange }: { content: Content; onChange: (c: Content) => void }) {
  return (
    <>
      <RichEditor value={content.body} documentId="00000000-0000-0000-0000-000000000000" onChange={(b) => onChange({ ...content, body: b })} />
      <h3 style={{ marginTop: 12 }}>手順（任意）</h3>
      <StepsEditor steps={content.steps} documentId="00000000-0000-0000-0000-000000000000" onChange={(s) => onChange({ ...content, steps: s })} />
      <h3 style={{ marginTop: 12 }}>チェック項目（任意）</h3>
      <ChecklistEditor items={content.checklistItems} onChange={(x) => onChange({ ...content, checklistItems: x })} />
    </>
  );
}

function Backup() {
  const [report, setReport] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <div className="stack" style={{ gap: 14 }}>
      <section className="card"><h2>バックアップをダウンロード</h2>
        <p>この組織のすべてのデータ（文書・版・承認・研修・確認記録・監査ログ・添付ファイル・設定）を1つのファイル（.json.gz）にまとめます。ファイルにはハッシュ化されたパスワードや機密文書も含まれるため、暗号化された安全な場所に保管してください。</p>
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => {
          const res = await fetch('/api/admin/backup', { method: 'POST', headers: { 'x-csrf-token': getCsrf() } });
          if (!res.ok) throw new Error('バックアップに失敗しました');
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1]) ?? 'operate-backup.json.gz';
          a.click();
        }, 'バックアップを作成しました')}><Icon name="download" />バックアップを作成</button></section>
      <section className="card"><h2>バックアップファイルの検証</h2>
        <p className="subtle">ファイルが壊れていないか・改ざんされていないか（件数とチェックサム）を確認します。復元はサーバー管理者がコマンドで行います（「バックアップと復元.txt」参照）。</p>
        <input type="file" accept=".gz,.json" aria-label="バックアップファイル" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); void run(async () => setReport(await api.form('/api/admin/backup/validate', fd))); }} />
        {report && <div className={`alert ${report.ok ? 'ok' : 'danger'}`} style={{ marginTop: 10 }}><div><strong>{report.ok ? '検証OK' : '検証NG'}</strong> ・ {report.organization?.name}（{report.organization?.slug}） ・ 作成 {fmtDateTime(report.generatedAt)}{report.errors.map((e: string) => <div key={e}>・{e}</div>)}<div className="subtle">文書 {report.counts.documents} ／ 版 {report.counts.document_versions} ／ 研修割当 {report.counts.training_assignments} ／ 監査ログ {report.counts.audit_events}</div></div></div>}
      </section>
    </div>
  );
}
