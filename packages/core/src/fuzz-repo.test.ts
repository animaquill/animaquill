/**
 * Batches from GitHub that the platform merges into its copy, while an editor that is offline
 * changes the project and takes in what changed in its folder, which can be the same change again,
 * where the folder is a clone of the repository. Then everything meets. The platform takes in what
 * the editor did one update after the other, as it does once the editor is back (late-writes.ts):
 * whatever of either side is not in the project then has to be in a conflict, which is checked here
 * from the projects alone, not from what late-writes.ts says it does. See platform-client.test.ts
 * for what this counts on in Yjs.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type Insertion } from "./doubled-text.ts";
import { FUZZ, openUnlocked, randomCommand, randomFrom, replica, seedIds } from "./fuzz-support.ts";
import { lateOf, valuesWithout, watch, writeBatch, type LateConflict } from "./late-writes.ts";
import { orderAt, type FileChange } from "./merge-files.ts";
import { mergeInRounds } from "./merge-rounds.ts";
import type { Here, ProjectState } from "./model.ts";
import { deepEqual, getIn } from "./patch.ts";
import { isContainer, type Path } from "./structure.ts";
import { ProjectStore, folderBatch, repoBatch, type CommandCall } from "./store.ts";

const SEEDS = Array.from({ length: 32 }, (_, index) => index + 1);
const ROUNDS = 20;
const SHARED = "code/animate.js";
const HERE: Here = { repo: "4242" };
const SEPARATOR = "\u0000";
const LEVELS = ["tracks", "sections"] as const;

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
    if (origin !== "sync" && origin !== "platform") updates.push(update);
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

/** Besides what fuzz-support.ts does: assets, which are one value each, of several fields. */
function anyCommand(store: ProjectStore, random: ReturnType<typeof randomFrom>): CommandCall {
  const asset = random.pick(Object.keys(store.getState().assets ?? {}));
  if (asset && random.chance(0.15)) {
    if (random.chance(0.2)) return { type: "asset.remove", params: { asset } };
    const changes = random.chance(0.5)
      ? { name: `name ${random.int(9)}` }
      : { tags: [`tag${random.int(9)}`] };
    return { type: "asset.update", params: { asset, changes } };
  }
  const main = store.getState().timelines["main"];
  const tracks = Object.keys(main?.tracks ?? {});
  const track = random.pick(tracks);
  if (track && random.chance(0.1)) {
    return { type: "track.move", params: { timeline: "main", track, before: random.pick(tracks) } };
  }
  const file = random.pick(Object.keys(store.getState().files).filter((path) => path !== SHARED));
  if (file && random.chance(0.12)) {
    if (random.chance(0.4)) return { type: "file.remove", params: { path: file } };
    const text = `${store.getState().files[file] ?? ""}// ${random.int(99)}\n`;
    return {
      type: "file.write",
      params: { path: random.chance(0.8) ? file : `code/n${random.int(3)}.js`, text },
    };
  }
  return randomCommand(store, random);
}

const counts = {
  merged: 0,
  lostByPlatform: 0,
  lostByEditor: 0,
  lostInRemoved: 0,
  lostWithParent: 0,
  orders: 0,
  files: 0,
  doubled: 0,
  undoubled: 0,
};
const AT_LEAST: Readonly<Record<keyof typeof counts, number>> = {
  merged: 200,
  lostByPlatform: 20,
  lostByEditor: 10,
  lostInRemoved: 5,
  lostWithParent: 10,
  orders: 5,
  files: 5,
  doubled: 10,
  undoubled: 10,
};

afterAll(() => {
  for (const [what, count] of Object.entries(counts)) {
    expect(count, what).toBeGreaterThanOrEqual(AT_LEAST[what as keyof typeof counts]);
  }
});

/**
 * The conflicts people see, as the platform keeps them: of what the batch wrote, the first one at a
 * place, as later changes are on top of that; of what the change did, the latest one.
 */
class OpenConflicts {
  readonly all = new Map<string, LateConflict>();

  take(conflict: LateConflict): void {
    const id = `${conflict.lost}${SEPARATOR}${conflict.path.join(SEPARATOR)}`;
    if (conflict.lost === "batch" && this.all.has(id)) return;
    this.all.set(id, conflict);
  }

