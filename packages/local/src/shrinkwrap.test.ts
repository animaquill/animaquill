import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { shrinkwrapOf } from "../scripts/shrinkwrap.ts";

/**
 * What npm installs with the package is only the PostgreSQL of each platform, of exact versions and
 * hashes, as the workspace installed them (scripts/shrinkwrap.ts): the file of the repository is
 * that, and the package has no other dependency.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("npm-shrinkwrap.json", () => {
  test("is what the package and the lockfile say", () => {
    const manifest = JSON.parse(read("../package.json"));
    expect(read("../npm-shrinkwrap.json")).toBe(
      shrinkwrapOf(manifest, read("../../../pnpm-lock.yaml")),
    );
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.files).toContain("npm-shrinkwrap.json");
    expect(Object.keys(manifest.optionalDependencies).toSorted()).toEqual([
      "@embedded-postgres/darwin-arm64",
      "@embedded-postgres/darwin-x64",
      "@embedded-postgres/linux-arm64",
      "@embedded-postgres/linux-x64",
      "@embedded-postgres/windows-x64",
    ]);
    const shrinkwrap = JSON.parse(read("../npm-shrinkwrap.json"));
    for (const [name, entry] of Object.entries(shrinkwrap.packages)) {
      if (name === "") continue;
      expect(entry).toMatchObject({
        optional: true,
        integrity: expect.stringMatching(/^sha512-/),
        resolved: expect.stringMatching(/^https:\/\/registry\.npmjs\.org\/@embedded-postgres\//),
      });
    }
  });
});
