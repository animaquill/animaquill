import { BlockList, isIP } from "node:net";
import { describe, expect, test } from "vitest";
import {
  NOT_ON_THE_INTERNET_V4,
  NOT_ON_THE_INTERNET_V6,
  Networks,
  parseNetwork,
  publicAddress,
} from "./addresses.ts";
import { checkHostname, targetOf } from "./target.ts";

/** Small and repeatable: a failure can be reproduced from its seed. */
const randomFrom = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    int: (limit: number) => Math.floor(next() * limit),
    chance: (probability: number) => next() < probability,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
};
type Random = ReturnType<typeof randomFrom>;
const SEEDS = 20;
const RUNS = 500;

/**
 * The rule as Node's own BlockList has it, which is not the code under test: what is not on the
 * internet, and IPv6 outside 2000::/3. An IPv6 address that carries IPv4 goes by that IPv4.
 */
const oracle = (() => {
  const v4 = new BlockList();
  for (const network of NOT_ON_THE_INTERNET_V4) {
    const [address, bits] = network.split("/");
    v4.addSubnet(address!, Number(bits), "ipv4");
  }
  const v6 = new BlockList();
  for (const network of NOT_ON_THE_INTERNET_V6) {
    const [address, bits] = network.split("/");
    v6.addSubnet(address!, Number(bits), "ipv6");
  }
  const global = new BlockList();
  global.addSubnet("2000::", 3, "ipv6");
  return {
    v4: (dotted: string) => !v4.check(dotted, "ipv4"),
    v6: (text: string) => global.check(text, "ipv6") && !v6.check(text, "ipv6"),
  };
})();

const dotted = (value: number) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
const hex4 = (value: number) => (value & 0xffff).toString(16);

/** IPv4 addresses, more often near the edges of the networks of the rule. */
const someIPv4 = (random: Random): number => {
  if (random.chance(0.3)) return random.int(2 ** 32);
  const network = parseNetwork(random.pick(NOT_ON_THE_INTERNET_V4));
  const base = Number(network.base);
  const size = 2 ** (32 - network.bits);
  const at = random.pick([base - 1, base, base + random.int(size), base + size - 1, base + size]);
  return (at + 2 ** 32) % 2 ** 32;
};

/** Eight groups of an IPv6 address, from the networks that matter more often than not. */
const someIPv6 = (random: Random): number[] => {
  const groups = Array.from({ length: 8 }, () => random.int(0x10000));
  switch (random.int(12)) {
    case 0: // global unicast
      groups[0] = 0x2000 | random.int(0x2000);
      break;
    case 1: // IPv4-mapped
      groups.splice(0, 6, 0, 0, 0, 0, 0, 0xffff);
      break;
    case 2: // NAT64
      groups.splice(0, 6, 0x64, 0xff9b, 0, 0, 0, 0);
      break;
    case 3: // IPv4-compatible, and the loopback and the unspecified
      groups.splice(0, 6, 0, 0, 0, 0, 0, 0);
      if (random.chance(0.3)) groups.splice(6, 2, 0, random.int(2));
      break;
    case 4: // Teredo and the rest of 2001::/23
      groups[0] = 0x2001;
      groups[1] = random.int(0x200);
      break;
    case 5:
      groups.splice(0, 2, 0x2001, 0xdb8);
      break;
    case 6: // 6to4
      groups[0] = 0x2002;
      break;
    case 7:
      groups[0] = 0x3fff;
      groups[1] = random.int(0x1000);
      break;
    case 8: // unique local
      groups[0] = 0xfc00 | random.int(0x200);
      break;
    case 9: // link-local
      groups[0] = 0xfe80 | random.int(0x40);
      break;
    case 10: // multicast
      groups[0] = 0xff00 | random.int(0x100);
      break;
    default:
      break;
  }
  if ((case4v4(groups) || groups[0] === 0x64) && random.chance(0.6)) {
    const v4 = someIPv4(random);
    groups[6] = v4 >>> 16;
    groups[7] = v4 & 0xffff;
  }
  return groups;
};
const case4v4 = (groups: readonly number[]) => groups.slice(0, 5).every((group) => group === 0);

