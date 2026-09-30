/** Automated accessibility scan (axe-core, WCAG 2.1 A/AA rules) of the main screens. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiCall, loginAs } from './helpers';

test('主要画面に重大 (critical / serious) なアクセシビリティ違反がない', async ({ browser }) => {
  test.setTimeout(180_000);
  const report: Record<string, unknown[]> = {};
  const scan = async (page: any, name: string) => {
    await page.waitForLoadState('networkidle');
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    report[name] = r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target }));
    return r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  };
  const anon = await browser.newContext();
  const lp = await anon.newPage();
  await lp.goto('/login');
  const bad: Record<string, unknown> = {};
  const add = (n: string, v: any[]) => { if (v.length) bad[n] = v.map((x) => `${x.id}: ${x.help} ${JSON.stringify(x.nodes[0]?.target)}`); };
  add('login', await scan(lp, 'login'));
  const { page } = await loginAs(browser, 'admin');
  const pol = (await apiCall(page, 'GET', '/api/search?q=' + encodeURIComponent('持ち出し'))).body.items[0].id;
  for (const [name, url] of [['home', '/'], ['search', '/search?q=返金'], ['documents', '/documents'], ['document', `/documents/${pol}`], ['history', `/documents/${pol}/history`],
    ['new-document', '/documents/new'], ['training-admin', '/manage/training'], ['health', '/health'], ['admin-users', '/admin?tab=users'], ['admin-ai', '/admin?tab=ai'], ['checklists', '/checklists']] as const) {
    await page.goto(url);
    add(name, await scan(page, name));
  }
  const member = await loginAs(browser, 'newhire');
  await member.page.goto('/training');
  add('training', await scan(member.page, 'training'));
  // Resolve from this file, not the process cwd (e2e may be started from the project root).
  const outDir = resolve(__dirname, '../test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'a11y.json'), JSON.stringify(report, null, 2));
  expect(bad).toEqual({});
});
