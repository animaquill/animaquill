import { Timeline } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  FUZZ,
  openUnlocked,
  randomCommand,
  randomFrom,
  seedIds,
  type Random,
} from "./fuzz-support.ts";
import { documentAt, stateToProject, stateToTimeline, type ProjectState } from "./model.ts";
import type { Patch } from "./patch.ts";
import { USER, aiTask, type ProjectStore } from "./store.ts";

/**
 * Random commands, of people and of AI, on a project that other pages and files break now and then
 * and fix again: the check before each batch (`brokenDocument`), which reads only what changed of a
 * timeline, says what reading all of the project before and after says, at every step. No batch it
 * lets through makes a valid document invalid, and the check of a whole timeline agrees with the
 * export. See `mayBreak` in model.ts.
 */

/** Every call of the check, with what the whole project before and after says. */
const calls: { readonly checked: string | undefined; readonly whole: string | undefined }[] = [];

vi.mock("./document-check.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./document-check.ts")>();
  const invalid = (state: ProjectState) =>
    new Set(stateToProject(state).problems.map(({ file }) => file));
  return {
    brokenDocument(before: ProjectState, after: ProjectState, patches: readonly Patch[]) {
      const result = real.brokenDocument(before, after, patches);
      const was = invalid(before);
      const now = [...invalid(after)].filter((file) => !was.has(file)).toSorted();
      calls.push({
        checked: result && String((result.params as { file?: string }).file),
        whole: now[0],
      });
      return result;
    },
  };
});

const MAIN = "timelines/main/timeline.json";

const mainOf = (store: ProjectStore) =>
  (store.doc.getMap("project").get("timelines") as Y.Map<Y.Map<unknown>>).get(
    "main",
  ) as Y.Map<unknown>;
const levelOf = (store: ProjectStore, key: string) =>
  mainOf(store).get(key) as Y.Map<Y.Map<unknown>>;

/** What another page, a file or an older editor can leave in the document, past every command. */
function breakSomething(store: ProjectStore, random: Random): void {
  const clips = levelOf(store, "clips");
  const tracks = levelOf(store, "tracks");
  const sections = [...levelOf(store, "sections").keys()];
  const id = random.pick([...clips.keys()].toSorted());
  const clip = id === undefined ? undefined : clips.get(id);
  store.doc.transact(() => {
    switch (random.int(12)) {
      case 0:
        clip?.set("duration", "-1");
        break;
      case 1:
        clip?.set("name", 5);
        break;
      case 2:
        clip?.set("source", { kind: "caption", text: "x" });
        break;
      case 3: {
        const taken = random.pick(sections) ?? "x";
        const track = new Y.Map<unknown>();
        track.set("id", taken);
        track.set("kind", "video");
        track.set("order", 99);
        tracks.set(taken, track);
        break;
      }
      case 4:
        mainOf(store).set("name", "");
        break;
      case 5:
        clip?.set("link", "bad id!");
        break;
      case 7:
        // A clip on a track that is gone, which the export puts on one that it makes up.
        clip?.set("track", "gone");
        break;
      default:
        break;
    }
    if (random.chance(0.5)) fixEverything(store);
  }, "sync");
}

function fixEverything(store: ProjectStore): void {
  const clips = levelOf(store, "clips");
  const tracks = levelOf(store, "tracks");
  for (const section of levelOf(store, "sections").keys()) tracks.delete(section);
  if (mainOf(store).get("name") === "") mainOf(store).set("name", "主时间轴");
  const track = [...tracks.values()].find((each) => each.get("kind") === "video")?.get("id");
  for (const [key, each] of Array.from(clips.entries())) {
    const source = each.get("source") as { readonly kind?: string } | undefined;
    if (source?.kind === "caption") {
      clips.delete(key);
      continue;
    }
    if (each.get("duration") === "-1") each.set("duration", "1");
    if (typeof each.get("name") === "number") each.set("name", "修好了");
    if (each.get("link") === "bad id!") each.delete("link");
    if (each.get("id") !== key) each.set("id", key);
    if (each.get("track") === "gone" && typeof track === "string") each.set("track", track);
  }
}

const isWhole = (state: ProjectState) => {
  const main = state.timelines.main;
  return main === undefined || Timeline.safeParse(stateToTimeline(main)).success;
};

const invalidFiles = (state: ProjectState) =>
  new Set(stateToProject(state).problems.map(({ file }) => file));

describe.each(Array.from({ length: 20 }, (_, index) => index + 1))(
  "the check of documents, seed %i",
  FUZZ,
  (seed) => {
    it("says what reading all of them says, at every step", () => {
      seedIds(seed);
      const random = randomFrom(seed);
      const store = openUnlocked();
      const document = documentAt(["timelines", "main", "clips"]);
      calls.length = 0;
      const broke: string[] = [];
      for (let step = 0; step < 400; step++) {
        const before = invalidFiles(store.getState());
        if (random.chance(0.1)) {
          breakSomething(store, random);
        } else {
          const batch = Array.from({ length: 1 + random.int(3) }, () =>
            randomCommand(store, random),
          );
          const origin = random.chance(0.5) ? USER : aiTask("t");
          const result = store.executeBatch(batch, { origin });
          if (result.ok) {
            const newly = [...invalidFiles(store.getState())].filter((file) => !before.has(file));
            for (const file of newly)
              broke.push(`${step}: ${batch.map(({ type }) => type)} ${file}`);
          }
        }
        const state = store.getState();
        const valid = document?.issue(state) === undefined;
        expect({ step, valid }).toEqual({ step, valid: isWhole(state) });
        expect(invalidFiles(state).has(MAIN)).toBe(!valid);
      }
      const disagree = calls.filter(
        ({ checked, whole }) => (checked === undefined) !== (whole === undefined),
      );
      expect(disagree).toEqual([]);
      expect(broke).toEqual([]);
    });
  },
);
