import { defineConfig, devices } from "@playwright/test";

/** A browser that can capture scenes. The one that comes with Playwright cannot yet. */
const executablePath = process.env["AQ_CHROME"];

/** Not the usual port: a copy of the editor people run on this computer keeps its own. */
const PORT = 7659;

/**
 * The editor on this computer, the way `npx animaquill` runs it: the built package and its server,
 * with every site on a name of its own under `localhost`.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://animaquill.localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    headless: !process.env["AQ_HEADED"],
    launchOptions: {
      ignoreDefaultArgs: ["--hide-scrollbars"],
      // A frame per process as in people's browsers, and folders a page can write without asking,
      // as people allow, see folder-support.ts of the editor's tests.
      args: ["--site-per-process", "--enable-experimental-web-platform-features"],
      ...(executablePath && { executablePath }),
    },
    trace: process.env["CI"] ? "retain-on-failure" : "off",
  },
  webServer: {
    command: `pnpm build && node dist/cli.js --no-open --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
  },
});
