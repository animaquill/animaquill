import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    // Headless browsers hide scrollbars, and people's browsers do not.
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite",
    url: "http://localhost:5173",
    reuseExistingServer: true,
  },
});
