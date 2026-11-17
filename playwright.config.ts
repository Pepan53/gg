import { defineConfig, devices } from '@playwright/test';

const chrome = { launchOptions: { executablePath: process.env.CHROME_PATH } };

/**
 * End-to-end testy hlavního scénáře na různých rozlišeních.
 * Port 5173: build s testovací náhradou panoramat (bez sítě).
 * Port 5174: build bez klíčů (ověření, že se knihovny poskytovatelů nenačtou).
 * Systémový Chrome lze zadat přes CHROME_PATH, jinak se použije Chromium z Playwright.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { ...chrome, baseURL: 'http://localhost:5173', trace: 'off' },
  webServer: [
    {
      command: 'npx vite --port 5173 --strictPort',
      port: 5173,
      env: { VITE_E2E: '1' },
      reuseExistingServer: false,
    },
    {
      command: 'npx vite --port 5174 --strictPort',
      port: 5174,
      env: { VITE_E2E: '0', VITE_MAPILLARY_TOKEN: '', VITE_MAPY_API_KEY: '' },
      reuseExistingServer: false,
    },
  ],
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobil', use: { ...devices['Pixel 7'], ...chrome } },
    {
      name: 'fold-zavreny',
      use: {
        viewport: { width: 344, height: 882 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
    {
      name: 'fold-otevreny',
      use: {
        viewport: { width: 884, height: 1104 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2.5,
      },
    },
    {
      name: 'fold-otevreny-nasirku',
      use: {
        viewport: { width: 1104, height: 884 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2.5,
      },
    },
  ],
});
