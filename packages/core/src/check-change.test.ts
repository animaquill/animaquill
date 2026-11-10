import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { checkWhole, checkWritten, ruleAt } from "./check-change.ts";
import { ProjectStore } from "./store.ts";
import { MAX_SOURCE_BYTES } from "./source-size.ts";
import type { Path } from "./structure.ts";

/** Names that every object has, and that no table of the checks may take for one of its own. */
const OBJECT_NAMES = Object.getOwnPropertyNames(Object.prototype);

/** Where the format has fields by name: a key there is a field, never an id. */
const FIELD_PLACES: readonly Path[] = [
  [],
  ["manifest"],
  ["timelines", "main"],
  ["timelines", "main", "sections", "s1"],
  ["timelines", "main", "markers", "m1"],
  ["timelines", "main", "tracks", "t1"],
  ["timelines", "main", "clips", "c1"],
  ["timelines", "main", "clips", "c1", "effects", "e1"],
  ["timelines", "main", "joins", "j1"],
  ["timelines", "main", "overrides", "v1"],
  ["timelines", "main", "overrides", "v1", "clips", "c1"],
];

const VALUES: readonly (() => unknown)[] = [
  () => "x",
  () => 1,
  () => ({ evil: true }),
  () => {
    const doc = new Y.Doc();
    const map = doc.getMap("m");
    map.set("x", 1);
    return map;
  },
];

const fixture = (name: string) =>
  Uint8Array.from(
    Buffer.from(
      readFileSync(new URL(`../fixtures/${name}/document.txt`, import.meta.url), "utf8"),
      "base64",
    ),
  );

describe("checkWritten", () => {
  it("takes no name that every object has for a field, in any table, and never throws", () => {
    for (const place of FIELD_PLACES) {
      for (const name of OBJECT_NAMES) {
        const path = [...place, name];
        for (const value of VALUES) {
          let fault: ReturnType<typeof checkWritten>;
          expect(() => (fault = checkWritten(path, value())), path.join("/")).not.toThrow();
          expect(fault, path.join("/")).toBeDefined();
        }
        if (name !== "__proto__") expect(ruleAt(path), path.join("/")).toBeUndefined();
      }
    }
  });

  it("takes the names that every object has for ids, as the editor does", () => {
    const doc = new Y.Doc();
    const clip = doc.getMap("clips");
    clip.set("name", "a clip");
    expect(checkWritten(["timelines", "main", "clips", "constructor"], clip)).toBeUndefined();
    expect(checkWritten(["timelines", "main", "clips", "toString", "name"], "x")).toBeUndefined();
  });

  it("takes the changes of a version as values of what they change", () => {
    const at = (...rest: string[]): Path => ["timelines", "main", "overrides", "v1", ...rest];
    expect(checkWritten(at("clips", "c1", "start"), { value: "1" })).toBeUndefined();
    expect(checkWritten(at("clips", "c1", "start"), { value: "1", base: "0" })).toBeUndefined();
    expect(checkWritten(at("clips", "c1", "start"), { value: 5 })).toBeDefined();
    expect(checkWritten(at("clips", "c1", "hidden"), { value: true })).toBeUndefined();
    expect(checkWritten(at("clips", "c1", "name"), { value: "x" })).toBeDefined();
    expect(
      checkWritten(at("clips", "c1", "properties", "opacity"), { value: 0.5 }),
    ).toBeUndefined();
    expect(checkWritten(at("clips", "c1", "properties", "opacity"), [{ a: 1 }])).toBeDefined();
    expect(checkWritten(at("sections", "s1"), { duration: { value: "2" } })).toBeUndefined();
    expect(
      checkWritten(
        at("sections", "s1"),
        Array.from({ length: 9 }, () => ({})),
      ),
    ).toBeDefined();
  });

  it("takes files of code by the rules that the editor writes them by", () => {
    const text = (content: string) => {
      const doc = new Y.Doc();
      const made = doc.getText("t");
      made.insert(0, content);
      return made;
    };
    expect(checkWritten(["files", "code/a.js"], text("a"))).toBeUndefined();
    expect(checkWritten(["files", "code/a\\b.js"], text("a"))).toBeDefined();
    expect(
      checkWritten(["files", "code/a.js"], text("a".repeat(MAX_SOURCE_BYTES))),
    ).toBeUndefined();
    expect(
      checkWritten(["files", "code/a.js"], text("a".repeat(MAX_SOURCE_BYTES + 1))),
    ).toBeDefined();
    // Larger in UTF-8 than in characters.
    expect(
      checkWritten(["files", "code/a.js"], text("好".repeat(Math.floor(MAX_SOURCE_BYTES / 3) + 1))),
    ).toBeDefined();
  });
});

describe("documents from before, as people have them", () => {
  for (const name of ["before-flat-levels", "before-flat-versions"]) {
    it(`takes ${name} as it is, and once today's editor changed it`, () => {
      const { store } = ProjectStore.fromUpdates([fixture(name)]);
      if (!store) throw new Error("the sample did not open");
      expect(checkWhole(store.doc)).toBeUndefined();
      store.execute({ type: "project.rename", params: { name: "改过" } });
      const copy = ProjectStore.fromUpdates([store.encodeWhole()]).store as ProjectStore;
      expect(checkWhole(copy.doc)).toBeUndefined();
    });
  }

  it("takes what a page from back then writes the way it did, as long as it is not large", () => {
    const store = ProjectStore.fromUpdates([fixture("before-flat-levels")]).store as ProjectStore;
    const main = (store.doc.getMap("project").get("timelines") as Y.Map<Y.Map<unknown>>).get(
      "main",
    ) as Y.Map<unknown>;
    const transitions = main.get("transitions") as Y.Map<unknown>;
    const kept = new Y.Map<unknown>();
    transitions.set("tr_9", kept);
    kept.set("kind", "fade");
    expect(checkWritten(["timelines", "main", "transitions", "tr_9"], kept)).toBeUndefined();
    expect(
      checkWritten(["timelines", "main", "clips", "c1", "effects"], [{ type: "blur" }]),
    ).toBeUndefined();
    kept.set("large", "x".repeat(5 * 1024 * 1024));
    expect(checkWritten(["timelines", "main", "transitions", "tr_9"], kept)).toBeDefined();
  });
});
