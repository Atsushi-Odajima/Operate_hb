import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDate, ROLES } from '../labels';
import { PageHead, useAction } from '../ui';

export default function Account() {
  const { me } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [conf, setConf] = useState('');
  const [code, setCode] = useState('');
  const [ver, setVer] = useState<any>(null);
  const { busy, run } = useAction();
  if (!me) return null;
  return (
    <div className="content narrow" style={{ padding: 0 }}>
      <PageHead title="アカウント" />
      <div className="card"><dl className="kv"><dt>名前</dt><dd>{me.name}</dd><dt>メール</dt><dd>{me.email}</dd><dt>組織</dt><dd>{me.orgName}</dd><dt>役割</dt><dd>{me.roles.map((r) => ROLES[r]).join('、')}</dd>{me.isExternal && <><dt>共有期限</dt><dd>{fmtDate(me.externalExpiresAt)}</dd></>}</dl></div>
      <form className="card" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.post('/api/me/password', { current: cur, next }); setCur(''); setNext(''); setConf(''); }, 'パスワードを変更しました（他の端末はログアウトされます）'); }}>
        <h2>パスワードの変更</h2>
        <div className="field"><label htmlFor="pc">現在のパスワード</label><input id="pc" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div className="field"><label htmlFor="pn">新しいパスワード（10文字以上）</label><input id="pn" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} /></div>
        <div className="field"><label htmlFor="pv">新しいパスワード（確認）</label><input id="pv" type="password" autoComplete="new-password" value={conf} onChange={(e) => setConf(e.target.value)} />{conf && conf !== next && <div className="hint" style={{ color: 'var(--danger)' }}>一致しません</div>}</div>
        <button className="btn primary" disabled={busy || !cur || next.length < 10 || next !== conf}>変更する</button>
      </form>
      {!me.isExternal && <div className="card"><h2>研修完了証の照合</h2><p className="subtle">完了証PDFに記載された照合コードで、記録が正しいか確認できます。</p>
        <div className="row"><input type="text" aria-label="照合コード" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 220 }} /><button className="btn" disabled={!code} onClick={() => void run(async () => setVer(await api.get(`/api/certificates/verify/${encodeURIComponent(code.trim())}`)))}>照合</button></div>
        {ver && (ver.valid ? <div className="alert ok" style={{ marginTop: 10 }}>有効な記録です：{ver.name} ／ {ver.course}（v{ver.version}）／ 修了 {fmtDate(ver.completedAt)}{ver.expired && '（有効期限切れ）'}</div> : <div className="alert danger" style={{ marginTop: 10 }}>該当する記録がありません</div>)}</div>}
    </div>
  );
}
