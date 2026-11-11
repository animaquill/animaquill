import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MemoryCloudLinks, browserCloudLinks } from "./cloud.ts";
import type { CloudLink, CloudLinks } from "./index.ts";

/** What a browser keeps about the projects it connected to a platform. */

const PLATFORM = "https://platform.example";

const link = (key: string, more: Partial<CloudLink> = {}): CloudLink => ({
  key,
  platform: PLATFORM,
  project: `project-${key}`,
  seq: 3,
  pushed: 7,
  linkedAt: 1,
  ...more,
});

describe.each([
  ["in a database of their own", () => browserCloudLinks(() => new IDBFactory())],
  ["in memory", () => new MemoryCloudLinks()],
] as const)("links to projects of a platform, %s", (_, create: () => CloudLinks) => {
  it("are kept by the key of the project in this browser, and listed", async () => {
    const links = create();
    await links.put(link("a"));
    await links.put(link("b", { project: "shared" }));
    await links.put(link("c", { project: "shared" }));
    expect(await links.get("a")).toEqual(link("a"));
    expect(await links.get("nothing")).toBeUndefined();
    expect((await links.list()).map(({ key }) => key).toSorted()).toEqual(["a", "b", "c"]);
    expect((await links.withProject(PLATFORM, "shared")).map(({ key }) => key).toSorted()).toEqual([
      "b",
      "c",
    ]);
    expect(await links.withProject("https://elsewhere.example", "shared")).toEqual([]);
    await links.remove("b");
    expect((await links.list()).map(({ key }) => key).toSorted()).toEqual(["a", "c"]);
  });

  it("keep what they remember for lists, as the last one said", async () => {
    const links = create();
    await links.put(link("a"));
    expect(
      await links.update("a", "project-a", {
        name: "原子",
        repository: { id: 9, fullName: "ada/atom" },
        owner: "user-1",
        pending: 4,
      }),
    ).toBe(true);
    expect(await links.get("a")).toEqual(
      link("a", {
        name: "原子",
        repository: { id: 9, fullName: "ada/atom" },
        owner: "user-1",
        pending: 4,
      }),
    );
    // Not forward only, as how far syncing got is: what waits can be less, and a repository gone.
    await links.update("a", "project-a", { pending: 0, repository: null, name: "原子 2" });
    expect(await links.get("a")).toMatchObject({ pending: 0, repository: null, name: "原子 2" });
    // What is not said stays.
    await links.update("a", "project-a", { syncedAt: 5 });
    expect(await links.get("a")).toMatchObject({ owner: "user-1", name: "原子 2", syncedAt: 5 });
  });

  it("say which copy of the project their log is of once, and never another one", async () => {
    const links = create();
    await links.put(link("a"));
    await links.update("a", "project-a", { generation: 1 });
    expect((await links.get("a"))?.generation).toBe(1);
    await links.update("a", "project-a", { generation: 2 });
    expect((await links.get("a"))?.generation).toBe(1);
    await links.put(link("b", { generation: 3 }));
    await links.update("b", "project-b", { generation: 1 });
    expect((await links.get("b"))?.generation).toBe(3);
  });

  it("still move forward only in how far syncing got, whatever else changes with it", async () => {
    const links = create();
    await links.put(link("a", { creating: true, digest: "d3" }));
    await links.update("a", "project-a", { seq: 2, digest: "old", pushed: 5, pending: 1 });
    expect(await links.get("a")).toMatchObject({ seq: 3, digest: "d3", pushed: 7, pending: 1 });
    await links.update("a", "project-a", { seq: 9, digest: "d9", pushed: 8, made: true });
    const moved = await links.get("a");
    expect(moved).toMatchObject({ seq: 9, digest: "d9", pushed: 8 });
    expect(moved?.creating).toBeUndefined();
    // A link to another project, or none, is not changed.
    expect(await links.update("a", "another", { pending: 9 })).toBe(false);
    expect(await links.update("nothing", "project-a", { pending: 9 })).toBe(false);
    expect((await links.get("a"))?.pending).toBe(1);
  });
});

describe("the database of links", () => {
  it("reads a link that an editor from before kept, which has none of what came later", async () => {
    const factory = new IDBFactory();
    // As the first version wrote it: the fields of then, and `where` for finding it by project.
    const old = {
      key: "old",
      platform: PLATFORM,
      project: "p-old",
      seq: 12,
      digest: "d12",
      pushed: 30,
      linkedAt: 100,
      syncedAt: 200,
      where: [PLATFORM, "p-old"],
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("animaquill-cloud", 1);
      request.addEventListener("upgradeneeded", () => {
        const links = request.result.createObjectStore("links", { keyPath: "key" });
        links.createIndex("project", "where");
        request.result.createObjectStore("meta");
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("links", "readwrite");
      transaction.objectStore("links").put(old);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
    database.close();

    const links = browserCloudLinks(() => factory);
    const { where: _where, ...expected } = old;
    expect(await links.get("old")).toEqual(expected);
    expect(await links.list()).toEqual([expected]);
    expect(await links.withProject(PLATFORM, "p-old")).toEqual([expected]);
    // It goes on as it did, and takes what an editor of now adds.
    expect(await links.update("old", "p-old", { seq: 13, digest: "d13", pushed: 31 })).toBe(true);
    expect(await links.update("old", "p-old", { generation: 1, pending: 2, name: "旧项目" })).toBe(
      true,
    );
    expect(await links.get("old")).toEqual({
      ...expected,
      seq: 13,
      digest: "d13",
      pushed: 31,
      generation: 1,
      pending: 2,
      name: "旧项目",
    });
    expect(await links.withProject(PLATFORM, "p-old")).toHaveLength(1);
  });

  it("is there for the next page, with everything a link remembers", async () => {
    const factory = new IDBFactory();
    const kept = link("a", {
      name: "原子",
      repository: null,
      owner: "user-1",
      pending: 2,
      generation: 1,
      digest: "d",
    });
    await browserCloudLinks(() => factory).put(kept);
    expect(await browserCloudLinks(() => factory).list()).toEqual([kept]);
  });

  it("needs no new version for any of it, so that pages still open are not locked out", async () => {
    const factory = new IDBFactory();
    await browserCloudLinks(() => factory).list();
    expect(await factory.databases()).toEqual([{ name: "animaquill-cloud", version: 1 }]);
  });
});