/** One way of writing an IPv6 address that `net.isIP` takes. */
const writeIPv6 = (groups: readonly number[], random: Random): string => {
  const words = groups.map((group) => {
    const text = group.toString(16);
    return random.chance(0.2) ? text.padStart(4, "0") : text;
  });
  const v4tail = random.chance(0.3);
  const head = v4tail ? words.slice(0, 6) : words;
  const tail = v4tail ? `:${dotted((groups[6]! << 16) | groups[7]!)}` : "";
  // The longest run of zero groups, if any, shortened to ::.
  let best = { at: -1, length: 0 };
  for (let at = 0; at < head.length; at++) {
    let length = 0;
    while (at + length < head.length && groups[at + length] === 0) length++;
    if (length > best.length) best = { at, length };
  }
  let text: string;
  if (best.length >= 1 && random.chance(0.8)) {
    const before = head.slice(0, best.at).join(":");
    const after = head.slice(best.at + best.length).join(":");
    text = `${before}::${after}`;
    if (tail && after === "") text = `${before}::${tail.slice(1)}`;
    else text += tail;
  } else text = `${head.join(":")}${tail}`;
  return random.chance(0.2) ? text.toUpperCase() : text;
};

const expectedOfIPv6 = (groups: readonly number[], text: string): boolean => {
  const carries =
    (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) ||
    (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0));
  if (carries) return oracle.v4(dotted(((groups[6]! << 16) | groups[7]!) >>> 0));
  return oracle.v6(text);
};

