import { canHold } from "@animaquill/schema";
import { afterAll, describe, expect, it } from "vitest";
import {
  FUZZ,
  openUnlocked,
  randomCommand,
  randomFrom,
  seedIds,
  type Random,
} from "./fuzz-support.ts";
import type { FileChange } from "./merge-files.ts";
import { linesOf } from "./merge-text.ts";
import { orderedSections, orderedTracks, type ProjectState } from "./model.ts";
import { deepEqual, getIn, type Patch } from "./patch.ts";
import { danglingAt } from "./references.ts";
import { isContainer, type Path } from "./structure.ts";
import { ProjectStore, USER, folderBatch, type MergeResult, type Origin } from "./store.ts";

const MAIN = "timelines/main/timeline.json";
/** Code both sides like to change. */
const SHARED = "code/animate.js";
const HIGHLIGHT = "timelines/highlight/timeline.json";
const ROUNDS = 100;
/** A project drifts far from where it started, which is worth seeing, but not without end. */
const FRESH_START = 40;

type Files = Map<string, string>;
type Fresh = (kind: string) => string;
// Documents as JSON, which is what these tests change at random.
type Json = any;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function opened(files: ReadonlyMap<string, string>): ProjectState | undefined {
  return ProjectStore.open(files).store?.getState();
}

