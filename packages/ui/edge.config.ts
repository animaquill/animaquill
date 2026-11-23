import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env["AQ_CHROME"];

/** The real sites, in a container where their names lead to the servers next to the browser. */
export default defineConfig({
  testDir: "./e2e",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "https://app.animaquill.com",
    viewport: { width: 1440, height: 900 },
    // The editor follows the system's theme unless people choose, and the tests that read colours
    // were written for the dark one: a system in dark, as before there were two. appearance.spec.ts
    // tries the others.
    colorScheme: "dark",
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: [
        "--site-per-process",
        "--ignore-certificate-errors",
        // The pretend AI service of deployment-relay.spec.ts is where the API finds it too.
        "--host-resolver-rules=MAP llm.example 11.22.33.44, MAP *.animaquill.com 127.0.0.1, MAP *.animaquill.dev 127.0.0.1, MAP *.example 127.0.0.1",
      ],
      ...(executablePath && { executablePath }),
    },
  },
});
