import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What public/boot.js puts on the page before the editor is there: the theme and the size of words
 * people chose (`Appearance` in the editor keeps them), else the system's theme.
 */

const script = readFileSync(new URL("../public/boot.js", import.meta.url), "utf8");

function boot(saved: string | null, systemLight: boolean): Record<string, string> {
  const dataset: Record<string, string> = {};
  const page = {
    localStorage: { getItem: (key: string) => (key === "animaquill.appearance" ? saved : null) },
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: light)" && systemLight,
    }),
    document: { documentElement: { dataset } },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  new Function(...Object.keys(page), script)(...Object.values(page));
  return dataset;
}

const saved = (value: unknown) => JSON.stringify(value);

describe("the page before the editor", () => {
  it("follows the system where nothing was chosen", () => {
    expect(boot(null, true)).toEqual({ theme: "light", fontSize: "normal" });
    expect(boot(null, false)).toEqual({ theme: "dark", fontSize: "normal" });
    expect(boot(saved({ version: 1, theme: "system", fontSize: "normal" }), true)).toEqual({
      theme: "light",
      fontSize: "normal",
    });
  });

  it("takes what was chosen, whatever the system", () => {
    expect(boot(saved({ version: 1, theme: "light", fontSize: "large" }), false)).toEqual({
      theme: "light",
      fontSize: "large",
    });
    expect(boot(saved({ version: 1, theme: "dark", fontSize: "small" }), true)).toEqual({
      theme: "dark",
      fontSize: "small",
    });
  });

  it("goes by the system where what was kept cannot be read", () => {
    for (const broken of ["{", saved({ version: 2, theme: "light" }), saved("light")])
      expect(boot(broken, false), broken).toEqual({ theme: "dark", fontSize: "normal" });
  });
});