/** Somebody broke some files on purpose, see randomFolder. */
function parsed(text: string | undefined): Json {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function edit(files: Files, path: string, change: (document: Json) => void): void {
  const document = parsed(files.get(path));
  if (!isPlain(document)) return;
  change(document);
  files.set(path, JSON.stringify(document, null, 1));
}

const clipsOf = (document: Json): Json[] =>
  document.tracks.flatMap((track: Json) => track.clips as Json[]);

/** Takes a clip out of a file the way the editor would: the joins on either side of it go along. */
function dropClip(document: Json, clip: Json): void {
  for (const track of document.tracks) {
    track.clips = track.clips.filter((each: Json) => each !== clip);
    if (!track.joins) continue;
    track.joins = track.joins.filter(({ from, to }: Json) => from !== clip.id && to !== clip.id);
    if (track.joins.length === 0) delete track.joins;
  }
}

/** A transition of the editor, the way a file has one. */
const fade = (random: Random) => ({
  type: "fade",
  duration: random.pick(["1/3", "0.5", "1"]) as string,
  ...(random.chance(0.3) && { curve: [0.42, 0, 0.58, 1] }),
});

const VIDEO_ONLY = ["hidden"];
const AUDIO_ONLY = ["role", "muted", "solo", "properties", "effects", "sends", "output"];

/** What somebody might do to a timeline in a text editor, or what Git might bring. */
function changeTimeline(document: Json, random: Random, fresh: Fresh): void {
  if (!Array.isArray(document.tracks) || !Array.isArray(document.sections)) return;
  for (let count = 1 + random.int(3); count > 0; count--) {
    const tracks = document.tracks as Json[];
    const track = random.pick(tracks);
    const clips = clipsOf(document);
    const clip = random.chance(0.5)
      ? clips.find(({ id }: Json) => id === "clip_title")
      : random.pick(clips);
    switch (random.int(18)) {
      case 0:
        if (track) track.name = fresh("名");
        break;
      case 1:
        if (track?.locked) delete track.locked;
        else if (track) track.locked = true;
        break;
      case 2: {
        if (!track || tracks.length < 2) break;
        document.tracks = tracks.filter((each) => each !== track);
        for (const each of track.clips) {
          const home = random.pick(
            document.tracks.filter((other: Json) => canHold(other.kind, each.source.kind)),
          ) as Json;
          if (home && random.chance(0.5))
            home.clips.push({ ...each, start: String(80 + random.int(9)) });
          else dropClip(document, each);
        }
        break;
      }
      case 3:
        tracks.splice(random.int(tracks.length + 1), 0, {
          id: fresh("track"),
          kind: random.pick(["video", "audio"]),
          clips: [],
        });
        break;
      case 4: {
        if (!track) break;
        document.tracks = tracks.filter((each) => each !== track);
        document.tracks.splice(random.int(document.tracks.length + 1), 0, track);
        break;
      }
      case 5: {
        // Only an empty track can become another kind and stay what its kind allows.
        if (!track || track.clips.length > 0) break;
        const kind = random.pick(
          ["video", "audio", "caption"].filter((each) => each !== track.kind),
        );
        for (const key of kind === "audio" ? VIDEO_ONLY : AUDIO_ONLY) delete track[key];
        if (kind === "caption") delete track.joins;
        track.kind = kind;
        break;
      }
      case 6:
        if (clip) clip.name = fresh("片段");
        break;
      case 7:
        if (clip) clip.start = String(random.int(60));
        break;
      case 8:
        if (clip) clip.properties = { ...clip.properties, opacity: random.int(10) / 10 };
        break;
      case 9:
        if (clip) dropClip(document, clip);
        break;
      case 10: {
        const home = random.chance(0.5)
          ? tracks.find(({ id }) => id === "track_video")
          : random.pick(tracks.filter((each) => each.kind === "video"));
        if (!home) break;
        home.clips.push({
          id: fresh("clip"),
          start: String(60 + random.int(30)),
          duration: "1",
          source: { kind: "color", color: "#123456" },
        });
        break;
      }
      case 11: {
        if (!clip) break;
        const from = tracks.find((each) => each.clips.includes(clip));
        const to = random.pick(
          tracks.filter((each) => each !== from && canHold(each.kind, clip.source.kind)),
        );
        if (!from || !to) break;
        dropClip(document, clip);
        to.clips.push(clip);
        break;
      }
      case 12: {
        const home = random.pick(
          tracks.filter((each) => each.kind === "video" && each.clips.length > 0),
        );
        const other = random.chance(0.5)
          ? clips.find(({ id }: Json) => id === "clip_logo")
          : random.pick(clips);
        if (!home || !other) break;
        const join = { id: fresh("join"), from: home.clips[0].id, to: other.id, ...fade(random) };
        home.joins = [...(home.joins ?? []), join];
        break;
      }
      case 13: {
        const sections = document.sections as Json[];
        const section = random.pick(sections);
        const roll = random.int(4);
        if (roll === 0 && section) section.duration = String(1 + random.int(20));
        else if (roll === 1)
          sections.splice(random.int(sections.length + 1), 0, {
            id: fresh("section"),
            duration: "2",
          });
        else if (roll === 2 && sections.length > 1)
          document.sections = sections.filter((each) => each !== section);
        else if (section) {
          document.sections = sections.filter((each) => each !== section);
          document.sections.splice(random.int(document.sections.length + 1), 0, section);
        }
        break;
      }
      case 14:
        document.markers = [
          ...(document.markers ?? []),
          { id: fresh("marker"), time: String(random.int(30)) },
        ];
        break;
      case 15: {
        // What comes in and goes out of a clip.
        if (!clip) break;
        const edge = random.chance(0.5) ? "enter" : "exit";
        if (random.chance(0.3)) delete clip[edge];
        else clip[edge] = fade(random);
        break;
      }
      case 16: {
        const home = random.pick(tracks.filter((each) => each.joins?.length));
        const join = home && random.pick(home.joins as Json[]);
        if (!join) break;
        const roll = random.int(3);
        if (roll === 0) join.duration = random.pick(["0.25", "0.5", "1.5"]);
        else if (roll === 1) join.align = random.pick(["before", "after", "center"]);
        else {
          home.joins = home.joins.filter((each: Json) => each !== join);
          if (home.joins.length === 0) delete home.joins;
        }
        break;
      }
      default:
        document.name = fresh("时间轴");
    }
  }
}

/** What versions change: values, whole clips, the whole file, or a new one. */
function changeVersions(
  files: Files,
  random: Random,
  fresh: Fresh,
  clips: readonly string[],
): void {
  const name = random.pick(["format.vertical", "language.en", "format.square"]) as string;
  const path = `timelines/main/overrides/${name}.json`;
  if (files.has(path) && random.chance(0.15)) {
    files.delete(path);
    return;
  }
  const scope = name === "language.en" ? { language: "en" } : { format: name.split(".")[1] };
  const found: Json = files.has(path) ? parsed(files.get(path)) : { scope };
  if (!isPlain(found) || (found["clips"] !== undefined && !isPlain(found["clips"]))) return;
  const document: Json = found;
  for (let count = 1 + random.int(3); count > 0; count--) {
    const clip = random.pick(clips) as string;
    document.clips ??= {};
    if (random.chance(0.3)) delete document.clips[clip];
    else document.clips[clip] = { ...document.clips[clip], hidden: { value: random.chance(0.5) } };
  }
  if (Object.keys(document.clips).length === 0) delete document.clips;
  files.set(path, JSON.stringify(document, null, 1));
  void fresh;
}

function changeAssets(document: Json, random: Random, fresh: Fresh): void {
  if (!isPlain(document.assets)) return;
  for (const id of Object.keys(document.assets)) {
    if (!random.chance(0.3)) continue;
    const roll = random.int(3);
    if (roll === 0) delete document.assets[id];
    else if (roll === 1) document.assets[id].path = `assets/${fresh("a")}.png`;
    else document.assets[id].credit = fresh("作者");
  }
  if (random.chance(0.3)) {
    document.assets[fresh("asset")] = {
      kind: "image",
      path: `assets/${fresh("b")}.png`,
      storage: "local",
    };
  }
}

function changeScenes(files: Files, random: Random, fresh: Fresh): void {
  const scenes = [...files.keys()].flatMap(
    (path) => /^scenes\/([^/]+)\/scene\.json$/.exec(path)?.slice(1) ?? [],
  );
  const scene = random.pick(scenes);
  const roll = random.int(6);
  if (roll === 0 && scene) {
    edit(files, `scenes/${scene}/scene.json`, (document) => {
      document.name = fresh("场景");
    });
  } else if (roll === 1 && scene) {
    for (const path of files.keys()) if (path.startsWith(`scenes/${scene}/`)) files.delete(path);
  } else if (roll === 2 && scene) {
    files.delete(`scenes/${scene}/scene.json`);
  } else if (roll === 3 && scene) {
    const entry = parsed(files.get(`scenes/${scene}/scene.json`))?.entry;
    if (entry) files.delete(`scenes/${scene}/${entry}`);
  } else {
    const id = fresh("scene");
    files.set(
      `scenes/${id}/scene.json`,
      JSON.stringify({ name: "外面的场景", entry: "index.html", runtime: 1 }),
    );
    files.set(`scenes/${id}/index.html`, `<p>${id}</p>\n`);
  }
}

/** Lines that are each different, so that where each one went says what happened. */
function changeCode(files: Files, random: Random, fresh: Fresh): void {
  const sources = [...files.keys()].filter(
    (path) => /^(scenes|sounds|code)\//.test(path) && !path.endsWith(".json"),
  );
  const path = random.chance(0.5) && files.has(SHARED) ? SHARED : random.pick(sources);
  const roll = random.int(8);
  if (roll === 0 || !path) {
    files.set(`code/${fresh("code")}.js`, `// ${fresh("x")}\n`);
    return;
  }
  if (roll === 1) {
    files.delete(path);
    return;
  }
  const lines = linesOf(files.get(path) as string);
  for (let count = 1 + random.int(3); count > 0; count--) {
    const at = random.int(random.chance(0.5) ? Math.min(3, lines.length + 1) : lines.length + 1);
    const change = random.int(3);
    if (change === 0 && lines.length > 0) lines.splice(Math.min(at, lines.length - 1), 1);
    else if (change === 1 && lines.length > 0)
      lines[Math.min(at, lines.length - 1)] = `// ${fresh("x")}\n`;
    else lines.splice(at, 0, `// ${fresh("x")}\n`);
  }
  files.set(path, lines.join(""));
}

function changeLocales(files: Files, random: Random, fresh: Fresh): void {
  const roll = random.int(5);
  if (roll === 0) {
    files.delete("locales/en.json");
  } else if (roll === 1) {
    files.set("locales/fr.json", JSON.stringify({ strings: { [fresh("k")]: { text: "un" } } }));
  } else {
    edit(files, "locales/en.json", (document) => {
      if (!isPlain(document.strings)) return;
      const key = random.pick(Object.keys(document.strings));
      if (key && random.chance(0.3)) delete document.strings[key];
      else if (key) document.strings[key].text = fresh("text");
      else document.strings[fresh("k")] = { text: "new" };
    });
  }
}

/**
 * What the editor does that the folder runs into: it takes away a clip or an asset that the folder
 * then starts to use, puts a picture on a track that the folder makes one for sound, gives a clip
 * another way to come in than the folder does, takes away a clip, with its join, whose join the
 * folder changes, or changes a join that the folder takes away, or the first line of the shared code,
 * which the folder changes too, as well as one at the end, or moves the last track to the front,
 * while the folder moves the first one to the end and renames one.
 */
type Clash = "clip" | "asset" | "kind" | "edge" | "join" | "joinGone" | "code" | "order";

/**
 * A folder that somebody changed outside of the editor, from what the editor wrote, with what runs
 * into what the editor did, see `Clash`. A "clip" clash is a join to the clip `aim`, which the
 * editor took away meanwhile, and a line at the top of the shared code, where the editor put one too.
 */
function randomFolder(
  base: ReadonlyMap<string, string>,
  random: Random,
  fresh: Fresh,
  clash: Clash | undefined,
  /** The track a "kind" clash is about, empty when the editor wrote it. */
  empty: string | undefined,
  /** The clip a "clip" clash is about. */
  aim: string | undefined,
): Files {
  const files = new Map(base);
  // Somebody may have broken the file of a timeline in an earlier round, and it waits.
  const editTimeline = (change: (document: Json) => void) =>
    edit(files, MAIN, (document) => {
      if (Array.isArray(document.tracks) && document.tracks.every(isPlain)) change(document);
    });
  if (clash === "order") {
    editTimeline((document) => {
      const tracks = document.tracks as Json[];
      if (tracks.length < 3) return;
      tracks.push(...tracks.splice(0, 1));
      (tracks[0] as Json).name = fresh("名");
    });
  }
  if (clash === "code") {
    const shared = files.get(SHARED);
    const lines = shared === undefined ? [] : linesOf(shared);
    if (lines.length > 2) {
      lines[0] = `// ${fresh("x")}\n`;
      lines.push(`// ${fresh("x")}\n`);
      files.set(SHARED, lines.join(""));
    }
  }
  if (clash === "edge") {
    editTimeline((document) => {
      const clip = clipsOf(document).find(({ id }: Json) => id === "clip_title");
      if (clip) clip.enter = { type: "fade", duration: "2" };
    });
  }
  if (clash === "joinGone") {
    editTimeline((document) => {
      for (const track of document.tracks) {
        if (!track.joins) continue;
        track.joins = track.joins.filter(({ id }: Json) => id !== "join_1");
        if (track.joins.length === 0) delete track.joins;
      }
    });
  }
  if (clash === "join") {
    editTimeline((document) => {
      const join = document.tracks
        .flatMap((track: Json) => track.joins ?? [])
        .find(({ id }: Json) => id === "join_1");
      if (join) join.duration = "2";
    });
  }
  if (clash === "asset") {
    const assets = parsed(base.get("assets.json"))?.assets;
    editTimeline((document) => {
      const home = document.tracks.find(({ id }: Json) => id === "track_video");
      if (!home || !isPlain(assets) || !Object.hasOwn(assets, "raw-footage")) return;
      home.clips.push({
        id: fresh("clip"),
        start: String(100 + random.int(20)),
        duration: "1",
        source: { kind: "video", media: { asset: "raw-footage" } },
      });
    });
  }
  if (clash === "kind") {
    editTimeline((document) => {
      const track = document.tracks.find(({ id }: Json) => id === empty);
      if (!track || track.clips.length > 0) return;
      for (const key of VIDEO_ONLY) delete track[key];
      track.kind = "audio";
    });
  }
  if (clash === "clip") {
    editTimeline((document) => {
      const home = document.tracks.find(({ id }: Json) => id === "track_video");
      const from = home?.clips.find(({ id }: Json) => id !== aim);
      if (!from || !clipsOf(document).some(({ id }: Json) => id === aim)) return;
      const join = { id: fresh("join"), from: from.id, to: aim, type: "fade", duration: "0.5" };
      home.joins = [...(home.joins ?? []), join];
    });
    const shared = files.get(SHARED);
    if (shared !== undefined) files.set(SHARED, `// ${fresh("x")}\n${shared}`);
  }
  const main = parsed(base.get(MAIN));
  const clips = Array.isArray(main?.tracks) ? clipsOf(main).map((clip) => clip.id as string) : [];
  for (let count = 1 + random.int(4); count > 0; count--) {
    const roll = random.int(100);
    if (roll < 30) editTimeline((document) => changeTimeline(document, random, fresh));
    else if (roll < 34) newTimeline(files, random, fresh, aim);
    else if (roll < 44) changeVersions(files, random, fresh, clips);
    else if (roll < 51)
      edit(files, "assets.json", (document) => changeAssets(document, random, fresh));
    else if (roll < 59) changeScenes(files, random, fresh);
    else if (roll < 72) changeCode(files, random, fresh);
    else if (roll < 76) {
      edit(files, "notes.json", (document) => {
        if (!Array.isArray(document.notes)) return;
        const note = random.pick(document.notes) as Json;
        if (note && random.chance(0.3))
          document.notes = document.notes.filter((each: Json) => each !== note);
        else if (note) note.text = fresh("批注");
      });
    } else if (roll < 81) changeLocales(files, random, fresh);
    else if (roll < 86) {
      edit(files, "animaquill.json", (document) => {
        document.name = fresh("项目");
        if (random.chance(0.3)) document.tags = [{ name: fresh("标签"), color: "#888888" }];
      });
    } else if (roll < 91) {
      // A file somebody broke.
      const documents = [...files.keys()].filter(
        (path) => path.endsWith(".json") && path !== "animaquill.json",
      );
      const path = random.pick(documents);
      if (path) files.set(path, random.chance(0.5) ? "{oops" : JSON.stringify({ name: 5 }));
    } else if (roll < 97) {
      files.delete(HIGHLIGHT);
      if (random.chance(0.6)) {
        edit(files, "animaquill.json", (document) => {
          document.timelines = document.timelines.filter((id: string) => id !== "highlight");
        });
      }
    } else if (random.chance(0.3)) {
      files.delete("animaquill.json");
    }
  }
  return files;
}

/**
 * A timeline that the folder brings: a copy of the main one, maybe with a join to the clip the editor
 * takes away, maybe broken, maybe with a version, listed in the manifest or not. Or only listed.
 */
function newTimeline(files: Files, random: Random, fresh: Fresh, aim: string | undefined): void {
  const id = fresh("tl");
  const source = parsed(files.get(MAIN));
  const roll = random.int(10);
  if (roll > 0 && isPlain(source) && Array.isArray(source["tracks"])) {
    const copy: Json = structuredClone(source);
    copy.name = fresh("副本");
    const home = copy.tracks.find((track: Json) => track.id === "track_video");
    const from = home?.clips.find((clip: Json) => clip.id !== aim);
    if (aim && from && random.chance(0.5) && clipsOf(copy).some((clip: Json) => clip.id === aim)) {
      const join = { id: fresh("join"), from: from.id, to: aim, type: "fade", duration: "0.5" };
      home.joins = [...(home.joins ?? []), join];
    }
    const broken = random.chance(0.25);
    files.set(
      `timelines/${id}/timeline.json`,
      broken ? JSON.stringify({ name: 5 }) : JSON.stringify(copy, null, 1),
    );
    if (random.chance(0.5)) {
      const version = {
        scope: { format: "vertical" },
        clips: { clip_title: { hidden: { value: true } } },
      };
      files.set(`timelines/${id}/overrides/format.vertical.json`, JSON.stringify(version));
    }
  }
  if (roll === 0 || random.chance(0.75)) {
    edit(files, "animaquill.json", (document) => {
      if (Array.isArray(document.timelines)) document.timelines = [...document.timelines, id];
    });
  }
}

function changesOf(
  base: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): FileChange[] {
  return [...new Set([...base.keys(), ...next.keys()])]
    .filter((path) => base.get(path) !== next.get(path))
    .map((path) => ({ path, base: base.get(path), text: next.get(path) }));
}

function lockOrUnlock(store: ProjectStore, random: Random): void {
  const track = random.pick(Object.keys(store.getState().timelines["main"]?.tracks ?? {}));
  const changes = { locked: random.chance(0.5) };
  store.execute({ type: "track.update", params: { timeline: "main", track, changes } });
}

/** What the editor did and has not written yet: commands, code, locks and versions. */
function editorChange(store: ProjectStore, random: Random, fresh: Fresh): void {
  const state = store.getState();
  const roll = random.int(14);
  if (roll < 4) {
    store.execute(randomCommand(store, random));
  } else if (roll < 5) {
    const main = state.timelines["main"];
    if (random.chance(0.7)) {
      const clip = random.chance(0.5) ? "clip_logo" : random.pick(Object.keys(main?.clips ?? {}));
      store.execute({ type: "clip.remove", params: { timeline: "main", clips: [clip] } });
    } else {
      const track = random.chance(0.5)
        ? "track_video"
        : random.pick(Object.keys(main?.tracks ?? {}));
      store.execute({ type: "track.remove", params: { timeline: "main", track } });
    }
  } else if (roll < 8) {
    const timeline = "main";
    const clip = "clip_title";
    const what = random.int(3);
    if (what === 0) {
      const changes = { name: fresh("名") };
      store.execute({ type: "clip.update", params: { timeline, clip, changes } });
    } else if (what === 1) {
      const enter = random.chance(0.2) ? null : fade(random);
      store.execute({ type: "clip.setTransition", params: { timeline, clip, enter } });
    } else {
      const value = random.int(10) / 10;
      store.execute({
        type: "clip.setProperty",
        params: { timeline, clip, path: "opacity", value },
      });
    }
  } else if (roll < 10) {
    const paths = Object.keys(state.files);
    const path = random.chance(0.5) && paths.includes(SHARED) ? SHARED : random.pick(paths);
    if (!path) return;
    const lines = linesOf(state.files[path] as string);
    const at = random.int(random.chance(0.5) ? Math.min(3, lines.length + 1) : lines.length + 1);
    if (random.chance(0.3) && lines.length > 0) lines.splice(Math.min(at, lines.length - 1), 1);
    else lines.splice(at, 0, `// ${fresh("e")}\n`);
    store.execute({ type: "file.write", params: { path, text: lines.join("") } });
  } else if (roll < 12) {
    lockOrUnlock(store, random);
  } else {
    const path = "timelines/main/overrides/format.vertical.json";
    const text = store.exportFiles().files.get(path);
    const clip = random.pick(Object.keys(state.timelines["main"]?.clips ?? {}));
    if (text === undefined || clip === undefined) return;
    const document = JSON.parse(text);
    document.clips ??= {};
    document.clips[clip] = { ...document.clips[clip], hidden: { value: random.chance(0.5) } };
    store.importFile(path, JSON.stringify(document), { origin: USER });
  }
}

const SEPARATOR = "\u0000";

const isOrder = (path: Path) =>
  path.length === 5 &&
  path[0] === "timelines" &&
  (path[2] === "tracks" || path[2] === "sections") &&
  path[4] === "order";

/** Every value of a project as fine-grained as the document is, which is what merges go by. */
function leavesOf(value: unknown, path: Path = [], into = new Map<string, unknown>()) {
  if (path[0] === "files" || isOrder(path)) return into;
  if (isContainer(path) && isPlain(value)) {
    for (const [key, item] of Object.entries(value)) leavesOf(item, [...path, key], into);
  } else if (value !== undefined) {
    into.set(path.join(SEPARATOR), value);
  }
  return into;
}

function changedLeaves(a: ProjectState, b: ProjectState): string[] {
  const before = leavesOf(a);
  const after = leavesOf(b);
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (key) => !deepEqual(before.get(key), after.get(key)),
  );
}

