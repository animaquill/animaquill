import { describe, expect, test } from "vitest";
import {
  checkSites,
  compositorPolicy,
  editorPolicy,
  LOCAL_PORT,
  localSites,
  siteHeaders,
  type Sites,
} from "./sites.ts";

const deployed: Sites = {
  editor: "https://editor.example",
  compositor: "https://compositor.example.net",
  scenes: ["https://scene-0.example.net", "https://scene-1.example.net"],
};

describe("localSites", () => {
  test("gives every site a name of its own under localhost, at one port", () => {
    expect(localSites(4321)).toEqual({
      editor: "http://animaquill.localhost:4321",
      compositor: "http://animaquill-sandbox.localhost:4321",
      scenes: [0, 1, 2, 3, 4, 5, 6, 7].map(
        (index) => `http://animaquill-scene-${index}.localhost:4321`,
      ),
    });
    expect(() => checkSites(localSites())).not.toThrow();
    expect(localSites().editor).toBe(`http://animaquill.localhost:${LOCAL_PORT}`);
  });

  test("writes origins as the browser does", () => {
    expect(localSites(80).editor).toBe("http://animaquill.localhost");
  });

  test("refuses what is no port", () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => localSites(port), String(port)).toThrow(RangeError);
    }
  });
});

describe("checkSites", () => {
  test("wants origins, and each site apart", () => {
    expect(() => checkSites(deployed)).not.toThrow();
    expect(() => checkSites({ ...deployed, compositor: deployed.editor })).toThrow();
    expect(() =>
      checkSites({ ...deployed, scenes: [deployed.compositor, ...deployed.scenes] }),
    ).toThrow();
    expect(() => checkSites({ ...deployed, scenes: [] })).toThrow();
    expect(() => checkSites({ ...deployed, editor: "https://editor.example/" })).toThrow();
    expect(() => checkSites({ ...deployed, editor: "editor.example" })).toThrow();
  });
});

describe("policies", () => {
  test("the editor shows only the compositor, and adds the pictures a deployment has", () => {
    expect(editorPolicy(deployed, { images: ["https://pictures.example"] })).toBe(
      "default-src 'none'; script-src 'self'; worker-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://pictures.example; " +
        "font-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; " +
        "manifest-src 'self'; frame-src https://compositor.example.net; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'",
    );
    expect(editorPolicy(deployed)).toContain("img-src 'self' data: blob:;");
  });

  test("the compositor runs its own code, shows only scenes, and only in the editor", () => {
    expect(compositorPolicy(deployed)).toBe(
      "default-src 'none'; script-src https://compositor.example.net; img-src blob:; " +
        "media-src blob:; frame-src https://scene-0.example.net https://scene-1.example.net; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors https://editor.example",
    );
  });

  test("every site has its headers, and sites that are not apart have none", () => {
    const headers = siteHeaders(deployed);
    expect(headers.editor["Content-Security-Policy"]).toBe(editorPolicy(deployed));
    expect(headers.compositor["Access-Control-Allow-Origin"]).toBe("*");
    expect(headers.scene["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    expect(headers.editor["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(() => siteHeaders({ ...deployed, compositor: deployed.editor })).toThrow();
  });
});