  /**
   * Whether one of them has `value` as what went, at `key` or above it. Where nothing went, its
   * place has to be in what went, and empty.
   */
  has(key: string, value: unknown): boolean {
    const path = key.split(SEPARATOR);
    return [...this.all.values()].some((conflict) => {
      if (!conflict.path.every((part, index) => path[index] === part)) return false;
      const rest = path.slice(conflict.path.length);
      if (!deepEqual(getIn(conflict.theirs, rest), value)) return false;
      if (value !== undefined || rest.length === 0) return true;
      return getIn(conflict.theirs, rest.slice(0, -1)) !== undefined;
    });
  }

  /** Whether one of them is the order of a level, with `ids` in this order. */
  hasOrder(timeline: string, level: string, ids: readonly string[]): boolean {
    return [...this.all.values()].some((conflict) => {
      if (conflict.kind !== "order") return false;
      if (conflict.path.join("/") !== `timelines/${timeline}/${level}`) return false;
      const theirs = conflict.theirs as readonly string[];
      const shared = ids.filter((id) => theirs.includes(id));
      return (
        shared.length === ids.length &&
        deepEqual(
          theirs.filter((id) => shared.includes(id)),
          shared,
        )
      );
    });
  }

  /** Whether one of them is about a file of code, of this kind, and with this as what went. */
  hasFile(file: string, kind: string, ...text: [string | undefined] | []): boolean {
    return [...this.all.values()].some(
      (conflict) =>
        conflict.kind === kind &&
        conflict.path.length === 2 &&
        conflict.path[0] === "files" &&
        conflict.path[1] === file &&
        (text.length === 0 || conflict.theirs === text[0]),
    );
  }
}