const at = (state: ProjectState, key: string) => getIn(state, key.split(SEPARATOR));

/** Joins with only some of what makes one, which no file has: see `JoinState`. */
const partialJoins = (state: ProjectState) =>
  Object.entries(state.timelines).flatMap(([id, timeline]) =>
    Object.entries(timeline.joins ?? {})
      .filter(([, { track, from, to, transition }]) => !track || !from || !to || !transition)
      .map(([join]) => `${id}/${join}`),
  );

/** What points at nothing anywhere in a project, see `danglingAt`, and code without its entry. */
function danglingIn(state: ProjectState | undefined): string[] {
  if (!state) return [];
  const links = Object.keys(state.timelines).flatMap((id) => danglingAt(state, ["timelines", id]));
  for (const id of state.manifest.timelines) {
    if (!Object.hasOwn(state.timelines, id)) links.push(`manifest -> timelines/${id}`);
  }
  for (const [root, manifests] of [
    ["scenes", state.scenes],
    ["sounds", state.sounds],
  ] as const) {
    for (const [id, { entry }] of Object.entries(manifests)) {
      const file = `${root}/${id}/${entry}`;
      if (state.files[file] === undefined) links.push(`${root}/${id} -> files/${file}`);
    }
  }
  return links;
}

/** Where the project keeps what a file holds. */
function placeOfFile(path: string): Path {
  const fixed: Record<string, Path> = {
    "animaquill.json": ["manifest"],
    "assets.json": ["assets"],
    "libraries.json": ["libraries"],
    "libraries.lock.json": ["lock"],
    "notes.json": ["notes"],
  };
  if (Object.hasOwn(fixed, path)) return fixed[path] as Path;
  const named = (pattern: RegExp) => pattern.exec(path)?.slice(1);
  const timeline = named(/^timelines\/([^/]+)\/timeline\.json$/);
  if (timeline) return ["timelines", timeline[0] as string];
  const version = named(/^timelines\/([^/]+)\/overrides\/([^/]+)\.json$/);
  if (version) return ["timelines", version[0] as string, "overrides", version[1] as string];
  const scene = named(/^scenes\/([^/]+)\/scene\.json$/);
  if (scene) return ["scenes", scene[0] as string];
  const sound = named(/^sounds\/([^/]+)\/sound\.json$/);
  if (sound) return ["sounds", sound[0] as string];
  const locale = named(/^locales\/([^/]+)\.json$/);
  if (locale) return ["locales", locale[0] as string];
  return ["files", path];
}

