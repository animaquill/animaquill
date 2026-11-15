/**
 * Batches of files from the repository on GitHub, which the platform merges into its working copy
 * of a project: where they come from, assets.json as written for the repository, what the platform
 * does not know of the files outside a batch, conflicts with both sides in them and in words, taking
 * the other side of one, merging what can come in where some files would break the project, and
 * telling the same change of code that came twice.
 */
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { insertionOf, undoubled } from "./doubled-text.ts";
import type { FileChange, MergeConflict } from "./merge-files.ts";
import { mergeInRounds, type MergeRound } from "./merge-rounds.ts";
import { orderedTracks, type Here } from "./model.ts";
import { STORAGE } from "./origin.ts";
import {
  ProjectStore,
  USER,
  folderBatch,
  repoBatch,
  type CommandCall,
  type CommandResult,
  type ExecuteOptions,
  type MergeResult,
} from "./store.ts";
import { sourceKindOf } from "./sync.ts";

const MAIN = "timelines/main/timeline.json";
const CODE = "code/animate.js";
const REPO = repoBatch("merge-1");
const HERE: Here = { repo: "1001" };
const HASH = "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=";

type Files = Map<string, string>;
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

/** What the last archive wrote into the repository. */
const archived = (store: ProjectStore, here: Here = HERE) => store.exportFiles({ here }).files;

/** What somebody committed on GitHub, as a batch from what the last archive wrote. */
function commit(base: ReadonlyMap<string, string>, edit: (files: Files) => void): FileChange[] {
  const next = new Map(base);
  edit(next);
  return [...new Set([...base.keys(), ...next.keys()])]
    .filter((path) => base.get(path) !== next.get(path))
    .map((path) => ({ path, base: base.get(path), text: next.get(path) }));
}

function editJson(files: Files, path: string, edit: (document: Json) => void): void {
  const document = JSON.parse(files.get(path) as string);
  edit(document);
  files.set(path, JSON.stringify(document, null, 2));
}

const clipIn = (document: Json, id: string) =>
  document.tracks.flatMap((track: Json) => track.clips).find((item: Json) => item.id === id);

/** How the platform merges a batch from GitHub: without the files outside of it, as itself. */
const mergeRepo = (store: ProjectStore, batch: readonly FileChange[], origin = REPO) =>
  store.writeAsPlatform(() => store.mergeFiles(batch, { origin, baseOf: undefined, here: HERE }));

function merged(result: MergeResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const run = (store: ProjectStore, type: string, params: unknown, options: ExecuteOptions = {}) =>
  success(store.execute({ type, params } as CommandCall, options));

const take = (store: ProjectStore, conflict: MergeConflict) =>
  store.execute({ type: "conflict.take", params: { conflict } });

const main = (store: ProjectStore) => store.getState().timelines["main"] as Json;
const clip = (store: ProjectStore, id = "clip_title") => main(store).clips[id];

const only = (result: MergeResult): MergeConflict => {
  const ok = merged(result);
  expect(ok.conflicts).toHaveLength(1);
  return ok.conflicts[0] as MergeConflict;
};

describe("a batch from the repository", () => {
  it("is a source of its own, and goes back as a whole", () => {
    expect(sourceKindOf(REPO)).toBe("repo");
    expect(sourceKindOf(folderBatch("1"))).toBe("folder");
    const store = open();
    const before = store.getState();
    const batch = commit(archived(store), (files) => {
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "GitHub 上改的";
      });
      files.set(CODE, "// GitHub 上改的\n");
    });
    merged(mergeRepo(store, batch));
    expect(clip(store).name).toBe("GitHub 上改的");
    expect(store.history.at(-1)?.origin).toBe(REPO);
    expect(store.canUndoOrigin(REPO)).toBe(true);
    expect(store.canUndo).toBe(false);
    expect(store.undoOrigin(REPO).ok).toBe(true);
    expect(store.getState()).toEqual(before);
  });

  it("reads assets.json the way it was written for the repository, and keeps places of elsewhere", () => {
    const store = open();
    const asset = { kind: "video", path: "assets/b.mov", storage: "local", hash: HASH, size: 9 };
    run(store, "asset.add", { id: "b-roll", asset });
    // Uploaded into Git LFS of another repository, which counts there and not here.
    const params = { asset: "b-roll", storage: "lfs", hash: HASH, repo: "2002" };
    run(store, "asset.setStorage", params, { origin: STORAGE });
    const place = store.getState().places?.["b-roll"];
    expect(place).toMatchObject({ storage: "lfs", repo: "2002" });
    const base = archived(store);
    expect(JSON.parse(base.get("assets.json") as string).assets["b-roll"].storage).toBe("local");
    const batch = commit(base, (files) =>
      editJson(files, "assets.json", (document) => {
        document.assets["b-roll"].name = "GitHub 上起的名字";
      }),
    );
    const result = merged(mergeRepo(store, batch));
    expect(result.conflicts).toEqual([]);
    expect(store.getState().assets?.["b-roll"]?.name).toBe("GitHub 上起的名字");
    // Neither taken away nor said of this repository.
    expect(store.getState().places?.["b-roll"]).toEqual(place);
    expect(result.files).toEqual([
      { path: "assets.json", status: "merged", base: batch[0]?.text, rewrite: false },
    ]);
    expect(store.exportFiles({ here: { repo: "2002" } }).files.get("assets.json")).toContain(
      '"storage": "lfs"',
    );
  });

  it("without the files outside of it, keeps the editor's side of what it starts to point at", () => {
    const store = open();
    const base = archived(store);
    run(store, "asset.remove", { asset: "raw-footage" });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        const track = document.tracks.find((each: Json) => each.id === "track_video");
        const source = { kind: "video", media: { asset: "raw-footage" } };
        track.clips.push({ id: "clip_raw", start: "40", duration: "1", source });
        document.name = "GitHub 上改的名字";
      }),
    );
    // assets.json is not in the batch, and the platform does not know what the repository has
    // of it: the asset counts as still there, so the clip is the editor's side of a conflict.
    const conflict = only(mergeRepo(store, batch));
    expect(conflict).toMatchObject({
      kind: "removed-link",
      path: ["timelines", "main", "clips", "clip_raw"],
      ours: undefined,
      label: "片段“clip_raw”",
    });
    expect(clip(store, "clip_raw")).toBeUndefined();
    expect(main(store).name).toBe("GitHub 上改的名字");
    expect(store.exportFiles().problems).toEqual([]);
  });
});

