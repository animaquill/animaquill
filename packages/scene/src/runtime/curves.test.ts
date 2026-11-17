import { readFileSync } from "node:fs";
import type { ValueType } from "@animaquill/schema/properties";
import { describe, expect, it } from "vitest";
import { ClipValues, CodeObjects } from "./content.ts";

interface GoldenCase {
  readonly name: string;
  readonly type: ValueType;
  readonly value: unknown;
  readonly samples: readonly (readonly [number, unknown])[];
}

/**
 * The same table the editor page is checked against: a scene works out the keys of its clip in its
 * own sandbox, and has to come to the same numbers, or a picture would be otherwise than its export.
 */
const golden = JSON.parse(
  readFileSync(new URL("../../../schema/fixtures/curves.json", import.meta.url), "utf8"),
) as { readonly tolerance: number; readonly cases: readonly GoldenCase[] };

const near = (found: unknown, wanted: unknown, tolerance: number): boolean => {
  if (typeof wanted === "number") {
    return typeof found === "number" && Math.abs(found - wanted) <= tolerance;
  }
  if (Array.isArray(wanted) && Array.isArray(found)) {
    return (
      found.length === wanted.length &&
      wanted.every((part: number, index) => Math.abs((found[index] as number) - part) <= tolerance)
    );
  }
  return found === wanted;
};

describe("the table of values in the project format, in a scene", () => {
  it.each(golden.cases.map((entry) => [entry.name, entry] as const))("%s", (_, entry) => {
    const values = new ClipValues({ "param.value": entry.value });
    const misses = entry.samples.flatMap(([clock, wanted]) => {
      const found = values.at("param.value", entry.type, clock);
      return near(found, wanted, golden.tolerance) ? [] : [[clock, wanted, found]];
    });
    expect(misses).toEqual([]);
  });

  it("comes to the same numbers through an object that code registers", () => {
    const numbers = golden.cases.filter(({ type }) => type === "number");
    const initial = Object.fromEntries(
      numbers.map((entry, index) => [`object.golden.p${index}`, entry.value]),
    );
    let now = 0;
    const objects = new CodeObjects(
      new ClipValues(initial),
      () => now,
      () => {},
    );
    const properties = Object.fromEntries(numbers.map((_, index) => [`p${index}`, 0]));
    const handle = objects.register("golden", { properties }, () => {});
    const misses: unknown[] = [];
    numbers.forEach((entry, index) => {
      for (const [clock, wanted] of entry.samples) {
        now = clock;
        const found = handle.at()[`p${index}`];
        if (!near(found, wanted, golden.tolerance)) misses.push([entry.name, clock, wanted, found]);
      }
    });
    expect(misses).toEqual([]);
  });
});
