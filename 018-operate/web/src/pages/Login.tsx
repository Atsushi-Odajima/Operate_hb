import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

export function Login() {
  const { me, refresh, expired } = useAuth();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [org, setOrg] = useState(localStorage.getItem('op.org') ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to={sp.get('next') || '/'} replace />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.post('/api/auth/login', { org: org.trim().toLowerCase(), email, password });
      localStorage.setItem('op.org', org.trim().toLowerCase());
      await refresh();
      const next = sp.get('next');
      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'ログインできませんでした');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <img src="/logo-horizontal.svg" alt="Operate" style={{ height: 44, marginBottom: 12 }} />
        <h1 style={{ fontSize: '1.3rem' }}>会社のマニュアル・新人教育・ルール変更を、ひとつにまとめる。</h1>
        <p className="hero-copy">仕事のやり方が、会社の力になる。</p>
        <div className="card" style={{ marginTop: 16 }}>
          <form onSubmit={submit} noValidate>
            {expired && <div className="alert warn" role="alert" style={{ marginBottom: 12 }}>共有期間が終了したため、ログアウトしました。</div>}
            {err && <div className="alert danger" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
            <div className="field"><label htmlFor="org">組織ID</label><input id="org" type="text" autoComplete="organization" value={org} onChange={(e) => setOrg(e.target.value)} required placeholder="例：sample-works" /></div>
            <div className="field"><label htmlFor="email">メールアドレス</label><input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div className="field"><label htmlFor="password">パスワード</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
            <button className="btn primary lg block" disabled={busy || !org || !email || !password}>{busy ? 'ログイン中…' : 'ログイン'}</button>
          </form>
        </div>
        <p className="subtle" style={{ marginTop: 12 }}>パスワードを忘れた場合は、社内の管理者（オーナー）に再発行を依頼してください。</p>
      </div>
    </div>
  );
}
