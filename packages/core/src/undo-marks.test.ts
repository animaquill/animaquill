/**
 * What the marks of undo records count on in Yjs (13.6.33), measured: see `Mark`. Each test makes a
 * document the way the store writes one, and looks at the marks before and after it was saved and
 * opened again.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { documentMark, marksAround, type Marks } from "./undo-marks.ts";
import type { Path } from "./structure.ts";

type Root = Y.Map<unknown>;

function project(): { doc: Y.Doc; root: Root } {
  const doc = new Y.Doc();
  const root = doc.getMap<unknown>("project");
  doc.transact(() => {
    root.set("manifest", new Y.Map());
    root.set("files", new Y.Map());
    const timelines = new Y.Map();
    root.set("timelines", timelines);
    const main = new Y.Map();
    timelines.set("main", main);
    main.set("clips", new Y.Map());
  });
  return { doc, root };
}

const at = (root: Root, path: Path): Y.Map<unknown> =>
  path.reduce((map, key) => map.get(key) as Y.Map<unknown>, root);

function marks(root: Root, where: Path): Marks {
  const into: Marks = new Map();
  marksAround(root, where, into);
  return into;
}

const markOf = (root: Root, where: Path) => marks(root, where).get(where.join("\n"))?.mark;

/** The same document, saved and opened again. */
function reopened(doc: Y.Doc): Root {
  const again = new Y.Doc();
  Y.applyUpdate(again, Y.encodeStateAsUpdate(doc));
  return again.getMap<unknown>("project");
}

const entry = (map: Y.Map<unknown>, key: string) =>
  // oxlint-disable-next-line no-underscore-dangle -- the item of a key, which is what this is about
  (map as unknown as { _map: Map<string, Y.Item> })._map.get(key) as Y.Item;

const NAME = ["manifest", "name"];
const CLIPS = ["timelines", "main", "clips"];
const CLIP = [...CLIPS, "c1"];
const OPACITY = [...CLIP, "properties", "opacity"];
const CODE = ["files", "code/a.js"];

describe("marks of what the document holds", () => {
  it("are another for the same value written again, and for a key taken away and written again", () => {
    const { root } = project();
    const manifest = at(root, ["manifest"]);
    manifest.set("name", "a");
    const first = markOf(root, NAME);
    manifest.set("name", "a");
    const again = markOf(root, NAME);
    expect(again).not.toBe(first);
    manifest.delete("name");
    const gone = markOf(root, NAME);
    expect(gone).toBe(`${again}-`);
    manifest.set("name", "a");
    expect(new Set([first, again, gone, markOf(root, NAME)]).size).toBe(4);
  });

  it("stay the same where Yjs joins the items of a key, which changes the id of the first", () => {
    const { doc, root } = project();
    const manifest = at(root, ["manifest"]);
    manifest.set("name", "a");
    manifest.set("name", "b");
    manifest.set("name", "c");
    manifest.delete("name");
    const before = entry(manifest, "name");
    const mark = markOf(root, NAME);
    // Three values one after the other, all gone: one item, which starts where the first one did.
    expect(before.length).toBe(3);
    const again = reopened(doc);
    expect(entry(at(again, ["manifest"]), "name").length).toBe(3);
    expect(markOf(again, NAME)).toBe(mark);
  });

  it("stay the same once the garbage collector took what is gone", () => {
    const { doc, root } = project();
    expect(doc.gc).toBe(true);
    const clips = at(root, CLIPS);
    const clip = new Y.Map<unknown>();
    clips.set("c1", clip);
    clip.set("properties/opacity", { value: 1 });
    clip.set("properties/opacity", { value: 0.5 });
    clip.delete("properties/opacity");
    const kept = markOf(root, OPACITY);
    expect(entry(clip, "properties/opacity").content).toBeInstanceOf(Y.ContentDeleted);
    expect(markOf(reopened(doc), OPACITY)).toBe(kept);
    // A map that is gone itself is emptied, which its mark says: what was in it is not looked at.
    clip.set("name", "x");
    clips.delete("c1");
    const around = marks(root, CLIP);
    expect([...around.keys()].filter((key) => key.startsWith(CLIP.join("\n")))).toEqual([
      CLIP.join("\n"),
    ]);
    expect(around.get(CLIP.join("\n"))?.mark).toMatch(/-$/);
    expect(marks(reopened(doc), CLIP)).toEqual(around);
  });

  it("of a map change with whatever is written in it, and with the maps above it", () => {
    const { root } = project();
    const clips = at(root, CLIPS);
    const clip = new Y.Map<unknown>();
    clips.set("c1", clip);
    clip.set("start", "0");
    const before = marks(root, CLIP);
    clip.set("properties/opacity", { value: 1 });
    const after = marks(root, CLIP);
    // The new key is there, under the path the store reads it at.
    expect(after.get(OPACITY.join("\n"))).toBeDefined();
    expect(before.get(OPACITY.join("\n"))).toBeUndefined();
    // A timeline written anew takes along all that was in it.
    const timeline = new Y.Map<unknown>();
    at(root, ["timelines"]).set("main", timeline);
    const replaced = marks(root, OPACITY);
    expect(replaced.get(["timelines", "main"].join("\n"))?.mark).not.toBe(
      after.get(["timelines", "main"].join("\n"))?.mark,
    );
    expect(replaced.get(OPACITY.join("\n"))?.mark).toBe("^");
  });

  it("of a text change with every edit, also one that comes back to the same text", () => {
    const { doc, root } = project();
    const text = new Y.Text("let a = 1;\n");
    at(root, ["files"]).set("code/a.js", text);
    const first = markOf(root, CODE);
    text.insert(0, "x");
    text.delete(0, 1);
    expect(text.toString()).toBe("let a = 1;\n");
    const back = markOf(root, CODE);
    expect(back).not.toBe(first);
    // Pieces that are gone are joined and collected when it is opened again: the same mark.
    expect(markOf(reopened(doc), CODE)).toBe(back);
    text.insert(4, "bb");
    text.delete(2, 6);
    expect(markOf(reopened(doc), CODE)).toBe(markOf(root, CODE));
  });

  it("of what the platform writes are those of its own client", () => {
    const { doc, root } = project();
    const own = doc.clientID;
    doc.clientID = 0;
    at(root, ["manifest"]).set("name", "from GitHub");
    doc.clientID = own;
    expect(markOf(root, NAME)).toMatch(/^0:\d+$/);
    expect(markOf(reopened(doc), NAME)).toBe(markOf(root, NAME));
  });

  it("tell another document of the same project by its manifest", () => {
    const one = project();
    const two = project();
    expect(documentMark(one.root)).not.toBe(documentMark(two.root));
    expect(documentMark(reopened(one.doc))).toBe(documentMark(one.root));
  });
});
