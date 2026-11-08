import { Track, canHold } from "@animaquill/schema";
import { afterAll, describe, expect, it } from "vitest";
import { FUZZ, openUnlocked, randomCommand, randomFrom, type Random } from "./fuzz-support.ts";
import type { ProjectState } from "./model.ts";
import { ProjectStore, USER, aiTask, type ImportResult, type Origin } from "./store.ts";

const MAIN = "timelines/main/timeline.json";

const lockedIn = (state: ProjectState) =>
  Object.values(state.timelines["main"]?.tracks ?? {})
    .filter(({ locked }) => locked)
    .map(({ id }) => id);

const contentOf = (state: ProjectState, tracks: readonly string[]) => {
  const main = state.timelines["main"];
  const on = <T extends { readonly id: string; readonly track: string }>(items: readonly T[]) =>
    Object.fromEntries(
      items.filter(({ track }) => tracks.includes(track)).map((item) => [item.id, item]),
    );
  const clips = on(Object.values(main?.clips ?? {}));
  const transitions = on(Object.values(main?.transitions ?? {}));
  // What versions change about those clips is what they show in that version.
  const versions = Object.entries(main?.overrides ?? {}).flatMap(([name, { clips: changes }]) => {
    const theirs = Object.keys(clips).flatMap((id) => (changes?.[id] ? [[id, changes[id]]] : []));
    return theirs.length > 0 ? [[name, Object.fromEntries(theirs)]] : [];
  });
  return { clips, transitions, versions: Object.fromEntries(versions) };
};

/** What a scene or sound on a locked track runs is what it shows or plays, so that stays too. */
const codeOf = (state: ProjectState, tracks: readonly string[]) => {
  const content = Object.values(contentOf(state, tracks).clips);
  // One from a library runs nothing of the project.
  const scenes = content.flatMap(({ source }) =>
    source.kind === "scene" && source.scene !== undefined ? [source.scene as string] : [],
  );
  const sounds = content.flatMap(({ source }) =>
    source.kind === "sound" && source.sound !== undefined ? [source.sound as string] : [],
  );
  const isTheirs = (path: string) =>
    scenes.some((id) => path.startsWith(`scenes/${id}/`)) ||
    sounds.some((id) => path.startsWith(`sounds/${id}/`)) ||
    (scenes.length + sounds.length > 0 && path.startsWith("code/"));
  return {
    manifests: [...scenes.map((id) => state.scenes[id]), ...sounds.map((id) => state.sounds[id])],
    files: Object.entries(state.files).filter(([path]) => isTheirs(path)),
  };
};

/** Every asset a value names, however deep. */
const assetsNamedIn = (value: unknown, into: Set<string>): Set<string> => {
  if (typeof value !== "object" || value === null) return into;
  const { asset } = value as { readonly asset?: unknown };
  if (typeof asset === "string") into.add(asset);
  for (const inner of Object.values(value)) assetsNamedIn(inner, into);
  return into;
};

/** What these tracks show of assets, also in versions, which stays as it is too. */
const assetsShown = (state: ProjectState, shown: ReadonlySet<string>) =>
  Object.fromEntries(
    [...shown].map((id) => {
      const {
        name: _name,
        license: _license,
        credit: _credit,
        ...content
      } = (state.assets?.[id] ?? {}) as Record<string, unknown>;
      return [id, content];
    }),
  );

/** What nothing should ever come to: a clip or a transition on a track that is gone, or does not fit. */
function brokenIn(state: ProjectState): readonly string[] {
  const main = state.timelines["main"];
  if (!main) return [];
  const clips = Object.values(main.clips).flatMap(({ id, track, source }) => {
    const home = main.tracks[track];
    if (!home) return [`${id} is on ${track}, which is gone`];
    return canHold(home.kind, source.kind) ? [] : [`${id} does not fit on ${track}`];
  });
  const transitions = Object.values(main.transitions).flatMap(({ id, track }) =>
    main.tracks[track] ? [] : [`${id} is on ${track}, which is gone`],
  );
  const tracks = Object.values(main.tracks).flatMap(({ order: _order, ...track }) =>
    Track.safeParse({ ...track, clips: [] }).success ? [] : [`${track.id} is not what its kind is`],
  );
  return [...clips, ...transitions, ...tracks];
}