const sequence = (items: readonly { readonly id: string }[]) => items.map(({ id }) => id);

/** A track or a section without its number, which says nothing on its own, see `isOrder`. */
const withoutOrder = (value: unknown) => {
  if (!isPlain(value) || !("order" in value)) return value;
  const { order: _order, ...rest } = value;
  return rest;
};
const among = (of: readonly string[], kept: ReadonlySet<string>) => of.filter((id) => kept.has(id));

/** What each side did to the order of tracks and sections, and what the merge has to show for it. */
function checkOrder(
  where: string,
  base: ProjectState,
  mine: ProjectState,
  theirs: ProjectState | undefined,
  merged: ProjectState,
  /** The timelines whose files came in. */
  came: ReadonlySet<string>,
): void {
  for (const [id, timeline] of Object.entries(merged.timelines)) {
    for (const ordered of [orderedTracks, orderedSections]) {
      const now = sequence(ordered(timeline));
      const of = (state: ProjectState | undefined) => {
        const other = state?.timelines[id];
        return other ? sequence(ordered(other)) : [];
      };
      const [was, my, their] = [of(base), of(mine), of(theirs)];
      const moved = (side: readonly string[]) =>
        !deepEqual(among(was, new Set(side)), among(side, new Set(was)));
      const winner = moved(their) && !moved(my) && came.has(id) ? their : my;
      const inNow = new Set(now);
      // What the side that counts has in common with the result is in its order.
      expect(among(now, new Set(winner)), `${where} ${id}`).toEqual(among(winner, inNow));
    }
  }
}