describe("conflicts of a merge", () => {
  it("say both sides of a value, and what it is in words", () => {
    const store = open();
    const base = archived(store);
    run(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "这里的" },
    });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "GitHub 上的";
      }),
    );
    expect(only(mergeRepo(store, batch))).toEqual({
      file: MAIN,
      path: ["timelines", "main", "clips", "clip_title", "name"],
      kind: "value",
      label: "片段“这里的”的 name",
      ours: "这里的",
      theirs: "GitHub 上的",
    });
  });

  it("say both sides of lines of code, with the lines around them", () => {
    const store = open();
    run(store, "file.write", { path: CODE, text: "a\nb\nc\nd\n" });
    const base = archived(store);
    run(store, "file.write", { path: CODE, text: "a\nB 这里\nc\nd\n" });
    const batch = commit(base, (files) => files.set(CODE, "a\nB GitHub\nc\nD\n"));
    expect(only(mergeRepo(store, batch))).toEqual({
      file: CODE,
      path: ["files", CODE],
      kind: "lines",
      label: "code/animate.js 第 2 行",
      lines: { from: 1, to: 2 },
      ours: "B 这里\n",
      theirs: "B GitHub\n",
      around: { before: "a\n", after: "c\n" },
    });
  });

  it("say both sides of a whole file of code", () => {
    const store = open();
    run(store, "file.write", { path: "code/gone.js", text: "x\n" });
    const base = archived(store);
    run(store, "file.write", { path: "code/gone.js", text: "x 这里\n" });
    const batch = commit(base, (files) => files.delete("code/gone.js"));
    expect(only(mergeRepo(store, batch))).toMatchObject({
      kind: "file",
      label: "文件 code/gone.js",
      ours: "x 这里\n",
      theirs: undefined,
    });
  });

  it("say both orders of tracks", () => {
    const store = open();
    const base = archived(store);
    const tracks = orderedTracks(main(store)).map(({ id }) => id);
    const [first, second, last] = [tracks[0], tracks[1], tracks.at(-1)] as string[];
    run(store, "track.move", { timeline: "main", track: last, before: first });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        const moved = document.tracks.splice(1, 1);
        document.tracks.push(...moved);
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    expect(conflict).toMatchObject({
      kind: "order",
      path: ["timelines", "main", "tracks"],
      label: "时间轴“主线”的轨道顺序",
      ours: [last, ...tracks.slice(0, -1)],
    });
    expect(conflict.theirs).toEqual([...tracks.filter((id) => id !== second), second]);
  });

  it("say both files of an asset, which only people can settle", () => {
    const store = open();
    const base = archived(store);
    const other = "sha256-UaRlWzVDiJrgB8CHNeq2VDHD-J0Xdq2jP9bQj0Ie4mI=";
    run(store, "asset.update", {
      asset: "interview",
      changes: { hash: other, size: 10 },
    });
    const batch = commit(base, (files) =>
      editJson(files, "assets.json", (document) => {
        document.assets.interview.hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        document.assets.interview.size = 11;
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    expect(conflict).toMatchObject({
      kind: "asset-file",
      path: ["assets", "interview", "hash"],
      ours: other,
    });
    const refused = take(store, conflict);
    expect(refused.ok || refused.error).toMatchObject({
      code: "conflict-not-taken",
      params: { why: "manual", file: "assets.json" },
    });
  });
});

describe("conflict.take", () => {
  it("takes the other value, which goes back with undo", () => {
    const store = open();
    const base = archived(store);
    run(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "这里的" },
    });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "GitHub 上的";
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    const before = store.getState();
    success(take(store, conflict));
    expect(clip(store).name).toBe("GitHub 上的");
    // Once more changes nothing.
    expect(success(take(store, conflict)).patches).toEqual([]);
    expect(store.undo().ok).toBe(true);
    expect(store.getState()).toEqual(before);
  });

  it("takes the other lines, found by what they are, also after other lines moved", () => {
    const store = open();
    run(store, "file.write", { path: CODE, text: "a\nb\nc\nd\n" });
    const base = archived(store);
    run(store, "file.write", { path: CODE, text: "a\nB 这里\nc\nd\n" });
    const conflict = only(
      mergeRepo(
        store,
        commit(base, (files) => files.set(CODE, "a\nB\nc\n")),
      ),
    );
    run(store, "file.write", { path: CODE, text: "新的一行\na\nB 这里\nc\n" });
    success(take(store, conflict));
    expect(store.getState().files[CODE]).toBe("新的一行\na\nB\nc\n");
  });

  it("does not find lines that are there twice, or not any more", () => {
    const store = open();
    run(store, "file.write", { path: CODE, text: "a\nb\nc\n" });
    const base = archived(store);
    run(store, "file.write", { path: CODE, text: "a\nB 这里\nc\n" });
    const conflict = only(
      mergeRepo(
        store,
        commit(base, (files) => files.set(CODE, "a\nB\nc\n")),
      ),
    );
    for (const text of ["a\nB 这里\nc\na\nB 这里\nc\n", "a\nB 又改了\nc\n"]) {
      run(store, "file.write", { path: CODE, text });
      const result = take(store, conflict);
      expect(result.ok || result.error).toMatchObject({
        code: "conflict-not-taken",
        params: { why: "not-found" },
      });
      expect(store.getState().files[CODE]).toBe(text);
    }
  });

  it("takes the other whole file of code, also where it was taken away", () => {
    const store = open();
    run(store, "file.write", { path: "code/gone.js", text: "x\n" });
    const base = archived(store);
    run(store, "file.write", { path: "code/gone.js", text: "x 这里\n" });
    const conflict = only(
      mergeRepo(
        store,
        commit(base, (files) => files.delete("code/gone.js")),
      ),
    );
    success(take(store, conflict));
    expect(store.getState().files["code/gone.js"]).toBeUndefined();
  });

  it("takes the other order", () => {
    const store = open();
    const base = archived(store);
    const tracks = orderedTracks(main(store)).map(({ id }) => id);
    const [first, last] = [tracks[0], tracks.at(-1)] as string[];
    run(store, "track.move", { timeline: "main", track: last, before: first });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        const moved = document.tracks.splice(1, 1);
        document.tracks.push(...moved);
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    success(take(store, conflict));
    expect(orderedTracks(main(store)).map(({ id }) => id)).toEqual(conflict.theirs);
  });

  it("brings back what the editor took away, where the other side changed it", () => {
    const store = open();
    const base = archived(store);
    const marker = main(store).markers["marker_turn"];
    run(store, "marker.remove", { timeline: "main", marker: "marker_turn" });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        document.markers.find((each: Json) => each.id === "marker_turn").name = "GitHub 上的";
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    expect(conflict).toMatchObject({ kind: "value", ours: undefined });
    success(take(store, conflict));
    expect(main(store).markers["marker_turn"]).toEqual({ ...marker, name: "GitHub 上的" });
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("brings back a whole track in its place, or after the others", () => {
    const store = open();
    run(store, "track.add", { timeline: "main", id: "track_extra", kind: "video" });
    const base = archived(store);
    run(store, "track.remove", { timeline: "main", track: "track_extra" });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        document.tracks.find((each: Json) => each.id === "track_extra").name = "GitHub 上的";
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    expect(conflict).toMatchObject({
      kind: "value",
      path: ["timelines", "main", "tracks", "track_extra"],
      ours: undefined,
      theirs: { name: "GitHub 上的", kind: "video" },
    });
    success(take(store, conflict));
    expect(orderedTracks(main(store)).at(-1)).toMatchObject({
      id: "track_extra",
      name: "GitHub 上的",
    });
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("does not write over what changed there since", () => {
    const store = open();
    const base = archived(store);
    run(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "这里的" },
    });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "GitHub 上的";
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    run(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "又改了" },
    });
    const result = take(store, conflict);
    expect(result.ok || result.error).toMatchObject({
      code: "conflict-not-taken",
      params: { why: "changed", file: MAIN },
    });
    expect(clip(store).name).toBe("又改了");
  });

  it("does not leave anything pointing at nothing", () => {
    const store = open();
    const base = archived(store);
    run(store, "clip.remove", { timeline: "main", clips: ["clip_title"] });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "GitHub 上的";
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    expect(conflict).toMatchObject({ path: ["timelines", "main", "clips", "clip_title"] });
    // The track of the clip is gone now too: the clip would be on nothing.
    const before = store.getState();
    run(store, "track.remove", { timeline: "main", track: "track_video" });
    const result = take(store, conflict);
    expect(result.ok || result.error).toMatchObject({
      code: "conflict-not-taken",
      params: { why: "would-break" },
    });
    expect(clip(store)).toBeUndefined();
    expect(before.timelines["main"]?.tracks["track_video"]).toBeDefined();
  });

  it("is for people only", () => {
    const store = open();
    const base = archived(store);
    run(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "这里的" },
    });
    const batch = commit(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "GitHub 上的";
      }),
    );
    const conflict = only(mergeRepo(store, batch));
    const result = store.execute(
      { type: "conflict.take", params: { conflict } },
      { origin: "ai:task" },
    );
    expect(result.ok || result.error.code).toBe("user-only");
  });
});

