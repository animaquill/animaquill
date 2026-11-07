import { describe, expect, it } from "vitest";
import { FUZZ, openUnlocked, randomCommand, randomFrom } from "./fuzz-support.ts";
import type { ProjectState } from "./model.ts";
import { USER, aiTask } from "./store.ts";

describe.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "taking back around locked tracks, seed %i",
  FUZZ,
  (seed) => {
    it("leaves what is on them as it is, for everyone", () => {
      const random = randomFrom(seed);
      const store = openUnlocked();
      const lockedIn = (state: ProjectState) =>
        Object.values(state.timelines["main"]?.tracks ?? {})
          .filter(({ locked }) => locked)
          .map(({ id }) => id);
      const contentOf = (state: ProjectState, tracks: readonly string[]) => {
        const clips = Object.values(state.timelines["main"]?.clips ?? {});
        return clips.filter(({ track }) => tracks.includes(track));
      };
      /** What a scene or sound on a locked track runs is what it shows or plays, so that stays too. */
      const codeOf = (state: ProjectState, tracks: readonly string[]) => {
        const content = contentOf(state, tracks);
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
          manifests: [
            ...scenes.map((id) => state.scenes[id]),
            ...sounds.map((id) => state.sounds[id]),
          ],
          files: Object.entries(state.files).filter(([path]) => isTheirs(path)),
        };
      };
      let held = 0;
      let lockedCode = 0;
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
        if (roll < 70) {
          const origin = random.chance(0.5) ? aiTask(task) : USER;
          store.execute(randomCommand(store, random), { origin });
          const still = lockedIn(before).filter((id) => lockedIn(store.getState()).includes(id));
          if (codeOf(before, still).files.length > 0) lockedCode += 1;
          expect(codeOf(store.getState(), still)).toEqual(codeOf(before, still));
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
        expect(contentOf(store.getState(), locked)).toEqual(contentOf(before, locked));
        expect(codeOf(store.getState(), locked)).toEqual(codeOf(before, locked));
      }
      expect(held).toBeGreaterThan(0);
      expect(lockedCode).toBeGreaterThan(0);
    });
  },
);
