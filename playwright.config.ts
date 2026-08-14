import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

const e2eDatabasePath = path.join(tmpdir(), "gsplayer20-e2e.sqlite");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  webServer: {
    command:
      "node db/scripts/migrate.js && npm run build && node scripts/test/start-standalone.mjs",
    url: "http://127.0.0.1:3100/login",
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      APP_PIN: "123456",
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      AUTH_URL: "http://127.0.0.1:3100",
      NEXTAUTH_URL: "http://127.0.0.1:3100",
      SPOTIFY_CLIENT_ID: "test-client",
      SPOTIFY_CLIENT_SECRET: "test-secret",
      TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      DB_PATH: e2eDatabasePath,
    },
  },
});
