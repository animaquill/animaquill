import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { openUnlocked, randomCommand, randomFrom, seedIds } from "./fuzz-support.ts";
import type { ProjectStore } from "./store.ts";
import { PROJECT_ROOT, checkUpdate, piecesOf } from "./sync.ts";

/** How many values a plain value has, itself and all inside of it. */
function valuesIn(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce((sum: number, item) => sum + valuesIn(item), 0);
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    return 1 + Object.values(value).reduce((sum: number, item) => sum + valuesIn(item), 0);
  }
  return 1;
}

/**
 * How many pieces Yjs makes of an update: its structs, the ranges it takes away, and the values
 * inside of plain values.
 */
function decodedPieces(update: Uint8Array): number {
  const { structs, ds } = Y.decodeUpdate(update);
  let pieces = structs.length;
  for (const items of ds.clients.values()) pieces += items.length;
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const { content } = struct;
    if (content instanceof Y.ContentAny) pieces += valuesIn(content.arr) - 1;
    if (content instanceof Y.ContentJSON) pieces += content.arr.length;
  }
  return pieces;
}

/** What `checkUpdate` did before it read updates piece by piece: all of it, decoded. */
function decodedCheck(update: Uint8Array): "malformed" | "foreign" | undefined {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return "malformed";
  }
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) continue;
    if (typeof struct.parent === "string" && struct.parent !== PROJECT_ROOT) return "foreign";
    const { content } = struct;
    if (content instanceof Y.ContentType) {
      if (!(content.type instanceof Y.Map) && !(content.type instanceof Y.Text)) return "foreign";
    } else if (
      !(content instanceof Y.ContentAny) &&
      !(content instanceof Y.ContentString) &&
      !(content instanceof Y.ContentDeleted) &&
      !(content instanceof Y.ContentJSON)
    ) {
      return "foreign";
    }
  }
  return undefined;
}

/** Updates of random changes to a project, as the editor makes them. */
function editorUpdates(seed: number, count: number): Uint8Array[] {
  seedIds(seed);
  const random = randomFrom(seed);
  const store: ProjectStore = openUnlocked();
  const updates: Uint8Array[] = [store.encodeState()];
  store.onLocalUpdate((update) => updates.push(update));
  for (let step = 0; step < count; step++) {
    try {
      store.execute(randomCommand(store, random));
    } catch {
      // Some random commands make no sense on some projects.
    }
  }
  updates.push(store.encodeState());
  store.destroy();
  return updates;
}

const write = (doc: Y.Doc, change: () => void): Uint8Array => {
  const before = Y.encodeStateVector(doc);
  doc.transact(change);
  return Y.encodeStateAsUpdate(doc, before);
};

describe("checkUpdate", () => {
  it("takes every change the editor makes, and counts its pieces as Yjs does", () => {
    for (const seed of [1, 2, 3]) {
      for (const update of editorUpdates(seed, 150)) {
        expect(checkUpdate(update)).toBeUndefined();
        const pieces = decodedPieces(update);
        const counted = piecesOf(update);
        expect((counted?.structs ?? 0) + (counted?.values ?? 0)).toBe(pieces);
        expect(checkUpdate(update, { most: pieces })).toBeUndefined();
        if (pieces > 0) expect(checkUpdate(update, { most: pieces - 1 })).toBe("too-large");
      }
    }
  });

  it("turns away what the editor never writes", () => {
    const doc = new Y.Doc();
    const project = doc.getMap(PROJECT_ROOT);
    expect(checkUpdate(write(doc, () => project.set("a", { deep: [1, "x", null, true] })))).toBe(
      undefined,
    );
    expect(checkUpdate(write(doc, () => doc.getMap("elsewhere").set("a", 1)))).toBe("foreign");
    expect(checkUpdate(write(doc, () => project.set("list", new Y.Array())))).toBe("foreign");
    expect(checkUpdate(write(doc, () => project.set("xml", new Y.XmlElement("p"))))).toBe(
      "foreign",
    );
    expect(checkUpdate(write(doc, () => project.set("bytes", new Uint8Array([1]))))).toBe(
      "foreign",
    );
    const text = new Y.Text();
    expect(checkUpdate(write(doc, () => project.set("text", text)))).toBeUndefined();
    expect(checkUpdate(write(doc, () => text.insert(0, "ab")))).toBeUndefined();
    expect(checkUpdate(write(doc, () => text.format(0, 1, { bold: true })))).toBe("foreign");
    expect(checkUpdate(write(doc, () => text.insertEmbed(0, { image: "x" })))).toBe("foreign");
    expect(checkUpdate(write(doc, () => project.set("doc", new Y.Doc())))).toBe("foreign");
  });

  it("agrees with reading all of it, on changes that are damaged or cut short", () => {
    const random = randomFrom(7);
    for (const update of editorUpdates(4, 60)) {
      for (let turn = 0; turn < 20; turn++) {
        const damaged = update.slice(0, Math.max(1, random.int(update.length + 1)));
        if (damaged.length > 0 && random.chance(0.7)) {
          const at = random.int(damaged.length);
          damaged[at] = random.int(256);
        }
        const reference = decodedCheck(damaged);
        const fast = checkUpdate(damaged);
        // It never turns away what Yjs reads as the editor's, and finds everything foreign that
        // Yjs reads whole.
        if (reference === undefined) expect(fast).toBeUndefined();
        if (reference === "foreign") expect(["foreign", "malformed"]).toContain(fast);
      }
    }
  });

  it("counts what is inside of plain values: few structs can hold more than a copy takes", () => {
    const doc = new Y.Doc();
    const project = doc.getMap(PROJECT_ROOT);
    // What it counts is what matters, not how many: more than `most` is enough, and quick to make.
    const many = Array.from({ length: 20_000 }, () => ({}));
    const update = write(doc, () => {
      for (let index = 0; index < 15; index++) project.set(`v${index}`, many);
    });
    const counted = { structs: 15, values: 15 * 20_001 };
    expect(piecesOf(update)).toEqual(counted);
    expect(checkUpdate(update, { most: 200_000 })).toBe("too-large");
    // Not by the structs, which are few: by the values inside of them.
    expect(checkUpdate(update, { most: counted.values })).toBe("too-large");
    expect(checkUpdate(update, { most: counted.structs + counted.values })).toBeUndefined();
  });

  it("knows a change of too many pieces before reading them, also where it says more than it has", () => {
    // One client, a billion structs, and no bytes for them.
    const lies = new Uint8Array([1, 0x80, 0x94, 0xeb, 0xdc, 0x03, 5, 0]);
    expect(checkUpdate(lies, { most: 1000 })).toBe("too-large");
    expect(checkUpdate(lies)).toBe("malformed");
    // Arrays inside arrays, deeper than a stack: it only reads them.
    const depth = 200_000;
    const name = [...new TextEncoder().encode(PROJECT_ROOT)];
    const deep = new Uint8Array([
      // One client, one struct, client 1, clock 0.
      1,
      1,
      1,
      0,
      // A value in a map, by its key, in the project, under "a": one value.
      0b0010_1000,
      1,
      name.length,
      ...name,
      1,
      97,
      1,
      ...Array.from({ length: depth }, () => [117, 1]).flat(),
      127,
      0, // nothing taken away
    ]);
    expect(checkUpdate(deep)).toBeUndefined();
    expect(checkUpdate(deep.subarray(0, deep.length - 2))).toBe("malformed");
  });
});
