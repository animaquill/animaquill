import { describe, expect, it, vi } from "vitest";
import { UNWRITTEN, WriteTree, sameWrites, type Written } from "./write-tree.ts";

const a = Symbol("a");
const b = Symbol("b");
const c = Symbol("c");

const CLIP = ["clips", "c"];
const START = ["clips", "c", "start"];
const DURATION = ["clips", "c", "duration"];

function tree(...writes: readonly (readonly [readonly string[], symbol])[]): WriteTree {
  const result = new WriteTree();
  for (const [path, by] of writes) result.put(path, { by });
  return result;
}

describe("what was written at a path", () => {
  it("is nothing in a project that was just opened", () => {
    expect(new WriteTree().at(START)).toEqual(UNWRITTEN);
  });

  it("is the last write there", () => {
    expect(tree([START, a], [START, b]).at(START).by).toBe(b);
  });

  it("is the write of what it is in, as long as nothing was written there since", () => {
    expect(tree([CLIP, a]).at(START).by).toBe(a);
    expect(tree([CLIP, a], [START, b]).at(DURATION).by).toBe(a);
  });

  it("starts over when something above it is replaced", () => {
    const writes = tree([START, a], [CLIP, b]);
    expect(writes.at(START).by).toBe(b);
    expect(writes.at(CLIP).below).toBeUndefined();
  });

  it("says nothing about what is next to it", () => {
    expect(tree([START, a], [DURATION, b]).at(START).by).toBe(a);
  });

  it("does not go by what every object inherits", () => {
    expect(tree([["clips", "constructor"], a]).at(["clips", "toString"])).toEqual(UNWRITTEN);
  });
});

describe("comparing what was written", () => {
  it("sees the write, not the object", () => {
    expect(sameWrites({ by: a }, { by: a })).toBe(true);
    expect(sameWrites({ by: a }, { by: b })).toBe(false);
    expect(sameWrites({ by: a }, UNWRITTEN)).toBe(false);
  });

  it("sees a write below a path", () => {
    const before = tree([CLIP, a]).at(CLIP);
    expect(sameWrites(tree([CLIP, a], [START, b]).at(CLIP), before)).toBe(false);
    expect(sameWrites(before, tree([CLIP, a], [START, b]).at(CLIP))).toBe(false);
  });

  it("sees which write it is, however deep", () => {
    const first = tree([START, a], [["clips", "c", "properties", "x"], b]).at(CLIP);
    const second = tree([START, a], [["clips", "c", "properties", "x"], c]).at(CLIP);
    const third = tree([START, a], [["clips", "c", "properties", "y"], b]).at(CLIP);
    expect(sameWrites(first, second)).toBe(false);
    expect(sameWrites(first, third)).toBe(false);
    expect(
      sameWrites(first, tree([START, a], [["clips", "c", "properties", "x"], b]).at(CLIP)),
    ).toBe(true);
  });

  it("is not fooled by a write that was taken back again", () => {
    const writes = tree([CLIP, a]);
    const left = writes.at(CLIP);
    const replaced = writes.at(START);
    writes.put(START, { by: b });
    expect(sameWrites(writes.at(CLIP), left)).toBe(false);
    writes.put(START, replaced);
    expect(sameWrites(writes.at(CLIP), left)).toBe(true);
    expect(writes.at(CLIP).below?.size ?? 0).toBe(0);
  });

  it("is not fooled by a whole object coming back", () => {
    const writes = tree([START, a]);
    const replaced = writes.at(CLIP);
    writes.put(CLIP, { by: b });
    expect(writes.at(START).by).toBe(b);
    writes.put(CLIP, replaced);
    expect(writes.at(START).by).toBe(a);
  });
});

describe("what was written so far", () => {
  it("stays as it is when writing goes on", () => {
    const first = tree([START, a]);
    const root = first.root;
    const second = new WriteTree(root);
    second.put(START, { by: b });
    second.put(DURATION, { by: c });
    expect(new WriteTree(root).at(START).by).toBe(a);
    expect(new WriteTree(root).at(DURATION).by).toBeUndefined();
  });

  it("stays as it is when the same tree goes on after handing it out", () => {
    const writes = tree([START, a]);
    const root = writes.root;
    writes.put(DURATION, { by: b });
    writes.put(START, { by: c });
    expect(new WriteTree(root).at(START).by).toBe(a);
    expect(new WriteTree(root).at(DURATION).by).toBeUndefined();
  });

  it("stays as it is for something that kept it, also further down", () => {
    const writes = tree([["clips", "c", "properties", "x"], a]);
    const kept: Written = writes.at(CLIP);
    writes.put(["clips", "c", "properties", "x"], { by: b });
    writes.put(["clips", "c", "properties", "y"], { by: b });
    writes.put(CLIP, { by: c });
    expect(new WriteTree(kept).at(["properties", "x"]).by).toBe(a);
    expect(new WriteTree(kept).at(["properties", "y"]).by).toBeUndefined();
  });

  it("copies what it changes only once, however much gets written", () => {
    let copies = 0;
    class CountingMap<K, V> extends Map<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) {
        super(entries);
        copies += 1;
      }
    }
    vi.stubGlobal("Map", CountingMap);
    const writes = new WriteTree();
    for (let index = 0; index < 100; index++) writes.put(["clips", String(index)], { by: a });
    vi.unstubAllGlobals();
    expect(copies).toBe(2);
    expect(writes.at(["clips"]).below?.size).toBe(100);
  });
});
