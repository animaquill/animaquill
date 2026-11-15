import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import { LICENSES_FILE } from "../build/licenses.ts";

/** The server and the command line as the package has them, built without writing anything. */
async function built(): Promise<Rolldown.RolldownOutput> {
  const output = await build({
    configFile: fileURLToPath(new URL("../vite.server.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    build: { write: false },
  });
  return (Array.isArray(output) ? output[0] : output) as Rolldown.RolldownOutput;
}

describe("the code of others in the package", { timeout: 120_000 }, () => {
  it("comes with the license of every package it is from", async () => {
    const { output } = await built();
    const notices = output.find((file) => file.fileName === LICENSES_FILE);
    expect(notices?.type).toBe("asset");
    const text = String((notices as Rolldown.OutputAsset).source);
    // Every package whose code is in the bundle, as the paths of its modules name it.
    const bundled = new Set(
      output
        .flatMap((file) => (file.type === "chunk" ? file.moduleIds : []))
        .flatMap((id) => /node_modules\/\.pnpm\/([^/]+)\//.exec(id)?.[1] ?? []),
    );
    expect(bundled.size).toBeGreaterThan(3);
    for (const folder of bundled) {
      // "@scope+name@1.2.3" or "name@1.2.3", with what it was built for after a "_".
      const [, name = "", version = ""] = /^(@?[^@]+)@([^_]+)/.exec(folder) ?? [];
      const heading = `${name.replace("+", "/")}@${version} (`;
      expect(text, heading).toContain(heading);
      const section = text.slice(text.indexOf(heading)).split(/\n={78}\n/)[1] ?? "";
      expect(section, heading).toMatch(/^--- (LICEN[CS]E|COPYING|NOTICE)/im);
    }
    expect(text).toContain("Apache License");
  });
});
