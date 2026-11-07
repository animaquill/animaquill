import { describe, expect, it } from "vitest";
import { compositorFrameSource, SCENE_POLICY, scenePage, scenePolicyHeader } from "./policy.ts";

describe("the scene page's policy", () => {
  it("is the policy that was tested", () => {
    expect(scenePolicyHeader()).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; " +
        "style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; " +
        "media-src blob: data:; connect-src blob: data:; base-uri 'none'; form-action 'none'; " +
        "sandbox allow-scripts",
    );
  });

  it("names no place outside the document", () => {
    const sources = Object.values(SCENE_POLICY).flatMap((value) => value.split(" "));
    expect(
      sources.filter((source) => /[.:/]/.test(source) && !/^(blob|data):$/.test(source)),
    ).toEqual([]);
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("'self'");
    expect(sources).not.toContain("https:");
  });

  it("gives the document no origin, and so no storage", () => {
    expect(SCENE_POLICY.sandbox).not.toContain("allow-same-origin");
  });

  it("does not try to name the pages around it, which nothing could match", () => {
    expect(scenePolicyHeader()).not.toContain("frame-ancestors");
  });

  it("writes the editors of a deployment into the page, as data", () => {
    const template = `<html data-editors="[]"><body>[]</body></html>`;
    const page = scenePage(template, ["https://app.test"]);
    expect(page).toBe(`<html data-editors="[&quot;https://app.test&quot;]"><body>[]</body></html>`);
    expect(scenePage(template, [`"><script>`])).not.toContain("<script>");
    expect(scenePage(template, ["a&quot;b"])).toContain("a&amp;quot;b");
    expect(scenePage(template, ["$&"])).toContain("&quot;$&amp;&quot;");
  });

  it("tells the compositor what it has to allow", () => {
    expect(compositorFrameSource(["https://a.test", "https://b.test"])).toBe(
      "frame-src https://a.test https://b.test",
    );
  });
});
