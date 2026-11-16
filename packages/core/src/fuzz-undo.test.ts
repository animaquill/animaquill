/**
 * Undo logs of AI tasks and batches of files, saved as the editor saves them and read again after
 * the project was opened again (`ProjectStore.saveUndo`, `restoreUndo`), in any order. The same work
 * in two stores that are closed and opened again at the same times has to come out the same, every
 * time something is taken back or done again: one reads what the editor saved as it went, which can
 * be from long before; the other what it knew the moment it closed. In between, people change the
 * project, and so does another window or device, which the marks of the records have to catch.
 * People's own steps do not last across a reload in either of them.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FUZZ, openUnlocked, randomCommand, randomFrom, replica, seedIds } from "./fuzz-support.ts";
import {
  ProjectStore,
  aiTask,
  folderBatch,
  repoBatch,
  type CommandCall,
  type Origin,
  type UndoResult,
} from "./store.ts";

const STEPS = 160;

const counts = { dropped: 0, reloads: 0, undone: 0, partly: 0, blocked: 0, redone: 0, restored: 0 };
const AT_LEAST: Readonly<Record<keyof typeof counts, number>> = {
  dropped: 20,
  reloads: 40,
  undone: 60,
  partly: 5,
  blocked: 5,
  redone: 20,
  restored: 100,
};

afterAll(() => {
  for (const [what, count] of Object.entries(counts)) {
    expect(count, what).toBeGreaterThanOrEqual(AT_LEAST[what as keyof typeof counts]);
  }
});

/** What can be compared of taking something back: the same in both stores. */
function outcome(result: UndoResult) {
  if (!result.ok) return { ok: false, code: result.error.code, obstacle: result.error.obstacle };
  return {
    ok: true,
    patches: result.patches,
    kept: result.kept.map((path) => path.join("/")).toSorted(),
    obstacle: result.obstacle,
  };
}

/** The same project as a store that was closed and opened again, writing as the same client. */
function reopen(store: ProjectStore, records: readonly unknown[]): ProjectStore {
  const { store: again } = ProjectStore.fromUpdates([store.encodeState()]);
  if (!again) throw new Error("did not open again");
  again.doc.clientID = store.doc.clientID;
  counts.restored += again.restoreUndo(records).length;
  return again;
}

function shuffled<T>(items: readonly T[], random: ReturnType<typeof randomFrom>): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = random.int(index + 1);
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/** Runs something with ids from a seed, see `seedIds`. */
function withIds<T>(seed: number, run: () => T): T {
  const random = randomFrom(seed);
  const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    if (array instanceof Uint8Array) array.forEach((_, index) => (array[index] = random.int(256)));
    return array;
  });
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

/** A small edit of a text, which the folder or GitHub brings. */
function edited(text: string, random: ReturnType<typeof randomFrom>): string {
  const at = random.int(text.length + 1);
  if (random.chance(0.4) && text.length > 4) return text.slice(0, at) + text.slice(at + 3);
  return `${text.slice(0, at)}/*${random.int(99)}*/${text.slice(at)}`;
}

