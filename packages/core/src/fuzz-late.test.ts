import { describe, expect, it } from "vitest";
import { FUZZ, openUnlocked, randomCommand, randomFrom, replica } from "./fuzz-support.ts";
import { ProjectStore } from "./store.ts";

describe.each([1, 2, 3, 4])("updates that arrive late and out of order, seed %i", FUZZ, (seed) => {
  it("leave no holes, whatever people do in the meantime", () => {
    const random = randomFrom(seed);
    const stores = [openUnlocked()];
    stores.push(replica(stores[0] as ProjectStore), replica(stores[0] as ProjectStore));
    const queues: Uint8Array[][] = stores.map(() => []);
    stores.forEach((store, from) =>
      store.onLocalUpdate((update) =>
        queues.forEach((queue, to) => {
          if (to !== from) queue.push(update);
        }),
      ),
    );
    const deliver = (index: number) => {
      const queue = queues[index] as Uint8Array[];
      const [update] = queue.splice(random.int(queue.length), 1);
      if (update) stores[index]?.applyUpdates([update]);
    };
    let refused = 0;
    for (let round = 0; round < 400; round++) {
      const store = random.pick(stores) as ProjectStore;
      const behind = store.isMissingUpdates;
      const before = store.revision;
      const result = random.chance(0.1)
        ? store.undo()
        : store.execute(randomCommand(store, random));
      if (behind) {
        refused += 1;
        expect(result.ok).toBe(false);
        expect(store.revision).toBe(before);
      }
      for (let count = random.int(3); count > 0; count--) deliver(random.int(stores.length));
      for (const each of stores) {
        // What people see is always whole, also while the document is not.
        for (const clip of Object.values(each.getState().timelines["main"]?.clips ?? {})) {
          expect(clip.start).toBeDefined();
          expect(clip.duration).toBeDefined();
          expect(clip.source).toBeDefined();
        }
        if (round % 20 === 0) expect(each.exportFiles().problems).toEqual([]);
      }
    }
    expect(refused).toBeGreaterThan(0);
    for (const index of stores.keys()) while (queues[index]?.length) deliver(index);
    for (const store of stores) expect(store.isMissingUpdates).toBe(false);
    expect(stores[1]?.getState()).toEqual(stores[0]?.getState());
    expect(stores[2]?.getState()).toEqual(stores[0]?.getState());
    const clips = Object.values(stores[0]?.getState().timelines["main"]?.clips ?? {});
    for (const clip of clips) {
      expect(clip.start).toBeDefined();
      expect(clip.duration).toBeDefined();
      expect(clip.source).toBeDefined();
    }
    expect(stores[0]?.exportFiles().problems).toEqual([]);
  });
});
