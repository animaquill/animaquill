import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { NotificationOptions } from "../workbench/notifications.ts";
import type { DefaultPlace } from "./default-place.ts";
import { NewAssets } from "./new-assets.ts";

const MB = 1024 * 1024;

/** A key and what it was given, as the text. */
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}(${values["count"]}:${values["name"]})` : key) as unknown as TFunction;

function world({
  knows = false,
  place = { chosen: "lfs", written: false, effective: "lfs" } as DefaultPlace,
  acknowledgeTakes = true,
  local = false,
} = {}) {
  const state = {
    key: "p1" as string | undefined,
    knows,
    place,
    local,
    assets: {
      a: { hash: "sha256-a", size: 1 * MB, path: "assets/a.png", name: "a.png" },
      b: { hash: "sha256-b", size: 300 * MB, path: "assets/b.mp4", name: "b.mp4" },
      c: { hash: "sha256-c", size: 3 * 1024 * MB, path: "assets/c.mov", name: "c.mov" },
      d: { hash: "sha256-d", size: 2 * MB, path: "assets/d.png", name: "d.png" },
      e: { hash: "sha256-e", size: 900 * MB, path: "assets/e.mov", name: "e.mov" },
    } as Record<string, { hash: string; size: number; path: string; name: string }>,
  };
  const sent: string[][] = [];
  const cancelled: string[] = [];
  const notices = new Map<number, { message: string; options: NotificationOptions }>();
  const failed: string[] = [];
  let keptHere = 0;
  let next = 1;
  const assets = new NewAssets({
    t,
    project: () =>
      state.key === undefined
        ? undefined
        : { key: state.key, place: state.place, local: state.local },
    assets: () => state.assets,
    acknowledged: async () => state.knows,
    acknowledge: async () => {
      if (acknowledgeTakes) state.knows = true;
      return acknowledgeTakes;
    },
    send: async (ids) => {
      sent.push([...ids]);
    },
    cancel: async (id) => {
      cancelled.push(id);
    },
    keepHere: () => {
      keptHere += 1;
    },
    notify: (message, options, instead) => {
      const id = instead !== undefined && notices.has(instead) ? instead : next++;
      notices.set(id, { message, options });
      return id;
    },
    dismiss: (id) => notices.delete(id),
    failed: (message) => failed.push(message),
    sizes: { large: 100 * MB, most: 2 * 1024 * MB, batch: 1024 * MB },
  });
  const press = async (id: number, label: string) => {
    const action = notices.get(id)?.options.actions?.find((each) => each.label === label);
    if (!action) throw new Error(`No ${label} on ${id}`);
    notices.delete(id);
    action.run();
    await new Promise((done) => setTimeout(done, 0));
  };
  return {
    state,
    assets,
    sent,
    cancelled,
    notices,
    failed,
    press,
    keptHere: () => keptHere,
  };
}

describe("assets just imported, once people said they know", () => {
  it("go into the storage at once; nothing is said of small files", async () => {
    const w = world({ knows: true });
    await w.assets.imported(["a", "d"]);
    expect(w.sent).toEqual([["a", "d"]]);
    expect(w.notices.size).toBe(0);
  });

  it("say once of the large and the too large, with a way to keep the large here", async () => {
    const w = world({ knows: true });
    await w.assets.imported(["a", "b", "c"]);
    expect(w.sent).toEqual([["a", "b"]]);
    expect(w.notices.size).toBe(1);
    const [id, notice] = [...w.notices][0] ?? [];
    expect(notice?.message).toContain("storage.uploads.notice.largeOne(1:b.mp4)");
    expect(notice?.message).toContain("storage.uploads.notice.tooLargeOne(1:c.mov)");
    expect(notice?.options.stays).toBe(true);
    await w.press(id as number, "storage.uploads.notice.notThis");
    expect(w.cancelled).toEqual(["b"]);
  });

  it("say of the too large only, which goes by itself", async () => {
    const w = world({ knows: true });
    await w.assets.imported(["c"]);
    expect(w.sent).toEqual([]);
    const [notice] = [...w.notices.values()];
    expect(notice?.message).toBe("storage.uploads.notice.tooLargeOne(1:c.mov)");
    expect(notice?.options.stays).toBe(false);
  });

  it("stay here where the default is this computer", async () => {
    const w = world({
      knows: true,
      place: { chosen: "local", written: true, effective: "local" },
    });
    await w.assets.imported(["a", "b", "c"]);
    expect(w.sent).toEqual([]);
    expect(w.notices.size).toBe(0);
  });

  it("never send again by themselves what people kept here, or what was too large", async () => {
    const w = world({ knows: true });
    await w.assets.imported(["b", "c"]);
    const [id] = [...w.notices.keys()];
    await w.press(id as number, "storage.uploads.notice.notThis");
    // Other assets come; those stay where they are.
    await w.assets.imported(["a"]);
    expect(w.sent).toEqual([["b"], ["a"]]);
    expect(w.sent.flat()).not.toContain("c");
  });
});

describe("one import larger than a gibibyte all together", () => {
  it("is told of once, in place of each large file, with a way to keep the project's assets here", async () => {
    const w = world({ knows: true });
    await w.assets.imported(["a", "b", "c", "e"]);
    expect(w.sent).toEqual([["a", "b", "e"]]);
    expect(w.notices.size).toBe(1);
    const [id, notice] = [...w.notices][0] ?? [];
    expect(notice?.message).toContain("storage.uploads.notice.batch");
    expect(notice?.message).not.toContain("largeOne");
    expect(notice?.message).not.toContain("largeMany");
    expect(notice?.message).toContain("storage.uploads.notice.tooLargeOne(1:c.mov)");
    expect(notice?.options.stays).toBe(true);
    await w.press(id as number, "storage.uploads.notice.keepHere");
    expect(w.cancelled.toSorted()).toEqual(["a", "b", "e"]);
    expect(w.keptHere()).toBe(1);
  });

  it("is not where one file alone is large: that is told of as such", async () => {
    const w = world({ knows: true });
    w.state.assets["f"] = {
      hash: "sha256-f",
      size: 1500 * MB,
      path: "assets/f.mov",
      name: "f.mov",
    };
    await w.assets.imported(["f"]);
    const [notice] = [...w.notices.values()];
    expect(notice?.message).toBe("storage.uploads.notice.largeOne(1:f.mov)");
  });

  it("before people said they know, says the total in the one notification that asks", async () => {
    const w = world();
    const many = Array.from({ length: 12 }, (_, at) => `m${at}`);
    for (const id of many)
      w.state.assets[id] = { hash: `sha256-${id}`, size: 90 * MB, path: `assets/${id}`, name: id };
    await w.assets.imported(many);
    const [notice] = [...w.notices.values()];
    expect(w.notices.size).toBe(1);
    expect(notice?.message).toContain("storage.uploads.notice.askTotal");
    expect(notice?.message).toContain("storage.uploads.notice.cost");
    expect(notice?.message).toContain("storage.uploads.notice.untilThen");
    // Large ones are named in its place, which says the same of them.
    const v = world();
    await v.assets.imported(["b", "e"]);
    const [named] = [...v.notices.values()];
    expect(named?.message).toContain("storage.uploads.notice.askLargeMany");
    expect(named?.message).not.toContain("askTotal");
  });

  it("are shown as waiting while they wait, and no more once they went or stayed", async () => {
    const w = world();
    let told = 0;
    w.assets.subscribe(() => (told += 1));
    await w.assets.imported(["a", "d"]);
    expect([...w.assets.getSnapshot()]).toEqual(["a", "d"]);
    w.assets.knownNow();
    expect(w.assets.getSnapshot().size).toBe(0);
    expect(w.sent).toEqual([["a", "d"]]);
    expect(w.notices.size).toBe(0);
    expect(told).toBe(2);
  });
});

describe("assets just imported, before people said they know", () => {
  it("wait in one notification that asks, gathering every import, large ones in it", async () => {
    const w = world();
    await w.assets.imported(["a"]);
    await w.assets.imported(["b", "c"]);
    expect(w.sent).toEqual([]);
    expect(w.notices.size).toBe(1);
    const [id, notice] = [...w.notices][0] ?? [];
    expect(notice?.message).toContain("storage.uploads.notice.askMany(2:a.png)");
    expect(notice?.message).toContain("storage.uploads.notice.cost");
    expect(notice?.message).toContain("storage.uploads.notice.askLargeOne(1:b.mp4)");
    expect(notice?.message).toContain("storage.uploads.notice.tooLargeOne(1:c.mov)");
    expect(notice?.options.stays).toBe(true);
    expect(w.assets.waiting).toEqual(["a", "b"]);
    await w.press(id as number, "storage.uploads.notice.agree");
    expect(w.state.knows).toBe(true);
    expect(w.sent).toEqual([["a", "b"]]);
    expect(w.assets.waiting).toEqual([]);
  });

  it("stay here, and the project's default becomes this computer, where people say so", async () => {
    const w = world();
    await w.assets.imported(["a"]);
    const [id] = [...w.notices.keys()];
    await w.press(id as number, "storage.uploads.notice.keepHere");
    expect(w.keptHere()).toBe(1);
    expect(w.sent).toEqual([]);
    expect(w.state.knows).toBe(false);
    // Another import asks again, afresh.
    await w.assets.imported(["d"]);
    expect(w.assets.waiting).toEqual(["d"]);
  });

  it("stay here as the project closes", async () => {
    const w = world();
    await w.assets.imported(["a"]);
    w.assets.reset();
    expect(w.notices.size).toBe(0);
    expect(w.assets.waiting).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("are asked for again where the account could not keep it", async () => {
    const w = world({ acknowledgeTakes: false });
    await w.assets.imported(["a"]);
    const [id] = [...w.notices.keys()];
    await w.press(id as number, "storage.uploads.notice.agree");
    expect(w.sent).toEqual([]);
    expect(w.failed).toEqual(["storage.uploads.dialog.failed"]);
    expect(w.assets.waiting).toEqual(["a"]);
    expect(w.notices.size).toBe(1);
  });

  it("of another project go nowhere", async () => {
    const w = world();
    await w.assets.imported(["a"]);
    const [id] = [...w.notices.keys()];
    w.state.key = "p2";
    await w.press(id as number, "storage.uploads.notice.agree");
    expect(w.sent).toEqual([]);
  });

  it("of a project in a repository of the server's own go at once: nothing asked, nothing said of size but what it does not take", async () => {
    const w = world({ local: true });
    await w.assets.imported(["a", "b", "e"]);
    expect(w.sent).toEqual([["a", "b", "e"]]);
    expect(w.assets.waiting).toEqual([]);
    expect(w.notices.size).toBe(0);
    await w.assets.imported(["c", "d"]);
    expect(w.sent).toEqual([["a", "b", "e"], ["d"]]);
    expect([...w.notices.values()].map(({ message }) => message)).toEqual([
      "storage.uploads.notice.tooLargeOne(1:c.mov)",
    ]);
  });
});
