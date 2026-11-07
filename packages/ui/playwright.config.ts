import { defineConfig, devices } from "@playwright/test";

/** A browser that can capture scenes. The one that comes with Playwright cannot yet. */
const executablePath = process.env["AQ_CHROME"];

export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      // Headless browsers hide scrollbars, and people's browsers do not.
      ignoreDefaultArgs: ["--hide-scrollbars"],
      // Without this the test browser keeps every frame in one process, and a scene that hangs
      // hangs the page around it. People's browsers do not.
      args: ["--site-per-process"],
      ...(executablePath && { executablePath }),
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite",
    url: "http://localhost:5173",
    reuseExistingServer: true,
  },
});