describe("merging what can come in", () => {
  /** A project that refuses any batch with code/bad.js, and says so, as `mergeFiles` would. */
  const refusing = () => {
    const merges: string[][] = [];
    const store = {
      getState: () => open().getState(),
      mergeFiles(changes: readonly FileChange[]): MergeResult {
        merges.push(changes.map(({ path }) => path));
        if (changes.some(({ path }) => path === "code/bad.js")) {
          const problem = {
            severity: "error" as const,
            code: "merge-would-break",
            file: "code/bad.js",
            message: "",
          };
          const error = { code: "merge-would-break" as const, params: {}, problems: [problem] };
          return { ok: false, error, files: [] };
        }
        return {
          ok: true,
          revision: 1,
          results: [],
          patches: [],
          state: open().getState(),
          files: [],
          problems: [],
          conflicts: [],
          kept: [],
          held: [],
        };
      },
    };
    return { store, merges };
  };

  it("leaves out the files a refusal names, and merges the rest", () => {
    const { store, merges } = refusing();
    const batch = ["code/a.js", "code/bad.js", "code/c.js"].map((path) => ({
      path,
      base: "x\n",
      text: "y\n",
    }));
    const rounds: MergeRound[] = [];
    mergeInRounds(store as never, batch, { origin: REPO, baseOf: undefined }, (round) =>
      rounds.push(round),
    );
    expect(merges).toEqual([
      ["code/a.js", "code/bad.js", "code/c.js"],
      ["code/a.js", "code/c.js"],
    ]);
    expect(rounds.map((round) => [round.ok, round.changes.map(({ path }) => path)])).toEqual([
      [false, ["code/bad.js"]],
      [true, ["code/a.js", "code/c.js"]],
    ]);
  });

  it("tries a single file only once", () => {
    const { store, merges } = refusing();
    const rounds: MergeRound[] = [];
    const batch = [{ path: "code/bad.js", base: "x\n", text: "y\n" }];
    mergeInRounds(store as never, batch, { origin: REPO, baseOf: undefined }, (round) =>
      rounds.push(round),
    );
    expect(merges).toHaveLength(1);
    expect(rounds.map(({ ok }) => ok)).toEqual([false]);
  });

  it("goes file by file where a refusal names none, and asks about the files left out", () => {
    const asked: string[] = [];
    let calls = 0;
    const fake = {
      getState: () => open().getState(),
      mergeFiles(
        changes: readonly FileChange[],
        options: { baseOf?: ((path: string) => string | undefined) | undefined },
      ): MergeResult {
        calls += 1;
        if (changes.length > 1) {
          return {
            ok: false,
            error: { code: "merge-unsettled", params: {}, problems: [] },
            files: [],
          };
        }
        for (const path of ["a.js", "b.js"].map((name) => `code/${name}`)) {
          asked.push(`${changes[0]?.path} ${path}=${options.baseOf?.(path)}`);
        }
        return {
          ok: true,
          revision: calls,
          results: [],
          patches: [],
          state: open().getState(),
          files: [],
          problems: [],
          conflicts: [],
          kept: [],
          held: [],
        };
      },
    };
    const batch = [
      { path: "code/a.js", base: "a\n", text: "A\n" },
      { path: "code/b.js", base: "b\n", text: "B\n" },
    ];
    const rounds: MergeRound[] = [];
    mergeInRounds(
      fake as never,
      batch,
      { origin: REPO, baseOf: (path) => `old ${path}` },
      (round) => rounds.push(round),
    );
    expect(rounds.map((round) => [round.ok, round.changes.map(({ path }) => path)])).toEqual([
      [true, ["code/a.js"]],
      [true, ["code/b.js"]],
    ]);
    // What a file outside a merge holds is what the batch has of it.
    expect(asked).toEqual([
      "code/a.js code/a.js=old code/a.js",
      "code/a.js code/b.js=B\n",
      "code/b.js code/a.js=A\n",
      "code/b.js code/b.js=old code/b.js",
    ]);
  });
});

