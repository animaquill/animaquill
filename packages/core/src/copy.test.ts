import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { CopyDiscarded, ProjectCopy } from "./copy.ts";
import type { CommandFailure } from "./failures.ts";
import { sceneSourceOf } from "./scene-plan.ts";
import { aiTask, ProjectStore, USER, type CommandCall, type CommandResult } from "./store.ts";

/** The example project, without its locked tag unless asked for. */
function open(locked = false): ProjectStore {
  const files = loadFixture("v1");
  if (!locked) {
    const manifest = JSON.parse(files.get("animaquill.json") as string);
    delete manifest.tags;
    files.set("animaquill.json", JSON.stringify(manifest));
  }
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

function fork(source: ProjectStore, maxBytes?: number): ProjectCopy {
  const forked = ProjectCopy.fork(source, maxBytes === undefined ? {} : { maxBytes });
  if (!forked.ok) throw new Error(forked.error.code);
  return forked.copy;
}

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

function failure(result: {
  readonly ok: boolean;
  readonly error?: CommandFailure;
}): CommandFailure {
  if (result.ok || !result.error) throw new Error("expected it to fail");
  return result.error;
}

const AI = aiTask("t1");
const rename = (clip: string, name: string): CommandCall => ({
  type: "clip.update",
  params: { timeline: "main", clip, changes: { name } },
});
const nameIn = (store: ProjectStore, clip: string) =>
  store.getState().timelines.main?.clips[clip]?.name;

/** Everything a project tells whoever listens, to see that nothing reached it. */
function listen(store: ProjectStore) {
  const heard: string[] = [];
  store.subscribe(() => heard.push("state"));
  store.onLocalUpdate(() => heard.push("update"));
  store.watchCommands(({ commands }) => heard.push(`command ${commands.join()}`));
  store.doc.on("update", () => heard.push("doc"));
  return heard;
}

/** What a project is, as everything that could tell that it changed. */
function snapshot(store: ProjectStore) {
  return {
    bytes: Array.from(store.encodeState()),
    vector: Array.from(store.stateVector()),
    state: store.getState(),
    revision: store.revisionId,
    history: store.history.length,
    canUndo: store.canUndo,
    lastStep: store.lastStep,
    changes: store.changesSince(0)?.length,
  };
}

describe("a copy of a project", () => {
  it("is written, read and discarded without the project hearing of it", () => {
    const source = open();
    success(source.execute(rename("clip_title", "before the copy"), { origin: AI }));
    const before = snapshot(source);
    const heard = listen(source);
    const copy = fork(source);
    expect(copy.id).toMatch(/^copy_/);
    expect(copy.baseRevision).toBe(source.revisionId);
    expect(copy.store.doc.clientID).not.toBe(source.doc.clientID);
    expect(copy.store.getState()).toEqual(source.getState());
    success(copy.store.execute(rename("clip_title", "in the copy"), { origin: AI }));
    success(
      copy.store.executeBatch(
        [
          { type: "marker.add", params: { timeline: "main", id: "marker_copy", time: "3" } },
          { type: "file.write", params: { path: "code/animate.js", text: "// copy\n" } },
        ],
        { origin: USER },
      ),
    );
    expect(copy.store.undo().ok).toBe(true);
    expect(copy.store.undoOrigin(AI).ok).toBe(true);
    success(copy.store.execute(rename("clip_logo", "again"), { origin: AI }));
    expect(nameIn(copy.store, "clip_logo")).toBe("again");
    copy.discard();
    expect(heard).toEqual([]);
    expect(snapshot(source)).toEqual(before);
    expect(nameIn(source, "clip_title")).toBe("before the copy");
    // The undo of the project still has its own change, and only that.
    expect(source.undoOrigin(AI).ok).toBe(true);
    expect(nameIn(source, "clip_title")).not.toBe("before the copy");
  });

  it("does not follow its project: its base is when it was made", () => {
    const source = open();
    const copy = fork(source);
    const base = copy.baseState();
    const files = copy.baseFiles();
    success(source.execute(rename("clip_title", "later in the project")));
    expect(nameIn(copy.store, "clip_title")).toBe("标题");
    expect(copy.baseState()).toBe(base);
    expect(copy.baseFiles()).toEqual(files);
    expect(copy.changes()).toEqual([]);
  });

  it("goes through the same commands and checks before a write", () => {
    const copy = fork(open());
    const state = copy.store.getState();
    const wrong = copy.store.execute({
      type: "clip.update",
      params: { timeline: "main", clip: "clip_title", changes: { start: 3 } },
    });
    expect(failure(wrong).code).toBe("invalid-params");
    const human = copy.store.execute(
      { type: "project.setTags", params: { tags: [] } },
      { origin: AI },
    );
    expect(failure(human).code).toBe("user-only");
    const taken = copy.store.execute({
      type: "track.add",
      params: { timeline: "main", id: "clip_title", kind: "video" },
    });
    expect(failure(taken).code).toBe("id-taken");
    const seen = copy.store.revisionId;
    success(copy.store.execute(rename("clip_title", "用户改的")));
    const stale = copy.store.execute(rename("clip_title", "AI"), {
      origin: AI,
      baseRevision: seen,
    });
    expect(failure(stale).code).toBe("conflict");
    expect(copy.store.getState().timelines.main?.clips.clip_title?.start).toBe(
      state.timelines.main?.clips.clip_title?.start,
    );
  });

  it("lists the objects that changed against its base, and none that went back", () => {
    const copy = fork(open());
    const { store } = copy;
    success(store.execute(rename("clip_title", "新名字")));
    success(store.execute(rename("clip_interview", "临时")));
    success(store.execute(rename("clip_interview", "采访")));
    success(
      store.execute({
        type: "marker.add",
        params: { timeline: "main", id: "marker_new", time: "4" },
      }),
    );
    success(
      store.execute({ type: "marker.remove", params: { timeline: "main", marker: "marker_turn" } }),
    );
    success(
      store.execute({ type: "file.write", params: { path: "code/animate.js", text: "// new\n" } }),
    );
    const changes = copy
      .changes()
      .map(({ object, change }) => `${change} ${object.kind} ${object.id}`);
    expect(changes.toSorted()).toEqual([
      "added marker marker_new",
      "changed clip clip_title",
      "changed file code/animate.js",
      "removed marker marker_turn",
    ]);
    const title = copy.changes().find(({ object }) => object.id === "clip_title");
    expect(title?.paths).toEqual([["timelines", "main", "clips", "clip_title", "name"]]);
  });

  it("gives its base as the files the project had, for a three-way merge", () => {
    const source = open();
    const copy = fork(source);
    success(copy.store.execute(rename("clip_title", "in the copy")));
    expect(copy.baseFiles()).toEqual(source.exportFiles().files);
  });

  it("is read-only and locked as its project is", () => {
    const readOnly = open();
    readOnly.readOnly = true;
    const copy = fork(readOnly);
    expect(copy.store.readOnly).toBe(true);
    expect(failure(copy.store.execute(rename("clip_title", "x"))).code).toBe("read-only");
    const locked = fork(open(true));
    expect(failure(locked.store.execute(rename("clip_title", "x"))).code).toBe("project-locked");
  });

  it("takes no new assets nor files from a folder", () => {
    const copy = fork(open());
    const asset = copy.store.execute({
      type: "asset.add",
      params: { asset: { name: "new", type: "image", file: "assets/new.png" } },
    });
    expect(failure(asset)).toEqual({ code: "not-in-copy", params: { command: "asset.add" } });
    const imported = copy.store.importFile("code/animate.js", "// x\n", { origin: USER });
    expect(failure(imported).code).toBe("not-in-copy");
    const merged = copy.store.mergeFiles([], { origin: USER, baseOf: () => undefined });
    expect(failure(merged).code).toBe("not-in-copy");
  });

  it("is not made of a project that is too large, or waits for changes", () => {
    const source = open();
    const tooLarge = ProjectCopy.fork(source, { maxBytes: 1000 });
    expect(failure(tooLarge)).toMatchObject({ code: "copy-too-large", params: { limit: 1000 } });
    // An update that needs one this project never got.
    const other = new Y.Doc();
    Y.applyUpdate(other, source.encodeState());
    const vector = Y.encodeStateVector(other);
    const manifest = other.getMap("project").get("manifest") as Y.Map<unknown>;
    manifest.set("description", "一");
    const between = Y.encodeStateVector(other);
    manifest.set("description", "二");
    source.applyUpdates([Y.encodeStateAsUpdate(other, between)]);
    expect(source.isMissingUpdates).toBe(true);
    expect(failure(ProjectCopy.fork(source)).code).toBe("missing-updates");
    expect(vector.length).toBeGreaterThan(0);
  });

  it("refuses to be used once discarded, also by a store kept from before", () => {
    const source = open();
    const copy = fork(source);
    const { store } = copy;
    success(store.execute(rename("clip_title", "x")));
    copy.discard();
    copy.discard();
    expect(copy.discarded).toBe(true);
    expect(() => copy.store).toThrow(CopyDiscarded);
    expect(() => copy.changes()).toThrow(CopyDiscarded);
    expect(() => copy.baseFiles()).toThrow(CopyDiscarded);
    expect(failure(store.execute(rename("clip_title", "y"))).code).toBe("copy-discarded");
    expect(failure(store.undo()).code).toBe("copy-discarded");
    expect(nameIn(source, "clip_title")).toBe("标题");
  });

  it("does not take turns with its project at what a scene is shown as", () => {
    const source = open();
    const shown = sceneSourceOf(source.getState(), "title");
    const copy = fork(source);
    success(
      copy.store.execute({
        type: "file.write",
        params: { path: "scenes/title/index.html", text: "<p>copy</p>\n" },
      }),
    );
    const inCopy = sceneSourceOf(copy.store.getState(), "title");
    expect(inCopy?.revision).not.toBe(shown?.revision);
    expect(sceneSourceOf(source.getState(), "title")).toBe(shown);
  });
});