describe.each(Array.from({ length: 12 }, (_, i) => i + 1))(
  "undo logs read again, seed %i",
  FUZZ,
  (seed) => {
    it("take back and do again the same as in a store that stayed open", () => {
      seedIds(seed);
      const random = randomFrom(seed);
      let live = openUnlocked();
      let again = reopen(live, []);
      const other = replica(live);
      /** What the editor saved last of each origin, in the order it saved them. */
      const records = new Map<Origin, unknown>();
      const origins = new Set<Origin>();
      /** Saves as the editor does: what changed, or everything after something was taken back. */
      const save = (...only: Origin[]) => {
        for (const origin of only.length > 0 ? only : again.undoOrigins) {
          const record = again.saveUndo(origin);
          records.delete(origin);
          if (record) records.set(origin, JSON.parse(JSON.stringify(record)));
        }
      };
      // New objects get the same ids in both stores.
      const both = <T>(run: (store: ProjectStore) => T, where: string): [T, T] => {
        const ids = random.int(2 ** 30);
        const results: [T, T] = [withIds(ids, () => run(live)), withIds(ids, () => run(again))];
        expect(again.getState(), where).toEqual(live.getState());
        return results;
      };
      const command = (origin: Origin | undefined) => {
        const call: CommandCall = randomCommand(live, random);
        both((store) => store.execute(call, origin ? { origin } : {}).ok, `${origin} ${call.type}`);
      };
      const batch = (origin: Origin, asPlatform: boolean, where: string) => {
        const files = Object.keys(live.getState().files);
        const path = random.pick(files);
        if (path === undefined) return;
        const base = live.getState().files[path] as string;
        const change = [{ path, base, text: edited(base, random) }];
        both((store) => {
          const merge = () => store.mergeFiles(change, { origin, baseOf: () => undefined });
          return (asPlatform ? store.writeAsPlatform(merge) : merge()).ok;
        }, where);
        origins.add(origin);
      };

      for (let step = 0; step < STEPS; step++) {
        const where = `seed ${seed} step ${step}`;
        const roll = random.int(100);
        if (roll < 22) {
          command(undefined);
        } else if (roll < 42) {
          const origin = aiTask(`t${random.int(6)}`);
          command(origin);
          origins.add(origin);
          save(origin);
        } else if (roll < 48) {
          const origin = folderBatch(`tool-${step}`);
          batch(origin, false, where);
          save(origin);
        } else if (roll < 52) {
          const origin = repoBatch(`r${step}`);
          batch(origin, true, where);
          save(origin);
        } else if (roll < 58) {
          // People take back their own steps, which only go as far as this store has them.
          const redo = random.chance(0.3);
          if (redo ? again.canRedo : again.canUndo) {
            const [a, b] = both((store) => outcome(redo ? store.redo() : store.undo()), where);
            expect(b, where).toEqual(a);
            save();
          }
        } else if (roll < 78) {
          const origin = random.pick([...origins]);
          if (origin === undefined) continue;
          expect(again.undoOutlook(origin), `${where} ${origin}`).toEqual(live.undoOutlook(origin));
          const redo =
            again.canRedoOrigin(origin) && (random.chance(0.4) || !again.canUndoOrigin(origin));
          const [a, b] = both(
            (store) => outcome(redo ? store.redoOrigin(origin) : store.undoOrigin(origin)),
            `${where} ${redo ? "redo" : "undo"} ${origin}`,
          );
          expect(b, `${where} ${redo ? "redo" : "undo"} ${origin}`).toEqual(a);
          if (a.ok && !redo) counts.undone += 1;
          if (a.ok && redo) counts.redone += 1;
          if (a.ok && (a.kept?.length ?? 0) > 0) counts.partly += 1;
          if (!a.ok && a.obstacle !== undefined) counts.blocked += 1;
          // Taking one back can hand places back to others, which are saved again too. One that
          // could not go back is gone from its log, which is saved as well.
          if (a.ok) save();
          else save(origin);
        } else if (roll < 81) {
          // A log goes, past the newest 50 or cleared: what the others knew of its places has to last.
          const origin = random.pick([...records.keys()]);
          if (origin === undefined) continue;
          records.delete(origin);
          origins.delete(origin);
          live.forgetUndo(origin);
          again.forgetUndo(origin);
          counts.dropped += 1;
        } else if (roll < 90) {
          // Another window or device changes the project, also as an AI task of its own.
          Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(live.doc, Y.encodeStateVector(other.doc)));
          for (let count = 1 + random.int(3); count > 0; count--) {
            const origin = random.chance(0.3) ? { origin: aiTask(`elsewhere${step}`) } : {};
            other.execute(randomCommand(other, random), origin);
          }
          const update = Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(live.doc));
          both((store) => Y.applyUpdate(store.doc, update, "remote"), where);
        } else {
          // In any order: a record saved before another one takes nothing from it.
          again = reopen(again, shuffled([...records.values()], random));
          // Everything as it was the moment it closed.
          const known = live.undoOrigins.map((origin) => live.saveUndo(origin)).filter(Boolean);
          live = reopen(live, JSON.parse(JSON.stringify(known)) as unknown[]);
          counts.reloads += 1;
          expect(again.getState(), where).toEqual(live.getState());
        }
      }
      for (const origin of origins) {
        expect(again.undoOutlook(origin), `seed ${seed} at the end ${origin}`).toEqual(
          live.undoOutlook(origin),
        );
      }
    });
  },
);