describe("addresses on the internet", () => {
  test("what is around the platform is refused, however it is written", () => {
    for (const address of [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.18.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "::FFFF:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:0001",
      "::ffff:a9fe:a9fe",
      "::ffff:10.0.0.1",
      "::ffff:0:7f00:1",
      "::127.0.0.1",
      "::7f00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::1",
      "100::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "fe80::1%eth0",
      "fec0::1",
      "ff02::1",
      "ff0e::1",
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:db8::1",
      "2002:7f00:1::1",
      "2002:c0a8:101::1",
      "3fff::1",
      "5f00::1",
    ])
      expect(publicAddress(address), address).toBeUndefined();
  });

  test("only what net.isIP takes is an address: other ways resolvers read numbers are not", () => {
    for (const text of [
      "2130706433",
      "0x7f000001",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "017700000001",
      "127.1",
      "127.0.1",
      "010.0.0.1",
      "08.8.8.8",
      "8.8.8.8.",
      " 8.8.8.8",
      "8.8.8.8 ",
      "[::1]",
      "[2606:4700::1111]",
      "8.8.8.8:443",
      "1.2.3.4.5",
      "256.1.1.1",
      "::ffff:127.0.0.1%25eth0",
      "localhost",
      "",
    ])
      expect(publicAddress(text), text).toBeUndefined();
  });

  test("someone on the internet is taken, as the address to connect to", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "11.22.33.44",
      "93.184.215.14",
      "100.63.255.255",
      "100.128.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "223.255.255.255",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2606:4700:12:1890::1",
    ])
      expect(publicAddress(address), address).toEqual({
        address,
        family: isIP(address),
      });
    // IPv4 in IPv6 is the IPv4 address; NAT64 goes through its translator.
    expect(publicAddress("::ffff:8.8.8.8")).toEqual({ address: "8.8.8.8", family: 4 });
    expect(publicAddress("::ffff:808:808")).toEqual({ address: "8.8.8.8", family: 4 });
    expect(publicAddress("64:ff9b::808:808")).toEqual({ address: "64:ff9b::808:808", family: 6 });
  });

  test("the platform's own addresses are refused, in any of their forms", () => {
    const own = new Networks(["1.2.3.4", "2606:4700:12:1890::/64"]);
    for (const address of [
      "1.2.3.4",
      "::ffff:1.2.3.4",
      "::ffff:102:304",
      "64:ff9b::102:304",
      "2606:4700:12:1890::1",
      "2606:4700:12:1890:1234:5678:9abc:def0",
    ])
      expect(publicAddress(address, own), address).toBeUndefined();
    expect(publicAddress("1.2.3.5", own)).toEqual({ address: "1.2.3.5", family: 4 });
    expect(publicAddress("2606:4700:12:1891::1", own)).toBeDefined();
  });

  // Each of these collects what goes wrong and looks once: an expect for each of hundreds of
  // thousands of inputs would take most of the time.
  test(
    "random IPv4, near the edges of the networks, as Node's BlockList judges them",
    { timeout: 30_000 },
    () => {
      const wrong: string[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const random = randomFrom(seed);
        for (let run = 0; run < RUNS; run++) {
          const value = someIPv4(random);
          const text = dotted(value);
          const expected = oracle.v4(text);
          const found = publicAddress(text);
          if ((found !== undefined) !== expected || (found && found.address !== text))
            wrong.push(`seed ${seed}: ${text}`);
          // The same address mapped into IPv6 is the same address.
          for (const mapped of [
            `::ffff:${text}`,
            `::ffff:${hex4(value >>> 16)}:${hex4(value)}`,
            `0:0:0:0:0:FFFF:${text}`,
          ]) {
            const viaV6 = publicAddress(mapped);
            if ((viaV6 !== undefined) !== expected) wrong.push(`seed ${seed}: ${mapped}`);
            if (viaV6 && (viaV6.address !== text || viaV6.family !== 4))
              wrong.push(`seed ${seed}: ${mapped} is ${viaV6.address}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  test(
    "random IPv6, written in every way net.isIP takes, as Node's BlockList judges them",
    { timeout: 30_000 },
    () => {
      const wrong: string[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const random = randomFrom(seed * 7919);
        for (let run = 0; run < RUNS; run++) {
          const groups = someIPv6(random);
          const text = writeIPv6(groups, random);
          if (isIP(text) !== 6) wrong.push(`seed ${seed}: ${text} is not written right`);
          const expected = expectedOfIPv6(groups, text);
          if ((publicAddress(text) !== undefined) !== expected) wrong.push(`seed ${seed}: ${text}`);
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  test(
    "random addresses inside, spelled the ways resolvers and URL parsers also read, never get through",
    { timeout: 30_000 },
    () => {
      const wrong: string[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const random = randomFrom(seed * 104729);
        for (let run = 0; run < RUNS; run++) {
          let value = someIPv4(random);
          if (oracle.v4(dotted(value))) value = (0x7f000000 | random.int(0x1000000)) >>> 0;
          const bytes = [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff);
          const octal = (byte: number) => `0${byte.toString(8)}`;
          const hex = (byte: number) => `0x${byte.toString(16)}`;
          const spellings = [
            dotted(value),
            String(value),
            `0x${value.toString(16)}`,
            `0${value.toString(8)}`,
            bytes.map(octal).join("."),
            bytes.map(hex).join("."),
            bytes.map((byte) => random.pick([String(byte), octal(byte), hex(byte)])).join("."),
            `${bytes[0]}.${(value & 0xffffff) >>> 0}`,
            `${bytes[0]}.${bytes[1]}.${value & 0xffff}`,
            `${dotted(value)}.`,
            `[::ffff:${dotted(value)}]`,
            `::ffff:${dotted(value)}`,
            `${dotted(value)}:443`,
            `${dotted(value)}%00`,
          ];
          for (const spelling of spellings) {
            if (publicAddress(spelling) !== undefined) wrong.push(`seed ${seed}: ${spelling}`);
            if (checkHostname(spelling) !== undefined) wrong.push(`seed ${seed}: name ${spelling}`);
            if (targetOf(`/api/llm-relay/https/${spelling}/v1/models`) !== undefined)
              wrong.push(`seed ${seed}: target ${spelling}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    },
  );
});

describe("networks", () => {
  test("are written as an address, or an address and its bits", () => {
    const networks = new Networks(["192.0.2.0/24", "2001:db8::/32", "203.0.113.5"]);
    expect(networks.has("192.0.2.200")).toBe(true);
    expect(networks.has("192.0.3.1")).toBe(false);
    expect(networks.has("2001:db8:1::1")).toBe(true);
    expect(networks.has("203.0.113.5")).toBe(true);
    expect(networks.has("203.0.113.6")).toBe(false);
    for (const wrong of ["192.0.2.0/33", "2001:db8::/129", "x/8", "1.2.3.4/8/9", "1.2.3.4/-1"])
      expect(() => parseNetwork(wrong), wrong).toThrow();
  });
});
