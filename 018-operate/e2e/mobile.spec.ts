/** E2E-8 + PWA / offline checks. Runs on iPhone 13, Pixel 7 and iPad (gen 7) device emulation. */
import { expect, test } from '@playwright/test';
import { apiCall, loginAs } from './helpers';

test('E2E-8: スマホ PWA で SOP 検索 → Step 実行モード → Checklist 完了 → PC 管理画面へ反映', async ({ browser }, info) => {
  const device = info.project.use;
  const m = await loginAs(browser, 'member-it', { contextOptions: device as any });
  const p = m.page;
  // bottom tab bar on phones; iPad (768px) also uses the mobile layout
  await p.getByRole('navigation', { name: 'タブ' }).getByRole('link', { name: '検索' }).click();
  await p.getByLabel('検索語または質問').fill('アカウント発行');
  await p.getByRole('button', { name: '検索', exact: true }).click();
  await p.getByRole('link', { name: /IT-005 新入社員アカウント発行/ }).click();
  await p.getByRole('link', { name: 'ステップ表示で実行' }).click();
  await expect(p).toHaveURL(/\/checklists\/[0-9a-f-]+$/);
  const runId = p.url().split('/').pop();
  for (let i = 1; i <= 4; i++) {
    await expect(p.getByText(`手順 ${i} / 4`)).toBeVisible();
    for (const box of await p.locator('.step-card input[type=checkbox]').all()) await box.check();
    if (i < 4) await p.getByRole('button', { name: '次へ' }).click();
  }
  const done = p.getByRole('button', { name: '完了として記録する' });
  await expect(done).toBeEnabled();
  await done.click();
  await expect(p.getByText(/に完了しました/)).toBeVisible();
  // tap targets on the run screen are at least 44px high
  const h = await p.getByRole('button', { name: '前へ' }).evaluate((e) => e.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(44);

  // The PC management screen shows the completed run
  const pc = await loginAs(browser, 'admin');
  await pc.page.goto('/checklists');
  await pc.page.getByRole('tab', { name: 'すべての記録' }).click();
  const row = pc.page.getByRole('row').filter({ has: pc.page.getByRole('link', { name: '新入社員アカウント発行' }) }).filter({ hasText: '小林 大輔（IT）' }).first();
  await expect(row).toBeVisible();
  const runs = (await apiCall(pc.page, 'GET', '/api/checklist-runs?scope=all')).body;
  expect(runs.find((r: any) => r.id === runId)?.status).toBe('completed');
  await m.ctx.close();
  await pc.ctx.close();
});

test('PWA: manifest / icons / service worker、許可された文書のオフライン閲覧と機密文書の保存拒否', async ({ browser }, info) => {
  const { ctx, page } = await loginAs(browser, 'member-it', { contextOptions: info.project.use as any });
  const man = await (await page.request.get('/manifest.webmanifest')).json();
  expect(man.name).toBe('Operate');
  expect(man.short_name).toBe('Operate');
  expect(man.display).toBe('standalone');
  expect(man.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
  for (const i of man.icons) expect((await page.request.get(i.src)).status()).toBe(200);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  expect(await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; })).toBe(true);
  await page.reload(); // page is now controlled by the service worker

  // save an internal document for offline use
  const faq = (await apiCall(page, 'GET', '/api/search?q=' + encodeURIComponent('経費'))).body.items[0];
  await page.goto(`/documents/${faq.id}`);
  await page.getByRole('button', { name: '端末に保存' }).click();
  await expect(page.getByText('この端末に保存しました')).toBeVisible();

  // restricted document cannot be saved offline
  const it020 = (await apiCall(page, 'GET', '/api/search?q=' + encodeURIComponent('退職者'))).body.items.find((x: any) => x.doc_number === 'IT-020');
  await page.goto(`/documents/${it020.id}`);
  await expect(page.getByText('この機密区分はオフライン保存できません')).toBeVisible();

  await ctx.setOffline(true);
  await page.goto('/offline');
  await expect(page.getByText('オフラインです。')).toBeVisible();
  await page.getByRole('button', { name: /経費精算の締め日/ }).click();
  await expect(page.getByRole('dialog').getByText('毎月25日です。')).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/端末に保存したコピー（v1\.0/)).toBeVisible();
  await ctx.setOffline(false);
  await ctx.close();
});
