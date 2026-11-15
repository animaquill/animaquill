import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { browserDownloads, MemoryDownloads } from "./downloads.ts";

/** What this browser keeps of the files it downloads, see `DownloadStore`. */

const text = async (blob: Blob) => blob.text();

describe.each([
  [
    "in IndexedDB",
    () =>
      browserDownloads(
        () => new IDBFactory(),
        () => undefined,
        () => undefined,
      ),
  ],
  ["in memory", () => new MemoryDownloads().window()],
])("downloads %s", (_name, make) => {
  it("keeps pieces by object, in order, until they go", async () => {
    const store = make();
    await store.putPiece("b", 0, new Blob(["other"]));
    await store.putPiece("a", 5, new Blob(["world"]));
    await store.putPiece("a", 0, new Blob(["hello"]));
    const pieces = await store.pieces("a");
    expect(pieces.map(({ start }) => start)).toEqual([0, 5]);
    expect(await Promise.all(pieces.map(({ bytes }) => text(bytes)))).toEqual(["hello", "world"]);
    expect((await store.objects()).map(({ oid }) => oid).toSorted()).toEqual(["a", "b"]);
    // The same piece again takes the place of the first.
    await store.putPiece("a", 0, new Blob(["HELLO"]));
    expect(await text((await store.pieces("a"))[0]!.bytes)).toBe("HELLO");
    await store.dropPieces("a");
    expect(await store.pieces("a")).toEqual([]);
    expect((await store.objects()).map(({ oid }) => oid)).toEqual(["b"]);
  });

  it("remembers which projects are paused, and says so", async () => {
    const store = make();
    const heard: string[] = [];
    store.listen((key) => heard.push(key));
    expect(await store.paused("p")).toBe(false);
    await store.setPaused("p", true);
    expect(await store.paused("p")).toBe(true);
    await store.setPaused("p", false);
    expect(await store.paused("p")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual(["p", "p"]);
  });
});
