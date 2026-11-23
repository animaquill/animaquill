import { describe, expect, test } from "vitest";
import { clientOf, Limits, RateLimit } from "./limits.ts";

describe("who a request comes from, as far as limits go", () => {
  test("is an address on the internet, IPv6 by its /64, which is what one line gets", () => {
    expect(clientOf("203.0.113.9")).toBe("203.0.113.9");
    expect(clientOf("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientOf("2606:4700:4700::1111")).toBe("2606:4700:4700:0::/64");
    expect(clientOf("2606:4700:4700:0:1:2:3:4")).toBe("2606:4700:4700:0::/64");
    expect(clientOf("2606:4700:4700:1::1")).toBe("2606:4700:4700:1::/64");
    expect(clientOf("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8:0:0::/64");
  });

  test("is nobody in particular for addresses that are not someone on the internet", () => {
    // A Docker bridge is where every IPv6 visitor comes from through docker-proxy, for now.
    for (const address of [
      "172.18.0.1",
      "172.31.255.254",
      "10.0.0.9",
      "192.168.1.2",
      "127.0.0.1",
      "::1",
      "::ffff:172.18.0.1",
      "169.254.0.1",
      "100.64.0.1",
      "fd00::1",
      "fe80::1",
      "::",
      "0.0.0.0",
      "",
      "not an address",
    ])
      expect(clientOf(address), address).toBeUndefined();
  });
});

describe("a limit counted by more than one at a time", () => {
  test("takes as many as fit, and counts none of what does not", () => {
    let now = 0;
    const limit = new RateLimit(10, 1000, () => now);
    expect(limit.take("a", 11)).toBe(false);
    expect(limit.take("a", 6)).toBe(true);
    expect(limit.take("a", 5)).toBe(false);
    expect(limit.take("a", 4)).toBe(true);
    expect(limit.take("a")).toBe(false);
    expect(limit.take("b", 10)).toBe(true);
    now = 1000;
    expect(limit.take("a", 10)).toBe(true);
  });
});

describe("limits", () => {
  const limits = (now = () => 0) => new Limits({ perClient: 3, perOwn: 2, ceiling: 5 }, 1000, now);

  test("count each address on the internet on its own", () => {
    const limit = limits();
    expect([1, 2, 3, 4].map(() => limit.take("203.0.113.9", undefined))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(limit.take("203.0.113.10", undefined)).toBe(true);
  });

  test("where the address says nothing, count what the request carries, under a ceiling for all", () => {
    let now = 0;
    const limit = limits(() => now);
    expect([1, 2, 3].map(() => limit.take(undefined, "session-a"))).toEqual([true, true, false]);
    // Someone else behind the same bridge is not locked out by that.
    expect(limit.take(undefined, "session-b")).toBe(true);
    expect(limit.take(undefined, undefined)).toBe(true);
    expect(limit.take(undefined, undefined)).toBe(true);
    // The ceiling of all of them together, against a flood.
    expect(limit.take(undefined, "session-c")).toBe(false);
    now = 1000;
    expect(limit.take(undefined, "session-c")).toBe(true);
  });
});
