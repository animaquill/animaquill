import { defineConfig, devices } from "@playwright/test";
import { EDITOR, HEALTH } from "./e2e/hosts.ts";

// Capture needs a newer browser than the one that comes with Playwright. On that one, what is in a
// canvas has styles and animations, and images load, but it has no boxes: nothing to measure, no
// resolved transform, no font in use, and it cannot take the focus. The tests that need those carry
// @layout and only run on a plain page. Everything else runs on both stages. For the whole of it on
// the real stage, set AQ_CHROME to a browser that can capture.
const executablePath = process.env.AQ_CHROME;

export default defineConfig({
  testDir: "e2e",
  // CI runs a test that failed once more. One that passes the second time is listed as flaky at
  // the end of the run (and noted on the run, by the `github` reporter): it is not hidden, and
  // one that fails twice fails the run. Where people run them it is not tried again.
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["list"], ["github"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: EDITOR,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    launchOptions: {
      // Without this the test browser keeps every frame in one process, and a scene that hangs
      // hangs the page around it. People's browsers do not.
      args: ["--site-per-process"],
      ...(executablePath && { executablePath }),
    },
  },
  projects: executablePath
    ? [{ name: "canvas", metadata: { stage: "canvas" } }]
    : [
        { name: "plain", metadata: { stage: "plain" } },
        { name: "canvas", metadata: { stage: "canvas" }, grepInvert: /@layout/ },
      ],
  webServer: {
    command: "node e2e/server.ts",
    url: HEALTH,
    reuseExistingServer: true,
  },
});
