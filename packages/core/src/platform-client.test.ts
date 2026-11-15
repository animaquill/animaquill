/**
 * What the platform's merges count on in Yjs, see `PLATFORM_CLIENT`: of two writes of the same key
 * that did not see each other, the one of the larger client id stays, wherever they meet first. And
 * what does not hold, which whoever merges has to know of. These pin the version of Yjs: when one of
 * them fails after an update of Yjs, the platform's merges have to be thought through again.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { insertionOf, undoubled } from "./doubled-text.ts";
import { replica } from "./fuzz-support.ts";
import type { FileChange } from "./merge-files.ts";
import { ProjectStore, USER, repoBatch, type CommandCall, type CommandResult } from "./store.ts";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { PLATFORM_CLIENT, checkUpdate } from "./sync.ts";

const MAIN = "timelines/main/timeline.json";
const CODE = "code/animate.js";
// Documents as JSON, which is what these tests change.
type Json = any;

function open(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const run = (store: ProjectStore, type: string, params: unknown) =>
  success(store.execute({ type, params } as CommandCall));

/**
 * The platform's copy and an editor's, from the same project, with ids that would let the platform
 * win, where it wrote with its own: only `PLATFORM_CLIENT` makes the editor win.
 */
function copies(): [ProjectStore, ProjectStore] {
  const platform = open();
  const editor = replica(platform);
  platform.doc.clientID = 0xffff_fff0;
  editor.doc.clientID = 5;
  return [platform, editor];
}

/** Records what a store writes from now on, to send it elsewhere later. */
function recording(store: ProjectStore): Uint8Array[] {
  const updates: Uint8Array[] = [];
  store.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "sync") updates.push(update);
  });
  return updates;
}

const deliver = (to: ProjectStore, updates: readonly Uint8Array[]) => {
  for (const update of updates) Y.applyUpdate(to.doc, update, "sync");
};

/** A batch from GitHub, from the files as the copy has them now. */
function commit(store: ProjectStore, edit: (files: Map<string, string>) => void): FileChange[] {
  const base = store.exportFiles().files;
  const next = new Map(base);
  edit(next);
  return [...next.keys()]
    .filter((path) => base.get(path) !== next.get(path))
    .map((path) => ({ path, base: base.get(path), text: next.get(path) }));
}

function editJson(files: Map<string, string>, path: string, edit: (document: Json) => void) {
  const document = JSON.parse(files.get(path) as string);
  edit(document);
  files.set(path, JSON.stringify(document, null, 2));
}

const clipIn = (document: Json, id: string) =>
  document.tracks.flatMap((track: Json) => track.clips).find((item: Json) => item.id === id);

const mergeAsPlatform = (store: ProjectStore, batch: readonly FileChange[]) =>
  store.writeAsPlatform(() =>
    store.mergeFiles(batch, { origin: repoBatch("1"), baseOf: undefined, here: { repo: "1" } }),
  );

const clientsOf = (update: Uint8Array) =>
  new Set(Y.decodeUpdate(update).structs.map((struct) => struct.id.client));

