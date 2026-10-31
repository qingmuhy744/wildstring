import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const baseURL = `http://127.0.0.1:${process.env.WILDSTRING_WEB_TEST_PORT || '18782'}`;

export default defineConfig({
  testDir: './tests',
  outputDir: '../../artifacts/browser-tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    // Existing specs assert the Chinese UI; i18n.spec.ts covers English.
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: process.env.WILDSTRING_WEB_TEST_SERVER || 'make web-test-server',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: `${baseURL}/health/ready`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 2000 },
  },
});
