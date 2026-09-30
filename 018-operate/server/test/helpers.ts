import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { DEMO_PASSWORD, seedSample } from '../src/services/seed.js';
import { resetRateLimits } from '../src/lib/ratelimit.js';

export interface Client {
  get(url: string): Promise<{ status: number; body: any; raw: string; headers: Record<string, unknown> }>;
  post(url: string, body?: unknown): Promise<{ status: number; body: any; raw: string; headers: Record<string, unknown> }>;
  put(url: string, body?: unknown): Promise<{ status: number; body: any; raw: string; headers: Record<string, unknown> }>;
  patch(url: string, body?: unknown): Promise<{ status: number; body: any; raw: string; headers: Record<string, unknown> }>;
  del(url: string): Promise<{ status: number; body: any; raw: string; headers: Record<string, unknown> }>;
  cookie: string;
  csrf: string;
}

let app: FastifyInstance | null = null;
export async function getApp() {
  app ??= await buildApp({ logger: false });
  return app;
}

type Seed = Awaited<ReturnType<typeof seedSample>>;
const seeds = new Map<string, Seed>();
export async function seed(slug = 'sample-works'): Promise<Seed> {
  if (!seeds.has(slug)) seeds.set(slug, await seedSample(slug, slug === 'sample-works' ? 'Sample Works株式会社' : `${slug} 株式会社`));
  return seeds.get(slug)!;
}

export async function login(user: string, org = 'sample-works', password = DEMO_PASSWORD): Promise<Client> {
  resetRateLimits();
  const a = await getApp();
  const email = user.includes('@') ? user : `${user}@${org}.example`;
  const res = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { org, email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${user}: ${res.statusCode} ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  const csrf = res.json().csrf;
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await a.inject({ method: method as any, url, payload: payload as any, headers: { cookie, 'x-csrf-token': csrf } });
    let body: any = null;
    try { body = r.json(); } catch { body = null; }
    return { status: r.statusCode, body, raw: r.body, headers: r.headers as Record<string, unknown> };
  };
  return {
    cookie, csrf,
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b ?? {}), patch: (u, b) => call('PATCH', u, b ?? {}), del: (u) => call('DELETE', u),
  };
}
