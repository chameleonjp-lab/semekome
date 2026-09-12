import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'], viewport: { width: 402, height: 700 }, launchOptions: process.env.SEMEKOME_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SEMEKOME_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage'] } : {} } },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 664 } } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
