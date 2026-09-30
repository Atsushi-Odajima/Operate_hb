import { useEffect, useState } from 'react';
import { api } from '../api';
import { CLASS, ROLES } from '../labels';

export interface Dept { id: string; name: string; code: string; teams: { id: string; name: string }[] }
export interface DirUser { id: string; name: string; roles: string[]; department_ids: string[]; is_external: boolean }

export function useDirectory() {
  const [deps, setDeps] = useState<Dept[]>([]);
  const [users, setUsers] = useState<DirUser[]>([]);
  useEffect(() => {
    api.get('/api/departments').then(setDeps).catch(() => undefined);
    api.get('/api/directory').then(setUsers).catch(() => undefined);
  }, []);
  return { deps, users };
}

export interface Audience { all: boolean; items: Array<{ kind: string; target: string }> }

export function AudiencePicker({ value, onChange, deps, users, disabled }: { value: Audience; onChange: (a: Audience) => void; deps: Dept[]; users: DirUser[]; disabled?: boolean }) {
  const has = (kind: string, target: string) => value.items.some((i) => i.kind === kind && i.target === target);
  const toggle = (kind: string, target: string) => onChange({ ...value, items: has(kind, target) ? value.items.filter((i) => !(i.kind === kind && i.target === target)) : [...value.items, { kind, target }] });
  const [userQ, setUserQ] = useState('');
  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sr-only">配布先</legend>
      <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={value.all} onChange={(e) => onChange({ ...value, all: e.target.checked })} />全社（社内メンバー全員。極秘文書と外部メンバーは対象外）</label>
      <div className="subtle" style={{ margin: '6px 0 4px' }}>部署・チーム</div>
      <div className="chips">
        {deps.map((d) => (
          <span key={d.id} className="row" style={{ gap: 4 }}>
            <label className="check chip"><input type="checkbox" checked={has('department', d.id)} onChange={() => toggle('department', d.id)} />{d.name}</label>
            {d.teams.map((t) => <label key={t.id} className="check chip"><input type="checkbox" checked={has('team', t.id)} onChange={() => toggle('team', t.id)} />{d.name}/{t.name}</label>)}
          </span>
        ))}
      </div>
      <div className="subtle" style={{ margin: '8px 0 4px' }}>役割</div>
      <div className="chips">{Object.entries(ROLES).filter(([k]) => k !== 'external').map(([k, v]) => <label key={k} className="check chip"><input type="checkbox" checked={has('role', k)} onChange={() => toggle('role', k)} />{v}</label>)}</div>
      <div className="subtle" style={{ margin: '8px 0 4px' }}>個別ユーザー</div>
      <input type="search" placeholder="名前で探す" aria-label="ユーザーを名前で探す" value={userQ} onChange={(e) => setUserQ(e.target.value)} style={{ maxWidth: 260 }} />
      <div className="chips" style={{ marginTop: 6 }}>
        {users.filter((u) => has('user', u.id) || (userQ && u.name.includes(userQ))).slice(0, 30).map((u) => <label key={u.id} className="check chip"><input type="checkbox" checked={has('user', u.id)} onChange={() => toggle('user', u.id)} />{u.name}{u.is_external && '（外部）'}</label>)}
      </div>
    </fieldset>
  );
}

export function ClassificationSelect({ value, onChange, id = 'cls' }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(CLASS).map(([k, v]) => <option key={k} value={k}>{v.label} — {v.hint}</option>)}
      </select>
    </>
  );
}

export function UserSelect({ users, value, onChange, filter, label, id }: { users: DirUser[]; value: string[]; onChange: (v: string[]) => void; filter?: (u: DirUser) => boolean; label: string; id: string }) {
  const list = users.filter((u) => !u.is_external && (!filter || filter(u)));
  return (
    <div>
      <div className="chips" role="group" aria-label={label} id={id}>
        {list.map((u) => <label key={u.id} className="check chip"><input type="checkbox" checked={value.includes(u.id)} onChange={(e) => onChange(e.target.checked ? [...value, u.id] : value.filter((x) => x !== u.id))} />{u.name}</label>)}
        {!list.length && <span className="subtle">対象のユーザーがいません</span>}
      </div>
    </div>
  );
}
