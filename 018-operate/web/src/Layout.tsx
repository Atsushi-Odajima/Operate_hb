import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { flushQueue, pending, recheckOffline } from './offline';
import { Icon, useToast } from './ui';

export function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    window.addEventListener('online', a);
    window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  return on;
}

interface Item { to: string; label: string; icon: string; show?: boolean; count?: number }

export function Layout({ children }: { children: ReactNode }) {
  const { me, can, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const online = useOnline();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [counts, setCounts] = useState<{ inbox: number; unread: number }>({ inbox: 0, unread: me?.unreadNotifications ?? 0 });
  const [queued, setQueued] = useState(0);

  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!online || !me) return;
    api.get('/api/dashboard').then((d) => setCounts({ inbox: (d.reviewCount ?? 0) + (d.approvalCount ?? 0), unread: d.unreadNotifications ?? 0 })).catch(() => undefined);
  }, [loc.pathname, online, me]);
  useEffect(() => {
    void pending().then((p) => setQueued(p.length));
    if (!online) return;
    void (async () => {
      const n = await flushQueue();
      if (n) push(`オフライン中の操作 ${n} 件を送信しました`);
      setQueued((await pending()).length);
      try {
        const r = await recheckOffline();
        if (r.updated.length) push(`保存済みマニュアルが新しい版に更新されました: ${r.updated.join('、')}`);
        if (r.removed.length) push(`廃止・権限変更により保存済みマニュアルを削除しました: ${r.removed.join('、')}`, true);
      } catch { /* ignore */ }
    })();
  }, [online, push]);

  if (!me) return null;
  const isInternal = !me.isExternal;
  const groups: Array<[string, Item[]]> = [
    ['', [
      { to: '/', label: 'ホーム', icon: 'home' },
      { to: '/search', label: '検索・AIに質問', icon: 'search' },
      { to: '/documents', label: 'マニュアル', icon: 'doc' },
      { to: '/training', label: '研修', icon: 'training', show: isInternal },
      { to: '/checklists', label: 'チェックリスト', icon: 'checklist', show: isInternal },
      { to: '/offline', label: '端末に保存した文書', icon: 'download' },
    ]],
    ['作成・承認', [
      { to: '/documents?view=work', label: '作成・編集', icon: 'edit', show: can('doc.create') },
      { to: '/inbox', label: 'レビュー・承認', icon: 'inbox', show: can('doc.review') || can('doc.approve'), count: counts.inbox },
      { to: '/import', label: '既存資料の取り込み', icon: 'upload', show: can('import') },
    ]],
    ['運用', [
      { to: '/manage/training', label: '研修管理', icon: 'training', show: can('training.manage') || can('training.report') },
      { to: '/attestations', label: '確認状況', icon: 'check', show: can('attestation.report') },
      { to: '/health', label: 'ナレッジ状況', icon: 'chart', show: can('health.read') },
      { to: '/feedback', label: 'フィードバック・改善', icon: 'feedback', show: isInternal && (can('feedback.manage') || can('doc.create')) },
    ]],
    ['管理', [
      { to: '/audit', label: '監査・レポート', icon: 'shield', show: can('audit.read') },
      { to: '/admin', label: '組織・ユーザー設定', icon: 'settings', show: can('user.manage') || can('dept.manage') || can('external.manage') || can('org.settings') },
    ]],
  ];
  const isActive = (to: string) => {
    const [p, s] = to.split('?');
    if (p === '/') return loc.pathname === '/';
    if (s) return loc.pathname === p && loc.search.includes(s);
    return loc.pathname.startsWith(p) && !(p === '/documents' && loc.search.includes('view=work'));
  };

  return (
    <div className="shell">
      <a className="skip" href="#main">本文へスキップ</a>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`side ${open ? 'open' : ''}`} aria-label="メインメニュー">
        <div className="brand"><img src="/logo-horizontal.svg" alt="Operate" /></div>
        <nav className="nav">
          {groups.map(([g, items]) => {
            const vis = items.filter((i) => i.show !== false);
            if (!vis.length) return null;
            return (
              <div key={g || 'main'}>
                {g && <div className="nav-group">{g}</div>}
                {vis.map((i) => (
                  <NavLink key={i.to} to={i.to} className={() => (isActive(i.to) ? 'active' : '')} aria-current={isActive(i.to) ? 'page' : undefined}>
                    <Icon name={i.icon} />{i.label}{!!i.count && <span className="count" aria-label={`${i.count}件`}>{i.count}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div style={{ marginTop: 'auto', padding: '12px 10px 0', borderTop: '1px solid var(--line)' }}>
          <div className="small" style={{ fontWeight: 700 }}>{me.name}</div>
          <div className="subtle">{me.orgName}{me.isExternal && ' ・外部メンバー'}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <NavLink className="btn sm" to="/account">アカウント</NavLink>
            <button className="btn sm" onClick={() => void logout().then(() => nav('/login'))}><Icon name="logout" size={16} />ログアウト</button>
          </div>
        </div>
      </aside>
      <div className="main">
        {!online && <div className="offline-banner" role="status"><Icon name="offline" size={16} /> オフラインです。端末に保存した文書のみ閲覧できます。承認・確認・テスト提出はオンラインで行ってください。</div>}
        {online && queued > 0 && <div className="offline-banner" role="status">未送信の操作が {queued} 件あります（接続後に自動送信）</div>}
        <header className="topbar">
          <button className="icon-btn mobile-only" onClick={() => setOpen(true)} aria-label="メニューを開く" style={{ display: undefined }}><Icon name="menu" /></button>
          <NavLink to="/" className="mobile-brand" aria-label="ホーム"><img src="/logo-horizontal.svg" alt="Operate" /></NavLink>
          <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); nav(`/search?q=${encodeURIComponent(q)}`); }}>
            <Icon name="search" size={18} />
            <input type="search" placeholder="マニュアルを検索（例：返金 本人確認）" aria-label="マニュアルを検索" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <div style={{ marginLeft: 'auto' }} className="row">
            <NavLink to="/notifications" className="icon-btn" aria-label={`通知 ${counts.unread}件未読`}><Icon name="bell" />{counts.unread > 0 && <span className="dot">{counts.unread > 99 ? '99+' : counts.unread}</span>}</NavLink>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>{children}</main>
      </div>
      <nav className="tabbar" aria-label="タブ">
        <NavLink to="/" end><Icon name="home" />ホーム</NavLink>
        <NavLink to="/search"><Icon name="search" />検索</NavLink>
        <NavLink to="/documents"><Icon name="doc" />マニュアル</NavLink>
        {isInternal ? <NavLink to="/training"><Icon name="training" />研修</NavLink> : <NavLink to="/offline"><Icon name="download" />保存済み</NavLink>}
        <button onClick={() => setOpen(true)} aria-label="メニュー"><Icon name="menu" />メニュー</button>
      </nav>
    </div>
  );
}