/** Another track that can hold a clip, often a locked one: that is where a file runs into a lock. */
function homeFor(tracks: readonly any[], clip: any, random: Random, but?: unknown): any {
  const fits = tracks.filter((track) => track !== but && canHold(track.kind, clip.source.kind));
  const locked = fits.filter((track) => track.locked);
  return random.pick(locked.length > 0 && random.chance(0.6) ? locked : fits);
}

const VIDEO_ONLY = ["hidden"];
const AUDIO_ONLY = ["role", "muted", "solo", "properties", "effects", "sends", "output"];

/**
 * Makes a track of a file another kind, the way the file stays valid: what it cannot hold goes onto
 * another track that can, also a locked one, or goes away.
 */
function changeKind(tracks: any[], track: any, random: Random): void {
  const kinds = ["video", "audio", "caption"].filter((kind) => kind !== track.kind);
  const kind = random.pick(kinds) as string;
  for (const key of kind === "audio" ? VIDEO_ONLY : AUDIO_ONLY) delete track[key];
  if (kind === "caption") delete track.transitions;
  track.kind = kind;
  for (const clip of track.clips) {
    if (canHold(kind, clip.source.kind)) continue;
    track.clips = track.clips.filter((item: any) => item !== clip);
    const other = homeFor(tracks, clip, random, track);
    if (other && random.chance(0.7))
      other.clips.push({ ...clip, start: String(80 + random.int(20)) });
  }
  for (const transition of track.transitions ?? []) {
    const stays = (id: string | undefined) =>
      id === undefined || track.clips.some((clip: any) => clip.id === id);
    if (!stays(transition.from)) delete transition.from;
    if (!stays(transition.to)) delete transition.to;
  }
  track.transitions = track.transitions?.filter(
    (transition: any) => transition.from ?? transition.to,
  );
  if (track.transitions?.length === 0) delete track.transitions;
}

/**
 * A file somebody changed outside of the editor: random changes to random clips, wherever they
 * are, also locks that go or come, tracks that go or become another kind, and assets. What is
 * valid is what comes in, apart from what is locked.
 */
