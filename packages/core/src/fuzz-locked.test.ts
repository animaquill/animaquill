import { describe, expect, it } from "vitest";
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

/**
 * A file somebody changed outside of the editor: random changes to random clips, wherever they
 * are, also locks that go or come. What is valid is what comes in, apart from what is locked.
 */
function randomFile(store: ProjectStore, random: Random): readonly [string, string] {
  const files = store.exportFiles().files;
  const roll = random.int(10);
  if (roll < 6) {
    const document = JSON.parse(files.get(MAIN) as string);
    const tracks = document.tracks as any[];
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
      for (let round = 0; round < 2000; round++) {
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
          // A lock only goes when a person's file takes it off, and then the track is theirs.
          if (origin !== USER)
            expect(lockedIn(after)).toEqual(expect.arrayContaining(lockedIn(before)));
          const still = lockedIn(before).filter((id) => lockedIn(after).includes(id));
          expect(contentOf(after, still)).toEqual(contentOf(before, still));
          expect(codeOf(after, still)).toEqual(codeOf(before, still));
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