describe("the same change of code, twice", () => {
  it("is told by what was inserted, and only by that", () => {
    const before = "a\nb\nc\n";
    const after = "a\nb\nnew 1\nnew 2\nc\n";
    const insertion = insertionOf(before, after);
    expect(insertion?.inserted.length).toBe("new 1\nnew 2\n".length);
    expect(undoubled(after, insertion as never)).toBeUndefined();
    const twice = "a\nb\nnew 1\nnew 2\nnew 1\nnew 2\nc\n";
    expect(undoubled(twice, insertion as never)).toBe(after);
    const thrice = "a\nb\nnew 1\nnew 2\nnew 1\nnew 2\nnew 1\nnew 2\nc\n";
    expect(undoubled(thrice, insertion as never)).toBe(after);
    // Anything else could be what people wrote.
    expect(undoubled("x\nb\nnew 1\nnew 2\nnew 1\nnew 2\nc\n", insertion as never)).toBeUndefined();
    expect(undoubled("a\nb\nnew 1\nnew 2\nnew 1\nnew 3\nc\n", insertion as never)).toBeUndefined();
    expect(insertionOf("a\nb\n", "a\n")).toBeUndefined();
  });

  it("comes with code a merge copied as it is", () => {
    const store = open();
    run(store, "file.write", { path: CODE, text: "a\nc\n" });
    const base = archived(store);
    const result = merged(
      mergeRepo(
        store,
        commit(base, (files) => files.set(CODE, "a\nb\nc\n")),
      ),
    );
    const copied = result.files.find(({ path }) => path === CODE)?.copied;
    expect(copied).toEqual(insertionOf("a\nc\n", "a\nb\nc\n"));
    // Not where the editor's side of the file stayed too.
    const other = open();
    run(other, "file.write", { path: CODE, text: "a\nc\n" });
    const otherBase = archived(other);
    run(other, "file.write", { path: CODE, text: "a\nc\nmine\n" });
    const mixed = merged(
      mergeRepo(
        other,
        commit(otherBase, (files) => files.set(CODE, "a\nb\nc\n")),
      ),
    );
    expect(mixed.files.find(({ path }) => path === CODE)?.copied).toBeUndefined();
  });
});

describe("folder batches stay as they were", () => {
  it("take a tool's batch as one origin, and repository batches beside them", () => {
    const store = open();
    const base = archived(store, {});
    const batch = commit(base, (files) => files.set(CODE, "// 文件夹里改的\n"));
    merged(
      store.mergeFiles(batch, { origin: folderBatch("tool-7"), baseOf: (path) => base.get(path) }),
    );
    const again = commit(archived(store), (files) => files.set(CODE, "// GitHub 上改的\n"));
    merged(mergeRepo(store, again));
    expect(store.canUndoOrigin(folderBatch("tool-7"))).toBe(true);
    expect(store.canUndoOrigin(REPO)).toBe(true);
    expect(USER).toBe("user");
  });
});
