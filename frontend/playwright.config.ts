import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the static export served by FastAPI on a separate port,
// with a seeded demo library that is reused between runs (docs/ARCHITECTURE.md 14.3).
const PORT = 8765;
const LIBRARY = process.env.DAR_E2E_LIBRARY ?? join(tmpdir(), "dar-al-ilm-e2e-library");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // Tests share one seeded library, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          // Cloud sessions point this at the preinstalled Chromium (/opt/pw-browsers/chromium).
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        },
      },
    },
  ],
  webServer: {
    command: `../scripts/e2e-server.sh --port ${PORT} --data-dir "${LIBRARY}"`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
