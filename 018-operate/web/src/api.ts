let csrf = '';
export function setCsrf(t: string) { csrf = t; }
export const getCsrf = () => csrf;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: any) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: isForm ? (body as FormData) : body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'offline', 'ネットワークに接続できません。オンラインになってから再度お試しください');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('op:unauthorized', { detail: data?.error }));
    const msg = data?.issues?.length ? `${data.message}（${data.issues.map((i: any) => i.path || i.message).slice(0, 3).join(', ')}）` : data?.message;
    throw new ApiError(res.status, data?.error ?? 'error', msg ?? `エラーが発生しました (${res.status})`, data?.detail);
  }
  return data as T;
}

export const api = {
  get: <T = any>(u: string) => request<T>('GET', u),
  post: <T = any>(u: string, b: unknown = {}) => request<T>('POST', u, b),
  put: <T = any>(u: string, b: unknown = {}) => request<T>('PUT', u, b),
  patch: <T = any>(u: string, b: unknown = {}) => request<T>('PATCH', u, b),
  del: <T = any>(u: string) => request<T>('DELETE', u),
  form: <T = any>(u: string, f: FormData) => request<T>('POST', u, f, true),
};

/** Server issues a one-time, 10-minute, user-bound download URL; the browser then downloads it normally. */
export async function downloadExport(kind: string, params: Record<string, unknown>) {
  const r = await api.post<{ url: string }>('/api/exports', { kind, params });
  const a = document.createElement('a');
  a.href = r.url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