/** How many rounds over all seeds had each of these, and how many at least, or this tests little. */
const counts = {
  conflicts: 0,
  textConflicts: 0,
  kept: 0,
  held: 0,
  blocked: 0,
  refused: 0,
  broken: 0,
  usesRemoved: 0,
  /** Joins, and what comes in and goes out of clips, that came in. */
  joins: 0,
  edges: 0,
  /** Where both sides changed one of those. */
  transitionConflicts: 0,
  /** Where both sides moved tracks or sections, each in their own way. */
  orderConflicts: 0,
  deleted: 0,
  rewritten: 0,
  undone: 0,
  moved: 0,
  /** Timelines the folder brought that came in, and files that waited from one batch to the next. */
  newTimelines: 0,
  waitedAgain: 0,
};
const AT_LEAST: Readonly<Record<keyof typeof counts, number>> = {
  conflicts: 20,
  textConflicts: 15,
  kept: 10,
  held: 30,
  blocked: 40,
  refused: 10,
  broken: 10,
  usesRemoved: 10,
  joins: 40,
  edges: 20,
  transitionConflicts: 8,
  orderConflicts: 10,
  deleted: 80,
  rewritten: 150,
  undone: 80,
  moved: 25,
  newTimelines: 15,
  waitedAgain: 15,
};

