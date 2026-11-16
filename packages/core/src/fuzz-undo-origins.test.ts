/**
 * Taking back several AI tasks at once, as "back to before this turn" does for the turns of a
 * conversation (`ProjectStore.undoOrigins`), and doing them again (`redoOrigins`). It has to come to
 * exactly what taking back each of them on its own does, one after the other, the newest first; and
 * a dry run has to come to what the real one does. Meanwhile people change the project and take back
 * their own steps, other conversations and other windows change it, batches come from the folder
 * and from GitHub, single turns are taken back and done again, and the project is opened again with
 * its undo logs read back in any order.
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
  type ManyUndoResult,
  type Origin,
  type UndoResult,
} from "./store.ts";

const STEPS = 160;

const counts = { groups: 0, partly: 0, blocked: 0, regroups: 0, reloads: 0, checked: 0 };
const AT_LEAST: Readonly<Record<keyof typeof counts, number>> = {
  groups: 300,
  partly: 15,
  blocked: 6,
  regroups: 80,
  reloads: 100,
  checked: 2000,
};

afterAll(() => {
  for (const [what, count] of Object.entries(counts)) {
    expect(count, what).toBeGreaterThanOrEqual(AT_LEAST[what as keyof typeof counts]);
  }
});

/** What can be compared of taking something back. A dry run writes nothing, so no revision. */
function outcome(result: UndoResult) {
  if (!result.ok) {
    return {
      ok: false,
      code: result.error.code,
      obstacle: result.error.obstacle,
      conflicts: result.error.conflicts,
    };
  }
  return { ok: true, patches: result.patches, kept: result.kept, obstacle: result.obstacle };
}

/** What came of each, with those that had nothing to do last, in no particular order. */
const outcomes = (result: ManyUndoResult) => {
  if (!result.ok) return { ok: false, code: result.error.code };
  const all = result.each.map(({ origin, result: each }) => ({ origin, ...outcome(each) }));
  const isNothing = (item: (typeof all)[number]) => !item.ok && item.code === "nothing-to-undo";
  return [
    ...all.filter((item) => !isNothing(item)),
    ...all.filter(isNothing).toSorted((a, b) => a.origin.localeCompare(b.origin)),
  ];
};

/**
 * What came of several at once is what came of each, one after the other, and then those that had
 * nothing to do, in any order.
 */
function expectInOrder(
  got: ReturnType<typeof outcomes>,
  each: readonly { readonly origin: Origin }[],
  group: readonly Origin[],
  where: string,
): void {
  if (!Array.isArray(got)) throw new Error(`${where}: ${JSON.stringify(got)}`);
  expect(got.slice(0, each.length), where).toEqual(each);
  const done = new Set(each.map(({ origin }) => origin));
  const rest = got.slice(each.length);
  expect(rest.map(({ origin }) => origin).toSorted(), where).toEqual(
    group.filter((origin) => !done.has(origin)).toSorted(),
  );
  for (const item of rest)
    expect(item, where).toMatchObject({ ok: false, code: "nothing-to-undo" });
}

function valuesOf(
  value: unknown,
  path = "",
  into = new Map<string, string>(),
): Map<string, string> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) valuesOf(inner, `${path}/${key}`, into);
  } else if (value !== undefined) {
    into.set(path, JSON.stringify(value));
  }
  return into;
}

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

function shuffled<T>(items: readonly T[], random: ReturnType<typeof randomFrom>): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = random.int(index + 1);
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

function edited(text: string, random: ReturnType<typeof randomFrom>): string {
  const at = random.int(text.length + 1);
  return `${text.slice(0, at)}/*${random.int(99)}*/${text.slice(at)}`;
}

/** The project opened again, with its undo logs read back in any order. */
function reopen(
  store: ProjectStore,
  random: ReturnType<typeof randomFrom>,
  clientID: number,
): ProjectStore {
  const records = store.loggedOrigins.flatMap((origin) => {
    const record = store.saveUndo(origin);
    return record ? [JSON.parse(JSON.stringify(record)) as unknown] : [];
  });
  const { store: again } = ProjectStore.fromUpdates([store.encodeState()]);
  if (!again) throw new Error("did not open again");
  again.doc.clientID = clientID;
  again.restoreUndo(shuffled(records, random));
  return again;
}