describe("Yjs, as the platform's merges count on it", () => {
  it("keeps the value of the larger client id of two writes that did not see each other", () => {
    for (const platformFirst of [true, false]) {
      const platform = new Y.Doc();
      platform.clientID = PLATFORM_CLIENT;
      const editor = new Y.Doc();
      editor.clientID = 7;
      platform.getMap("m").set("k", "before");
      Y.applyUpdate(editor, Y.encodeStateAsUpdate(platform));
      // The platform writes twice, the editor once, from what both had.
      platform.getMap("m").set("k", "github 1");
      platform.getMap("m").set("k", "github 2");
      editor.getMap("m").set("k", "offline");
      const [fromPlatform, fromEditor] = [platform, editor].map((doc) =>
        Y.encodeStateAsUpdate(doc),
      ) as [Uint8Array, Uint8Array];
      if (platformFirst) {
        Y.applyUpdate(editor, fromPlatform);
        Y.applyUpdate(platform, fromEditor);
      } else {
        Y.applyUpdate(platform, fromEditor);
        Y.applyUpdate(editor, fromPlatform);
      }
      expect(platform.getMap("m").get("k")).toBe("offline");
      expect(editor.getMap("m").get("k")).toBe("offline");
    }
  });

  it("keeps what one copy writes later, where it saw what the platform wrote", () => {
    const platform = new Y.Doc();
    platform.clientID = PLATFORM_CLIENT;
    const editor = new Y.Doc();
    editor.clientID = 7;
    platform.getMap("m").set("k", "github");
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(platform));
    editor.getMap("m").set("k", "later");
    Y.applyUpdate(platform, Y.encodeStateAsUpdate(editor));
    platform.getMap("m").set("k", "github again");
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(platform));
    // Nothing about ids where one saw the other: the last one stays.
    expect(editor.getMap("m").get("k")).toBe("github again");
  });

  it("does not keep a key that one copy took away, where the platform wrote it at the same time", () => {
    // Known: a deletion takes away only what it saw. Whoever merges has to tell people of it.
    const platform = new Y.Doc();
    platform.clientID = PLATFORM_CLIENT;
    const editor = new Y.Doc();
    editor.clientID = 7;
    platform.getMap("m").set("k", "before");
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(platform));
    platform.getMap("m").set("k", "github");
    editor.getMap("m").delete("k");
    Y.applyUpdate(platform, Y.encodeStateAsUpdate(editor));
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(platform));
    expect(editor.getMap("m").get("k")).toBe("github");
    expect(platform.getMap("m").get("k")).toBe("github");
  });

  it("puts the same insert of a text twice, next to each other", () => {
    const platform = new Y.Doc();
    platform.clientID = PLATFORM_CLIENT;
    const editor = new Y.Doc();
    editor.clientID = 7;
    platform.getText("t").insert(0, "a\nc\n");
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(platform));
    platform.getText("t").insert(2, "b\n");
    editor.getText("t").insert(2, "b\n");
    Y.applyUpdate(platform, Y.encodeStateAsUpdate(editor));
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(platform));
    expect(platform.getText("t").toString()).toBe("a\nb\nb\nc\n");
    const insertion = insertionOf("a\nc\n", "a\nb\nc\n");
    expect(insertion && undoubled(editor.getText("t").toString(), insertion)).toBe("a\nb\nc\n");
  });
});

describe("writing as the platform", () => {
  it("writes with the platform's id, and goes back to the document's own", () => {
    const store = open();
    const own = store.doc.clientID;
    const updates = recording(store);
    const batch = commit(store, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "GitHub 上的";
      }),
    );
    expect(mergeAsPlatform(store, batch).ok).toBe(true);
    expect(store.doc.clientID).toBe(own);
    expect(updates.flatMap((update) => [...clientsOf(update)])).toEqual([PLATFORM_CLIENT]);
    run(store, "clip.update", { timeline: "main", clip: "clip_title", changes: { name: "又改" } });
    expect([...clientsOf(updates.at(-1) as Uint8Array)]).toEqual([own]);
  });

  it("goes back also where the write throws", () => {
    const store = open();
    const own = store.doc.clientID;
    expect(() =>
      store.writeAsPlatform(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.doc.clientID).toBe(own);
    expect(() => store.writeAsPlatform(() => store.writeAsPlatform(() => 1))).toThrow();
    expect(store.doc.clientID).toBe(own);
  });

  it("refuses a copy that waits for updates, which could number something twice", () => {
    const store = open();
    const other = replica(store);
    const updates = recording(other);
    run(other, "clip.update", { timeline: "main", clip: "clip_title", changes: { name: "一" } });
    run(other, "clip.update", { timeline: "main", clip: "clip_title", changes: { name: "二" } });
    // Only the second arrives.
    store.applyUpdates([updates[1] as Uint8Array]);
    expect(store.isMissingUpdates).toBe(true);
    expect(() => store.writeAsPlatform(() => 1)).toThrow();
  });

  it("is never the id of an editor's document", () => {
    const doc = new Y.Doc();
    doc.clientID = PLATFORM_CLIENT;
    const store = new ProjectStore(doc);
    expect(store.doc.clientID).not.toBe(PLATFORM_CLIENT);
  });

  it("is turned away from an editor, and taken from the platform", () => {
    const store = open();
    const batch = commit(store, (files) => files.set(CODE, "// GitHub 上的\n"));
    const updates = recording(store);
    mergeAsPlatform(store, batch);
    const update = updates[0] as Uint8Array;
    expect(checkUpdate(update)).toBeUndefined();
    expect(checkUpdate(update, { fromEditor: true })).toBe("foreign");
    run(store, "file.write", { path: CODE, text: "// 编辑器里的\n" });
    expect(checkUpdate(updates.at(-1) as Uint8Array, { fromEditor: true })).toBeUndefined();
  });
});

