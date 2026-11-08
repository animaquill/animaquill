import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/** A browser that can capture scenes. The one that comes with Playwright cannot yet. */
const executablePath = process.env["AQ_CHROME"];

/**
 * Where the development page gets built for this run. One of its own, so that runs at the same
 * time from one clone do not take the files away from each other. The workers read this file too,
 * and get the same place from the environment. Removed by `e2e/teardown.ts`.
 */
const build = (process.env["AQ_E2E_BUILD"] ??= join(tmpdir(), `animaquill-e2e-${process.pid}`));

/**
 * The React for development says what is wrong with components, and is several times slower than
 * the one people get. `AQ_REACT=production` builds with that one, for measuring how fast it is.
 */
const react = process.env["AQ_REACT"] === "production" ? "production" : "development";

export default defineConfig({
  testDir: "e2e",
  // Every test opens a page of its own and leaves nothing for the next one, so the tests of a file
  // can run on different workers. Otherwise the longest file sets how long the whole run takes.
  fullyParallel: true,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    // With a window, on a virtual screen, a page behind another tab is hidden as for people.
    headless: !process.env["AQ_HEADED"],
    launchOptions: {
      // Headless browsers hide scrollbars, and people's browsers do not.
      ignoreDefaultArgs: ["--hide-scrollbars"],
      // Without this the test browser keeps every frame in one process, and a scene that hangs
      // hangs the page around it. People's browsers do not.
      args: ["--site-per-process"],
      ...(executablePath && { executablePath }),
    },
    // Recording a trace makes every test about a third slower, also those that pass. CI keeps one
    // of each failure. Here, run a failed test again by name with `--trace=on` to get one.
    trace: process.env["CI"] ? "retain-on-failure" : "off",
  },
  // A build of the development page, with what it has for tests, see `devPage` in e2e/support.ts.
  // On the development server every page that opens asks for each module on its own, which made
  // the whole run take almost twice as long, and the code editor most of all. React stays the one
  // for development unless `AQ_REACT` says otherwise, see above. A server that is already running,
  // like `pnpm dev`, gets used instead: no build then, and changes show without one.
  webServer: {
    command: `NODE_ENV=${react} pnpm exec vite build --logLevel warn --outDir ${build} && pnpm exec vite preview --outDir ${build}`,
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 180_000,
  },
  globalTeardown: "./e2e/teardown.ts",
});