describe.each(SEEDS)(
  "batches from GitHub, offline changes and the folder, seed %i",
  FUZZ,
  (seed) => {
    it("lose nothing that no conflict has, and come out the same in any order", () => {
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
        for (let count = 1 + random.int(6); count > 0; count--) {
          github.execute(anyCommand(github, random));
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
        for (let count = random.int(10); count > 0; count--) {
          editor.execute(anyCommand(editor, random));
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
        const offlineUpdates = [...fromEditor];

        // The platform merges the commit.
        const copied = new Map<string, Insertion>();
        const id = `${seed}.${round}`;
        const written = writeBatch(platform, id, () =>
          mergeInRounds(
            platform,
            batchOf(repository, committed),
            { origin: repoBatch(id), baseOf: undefined, here: HERE },
            (merge) => {
              if (!merge.ok) return;
              counts.merged += merge.result.patches.length > 0 ? 1 : 0;
              for (const file of merge.result.files) {
                if (file.copied) copied.set(file.path, file.copied);
              }
            },
          ),
        );
        const batch = {
          ...written.batch,
          seq: 1,
          copied: [...copied].map(([file, insertion]) => ({ file, insertion })),
        };
        const merged = platform.getState();
        const mergedUpdates = [...fromPlatform];

        // The order things arrive in makes no difference to what Yjs makes of them.
        const both = [...mergedUpdates, ...offlineUpdates];
        const plain = arrived(start, both);
        for (let time = 0; time < 2; time++) {
          expect(arrived(start, shuffled(both, random)), where).toEqual(plain);
        }

        // The editor is back: the platform takes in what it did, in the order it was done, a few
        // changes at a time, as from its log.
        const open = new OpenConflicts();
        const sent: Uint8Array[] = [];
        for (let index = 0; index < offlineUpdates.length;) {
          const size = 1 + random.int(3);
          const update = Y.mergeUpdates(offlineUpdates.slice(index, index + size));
          index += size;
          const watched = watch(platform, () => platform.applyChecked(update, "platform"));
          sent.push(update);
          const outcome = lateOf(platform, [batch], { update, watched }, () => true);
          const without = outcome.conflicts.filter((conflict) => conflict.without);
          const { values } = valuesWithout(
            [start, ...sent],
            without.map((conflict) => conflict.path),
          );
          for (const [place, conflict] of without.entries()) {
            open.take({ ...conflict, theirs: values[place] });
          }
          for (const conflict of outcome.conflicts) if (!conflict.without) open.take(conflict);
          for (const { file, text } of outcome.doubled) {
            platform.writeAsPlatform(() =>
              platform.execute(
                { type: "file.write", params: { path: file, text } },
                { origin: repoBatch(id) },
              ),
            );
            counts.undoubled += 1;
          }
        }
        // ...and gets what the platform has.
        Y.applyUpdate(
          editor.doc,
          Y.encodeStateAsUpdate(platform.doc, Y.encodeStateVector(editor.doc)),
          "sync",
        );
        const final = platform.getState();
        expect(editor.getState(), where).toEqual(final);

        // What either side wrote and is not in the project is in a conflict, with what it was.
        const isParentGone = (state: ProjectState, key: string) => {
          const parts = key.split(SEPARATOR);
          return parts.some((_, end) => end > 0 && getIn(state, parts.slice(0, end)) === undefined);
        };
        for (const key of changedLeaves(before, merged)) {
          if (deepEqual(at(final, key), at(merged, key))) continue;
          expect(open.has(key, at(merged, key)), `${where} merge's ${key}`).toBe(true);
          counts.lostByPlatform += 1;
          if (isParentGone(final, key)) counts.lostWithParent += 1;
        }
        for (const key of changedLeaves(before, offline)) {
          if (deepEqual(at(final, key), at(offline, key))) continue;
          expect(open.has(key, at(offline, key)), `${where} editor's ${key}`).toBe(true);
          counts.lostByEditor += 1;
          if (isParentGone(final, key)) counts.lostWithParent += 1;
          const parts = key.split(SEPARATOR);
          const isRemoved = batch.removed.some((each) =>
            each.path.every((part, index) => parts[index] === part),
          );
          if (isRemoved) counts.lostInRemoved += 1;
        }

        // The order of tracks and sections, of what is still there.
        for (const timeline of Object.keys(final.timelines)) {
          for (const level of LEVELS) {
            const now = orderAt(final, timeline, level);
            const was = orderAt(before, timeline, level);
            for (const [side, state] of [
              ["merge", merged],
              ["editor", offline],
            ] as const) {
              const meant = orderAt(state, timeline, level);
              // Only where it put some of what was there in another order.
              const isMoved = !deepEqual(
                was.filter((each) => meant.includes(each)),
                meant.filter((each) => was.includes(each)),
              );
              if (!isMoved) continue;
              // Of what was there before: what either side made has no place in the other's order.
              const kept = meant.filter((each) => now.includes(each) && was.includes(each));
              if (
                deepEqual(
                  kept,
                  now.filter((each) => kept.includes(each)),
                )
              )
                continue;
              expect(open.hasOrder(timeline, level, kept), `${where} ${side}'s order`).toBe(true);
              counts.orders += 1;
            }
          }
        }

        // Files of code. A text that both changed goes by characters: see the doubled lines below.
        const files = new Set([
          ...Object.keys(before.files),
          ...Object.keys(merged.files),
          ...Object.keys(offline.files),
        ]);
        for (const file of files) {
          const was = before.files[file];
          const ours = offline.files[file];
          const theirs = merged.files[file];
          const now = final.files[file];
          const isBothText =
            was !== undefined &&
            ours !== undefined &&
            theirs !== undefined &&
            ours !== was &&
            theirs !== was;
          if (isBothText) continue;
          if (theirs !== was && now !== theirs) {
            // What the editor took away had what the merge wrote in it, and what it wrote itself.
            if (was === undefined) {
              expect(open.hasFile(file, "file", theirs), `${where} merge's ${file}`).toBe(true);
            } else expect(open.hasFile(file, "file"), `${where} merge's ${file}`).toBe(true);
            counts.files += 1;
          }
          if (ours !== was && now !== ours) {
            expect(open.hasFile(file, "file", ours), `${where} editor's ${file}`).toBe(true);
            counts.files += 1;
          }
        }

        // The same line from GitHub and from the folder is there once, or people are told.
        if (isPulled && copied.has(SHARED) && plain.files[SHARED] !== pulled) {
          counts.doubled += 1;
          if (final.files[SHARED] !== pulled) {
            expect(open.hasFile(SHARED, "check-duplicate"), where).toBe(true);
          }
        }

        // The platform archives what it has.
        repository = platform.exportFiles({ here: HERE }).files;
      }
    });
  },
);
