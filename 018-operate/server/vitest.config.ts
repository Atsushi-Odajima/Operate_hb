import { defineConfig } from 'vitest/config';

const DB = process.env.TEST_DB ?? 'operate_test';
export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: `postgres://operate_app:operate_app@127.0.0.1:5432/${DB}`,
      DATABASE_ADMIN_URL: `postgres://postgres:postgres@127.0.0.1:5432/${DB}`,
      APP_SECRET: 'test-secret-test-secret-test-secret-123',
      RUN_WORKER: 'false',
      TEST_DB: DB,
    },
  },
});
