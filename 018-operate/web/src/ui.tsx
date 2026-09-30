import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { ATTEST, CHANGE, CLASS, DOC_STATUS, TRAINING, VER_STATUS, type Tone } from './labels';

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.3-4.3',
  doc: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm7 0v5h5M9 13h7M9 17h5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  check: 'M5 12.5 10 17 19 7',
  checklist: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z',
  training: 'M3 9l9-5 9 5-9 5zM7 11.5V16c0 1 2.5 3 5 3s5-2 5-3v-4.5',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.9M15 3.1a3.5 3.5 0 0 1 0 6.8',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  feedback: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M4 21h16',
  upload: 'M12 21V9m0 0-4 4m4-4 4 4M4 3h16',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  back: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  x: 'M18 6 6 18M6 6l12 12',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  offline: 'M1 1l22 22M16.7 11.1A10.9 10.9 0 0 1 19 12.5M5 12.5a10.9 10.9 0 0 1 5.2-2.4M10.7 5.1A16 16 0 0 1 22.6 9M1.4 9a15.9 15.9 0 0 1 4.3-2.6M8.5 16.1a6 6 0 0 1 7 0M12 20h.01',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  play: 'M6 4l14 8-14 8z',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
};

export function Icon({ name, size = 20, label }: { name: keyof typeof PATHS | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name] ?? PATHS.doc} />
    </svg>
  );
}

export const Badge = ({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) => <span className={`badge ${tone}`} title={title}>{children}</span>;
const pick = (m: Record<string, { label: string; tone: Tone }>, k: string) => m[k] ?? { label: k, tone: 'neutral' as Tone };
export const DocStatus = ({ s }: { s: string }) => { const x = pick(DOC_STATUS, s); return <Badge tone={x.tone}>{x.label}</Badge>; };
export const VerStatus = ({ s }: { s: string }) => { const x = pick(VER_STATUS, s); return <Badge tone={x.tone}>{x.label}</Badge>; };
export const ClassBadge = ({ c }: { c: string }) => { const x = CLASS[c] ?? { label: c, tone: 'neutral' as Tone, hint: '' }; return <Badge tone={x.tone} title={x.hint}>🔒 {x.label}</Badge>; };
export const ChangeBadge = ({ c }: { c: string }) => { const x = pick(CHANGE, c); return <Badge tone={x.tone}>{x.label}</Badge>; };
export const TrainingBadge = ({ s }: { s: string }) => { const x = pick(TRAINING, s); return <Badge tone={x.tone}>{x.label}</Badge>; };
export const AttestBadge = ({ s }: { s: string }) => { const x = pick(ATTEST, s); return <Badge tone={x.tone}>{x.label}</Badge>; };
export const AiBadge = () => <Badge tone="ai">AI生成</Badge>;

export const Spinner = () => <div className="spinner" role="status" aria-label="読み込み中" />;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, ReactNode]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

// ---------- toast
type ToastT = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<{ push: (t: string, error?: boolean) => void }>({ push: () => undefined });
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, error }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), error ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.error ? 'error' : ''}`} role={t.error ? 'alert' : 'status'}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Wraps an async action: shows error toasts, disables double submit. */
export function useAction() {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) push(ok);
      return r;
    } catch (e) {
      push(e instanceof ApiError ? e.message : 'エラーが発生しました', true);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [push]);
  return { busy, run };
}

/** Data loader with reload. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    fn().then((d) => alive && setData(d)).catch((e) => alive && setError(e instanceof ApiError ? e : new ApiError(0, 'error', String(e))));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}

export function Loaded<T>({ state, children }: { state: { data: T | null; error: ApiError | null }; children: (d: T) => ReactNode }) {
  if (state.error) return <div className="alert danger" role="alert">{state.error.status === 404 ? '見つからないか、閲覧する権限がありません。' : state.error.message}</div>;
  if (state.data === null) return <Spinner />;
  return <>{children(state.data)}</>;
}

export function Stat({ label, value, tone, to }: { label: string; value: ReactNode; tone?: 'blue' | 'red' | 'amber'; to?: string }) {
  const inner = <div className="stat"><span className="label">{label}</span><span className={`value ${tone ?? ''}`}>{value}</span></div>;
  return <div className="card">{to ? <a href={to} style={{ color: 'inherit' }}>{inner}</a> : inner}</div>;
}

export function Progress({ value, label }: { value: number; label: string }) {
  return <div className="progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100} aria-label={label}><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}
