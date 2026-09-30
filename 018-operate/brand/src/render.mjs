// Render PNG brand assets from the SVG sources with headless Chromium.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const here = new URL('..', import.meta.url).pathname;
const mark = readFileSync(here + 'logo-mark.svg', 'utf8');
const markDark = readFileSync(here + 'logo-mark-dark.svg', 'utf8');
const horiz = readFileSync(here + 'logo-horizontal.svg', 'utf8');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
async function shot(file, w, h, html, transparent = false) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;${transparent ? 'background:transparent' : ''}}</style></head><body>${html}</body></html>`);
  await page.screenshot({ path: here + file, omitBackground: transparent });
}
const icon = (size, bg, m, pad) => `<div style="width:${size}px;height:${size}px;background:${bg};display:grid;place-items:center"><div style="width:${size * (1 - 2 * pad)}px;height:${size * (1 - 2 * pad)}px">${m.replace('<svg ', '<svg width="100%" height="100%" ')}</div></div>`;
await shot('app-icon-512.png', 512, 512, icon(512, '#FFFFFF', mark, 0.14));
await shot('app-icon-192.png', 192, 192, icon(192, '#FFFFFF', mark, 0.14));
await shot('app-icon-maskable-512.png', 512, 512, icon(512, '#FFFFFF', mark, 0.24)); // safe zone: 80% circle
await shot('app-icon-dark-512.png', 512, 512, icon(512, '#0B1A33', markDark, 0.16));
await shot('apple-touch-icon.png', 180, 180, icon(180, '#FFFFFF', mark, 0.15));
await shot('favicon-32.png', 32, 32, icon(32, 'transparent', readFileSync(here + 'favicon.svg', 'utf8'), 0.02), true);
await shot('favicon-16.png', 16, 16, icon(16, 'transparent', readFileSync(here + 'favicon.svg', 'utf8'), 0), true);
await shot('favicon-48.png', 48, 48, icon(48, 'transparent', readFileSync(here + 'favicon.svg', 'utf8'), 0.02), true);
const font = `font-family:'Hiragino Sans','Noto Sans JP','IPAGothic',sans-serif`;
await shot('og-image.png', 1200, 630, `<div style="width:1200px;height:630px;background:#fff;position:relative;${font};color:#0B1A33">
  <div style="position:absolute;right:-160px;top:-160px;width:620px;height:620px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#E0F2FE,#EFF6FF 60%,#fff 70%)"></div>
  <div style="position:absolute;left:96px;top:120px;width:560px">${horiz.replace('<svg ', '<svg width="100%" ')}</div>
  <div style="position:absolute;left:100px;top:300px;font-size:44px;font-weight:700;letter-spacing:.02em">会社のマニュアル・新人教育・<br>ルール変更を、ひとつにまとめる。</div>
  <div style="position:absolute;left:100px;top:470px;font-size:28px;color:#334155">仕事のやり方が、会社の力になる。</div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:14px;background:linear-gradient(90deg,#22D3EE,#2563EB,#1E3A8A)"></div></div>`);
await browser.close();
console.log('rendered');
