import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every key of the local storage the editor writes has the scope of the page in it, see
 * `scoped`, or is one of the few of the whole device: what `dropUnscopedData` keeps. One without
 * would be shared by the modes and the accounts, and taken away as left over from before the
 * scopes, at every page that starts.
 */

const PACKAGES = new URL("../..", import.meta.url).pathname;

/** The code of the packages, without tests, as the page has it. */
function sources(): { readonly file: string; readonly text: string }[] {
  const found: { file: string; text: string }[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "e2e", "dev", "dist", "test-results"].includes(entry.name))
          walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|-support\.ts$/.test(entry.name)) {
        found.push({ file: path.slice(PACKAGES.length), text: readFileSync(path, "utf8") });
      }
    }
  };
  for (const name of readdirSync(PACKAGES)) walk(join(PACKAGES, name, "src"));
  return found;
}

/** Keys of the whole device, by the names of their constants: all in `UNSCOPED_KEPT`. */
const DEVICE_KEYS = new Set([
  "PERSIST_ASKED_KEY",
  "PROJECTS_HERE_KEY",
  "CLEAR_KEY",
  "RELAY_TRUST_KEY",
  "RELAY_PORTS_KEY",
  "LOCAL_BINDING_KEY",
  "OFFLINE_HINT_KEY",
]);

describe("the keys of the local storage", () => {
  it("are of the scope of the page, or of the device and kept", () => {
    const wrong: string[] = [];
    const call =
      /\b(?:localStorage|storage\(\)|local\(\))\.(?:getItem|setItem|removeItem)\(\s*([^,)]+)/g;
    for (const { file, text } of sources()) {
      for (const match of text.matchAll(call)) {
        const key = (match[1] ?? "").trim();
        const isScoped = key.startsWith("scoped(") || key.startsWith("keyOf(");
        // What remembers the modes, and what takes away what was before, go by keys given.
        const isGiven = file === "host/src/browser.ts" && key === "key";
        if (!isScoped && !isGiven && !DEVICE_KEYS.has(key)) wrong.push(`${file}: ${key}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("of the device are not taken away as left over from before", () => {
    const browser = readFileSync(join(PACKAGES, "host/src/browser.ts"), "utf8");
    const kept = /const UNSCOPED_KEPT[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(browser)?.[1] ?? "";
    for (const name of DEVICE_KEYS) expect(kept).toContain(name);
  });
});
