import { describe, expect, it } from "vitest";
import { clockDate } from "./time.ts";

/** Node's own `Date`, or the test would be replacing it for itself. */
function fresh() {
  const Real = class extends Date {} as unknown as DateConstructor;
  Object.defineProperty(Real, "length", { value: 7 });
  // A subclass has a prototype of its own, so changing `constructor` leaves the real one alone.
  let now = 1000;
  const VirtualDate = clockDate(Real, () => now);
  return { VirtualDate, setNow: (value: number) => (now = value) };
}

describe("clockDate", () => {
  it("reads the clock when asked for the present", () => {
    const { VirtualDate, setNow } = fresh();
    expect(VirtualDate.now()).toBe(1000);
    expect(new VirtualDate().getTime()).toBe(1000);
    setNow(2000);
    expect(new VirtualDate().getTime()).toBe(2000);
  });

  it("gives a string without new, as Date always did", () => {
    const { VirtualDate } = fresh();
    expect(VirtualDate()).toBe(new Date(1000).toString());
  });

  it("takes everything else the way Date takes it", () => {
    const { VirtualDate } = fresh();
    expect(new VirtualDate(5).getTime()).toBe(5);
    expect(new VirtualDate("2020-01-02T03:04:05Z").toISOString()).toBe("2020-01-02T03:04:05.000Z");
    expect(new VirtualDate(2020, 0, 2).getMonth()).toBe(0);
    expect(VirtualDate.UTC(2020, 0, 1)).toBe(Date.UTC(2020, 0, 1));
    expect(VirtualDate.parse("2020-01-01T00:00:00Z")).toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(VirtualDate.length).toBe(7);
  });

  it("is still the same kind of thing", () => {
    const { VirtualDate } = fresh();
    expect(new VirtualDate()).toBeInstanceOf(VirtualDate);
    expect(new VirtualDate().constructor).toBe(VirtualDate);
    class Later extends VirtualDate {
      later() {
        return this.getTime() + 1;
      }
    }
    const later = new Later();
    expect(later).toBeInstanceOf(Later);
    expect(later.later()).toBe(1001);
  });
});
