import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExportStore } from "./exports.ts";

beforeEach(() => vi.stubGlobal("IDBKeyRange", FakeKeyRange));
afterEach(() => vi.unstubAllGlobals());

const store = (factory = new IDBFactory()) =>
  createExportStore(
    () => factory,
    () => undefined,
  );

const saved = (id: string, project = "p") => ({
  id,
  project,
  savedAt: 1,
  target: { kind: "download", name: "片子.mp4" },
  state: { frame: 30 },
});

const piece = (seq: number) => ({ seq, data: new Blob([`piece ${seq}`]), index: [{ size: 7 }] });

async function all(pieces: AsyncIterable<{ seq: number; data: Blob }>) {
  const out: string[] = [];
  for await (const { data } of pieces) out.push(await data.text());
  return out;
}

describe("what an export keeps", () => {
  it("is there for the next page, by project", async () => {
    const factory = new IDBFactory();
    await store(factory).save(saved("a"));
    await store(factory).save(saved("b", "other"));
    const next = store(factory);
    expect(await next.list("p")).toEqual([saved("a")]);
    expect(await next.list("nothing")).toEqual([]);
  });

  it("has its pieces in order, however many there are", async () => {
    const exports = store();
    await exports.save(saved("a"));
    await exports.save(saved("b"));
    for (const seq of [2, 0, 1, 4, 3, 5, 6, 7, 8, 9])
      await exports.addPiece("a", "video", piece(seq));
    await exports.addPiece("a", "sound", piece(0));
    await exports.addPiece("b", "video", piece(0));
    expect(await all(exports.pieces("a", "video"))).toEqual(
      Array.from({ length: 10 }, (_, seq) => `piece ${seq}`),
    );
    expect(await all(exports.pieces("a", "sound"))).toEqual(["piece 0"]);
  });

  it("loses the pieces after a place it goes on from", async () => {
    const exports = store();
    await exports.save(saved("a"));
    for (const seq of [0, 1, 2, 3]) await exports.addPiece("a", "video", piece(seq));
    await exports.addPiece("a", "sound", piece(0));
    await exports.dropPieces("a", "video", 2);
    expect(await all(exports.pieces("a", "video"))).toEqual(["piece 0", "piece 1"]);
    expect(await all(exports.pieces("a", "sound"))).toEqual(["piece 0"]);
  });

  it("goes away with all of its pieces, and only its own", async () => {
    const exports = store();
    await exports.save(saved("a"));
    await exports.save(saved("ab"));
    await exports.addPiece("a", "video", piece(0));
    await exports.addPiece("ab", "video", piece(0));
    await exports.remove("a");
    expect(await exports.list("p")).toEqual([saved("ab")]);
    expect(await all(exports.pieces("a", "video"))).toEqual([]);
    expect(await all(exports.pieces("ab", "video"))).toEqual(["piece 0"]);
  });
});

describe("a piece of an export", () => {
  it("does not go in when the export is not there, or not any more", async () => {
    const exports = store();
    await expect(exports.addPiece("a", "video", piece(0))).rejects.toThrow();
    await exports.save(saved("a"));
    await exports.addPiece("a", "video", piece(0));
    await exports.remove("a");
    await expect(exports.addPiece("a", "video", piece(1))).rejects.toThrow();
    expect(await all(exports.pieces("a", "video"))).toEqual([]);
  });
});

describe("working on an export", () => {
  it("is for one window at a time", async () => {
    const exports = store();
    const release = await exports.claim("a");
    expect(release).toBeDefined();
    expect(await exports.claim("a")).toBeUndefined();
    expect(await exports.claim("b")).toBeDefined();
    release?.();
    expect(await exports.claim("a")).toBeDefined();
  });

  it("goes by the locks of the browser where there are any", async () => {
    const taken = new Set<string>();
    const locks = {
      request: (name: string, _: unknown, work: (lock: unknown) => Promise<void> | undefined) => {
        if (taken.has(name)) return Promise.resolve(work(null));
        taken.add(name);
        return Promise.resolve(work({ name })).then(() => void taken.delete(name));
      },
    } as unknown as LockManager;
    const exports = createExportStore(
      () => new IDBFactory(),
      () => locks,
    );
    const release = await exports.claim("a");
    expect(taken).toContain("animaquill-export-a");
    expect(await exports.claim("a")).toBeUndefined();
    release?.();
    await vi.waitFor(() => expect(taken.size).toBe(0));
  });
});
