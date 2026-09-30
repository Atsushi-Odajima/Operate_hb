import { chromium } from '@playwright/test';
const here = new URL('.', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1536, height: 1024 } });
await p.goto('file://' + here + 'board.html');
await p.waitForTimeout(300);
await p.screenshot({ path: here + '../brand-board.png' });
await b.close();
