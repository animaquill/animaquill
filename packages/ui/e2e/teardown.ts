import { rmSync } from "node:fs";

/** Removes the build the tests ran on, see `webServer` in playwright.config.ts. */
export default function teardown(): void {
  const build = process.env["AQ_E2E_BUILD"];
  // Only what the config made: this is a variable anyone can set.
  if (build?.includes("animaquill-e2e-")) rmSync(build, { recursive: true, force: true });
}
