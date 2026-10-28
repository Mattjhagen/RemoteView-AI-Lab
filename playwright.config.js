const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {baseURL: 'http://127.0.0.1:18765', headless: true,
    launchOptions: {executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox']},
    screenshot: 'only-on-failure'},
  webServer: {command: 'python3 tests/browser_server.py', url: 'http://127.0.0.1:18765', reuseExistingServer: false, timeout: 10000},
});