afterAll(() => {
  for (const [what, count] of Object.entries(counts)) {
    expect(count, what).toBeGreaterThanOrEqual(AT_LEAST[what as keyof typeof counts]);
  }
});

describe.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "merging what changed in the folder, seed %i",
  FUZZ,
  (seed) => {
    it("keeps the editor's changes, brings in the folder's, stays whole, and goes back as one", () => {
      seedIds(seed);
      const random = randomFrom(seed);
      let made = 0;
      const fresh: Fresh = (kind) => `${kind}_${seed}_${made++}`;
      let store = openUnlocked();
      /** What the folder holds, and the base of each file: what the editor last wrote or read. */
      let disk: Files = new Map();
      let bases: Files = new Map();
      for (let round = 0; round < ROUNDS; round++) {
        if (round % FRESH_START === 0) {
          store = openUnlocked();
          bases = new Map(store.exportFiles().files);
          disk = new Map(bases);
        }
        const where = `seed ${seed} round ${round}`;
        // Locks the editor already wrote out, which are a field like any other.
        if (random.chance(0.3)) lockOrUnlock(store, random);
        // Code twice: a conflict in code takes both sides changing lines next to each other.
        const clash = random.chance(0.3)
          ? random.pick([
              "clip",
              "asset",
              "kind",
              "edge",
              "join",
              "joinGone",
              "code",
              "code",
              "order",
            ] as const)
          : undefined;
        // The editor wrote out an asset that it is going to take away, while the folder uses it.
        if (clash === "asset" && !store.getState().assets?.["raw-footage"]) {
          const asset = { kind: "video", path: "assets/raw.mov", storage: "local" };
          store.execute({ type: "asset.add", params: { id: "raw-footage", asset } });
        }
        // The editor wrote out an empty track, which the folder is going to make one for sound.
        const empty = clash === "kind" ? fresh("track") : undefined;
        // A clip that the editor is going to take away, and the folder to join.
        const onVideo = Object.values(store.getState().timelines["main"]?.clips ?? {}).filter(
          ({ track }) => track === "track_video",
        );
        const aim = clash === "clip" ? random.pick(onVideo)?.id : undefined;
        if (empty) {
          store.execute({
            type: "track.add",
            params: { timeline: "main", id: empty, kind: "video" },
          });
        }
        // Now and then somebody settles a file that waits, by taking back what they did to it.
        for (const path of new Set([...disk.keys(), ...bases.keys()])) {
          if (disk.get(path) === bases.get(path) || !random.chance(0.3)) continue;
          const kept = bases.get(path);
          if (kept === undefined) disk.delete(path);
          else disk.set(path, kept);
        }
        // The editor writes out what it has, apart from files that wait: those are not written over.
        const exported = store.exportFiles().files;
        for (const path of new Set([...exported.keys(), ...bases.keys()])) {
          if (disk.get(path) !== bases.get(path)) continue;
          const text = exported.get(path);
          if (text === undefined) {
            disk.delete(path);
            bases.delete(path);
          } else {
            disk.set(path, text);
            bases.set(path, text);
          }
        }
        const files = new Map(bases);
        const base = store.getState();
        const folderBase = opened(files) as ProjectState;
        for (let count = random.int(5); count > 0; count--) editorChange(store, random, fresh);
        if (clash === "asset") {
          store.execute({ type: "asset.remove", params: { asset: "raw-footage" } });
        }
        if (clash === "order") {
          const tracks = orderedTracks(store.getState().timelines["main"] as never);
          const [first, last] = [tracks[0], tracks.at(-1)];
          if (tracks.length >= 3 && first && last) {
            const params = { timeline: "main", track: last.id, before: first.id };
            store.execute({ type: "track.move", params });
          }
        }
        if (clash === "code") {
          const shared = store.getState().files[SHARED];
          const lines = shared === undefined ? [] : linesOf(shared);
          if (lines.length > 2) {
            lines[0] = `// ${fresh("e")}\n`;
            store.execute({ type: "file.write", params: { path: SHARED, text: lines.join("") } });
          }
        }
        if (clash === "edge") {
          const enter = { type: "fade", duration: "1" };
          const params = { timeline: "main", clip: "clip_title", enter };
          store.execute({ type: "clip.setTransition", params });
        }
        if (clash === "joinGone") {
          // A join changed in another window of the editor, which is how a join changes now.
          const written = store.exportFiles().files.get(MAIN);
          const document = written === undefined ? undefined : parsed(written);
          const join = document?.tracks
            .flatMap((track: Json) => track.joins ?? [])
            .find(({ id }: Json) => id === "join_1");
          if (join) {
            join.duration = "3";
            store.importFile(MAIN, JSON.stringify(document), { origin: USER });
          }
        }
        if (clash === "join") {
          // Taking a clip away takes its joins along.
          const params = { timeline: "main", clips: ["clip_interview"] };
          store.execute({ type: "clip.remove", params });
        }
        if (clash === "kind" && empty) {
          const clip = { start: "0", duration: "1", source: { kind: "color", color: "#111111" } };
          store.execute({
            type: "clip.add",
            params: { timeline: "main", track: empty, ...clip, overlap: "overwrite" },
          });
        }
        if (clash === "clip" && aim) {
          store.execute({ type: "clip.remove", params: { timeline: "main", clips: [aim] } });
          const shared = store.getState().files[SHARED];
          const text = `// ${fresh("e")}\n${shared ?? ""}`;
          if (shared !== undefined)
            store.execute({ type: "file.write", params: { path: SHARED, text } });
        }
        const mine = store.getState();
        const mineWritten = store.exportFiles();
        expect(mineWritten.problems, where).toEqual([]);

        const next = randomFolder(disk, random, fresh, clash, empty, aim);
        const batch = changesOf(files, next);
        const waitedBefore = batch.filter(({ path }) => disk.get(path) !== files.get(path));
        const origin: Origin = random.chance(0.75) ? folderBatch(`${seed}.${round}`) : USER;
        const steps = store.history.length;
        // What the folder has besides the batch is what the editor wrote.
        const baseOf = (path: string) => files.get(path);
        const result: MergeResult = store.mergeFiles(batch, { origin, baseOf });
        const merged = store.getState();
        const about = `${where}: ${JSON.stringify(result.ok ? result.problems : result.error)}`;
        // What the next round goes on from.
        disk = new Map(next);
        for (const { path, base: kept } of result.files) {
          if (kept === undefined) bases.delete(path);
          else bases.set(path, kept);
        }
        counts.waitedAgain += waitedBefore.length > 0 ? 1 : 0;

        // Every file is accounted for, and keeps its base unless it came in.
        expect(
          result.files.map(({ path }) => path),
          about,
        ).toEqual(batch.map(({ path }) => path));
        for (const [index, file] of result.files.entries()) {
          const change = batch[index] as FileChange;
          if (file.status === "merged") expect(file.base, about).toBe(change.text);
          if (file.status === "blocked") expect(file.base, about).toBe(change.base);
        }
        // A timeline that waits takes the files of its versions along, whatever they are.
        for (const { path, status } of result.files) {
          const id = /^timelines\/([^/]+)\/timeline\.json$/.exec(path)?.[1];
          if (id === undefined || status !== "blocked") continue;
          for (const other of result.files) {
            if (!other.path.startsWith(`timelines/${id}/overrides/`)) continue;
            expect(other.status, `${about} ${other.path}`).toBe("blocked");
          }
        }
        // A join comes whole, or not at all.
        const partly = partialJoins(mine);
        expect(
          partialJoins(merged).filter((join) => !partly.includes(join)),
          about,
        ).toEqual([]);
        // Whatever happens, the project can be written.
        expect(store.exportFiles().problems, about).toEqual([]);

        if (!result.ok) {
          counts.refused += 1;
          if (result.error.code === "merge-would-break") counts.broken += 1;
          // The only reasons there are for nothing to come in.
          expect(["manifest-deleted", "merge-would-break"], about).toContain(result.error.code);
          expect(merged, about).toBe(mine);
          expect(store.history.length, about).toBe(steps);
          continue;
        }
        expect(store.history.length, about).toBe(steps + (result.patches.length > 0 ? 1 : 0));
        counts.broken += result.problems.some(({ code }) => code === "merge-would-break") ? 1 : 0;

        // The project reads back from its files without an error that neither it nor the folder had.
        const errorsOf = (written: ReadonlyMap<string, string>) =>
          ProjectStore.open(written)
            .problems.filter(({ severity }) => severity === "error")
            .map(({ code, file }) => `${code} ${file}`);
        const knownErrors = new Set([
          ...errorsOf(files),
          ...errorsOf(next),
          ...errorsOf(mineWritten.files),
        ]);
        for (const error of errorsOf(store.exportFiles().files)) {
          expect(knownErrors.has(error), `${about} ${error}`).toBe(true);
        }

        // Nothing of what the editor had not written yet is lost.
        for (const key of changedLeaves(base, mine)) {
          expect(at(merged, key), `${about} ${key}`).toEqual(at(mine, key));
        }

        // What the folder changed came in, apart from what the result says stayed.
        const waiting = result.files.filter(({ status }) => status === "blocked");
        const folder = new Map(next);
        for (const { path, base: kept } of waiting) {
          if (kept === undefined) folder.delete(path);
          else folder.set(path, kept);
        }
        const theirs = opened(folder);
        // Nothing new points at what is not there, unless the folder on its own does that too.
        const known = new Set([...danglingIn(mine), ...danglingIn(theirs)]);
        for (const link of danglingIn(merged)) {
          expect(known.has(link), `${about} ${link}`).toBe(true);
          // And nothing the editor had was taken away while something still points at it.
          const [, to = ""] = link.split(" -> ");
          if (/ of another kind$|^its kind$|^a section$/.test(to)) continue;
          expect(getIn(mine, to.split("/")), `${about} ${link}`).toBeUndefined();
        }
        // An order says nothing about what else a track or a section has, see `isOrder`.
        const isOrderLevel = (path: Path) =>
          path.length === 3 && (path[2] === "tracks" || path[2] === "sections");
        const left = new Set(
          [
            ...result.conflicts.map(({ path }) => path).filter((path) => !isOrderLevel(path)),
            ...result.kept,
            ...result.held,
            ...waiting.map(({ path }) => placeOfFile(path)),
          ]
            // Code goes by lines, below.
            .filter((path) => path[0] !== "files")
            .map((path) => path.join(SEPARATOR)),
        );
        const isLeft = (key: string) => {
          const parts = key.split(SEPARATOR);
          return parts.some((_, index) => left.has(parts.slice(0, index + 1).join(SEPARATOR)));
        };
        if (theirs) {
          for (const key of changedLeaves(folderBase, theirs)) {
            if (!isLeft(key)) expect(at(merged, key), `${about} ${key}`).toEqual(at(theirs, key));
          }
        }
        const came = new Set(
          result.files.flatMap(({ path, status }) => {
            const [kind, id = ""] = placeOfFile(path);
            return status === "merged" && kind === "timelines" && path.endsWith("/timeline.json")
              ? [id]
              : [];
          }),
        );
        checkOrder(about, folderBase, mine, theirs, merged, came);
        counts.newTimelines += [...came].some((id) => !Object.hasOwn(mine.timelines, id)) ? 1 : 0;

        // What a conflict says the folder has is what it has.
        for (const conflict of result.conflicts) {
          if (conflict.path[0] === "files" || !theirs) continue;
          const value = isOrderLevel(conflict.path)
            ? sequence(
                (conflict.path[2] === "tracks" ? orderedTracks : orderedSections)(
                  theirs.timelines[conflict.path[1] as string] as never,
                ),
              )
            : getIn(theirs, conflict.path);
          expect(withoutOrder(conflict.theirs), `${about} ${conflict.path.join("/")}`).toEqual(
            withoutOrder(value),
          );
        }

        // Code, line by line.
        for (const path of new Set([
          ...Object.keys(folderBase.files),
          ...Object.keys(mine.files),
          ...Object.keys(theirs?.files ?? {}),
        ])) {
          const [was, my, their, now] = [folderBase, mine, theirs, merged].map((state) =>
            linesOf(state?.files[path] ?? ""),
          ) as [string[], string[], string[], string[]];
          const isWaiting = waiting.some((file) => file.path === path);
          if (isWaiting) {
            expect(merged.files[path], `${about} ${path}`).toBe(mine.files[path]);
            continue;
          }
          if ([was, my, their].some((lines) => new Set(lines).size !== lines.length)) continue;
          const has = new Set(now);
          for (const line of my)
            if (!was.includes(line)) expect(has.has(line), `${about} ${path}`).toBe(true);
          for (const line of was)
            if (!my.includes(line)) expect(has.has(line), `${about} ${path}`).toBe(false);
          // An entry that has to stay, as the folder took it away.
          const isKept = result.held.some((held) => held[0] === "files" && held[1] === path);
          if (!theirs || isKept) continue;
          // What the folder changed came in, apart from the lines of a conflict, which say what the
          // folder had there, or the whole file, where there are no lines to go by.
          const here = result.conflicts.filter((conflict) => conflict.file === path);
          const whole = here.find(({ lines }) => lines === undefined);
          if (whole) {
            expect(whole.theirs, `${about} ${path}`).toBe(theirs.files[path]);
            expect(merged.files[path], `${about} ${path}`).toBe(mine.files[path]);
            continue;
          }
          const theirsThere = new Set(
            here.flatMap(({ theirs: lines }) => linesOf(lines as string)),
          );
          for (const line of theirsThere) expect(their, `${about} ${path}`).toContain(line);
          const isMineThere = (index: number) =>
            here.some(({ lines }) => lines && index >= lines.from && index < lines.to);
          const outside = new Set(now.filter((_, index) => !isMineThere(index)));
          for (const line of their)
            if (!was.includes(line) && !theirsThere.has(line))
              expect(has.has(line), `${about} ${path} ${line}`).toBe(true);
          for (const line of was)
            if (!their.includes(line))
              expect(outside.has(line), `${about} ${path} ${line}`).toBe(false);
        }

        // A file is to be written again exactly when the project holds something else than it.
        for (const [index, file] of result.files.entries()) {
          if (file.status !== "merged") continue;
          const { path, text } = batch[index] as FileChange;
          let differs: boolean;
          if (text === undefined) differs = store.exportFiles().files.has(path);
          else if (/^(scenes|sounds|code)\//.test(path) && !path.endsWith(".json")) {
            differs = merged.files[path] !== text;
          } else {
            const check = store.importFile(path, text, { origin: USER, dryRun: true });
            // An empty language is always said to be there again, which changes nothing.
            const isNothing = ({ op, path: place, value }: Patch & { value?: unknown }) =>
              op === "set" && deepEqual(value, {}) && deepEqual(getIn(merged, place), {});
            differs = !check.ok || check.patches.some((patch) => !isNothing(patch));
          }
          expect(file.rewrite, `${about} ${path}`).toBe(differs);
        }

        counts.conflicts += result.conflicts.length > 0 ? 1 : 0;
        counts.textConflicts += result.conflicts.some(({ lines }) => lines) ? 1 : 0;
        counts.kept += result.kept.length > 0 ? 1 : 0;
        counts.usesRemoved += result.problems.some(({ code }) => code === "uses-removed") ? 1 : 0;
        const isJoin = (path: Path) => path[2] === "joins";
        const isEdge = (path: Path) => path[2] === "clips" && /^(enter|exit)$/.test(path[4] ?? "");
        const touched = [...result.patches.map(({ path }) => path), ...result.kept];
        counts.joins += touched.some(isJoin) ? 1 : 0;
        counts.edges += touched.some(isEdge) ? 1 : 0;
        const conflicted = result.conflicts.map(({ path }) => path);
        counts.transitionConflicts += conflicted.some((path) => isJoin(path) || isEdge(path))
          ? 1
          : 0;
        counts.orderConflicts += conflicted.some(isOrderLevel) ? 1 : 0;
        counts.held += result.held.length > 0 ? 1 : 0;
        counts.blocked += waiting.length > 0 ? 1 : 0;
        counts.deleted += result.patches.some(({ op }) => op === "delete") ? 1 : 0;
        counts.rewritten += result.files.some(({ rewrite }) => rewrite) ? 1 : 0;
        counts.moved += result.patches.some(({ path }) => path.at(-1) === "order") ? 1 : 0;

        // The whole batch goes back as one, and comes again.
        if (result.patches.length > 0 && random.chance(0.4)) {
          const back = origin === USER ? store.undo() : store.undoOrigin(origin);
          expect(back.ok, about).toBe(true);
          expect(store.getState(), about).toEqual(mine);
          counts.undone += 1;
          if (random.chance(0.5)) {
            const again = origin === USER ? store.redo() : store.redoOrigin(origin);
            expect(again.ok, about).toBe(true);
            expect(store.getState(), about).toEqual(merged);
          }
        }
      }
    });
  },
);
