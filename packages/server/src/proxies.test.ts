import { describe, expect, test } from "vitest";
import { trustedProxies } from "./proxies.ts";

describe("the proxies the API takes the address of the browser from", () => {
  test("are the addresses given, and the addresses of the names given, nothing else", async () => {
    const lookups: string[] = [];
    const proxies = trustedProxies(["127.0.0.1", "::1", "gateway"], {
      lookup: async (name) => {
        lookups.push(name);
        return ["172.18.0.3"];
      },
    });
    await proxies.refresh();
    expect(new Set(lookups)).toEqual(new Set(["gateway"]));
    for (const address of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "172.18.0.3",
      "::ffff:172.18.0.3",
    ])
      expect(proxies.trusts(address), address).toBe(true);
    for (const address of ["172.18.0.4", "10.0.0.9", "203.0.113.9", "", "gateway"])
      expect(proxies.trusts(address), address).toBe(false);
    proxies.stop();
  });

  test("follow the gateway when it comes back with another address", async () => {
    let now = "172.18.0.3";
    const proxies = trustedProxies(["gateway"], {
      lookup: async () => [now],
      refreshMs: 60_000,
      againMs: 0,
    });
    await proxies.refresh();
    expect(proxies.trusts("172.18.0.3")).toBe(true);
    now = "172.18.0.7";
    // A peer it does not know makes it look again, now and then.
    expect(proxies.trusts("172.18.0.7")).toBe(false);
    await proxies.settled();
    expect(proxies.trusts("172.18.0.7")).toBe(true);
    expect(proxies.trusts("172.18.0.3")).toBe(false);
    proxies.stop();
  });

  test("trust nobody by a name that does not resolve, and say so", async () => {
    const said: string[] = [];
    const proxies = trustedProxies(["gateway"], {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
      warn: (message) => said.push(message),
    });
    await proxies.refresh();
    expect(proxies.trusts("172.18.0.3")).toBe(false);
    expect(said.join()).toMatch(/gateway/);
    proxies.stop();
  });
});