describe("a person's change that arrives after a merge from GitHub", () => {
  it("wins where both changed the same key, and both stay where they did not", () => {
    for (const platformFirst of [true, false]) {
      const [platform, editor] = copies();
      const fromPlatform = recording(platform);
      const fromEditor = recording(editor);
      // Offline in the editor.
      run(editor, "clip.update", {
        timeline: "main",
        clip: "clip_title",
        changes: { name: "离线时改的" },
      });
      run(editor, "clip.setProperty", {
        timeline: "main",
        clip: "clip_title",
        path: "param.size",
        value: 80,
      });
      // On GitHub, and merged by the platform first.
      const batch = commit(platform, (files) =>
        editJson(files, MAIN, (document) => {
          const title = clipIn(document, "clip_title");
          title.name = "GitHub 上的";
          title.start = "1";
        }),
      );
      expect(mergeAsPlatform(platform, batch).ok).toBe(true);
      if (platformFirst) {
        deliver(editor, fromPlatform);
        deliver(platform, fromEditor);
      } else {
        deliver(platform, fromEditor);
        deliver(editor, fromPlatform);
      }
      for (const store of [platform, editor]) {
        const title = store.getState().timelines["main"]?.clips["clip_title"] as Json;
        expect(title.name).toBe("离线时改的");
        expect(title.start).toBe("1");
        expect(title.properties["param.size"]).toBe(80);
      }
      expect(editor.getState()).toEqual(platform.getState());
    }
  });

  it("wins over the whole value of an asset, where the merge changed another field of it", () => {
    // Known: an asset is one value. The platform has to tell people that the merge lost there.
    const [platform, editor] = copies();
    const fromPlatform = recording(platform);
    const fromEditor = recording(editor);
    run(editor, "asset.update", { asset: "logo", changes: { name: "离线时起的" } });
    const batch = commit(platform, (files) =>
      editJson(files, "assets.json", (document) => {
        document.assets.logo.credit = "GitHub 上的署名";
      }),
    );
    expect(mergeAsPlatform(platform, batch).ok).toBe(true);
    deliver(platform, fromEditor);
    deliver(editor, fromPlatform);
    const logo = platform.getState().assets?.["logo"];
    expect(logo?.name).toBe("离线时起的");
    expect(logo?.credit).toBe("示例作者");
    expect(editor.getState()).toEqual(platform.getState());
  });

  it("loses where it took away an asset that the merge changed: the asset is back", () => {
    // Known: taking away takes away only what it saw. The platform has to tell people of it.
    const [platform, editor] = copies();
    const fromPlatform = recording(platform);
    const fromEditor = recording(editor);
    run(editor, "asset.remove", { asset: "raw-footage" });
    const batch = commit(platform, (files) =>
      editJson(files, "assets.json", (document) => {
        document.assets["raw-footage"].name = "GitHub 上的";
      }),
    );
    expect(mergeAsPlatform(platform, batch).ok).toBe(true);
    deliver(platform, fromEditor);
    deliver(editor, fromPlatform);
    expect(platform.getState().assets?.["raw-footage"]?.name).toBe("GitHub 上的");
    expect(editor.getState()).toEqual(platform.getState());
  });

  it("wins where it took away a whole clip that the merge changed: the clip stays away", () => {
    const [platform, editor] = copies();
    const fromPlatform = recording(platform);
    const fromEditor = recording(editor);
    run(editor, "clip.remove", { timeline: "main", clips: ["clip_title"] });
    const batch = commit(platform, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "GitHub 上的";
      }),
    );
    expect(mergeAsPlatform(platform, batch).ok).toBe(true);
    deliver(platform, fromEditor);
    deliver(editor, fromPlatform);
    // A clip is a map of its own: taking it away takes along what was written into it.
    expect(platform.getState().timelines["main"]?.clips["clip_title"]).toBeUndefined();
    expect(editor.getState()).toEqual(platform.getState());
    expect(USER).toBe("user");
  });
});
