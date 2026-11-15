/**
 * Batches from GitHub that the platform merges into its copy, while an editor that is offline
 * changes the project and takes in what changed in its folder, which can be the same change again,
 * where the folder is a clone of the repository. Then everything meets, in any order. See
 * platform-client.test.ts for what this counts on in Yjs.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { undoubled, type Insertion } from "./doubled-text.ts";
import { FUZZ, openUnlocked, randomCommand, randomFrom, replica, seedIds } from "./fuzz-support.ts";
import type { FileChange } from "./merge-files.ts";
import { mergeInRounds } from "./merge-rounds.ts";
import type { Here, ProjectState } from "./model.ts";
import { deepEqual, getIn } from "./patch.ts";
import { isContainer, type Path } from "./structure.ts";
import { ProjectStore, folderBatch, repoBatch } from "./store.ts";

const ROUNDS = 30;
const SHARED = "code/animate.js";
const HERE: Here = { repo: "4242" };
const SEPARATOR = "\u0000";

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOrder = (path: Path) =>
  path.length === 5 &&
  path[0] === "timelines" &&
  (path[2] === "tracks" || path[2] === "sections") &&
  path[4] === "order";

/**
 * Every value of a project as Yjs has it, one key each: what goes down is a map of its own, see
 * structure.ts. Code goes by characters, and orders only say something together: those are below.
 */
function leavesOf(value: unknown, path: Path = [], into = new Map<string, unknown>()) {
  if (path[0] === "files" || isOrder(path)) return into;
  if (isContainer(path) && isPlain(value)) {
    for (const [key, item] of Object.entries(value)) leavesOf(item, [...path, key], into);
  } else if (value !== undefined) {
    into.set(path.join(SEPARATOR), value);
  }
  return into;
}

function changedLeaves(a: ProjectState, b: ProjectState): Set<string> {
  const before = leavesOf(a);
  const after = leavesOf(b);
  return new Set(
    [...new Set([...before.keys(), ...after.keys()])].filter(
      (key) => !deepEqual(before.get(key), after.get(key)),
    ),
  );
}

const at = (state: ProjectState, key: string) => getIn(state, key.split(SEPARATOR));

function batchOf(base: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>) {
  return [...new Set([...base.keys(), ...next.keys()])]
    .filter((path) => base.get(path) !== next.get(path))
    .map((path): FileChange => ({ path, base: base.get(path), text: next.get(path) }));
}

/** Records what a store writes itself, which is what it sends elsewhere. */
function recording(store: ProjectStore): Uint8Array[] {
  const updates: Uint8Array[] = [];
  store.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "sync") updates.push(update);
  });
  return updates;
}

/** A project from where it was, with updates in this order. */
function arrived(start: Uint8Array, updates: readonly Uint8Array[]): ProjectState {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, start, "sync");
  for (const update of updates) Y.applyUpdate(doc, update, "sync");
  return new ProjectStore(doc).getState();
}

function shuffled<T>(items: readonly T[], random: ReturnType<typeof randomFrom>): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = random.int(index + 1);
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

const counts = { merged: 0, lostByPlatform: 0, lostByEditor: 0, doubled: 0, undoubled: 0 };
const AT_LEAST: Readonly<Record<keyof typeof counts, number>> = {
  merged: 60,
  lostByPlatform: 5,
  lostByEditor: 1,
  doubled: 10,
  undoubled: 10,
};

afterAll(() => {
  for (const [what, count] of Object.entries(counts)) {
    expect(count, what).toBeGreaterThanOrEqual(AT_LEAST[what as keyof typeof counts]);
  }
});

