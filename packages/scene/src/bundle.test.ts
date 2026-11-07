import { describe, expect, it } from "vitest";
import { bundleRuntime } from "./bundle.ts";

describe("bundleRuntime", () => {
  it("makes one script that keeps the notices of what is in it", async () => {
    const { code, files } = await bundleRuntime();
    const bundled = files.filter((file) => file.includes("node_modules"));
    for (const name of ["parse5", "entities", "es-module-lexer", "@csstools/css-tokenizer"]) {
      expect(bundled.some((file) => file.includes(`/node_modules/${name}/`))).toBe(true);
      expect(code.slice(0, code.indexOf("*/"))).toContain(`${name} `);
    }
    const notices = code.slice(0, code.indexOf("*/"));
    expect(notices).toContain("Redistributions in binary form must reproduce");
    expect(notices).toContain("Permission is hereby granted");
    expect(() => new Function(code)).not.toThrow();
  }, 60000);
});