describe.each(Array.from({ length: 12 }, (_, i) => i + 1))(
  "several turns taken back at once, seed %i",
  FUZZ,
  (seed) => {
    it("comes to what taking back each turn does, the newest first, and so does a dry run", () => {
      seedIds(seed);
      const random = randomFrom(seed);
      // `one` takes turns back one at a time, `many` all at once.
      let one = openUnlocked();
      const { store: twin } = ProjectStore.fromUpdates([one.encodeState()]);
      if (!twin) throw new Error("did not open");
      twin.doc.clientID = one.doc.clientID;
      let many = twin;
      const clientID = one.doc.clientID;
      const other = replica(one);

      /** The turns of the conversation, the oldest first. */
      const turns: Origin[] = [];
      /**
       * When each origin last had something done and taken back, as this test counts it, apart from
       * the store: the newest of those goes first.
       */
      let clock = 0;
      const lastDone = new Map<Origin, number>();
      const undone = new Map<Origin, number[]>();
      const tookBack = (origin: Origin, result: UndoResult) => {
        if (result.ok) (undone.get(origin) ?? undone.set(origin, []).get(origin))?.push(++clock);
      };
      const didAgain = (origin: Origin, result: UndoResult) => {
        undone.get(origin)?.pop();
        if (result.ok) lastDone.set(origin, ++clock);
      };

      const both = <T>(run: (store: ProjectStore) => T, where: string): [T, T] => {
        const ids = random.int(2 ** 30);
        const results: [T, T] = [withIds(ids, () => run(one)), withIds(ids, () => run(many))];
        expect(many.getState(), where).toEqual(one.getState());
        return results;
      };
      const command = (origin: Origin | undefined, where: string) => {
        const call: CommandCall = randomCommand(one, random);
        const [result] = both((store) => {
          const done = store.execute(call, origin ? { origin } : {});
          return done.ok && done.patches.length > 0;
        }, `${where} ${origin} ${call.type}`);
        if (result && origin) lastDone.set(origin, ++clock);
      };
      const batch = (origin: Origin, asPlatform: boolean, where: string) => {
        const files = Object.keys(one.getState().files);
        const path = random.pick(files);
        if (path === undefined) return;
        const base = one.getState().files[path] as string;
        const change = [{ path, base, text: edited(base, random) }];
        both((store) => {
          const merge = () => store.mergeFiles(change, { origin, baseOf: () => undefined });
          return (asPlatform ? store.writeAsPlatform(merge) : merge()).ok;
        }, where);
      };

      const writers = new Map<string, string>();
      let values = valuesOf(many.getState());
      for (let step = 0; step < STEPS; step++) {
        const where = `seed ${seed} step ${step}`;
        const roll = random.int(100);
        let writer = "people";
        if (roll < 22) {
          // A new turn of the conversation.
          const origin = aiTask(`turn${turns.length}`);
          turns.push(origin);
          writer = origin;
          for (let count = 1 + random.int(3); count > 0; count--) command(origin, where);
        } else if (roll < 34) {
          command(undefined, where);
        } else if (roll < 40) {
          // Another conversation, which goes on while this one does.
          const origin = aiTask(`elsewhere${random.int(3)}`);
          writer = origin;
          command(origin, where);
        } else if (roll < 44) {
          writer = folderBatch(`tool-${step}`);
          batch(writer, false, where);
        } else if (roll < 47) {
          writer = repoBatch(`r${step}`);
          batch(writer, true, where);
        } else if (roll < 53) {
          const redo = random.chance(0.3);
          writer = "back";
          if (redo ? many.canRedo : many.canUndo) {
            const [a, b] = both((store) => outcome(redo ? store.redo() : store.undo()), where);
            expect(b, where).toEqual(a);
          }
        } else if (roll < 60) {
          // One turn on its own, from its card.
          const origin = random.pick(turns);
          if (origin === undefined) continue;
          const redo = many.canRedoOrigin(origin) && !many.canUndoOrigin(origin);
          const [a, b] = both(
            (store) => (redo ? store.redoOrigin(origin) : store.undoOrigin(origin)),
            `${where} ${origin}`,
          );
          expect(outcome(b), `${where} ${origin}`).toEqual(outcome(a));
          if (redo) didAgain(origin, a);
          else tookBack(origin, a);
          writer = "back";
        } else if (roll < 70) {
          Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(one.doc, Y.encodeStateVector(other.doc)));
          for (let count = 1 + random.int(3); count > 0; count--) {
            const origin = random.chance(0.3) ? { origin: aiTask(`remote${step}`) } : {};
            other.execute(randomCommand(other, random), origin);
          }
          const update = Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(one.doc));
          both((store) => Y.applyUpdate(store.doc, update, "remote"), where);
          writer = "elsewhere";
        } else if (roll < 78) {
          one = reopen(one, random, clientID);
          many = reopen(many, random, clientID);
          counts.reloads += 1;
          expect(many.getState(), where).toEqual(one.getState());
        } else {
          // Back to before a turn: that one and every one after it.
          const from = random.int(turns.length);
          const group = turns.slice(from);
          if (group.length === 0) continue;
          const order = group
            .filter((origin) => one.canUndoOrigin(origin))
            .toSorted((a, b) => (lastDone.get(b) ?? 0) - (lastDone.get(a) ?? 0));
          const revision = many.revision;
          const dry = many.undoOrigins(shuffled(group, random), { dryRun: true });
          expect(many.revision, `${where} a dry run writes nothing`).toBe(revision);
          const each = order.map((origin) => ({ origin, ...outcome(one.undoOrigin(origin)) }));
          const real = many.undoOrigins(shuffled(group, random));
          const got = outcomes(real);
          expectInOrder(got, each, group, `${where} one after the other`);
          expect(outcomes(dry), `${where} as the dry run said`).toEqual(got);
          expect(many.getState(), `${where} the same project`).toEqual(one.getState());
          for (const item of each) {
            tookBack(item.origin, { ok: item.ok } as UndoResult);
            if (item.ok && (item.kept?.length ?? 0) > 0) counts.partly += 1;
            if (!item.ok) counts.blocked += 1;
          }
          counts.groups += 1;
          // What anybody else wrote last stays as it is.
          const now = valuesOf(many.getState());
          for (const key of new Set([...values.keys(), ...now.keys()])) {
            if (values.get(key) === now.get(key)) continue;
            const last = writers.get(key);
            expect(
              last === "back" || group.includes(last as Origin),
              `${where} took ${key} of ${last}`,
            ).toBe(true);
            counts.checked += 1;
          }
          writer = "back";
          if (random.chance(0.5) && each.some((item) => item.ok)) {
            // Done again as a whole, right away: back to where it was.
            // Only what this took back: a turn taken back on its own before stays as it is.
            const taken = each.filter((item) => item.ok).map((item) => item.origin);
            const redoOrder = taken
              .filter((origin) => one.canRedoOrigin(origin))
              .toSorted((a, b) => (undone.get(b)?.at(-1) ?? 0) - (undone.get(a)?.at(-1) ?? 0));
            const dryAgain = many.redoOrigins(shuffled(taken, random), { dryRun: true });
            const again = redoOrder.map((origin) => ({
              origin,
              ...outcome(one.redoOrigin(origin)),
            }));
            const realAgain = outcomes(many.redoOrigins(shuffled(taken, random)));
            expectInOrder(realAgain, again, taken, `${where} again one after the other`);
            expect(outcomes(dryAgain), `${where} again as the dry run said`).toEqual(realAgain);
            expect(many.getState(), `${where} the same project again`).toEqual(one.getState());
            expect(valuesOf(many.getState()), `${where} as before`).toEqual(values);
            for (const item of again) didAgain(item.origin, { ok: item.ok } as UndoResult);
            counts.regroups += 1;
          }
        }
        const now = valuesOf(many.getState());
        for (const key of new Set([...values.keys(), ...now.keys()])) {
          if (values.get(key) !== now.get(key)) writers.set(key, writer);
        }
        values = now;
      }
    });
  },
);
