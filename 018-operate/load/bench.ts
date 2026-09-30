/**
 * HTTP latency benchmark against a running Operate server (pointed at the load database).
 * Usage: BASE=http://localhost:8095 npx tsx load/bench.ts > load/out/result.json
 */
const BASE = process.env.BASE ?? 'http://localhost:8095';
const SIZES = (process.env.SIZES ?? '10,50,200,1000').split(',').map(Number);
const N = Number(process.env.REQUESTS ?? 200);
const CONC = Number(process.env.CONCURRENCY ?? 10);

interface Sess { cookie: string; csrf: string }
async function login(org: string, email: string): Promise<Sess> {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': Math.random().toString() }, body: JSON.stringify({ org, email, password: 'Operate-Load-2026!' }) });
  if (!r.ok) throw new Error(`login ${org} ${email}: ${r.status} ${await r.text()}`);
  return { cookie: r.headers.get('set-cookie')!.split(';')[0], csrf: (await r.json()).csrf };
}
async function call(s: Sess, method: string, path: string, body?: unknown) {
  const t = performance.now();
  const r = await fetch(BASE + path, { method, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const buf = await r.arrayBuffer();
  return { ms: performance.now() - t, status: r.status, bytes: buf.byteLength };
}
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10;
  return { n: s.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: Math.round(s[s.length - 1]) };
}
async function run(s: Sess | Sess[], name: string, fn: (i: number) => [string, string, unknown?]) {
  const lat: number[] = [];
  let errors = 0;
  let i = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < N) {
      const k = i++;
      const [m, p, b] = fn(k);
      const r = await call(Array.isArray(s) ? s[k % s.length] : s, m, p, b);
      if (r.status >= 400) errors++;
      lat.push(r.ms);
    }
  }));
  const sec = (performance.now() - t0) / 1000;
  return { name, ...stats(lat), rps: Math.round(N / sec), errors };
}

const out: any[] = [];
const words = ['返金', '出荷 検品', '請求', 'アカウント', '本人確認', '棚卸し', 'クレーム', 'パスワード'];
for (const n of SIZES) {
  const org = `t${n}`;
  const member = await login(org, `u2@${org}.example`);
  const admin = await login(org, `u1@${org}.example`);
  // AI is rate limited per user (max 120/min): spread the AI scenario over several members
  const members = [member, ...(await Promise.all([3, 4, 5, 6].filter((x) => x <= n).map((x) => login(org, `u${x}@${org}.example`))))];
  const res: any = { tenant: org, users: n, scenarios: [] as any[] };
  res.scenarios.push(await run(member, 'search (keyword, ACL)', (k) => ['GET', `/api/search?q=${encodeURIComponent(words[k % words.length])}`]));
  res.scenarios.push(await run(members, 'AI ask (local, ACL retrieval)', (k) => ['POST', '/api/ai/ask', { question: `${words[k % words.length]}の手順は？` }]));
  res.scenarios.push(await run(member, 'dashboard (member)', () => ['GET', '/api/dashboard']));
  res.scenarios.push(await run(member, 'document list', () => ['GET', '/api/documents?limit=50']));
  res.scenarios.push(await run(admin, 'dashboard (owner/KA)', () => ['GET', '/api/dashboard']));
  res.scenarios.push(await run(admin, 'knowledge health', () => ['GET', '/api/health/knowledge']));
  res.scenarios.push(await run(admin, 'training report', () => ['GET', '/api/training/report']));
  // single heavy operations
  const courses = await (await fetch(`${BASE}/api/courses`, { headers: { cookie: admin.cookie } })).json();
  const t1 = performance.now();
  const c2 = await (await fetch(`${BASE}/api/courses`, { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'bench' }) })).json();
  await fetch(`${BASE}/api/courses/${c2.id}/draft`, { method: 'PUT', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ modules: [{ id: 'm1', type: 'text', title: 'x', required: true, text: 'x' }] }) });
  await fetch(`${BASE}/api/courses/${c2.id}/publish`, { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf } });
  const ta = performance.now();
  const assign = await call(admin, 'POST', `/api/courses/${c2.id}/assign`, { roles: ['member'] });
  res.single = { assignmentGenerationMs: Math.round(assign.ms), assignedUsers: n, courseSetupMs: Math.round(ta - t1), existingCourses: courses.length };
  const tok = await (await fetch(`${BASE}/api/exports`, { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'audit-package', params: { from: '2000-01-01', to: '2100-01-01', includePdf: false } }) })).json();
  const ex = await call(admin, 'GET', tok.url);
  res.single.auditPackageMs = Math.round(ex.ms);
  res.single.auditPackageBytes = ex.bytes;
  const tok2 = await (await fetch(`${BASE}/api/exports`, { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'audit-log', params: { from: '2000-01-01', to: '2100-01-01' } }) })).json();
  const ex2 = await call(admin, 'GET', tok2.url);
  res.single.auditLogCsvMs = Math.round(ex2.ms);
  res.single.auditLogCsvBytes = ex2.bytes;
  out.push(res);
  console.error(JSON.stringify(res));
}
console.log(JSON.stringify({ base: BASE, requestsPerScenario: N, concurrency: CONC, generatedAt: new Date().toISOString(), results: out }, null, 2));
