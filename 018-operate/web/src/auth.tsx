import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrf } from './api';
import { clearOffline } from './offline';

export interface Me {
  id: string; name: string; email: string; orgId: string; orgName: string; roles: string[]; departmentIds: string[]; teamIds: string[];
  isExternal: boolean; externalExpiresAt: string | null; csrf: string; perms: string[]; unreadNotifications: number;
  policy: { offlineAllowed: string[]; downloadAllowed: string[]; ai: { enabled: boolean; draft: boolean; quizDraft: boolean; provider: string }; requireChangeSummary: boolean; docTypes: Record<string, any>; overduePolicy: string };
}

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; can: (p: string) => boolean; expired: boolean }>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>('/api/me');
      setCsrf(m.csrf);
      setMe(m);
      setExpired(false);
      localStorage.setItem('op.lastUser', m.id);
    } catch (e: any) {
      if (e?.status === 0) {
        // offline: keep a minimal cached identity so saved documents stay readable
        const cached = localStorage.getItem('op.me');
        if (cached) setMe({ ...JSON.parse(cached), offline: true });
      } else setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (me) localStorage.setItem('op.me', JSON.stringify({ ...me, csrf: '' }));
  }, [me]);
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail === 'external_expired') setExpired(true);
      // Forced logout (expiry, revocation, external access ended): drop cached documents too.
      void clearOffline();
      localStorage.removeItem('op.me');
      setMe(null);
    };
    window.addEventListener('op:unauthorized', on);
    return () => window.removeEventListener('op:unauthorized', on);
  }, []);
  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* already logged out */ }
    await clearOffline();
    localStorage.removeItem('op.me');
    setMe(null);
  }, []);
  const can = useCallback((p: string) => !!me?.perms.includes(p), [me]);
  return <Ctx.Provider value={{ me, loading, refresh, logout, can, expired }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
