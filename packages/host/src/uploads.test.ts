import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { UploadRecord } from "./index.ts";
import { lfsAccountOf } from "./lfs.ts";
import { browserUploads, uploadRecordOf } from "./uploads.ts";

/**
 * The files of assets this browser sends somewhere, as it keeps them (uploads.ts): by project and
 * asset, each change in one go with reading it, what another window changed heard of, and nothing
 * kept that this editor cannot read.
 */

const record = (asset: string, more: Partial<UploadRecord> = {}): UploadRecord => ({
  key: "k1",
  asset,
  target: "lfs",
  hash: `sha256-${asset}`,
  size: 10,
  name: `${asset}.mp4`,
  project: "p1",
  state: "waiting",
  at: 1,
  ...more,
});

describe("the uploads of a browser", () => {
  it("keeps them by project and asset, changes each in one go, and lets go of a project", async () => {
    const factory = new IDBFactory();
    const heard: string[] = [];
    const store = browserUploads(
      () => factory,
      () => undefined,
      () => undefined,
    );
    store.listen((key) => heard.push(key));
    await store.update("k1", ["a", "b"], (_kept, asset) => record(asset));
    await store.update("k2", ["a"], (_kept, asset) => record(asset, { key: "k2" }));
    expect((await store.list("k1")).map(({ asset }) => asset)).toEqual(["a", "b"]);
    expect(await store.list()).toHaveLength(3);
    // What it is now is what a change goes from; undefined leaves it, null takes it away.
    const after = await store.update("k1", ["a", "b", "c"], (kept, asset) =>
      asset === "a" ? { ...(kept as UploadRecord), received: 5 } : asset === "b" ? null : undefined,
    );
    expect(after).toEqual([
      expect.objectContaining({ asset: "a", received: 5 }),
      undefined,
      undefined,
    ]);
    expect((await store.list("k1")).map(({ asset }) => asset)).toEqual(["a"]);
    // Nothing changed, nothing heard.
    const before = heard.length;
    await store.update("k1", ["a"], () => undefined);
    expect(heard).toHaveLength(before);
    await store.forget("k1");
    expect(await store.list("k1")).toEqual([]);
    expect(await store.list("k2")).toHaveLength(1);
    expect(heard).toContain("k2");
  });

  it("hears what another window changed", async () => {
    const factory = new IDBFactory();
    const listeners = new Set<(key: string) => void>();
    const channel = () => ({
      post: (key: string) => {
        for (const listener of listeners) listener(key);
      },
      listen: (listener: (key: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const mine = browserUploads(
      () => factory,
      () => undefined,
      channel,
    );
    const theirs = browserUploads(
      () => factory,
      () => undefined,
      channel,
    );
    const heard = vi.fn();
    mine.listen(heard);
    await theirs.update("k1", ["a"], () => record("a"));
    expect(heard).toHaveBeenCalledWith("k1");
    expect(await mine.list("k1")).toHaveLength(1);
  });

  it("reads only what it can: a record of a newer editor is left out", () => {
    expect(uploadRecordOf(record("a"))).toEqual(record("a"));
    expect(uploadRecordOf({ ...record("a"), target: "somewhere" })).toBeUndefined();
    expect(uploadRecordOf({ ...record("a"), state: "flying" })).toBeUndefined();
    expect(uploadRecordOf({ ...record("a"), size: -1 })).toBeUndefined();
    expect(uploadRecordOf(null)).toBeUndefined();
  });
});

describe("the large file storage of an account, as the platform says it", () => {
  it("reads what is there, leaves out what it cannot read, and nothing else", () => {
    const repository = {
      repo: 7,
      fullName: "octo/film",
      url: "https://github.com/octo/film",
      project: { id: "p1", name: "片子" },
      files: 2,
      bytes: 100,
    };
    expect(
      lfsAccountOf({
        account: "u1",
        acknowledgedAt: 5,
        auto: ["p1", 3],
        repositories: [repository, { ...repository, url: "javascript:alert(1)" }],
      }),
    ).toEqual({ account: "u1", acknowledgedAt: 5, auto: ["p1"], repositories: [repository] });
    expect(lfsAccountOf({ account: "u1", auto: [], repositories: [] })).toEqual({
      account: "u1",
      auto: [],
      repositories: [],
    });
    expect(lfsAccountOf({ auto: [], repositories: [] })).toBeUndefined();
    expect(lfsAccountOf([])).toBeUndefined();
  });
});