describe.each([1, 2, 3, 4, 5, 6])(
  "batches from GitHub, offline changes and the folder, seed %i",
  FUZZ,
  (seed) => {
    it("lose nothing but where both wrote the same key, and come out the same in any order", () => {
      seedIds(seed);
      const random = randomFrom(seed);
      const platform = openUnlocked();
      const editor = replica(platform);
      const fromPlatform = recording(platform);
      const fromEditor = recording(editor);
      /** What the repository has: what the platform last archived. */
      let repository = platform.exportFiles({ here: HERE }).files;
      for (let round = 0; round < ROUNDS; round++) {
        const where = `seed ${seed} round ${round}`;
        fromPlatform.length = 0;
        fromEditor.length = 0;
        const start = Y.encodeStateAsUpdate(platform.doc);
        const before = platform.getState();
        const shared = before.files[SHARED];

        // Somebody commits on GitHub, from what was archived there.
        const github = ProjectStore.open(repository).store as ProjectStore;
        for (let count = 1 + random.int(4); count > 0; count--) {
          github.execute(randomCommand(github, random));
        }
        const committed = new Map(github.exportFiles({ here: HERE }).files);
        // Now and then a line of code, that the folder of the editor gets as well, from Git.
        const line = random.chance(0.4) ? `// ${seed}.${round}\n` : undefined;
        if (line && shared !== undefined && repository.get(SHARED) === shared) {
          committed.set(
            SHARED,
            `${shared.slice(0, shared.indexOf("\n") + 1)}${line}${shared.slice(shared.indexOf("\n") + 1)}`,
          );
        }

        // Offline in the editor.
        for (let count = random.int(5); count > 0; count--) {
          editor.execute(randomCommand(editor, random));
        }
        const pulled = committed.get(SHARED);
        const isPulled =
          line !== undefined &&
          pulled !== undefined &&
          pulled !== shared &&
          editor.getState().files[SHARED] === shared &&
          random.chance(0.7);
        if (isPulled) {
          const change = { path: SHARED, base: shared, text: pulled };
          editor.mergeFiles([change], {
            origin: folderBatch(`${seed}.${round}`),
            baseOf: (path) => editor.exportFiles().files.get(path),
          });
        }
        const offline = editor.getState();

        // The platform merges the commit.
        const copied = new Map<string, Insertion>();
        platform.writeAsPlatform(() =>
          mergeInRounds(
            platform,
            batchOf(repository, committed),
            { origin: repoBatch(`${seed}.${round}`), baseOf: undefined, here: HERE },
            (merge) => {
              if (!merge.ok) return;
              counts.merged += merge.result.patches.length > 0 ? 1 : 0;
              for (const file of merge.result.files) {
                if (file.copied) copied.set(file.path, file.copied);
              }
            },
          ),
        );
        const merged = platform.getState();
        const updates = [...fromPlatform, ...fromEditor];

        // The order things arrive in makes no difference.
        const results = [0, 1, 2].map(() => arrived(start, shuffled(updates, random)));
        Y.applyUpdate(
          editor.doc,
          Y.encodeStateAsUpdate(platform.doc, Y.encodeStateVector(editor.doc)),
          "sync",
        );
        Y.applyUpdate(
          platform.doc,
          Y.encodeStateAsUpdate(editor.doc, Y.encodeStateVector(platform.doc)),
          "sync",
        );
        const final = platform.getState();
        expect(editor.getState(), where).toEqual(final);
        for (const result of results) expect(result, where).toEqual(final);

        // What the person changed stays, apart from what they took away where the merge wrote.
        const byEditor = changedLeaves(before, offline);
        const byMerge = changedLeaves(before, merged);
        for (const key of byEditor) {
          const isTaken = at(offline, key) === undefined;
          if (deepEqual(at(final, key), at(offline, key))) continue;
          expect(isTaken && byMerge.has(key), `${where} ${key}`).toBe(true);
          counts.lostByEditor += 1;
        }
        // What the merge brought stays, apart from the keys the person wrote too, and what is in a
        // map that the person took away, such as a clip, which takes along what is written into it.
        const isTakenAway = (key: string) => {
          const parts = key.split(SEPARATOR);
          return parts.some((_, end) => {
            const path = parts.slice(0, end);
            return (
              end > 0 &&
              isContainer(path) &&
              getIn(before, path) !== undefined &&
              getIn(offline, path) === undefined
            );
          });
        };
        for (const key of byMerge) {
          if (deepEqual(at(final, key), at(merged, key))) continue;
          expect(byEditor.has(key) || isTakenAway(key), `${where} ${key}`).toBe(true);
          counts.lostByPlatform += 1;
        }

        // The same line from GitHub and from the folder is there twice, and is told.
        const now = final.files[SHARED];
        const mark = copied.get(SHARED);
        if (isPulled && mark && now !== undefined && now !== pulled) {
          counts.doubled += 1;
          const once = undoubled(now, mark);
          expect(once, where).toBe(pulled);
          counts.undoubled += once === pulled ? 1 : 0;
        }

        // The platform archives what it has.
        repository = platform.exportFiles({ here: HERE }).files;
      }
    });
  },
);
