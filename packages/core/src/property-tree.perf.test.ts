import type { ObjectDescriptor } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { objectForest } from "./property-tree.ts";

describe("objects from a flat list", () => {
  const object = (id: string, parent?: string): ObjectDescriptor => ({
    id,
    properties: [],
    ...(parent === undefined ? {} : { parent }),
  });

  it("puts many thousands in order without going through them again for each one", () => {
    const many = 200_000;
    const lists = [
      [object("root"), ...Array.from({ length: many }, (_, index) => object(`o${index}`, "root"))],
      Array.from({ length: many }, (_, index) => object(`o${index}`)),
      Array.from({ length: many }, (_, index) =>
        object(`o${index}`, index === 0 ? undefined : `o${index - 1}`),
      ),
    ];
    for (const list of lists) {
      const started = performance.now();
      const { roots } = objectForest(list);
      // Many times what it takes. Going through them again for each one took minutes.
      expect(performance.now() - started).toBeLessThan(3000);
      const count = (trees: typeof roots): number =>
        trees.reduce((sum, { children }) => sum + 1 + count(children), 0);
      expect(count(roots)).toBe(list.length);
    }
  });
});