function randomFile(store: ProjectStore, random: Random): readonly [string, string] {
  const files = store.exportFiles().files;
  const roll = random.int(12);
  if (roll >= 10) {
    const document = JSON.parse(files.get("assets.json") ?? `{ "assets": {} }`);
    for (const id of Object.keys(document.assets)) {
      if (!random.chance(0.3)) continue;
      const change = random.int(3);
      if (change === 0) delete document.assets[id];
      else if (change === 1) document.assets[id].path = `assets/n${random.int(9)}.png`;
      else document.assets[id].credit = `c${random.int(9)}`;
    }
    return ["assets.json", JSON.stringify(document)];
  }
  if (roll < 6) {
    const document = JSON.parse(files.get(MAIN) as string);
    let tracks = document.tracks as any[];
    if (random.chance(0.2) && tracks.length > 1) {
      const gone = random.pick(tracks);
      tracks = tracks.filter((track) => track !== gone);
      document.tracks = tracks;
      // What was on it goes elsewhere, or with it.
      for (const clip of gone.clips) {
        const other = homeFor(tracks, clip, random);
        if (other && random.chance(0.6))
          other.clips.push({ ...clip, start: String(80 + random.int(20)) });
      }
    }
    if (random.chance(0.2)) changeKind(tracks, random.pick(tracks), random);
    for (const track of tracks) {
      if (random.chance(0.15)) {
        if (track.locked) delete track.locked;
        else track.locked = true;
      }
      for (const clip of track.clips) {
        if (!random.chance(0.3)) continue;
        const change = random.int(5);
        if (change === 0) clip.name = `n${random.int(9)}`;
        else if (change === 1) clip.start = String(random.int(60));
        else if (change === 2)
          clip.properties = { ...clip.properties, opacity: random.int(10) / 10 };
        else if (change === 3) track.clips = track.clips.filter((other: any) => other !== clip);
        else {
          const other = random.pick(tracks.filter(({ kind }) => kind === track.kind));
          if (other && other !== track) {
            track.clips = track.clips.filter((item: any) => item !== clip);
            other.clips.push(clip);
          }
        }
      }
      if (track.kind === "video" && random.chance(0.1)) {
        const source = { kind: "color", color: "#123456" };
        track.clips.push({ id: `f${random.int(1000)}`, start: "70", duration: "1", source });
      }
    }
    return [MAIN, JSON.stringify(document)];
  }
  if (roll < 9) {
    const name = random.pick(["format.vertical", "language.en", "format.sq"]) as string;
    const path = `timelines/main/overrides/${name}.json`;
    const text = files.get(path);
    const scope = name === "language.en" ? { language: "en" } : { format: name.split(".")[1] };
    const document = text === undefined ? { scope } : JSON.parse(text);
    const clips = Object.keys(store.getState().timelines["main"]?.clips ?? {});
    for (let count = 1 + random.int(3); count > 0; count--) {
      const clip = random.pick(clips) as string;
      document.clips ??= {};
      if (random.chance(0.3)) delete document.clips[clip];
      else document.clips[clip] = { hidden: { value: random.chance(0.5) } };
    }
    return [path, JSON.stringify(document)];
  }
  const path = random.pick(
    [...files.keys()].filter((each) => /^(scenes|sounds|code)\//.test(each)),
  );
  return [path ?? "code/x.js", `// ${random.int(1000)}`];
}

/** Files that came in as nothing, because the rest would break without what stays: over all seeds. */
let refusedWhole = 0;
afterAll(() => {
  expect(refusedWhole).toBeGreaterThan(0);
});

describe.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "taking back around locked tracks, seed %i",
  FUZZ,
  (seed) => {
    it("leaves what is on them as it is, for everyone", () => {
      const random = randomFrom(seed);
      const store = openUnlocked();
      let held = 0;
      let lockedCode = 0;
      let heldFiles = 0;
      /** Whatever happens, the project stays whole and can be written. */
      const stillWhole = (round: number, always: boolean) => {
        expect(brokenIn(store.getState()), `round ${round}`).toEqual([]);
        if (always || round % 20 === 0) {
          expect(store.exportFiles().problems, `round ${round}`).toEqual([]);
        }
      };
      for (let round = 0; round < 2000; round++) {
        if (round > 0) stillWhole(round, false);
        const task = `t${random.int(3)}`;
        const roll = random.int(100);
        const before = store.getState();
        if (roll < 25) {
          const tracks = Object.keys(before.timelines["main"]?.tracks ?? {});
          const track = random.pick(tracks);
          const changes = { locked: random.chance(0.5) };
          store.execute({ type: "track.update", params: { timeline: "main", track, changes } });
          continue;
        }
        const origin: Origin = random.chance(0.5) ? aiTask(task) : USER;
        if (roll < 60) {
          store.execute(randomCommand(store, random), { origin });
          const still = lockedIn(before).filter((id) => lockedIn(store.getState()).includes(id));
          if (codeOf(before, still).files.length > 0) lockedCode += 1;
          expect(codeOf(store.getState(), still)).toEqual(codeOf(before, still));
          continue;
        }
        if (roll < 70) {
          const [path, text] = randomFile(store, random);
          const result: ImportResult = store.importFile(path, text, { origin });
          const after = store.getState();
          if (result.ok ? result.kept.length > 0 : result.error.code === "track-locked") {
            heldFiles += 1;
          }
          if (
            !result.ok &&
            result.error.problems?.some(({ code }) => code === "needs-locked-part")
          ) {
            refusedWhole += 1;
          }
          // A lock only goes when a person's file takes it off, and then the track is theirs.
          if (origin !== USER)
            expect(lockedIn(after)).toEqual(expect.arrayContaining(lockedIn(before)));
          const still = lockedIn(before).filter((id) => lockedIn(after).includes(id));
          expect(contentOf(after, still)).toEqual(contentOf(before, still));
          expect(codeOf(after, still)).toEqual(codeOf(before, still));
          const shown = assetsNamedIn(contentOf(before, still), new Set());
          expect(assetsShown(after, shown)).toEqual(assetsShown(before, shown));
          stillWhole(round, true);
          continue;
        }
        const result =
          roll < 80
            ? store.undoTask(task)
            : roll < 85
              ? store.redoTask(task)
              : roll < 95
                ? store.undo()
                : store.redo();
        if (!result.ok && result.error.obstacle === "locked") held += 1;
        const locked = lockedIn(before).filter((id) => lockedIn(store.getState()).includes(id));
        // A transition there can point at a clip elsewhere, which goes and comes back with its link.
        const { transitions: _now, ...now } = contentOf(store.getState(), locked);
        const { transitions: _was, ...was } = contentOf(before, locked);
        expect(now).toEqual(was);
        expect(codeOf(store.getState(), locked)).toEqual(codeOf(before, locked));
      }
      expect(held).toBeGreaterThan(0);
      expect(lockedCode).toBeGreaterThan(0);
      expect(heldFiles).toBeGreaterThan(10);
    });
  },
);
