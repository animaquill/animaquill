import { pbkdf2 } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { startFakeDns, type FakeAnswer, type FakeDns } from "../test/fake-dns.ts";
import { resolverNetwork } from "./network.ts";

/**
 * How the relay looks names up: asking DNS servers itself, A and AAAA, with short timeouts, never
 * through the system's getaddrinfo, which runs in the pool of threads that Node shares with files,
 * the database's lookups and crypto, and cannot be stopped. A name whose DNS never answers must hold
 * none of that up.
 */

const servers: FakeDns[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/**
 * A DNS server of the test. On port 53 where that can be had, as root in a container: then a
 * system whose resolv.conf names 127.0.0.1 asks it too, which is how the getaddrinfo of the system
 * can be shown to hang on it.
 */
async function dnsServer(answers: (name: string) => FakeAnswer) {
  let server: FakeDns;
  try {
    server = await startFakeDns({ answers, port: 53 });
  } catch {
    server = await startFakeDns({ answers });
  }
  servers.push(server);
  return { server, at: `127.0.0.1:${server.port}` };
}

/** How long work of the pool of threads takes now: reading a file, the system's own lookup, crypto. */
async function poolMs(): Promise<number> {
  const started = performance.now();
  await Promise.all([
    ...Array.from({ length: 4 }, () => readFile("/etc/hostname").catch(() => undefined)),
    lookup("localhost"),
    new Promise((resolve) => pbkdf2("x", "y", 1, 32, "sha256", resolve)),
  ]);
  return performance.now() - started;
}

describe("looking names up", () => {
  test("asks for IPv4 and IPv6, and says when a name is not there", async () => {
    const { at } = await dnsServer((name) =>
      name === "both.test"
        ? { a: ["93.184.215.14"], aaaa: ["2606:4700::1111"] }
        : name === "v4.test"
          ? { a: ["1.1.1.1", "1.0.0.1"] }
          : name === "v6.test"
            ? { aaaa: ["2606:4700::1001"] }
            : undefined,
    );
    const network = resolverNetwork({ servers: [at] });
    expect(await network.resolve("both.test")).toEqual(["93.184.215.14", "2606:4700::1111"]);
    expect(await network.resolve("v4.test")).toEqual(["1.1.1.1", "1.0.0.1"]);
    expect(await network.resolve("v6.test")).toEqual(["2606:4700::1001"]);
    await expect(network.resolve("nowhere.test")).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  test("a name whose DNS never answers is given up on soon, and holds nothing else up meanwhile", async () => {
    const { server, at } = await dnsServer(() => "silent");
    const network = resolverNetwork({
      servers: [at],
      timeoutMs: 300,
      tries: 1,
      deadlineMs: 2000,
    });
    const before = await poolMs();
    const started = performance.now();
    const looking = Array.from({ length: 8 }, (_, index) =>
      network.resolve(`n${index}.slow.test`).then(
        () => "found",
        (error: NodeJS.ErrnoException) => error.code,
      ),
    );
    await expect
      .poll(() => server.asked.length, { timeout: 2000, interval: 10 })
      .toBeGreaterThan(0);
    // The pool of threads is as free as before.
    expect(await poolMs()).toBeLessThan(before + 300);
    expect(await Promise.all(looking)).toEqual(Array<string>(8).fill("ETIMEOUT"));
    expect(performance.now() - started).toBeLessThan(4000);
  });

  test("gives up at its deadline, however its servers go on", async () => {
    const { at } = await dnsServer(() => "silent");
    const network = resolverNetwork({ servers: [at], timeoutMs: 2000, tries: 2, deadlineMs: 500 });
    const started = performance.now();
    await expect(network.resolve("late.test")).rejects.toMatchObject({ code: "ETIMEOUT" });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("looks up so many names at once at most: more are turned away at once", async () => {
    const { at } = await dnsServer(() => "silent");
    const network = resolverNetwork({ servers: [at], timeoutMs: 300, tries: 1, lookups: 2 });
    const two = [network.resolve("a.slow.test"), network.resolve("b.slow.test")];
    for (const each of two) each.catch(() => {});
    const started = performance.now();
    await expect(network.resolve("c.slow.test")).rejects.toMatchObject({ code: "EBUSY" });
    expect(performance.now() - started).toBeLessThan(100);
    await Promise.allSettled(two);
    // Once they are done there is room again.
    await expect(network.resolve("d.slow.test")).rejects.toMatchObject({ code: "ETIMEOUT" });
  });
});
