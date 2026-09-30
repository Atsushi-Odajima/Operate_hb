import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8090);
const exe = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const chromium = { browserName: 'chromium' as const, launchOptions: { executablePath: exe } };

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../test-results/e2e.json' }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  webServer: { command: 'bash ./start-server.sh', url: `http://localhost:${PORT}/api/health`, timeout: 180_000, reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe' },
  projects: [
    { name: 'desktop', testMatch: /flows\.spec\.ts|a11y\.spec\.ts/, use: { ...devices['Desktop Chrome'], ...chromium, viewport: { width: 1366, height: 900 } } },
    { name: 'iphone', testMatch: /mobile\.spec\.ts/, use: { ...devices['iPhone 13'], ...chromium } },
    { name: 'android', testMatch: /mobile\.spec\.ts/, use: { ...devices['Pixel 7'], ...chromium } },
    { name: 'ipad', testMatch: /mobile\.spec\.ts/, use: { ...devices['iPad (gen 7)'], ...chromium } },
  ],
});
