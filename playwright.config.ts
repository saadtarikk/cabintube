import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4317', headless: true, viewport: { width: 1440, height: 960 },
    launchOptions: { executablePath: process.env.BROWSER_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--autoplay-policy=no-user-gesture-required'] } },
  reporter: 'list',
});
