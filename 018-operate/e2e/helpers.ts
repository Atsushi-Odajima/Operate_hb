import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PW = 'Operate-Demo-2026!';
export const ORG = 'sample-works';

export async function loginAs(browser: Browser, user: string, opts: { org?: string; password?: string; contextOptions?: Parameters<Browser['newContext']>[0] } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(opts.contextOptions);
  const page = await ctx.newPage();
  await login(page, user, opts.org, opts.password);
  return { ctx, page };
}

export async function login(page: Page, user: string, org = ORG, password = PW) {
  await page.goto('/login');
  await page.locator('#org').fill(org);
  await page.locator('#email').fill(user.includes('@') ? user : `${user}@${org}.example`);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** JSON API call using the page's session (cookie) and CSRF token. */
export async function apiCall(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(async ({ method, url, body }) => {
    const me = await (await fetch('/api/me')).json();
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  }, { method, url, body });
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 150_000, stepMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!ok(v)) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, stepMs));
    v = await fn();
  }
  return v;
}

export const dialog = (page: Page) => page.getByRole('dialog');
