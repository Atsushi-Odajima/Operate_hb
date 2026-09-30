import { describe, expect, it } from 'vitest';
import { login, seed } from './helpers.js';

describe('smoke', () => {
  it('seeds and logs in', async () => {
    await seed('smoke-co');
    const c = await login('member-cs', 'smoke-co');
    const me = await c.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.roles).toContain('member');
    const s = await c.get('/api/search?q=返金');
    expect(s.status).toBe(200);
    expect(s.body.items.length).toBeGreaterThan(0);
    const d = await c.get('/api/dashboard');
    expect(d.status).toBe(200);
  });
});
