import { ProblemSet } from "@animaquill/core";
import { BRIDGE_PROTOCOL, proofText, type PageProject } from "@animaquill/tools";
import { describe, expect, it } from "vitest";
import { openUnlocked } from "../../../../core/src/fuzz-support.ts";
import { ToolBridge, type BridgePage, type RelayTrust } from "./bridge.ts";
import { BridgeExecutor } from "./executor.ts";

/**
 * The editor's end of the AI tools on this computer (docs/design/online-offline.md of AnimaQuill
 * Cloud, 5.2, 5.3, 5.7): when it connects, which relay it takes, and which window takes the calls.
 */

const ORIGIN = "https://editor.test";
const PORTS = { first: 47_300, count: 3 };

/** A relay on a port, with a key of its own, that signs what pages ask the way `Relay` does. */
async function relayKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const key = btoa(String.fromCharCode(...spki));
  const sign = async (text: string) => {
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(text),
      ),
    );
    return btoa(String.fromCharCode(...signature));
  };
  return { key, sign };
}

type Relay = Awaited<ReturnType<typeof relayKey>> & { readonly port: number };

/** WebSockets that reach the relays given, by port, and nothing on the other ports. */
function socketsTo(relays: readonly Relay[], tried: string[] = []) {
  const open: FakeSocket[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    readonly sent: unknown[] = [];
    readonly #listeners = new EventTarget();
    addEventListener(
      type: string,
      listener: (event: Event) => void,
      options?: AddEventListenerOptions,
    ) {
      this.#listeners.addEventListener(type, listener, options);
    }
    #fire(type: string, data?: string) {
      const event = new Event(type);
      if (data !== undefined) Object.assign(event, { data });
      this.#listeners.dispatchEvent(event);
    }
    constructor(url: string) {
      tried.push(url);
      const { port, searchParams } = new URL(url);
      const relay = relays.find((each) => each.port === Number(port));
      open.push(this);
      setTimeout(async () => {
        if (!relay) {
          this.#fire("error");
          return;
        }
        this.readyState = 1;
        const nonce = searchParams.get("nonce") ?? "";
        const signature = await relay.sign(proofText(nonce, ORIGIN, relay.port));
        this.#fire(
          "message",
          JSON.stringify({
            t: "hello",
            protocol: BRIDGE_PROTOCOL,
            toolset: "t",
            list: "l",
            key: relay.key,
            signature,
          }),
        );
      }, 1);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.#fire("close");
    }
  }
  return { Socket: FakeSocket as unknown as typeof WebSocket, open };
}

function trustOf(keys: string[] = []): RelayTrust {
  return {
    has: (key) => keys.includes(key),
    add: (key) => void keys.push(key),
    delete: (key) => {
      const at = keys.indexOf(key);
      if (at >= 0) keys.splice(at, 1);
    },
    get any() {
      return keys.length > 0;
    },
  };
}

/** Exclusive locks as one browser has them, for every window of it. */
function locksOf(): LockManager {
  const queues = new Map<string, (() => void)[]>();
  const held = new Set<string>();
  return {
    request(name: string, callback: (lock: Lock | null) => Promise<void> | undefined) {
      return new Promise<void>((resolve) => {
        const run = async () => {
          held.add(name);
          try {
            await callback({ name, mode: "exclusive" } as Lock);
          } finally {
            held.delete(name);
            queues.get(name)?.shift()?.();
            resolve();
          }
        };
        if (held.has(name)) queues.set(name, [...(queues.get(name) ?? []), run]);
        else void run();
      });
    },
    query: async () => ({}),
  } as unknown as LockManager;
}

const project: PageProject = { mode: "online", key: "p1", id: "x", name: "宣传片" };

function bridgeOf(options: {
  readonly Socket: typeof WebSocket;
  readonly trust: RelayTrust;
  readonly auto?: boolean;
  readonly confirm?: () => Promise<boolean>;
  readonly granted?: boolean;
  readonly locks?: LockManager;
  readonly page?: BridgePage;
  readonly permission?: PermissionState;
  readonly fetch?: typeof fetch;
}) {
  const store = openUnlocked();
  const problems = new ProblemSet();
  const executor = new BridgeExecutor({
    store: () => store,
    parts: { problems: () => problems },
    hidden: () => false,
    picture: async () => undefined,
  });
  const asked: string[] = [];
  const bridge = new ToolBridge({
    executor,
    page: () => options.page ?? { project, eligible: true },
    subscribe: () => () => {},
    readFile: async () => undefined,
    trust: options.trust,
    autoConnect: () => options.auto === true,
    confirm: async () => {
      asked.push("asked");
      return (await options.confirm?.()) ?? false;
    },
    toolset: "t",
    list: "l",
    browser: "Test",
    origin: ORIGIN,
    permission: async () => options.permission ?? (options.granted ? "granted" : "prompt"),
    fetch: options.fetch ?? ((() => Promise.reject(new Error("nothing there"))) as typeof fetch),
    ...(options.locks && { locks: () => options.locks }),
    WebSocket: options.Socket,
    ports: PORTS,
    hidden: () => false,
  });
  return { bridge, asked, store };
}

const until = async (check: () => boolean, tries = 200) => {
  for (let tried = 0; tried < tries && !check(); tried += 1) {
    await new Promise((done) => setTimeout(done, 5));
  }
  expect(check()).toBe(true);
};

describe("the editor and the AI tools on this computer", () => {
  it("tries no port where people never connected, unless they asked", async () => {
    const relay = { ...(await relayKey()), port: 47_300 };
    const tried: string[] = [];
    const { Socket } = socketsTo([relay], tried);
    const { bridge } = bridgeOf({ Socket, trust: trustOf(), granted: true });
    await bridge.start();
    await new Promise((done) => setTimeout(done, 30));
    expect(tried).toEqual([]);
    expect(bridge.getSnapshot().status).toBe("off");
    // Allowed before, but the browser would still ask about this computer: nothing either.
    const before = bridgeOf({ Socket, trust: trustOf([relay.key]), granted: false });
    await before.bridge.start();
    await new Promise((done) => setTimeout(done, 30));
    expect(tried).toEqual([]);
    // People ask: the relay there is the one they allow, without asking again.
    const trust = trustOf();
    const asking = bridgeOf({ Socket, trust });
    asking.bridge.connect();
    await until(() => asking.bridge.getSnapshot().status === "connected");
    expect(asking.asked).toEqual([]);
    expect(trust.has(relay.key)).toBe(true);
  });

  it("connects by itself where the browser lets it and the relay is the one allowed", async () => {
    const relay = { ...(await relayKey()), port: 47_301 };
    const { Socket } = socketsTo([relay]);
    const { bridge } = bridgeOf({ Socket, trust: trustOf([relay.key]), granted: true });
    await bridge.start();
    await until(() => bridge.getSnapshot().status === "connected");
  });

  it("asks people about a relay they did not allow, met without their asking", async () => {
    const stranger = { ...(await relayKey()), port: 47_300 };
    const { Socket } = socketsTo([stranger]);
    const trust = trustOf();
    const { bridge, asked } = bridgeOf({ Socket, trust, auto: true, confirm: async () => false });
    await bridge.start();
    await until(() => bridge.getSnapshot().status === "refused");
    expect(asked).toEqual(["asked"]);
    expect(trust.any).toBe(false);
  });

  it("takes the relay allowed over another one on another port, and none that cannot prove its key", async () => {
    const allowed = { ...(await relayKey()), port: 47_302 };
    const other = { ...(await relayKey()), port: 47_300 };
    // One that has the port and somebody else's key: it says it is the relay allowed, and is not.
    const forger = { ...(await relayKey()), port: 47_301 };
    const forged = { ...forger, key: allowed.key };
    const { Socket } = socketsTo([other, forged, allowed]);
    const trust = trustOf([allowed.key]);
    const { bridge, asked } = bridgeOf({ Socket, trust, auto: true });
    await bridge.start();
    await until(() => bridge.getSnapshot().status === "connected");
    expect(asked).toEqual([]);
  });

  it("has one window of a browser take the calls of a project, and the next once it goes", async () => {
    const relay = { ...(await relayKey()), port: 47_300 };
    const { Socket, open } = socketsTo([relay]);
    const locks = locksOf();
    const trust = trustOf([relay.key]);
    const first = bridgeOf({ Socket, trust, granted: true, locks });
    const second = bridgeOf({ Socket, trust, granted: true, locks });
    await first.bridge.start();
    await until(() => first.bridge.getSnapshot().serving);
    await second.bridge.start();
    await until(() => second.bridge.getSnapshot().status === "connected");
    expect(second.bridge.getSnapshot().serving).toBe(false);
    // What the second one tells the relay: it has the project, and takes no calls.
    const said = (open.at(-1)?.sent ?? []) as { t: string; serving?: boolean }[];
    expect(said.filter(({ t }) => t === "page").at(-1)?.serving).toBe(false);
    first.bridge.dispose();
    await until(() => second.bridge.getSnapshot().serving);
  });

  it("takes none of two relays never allowed, also when people asked to connect", async () => {
    const one = { ...(await relayKey()), port: 47_300 };
    const two = { ...(await relayKey()), port: 47_301 };
    const { Socket } = socketsTo([one, two]);
    const trust = trustOf();
    const { bridge, asked } = bridgeOf({ Socket, trust });
    bridge.connect();
    await until(() => bridge.getSnapshot().status === "several");
    expect(trust.any).toBe(false);
    expect(asked).toEqual([]);
  });

  it("takes the relay people start in the minute after they clicked, without asking", async () => {
    const relay = { ...(await relayKey()), port: 47_300 };
    // Nothing there when people click; the AI tool starts after.
    const relays: Relay[] = [];
    const { Socket } = socketsTo(relays);
    const trust = trustOf();
    const { bridge, asked } = bridgeOf({ Socket, trust, confirm: async () => false });
    bridge.connect();
    await until(() => bridge.getSnapshot().status === "no-relay");
    relays.push(relay);
    await until(() => bridge.getSnapshot().status === "connected", 1_000);
    expect(asked).toEqual([]);
    expect(trust.has(relay.key)).toBe(true);
  });

  it("takes none of two new ones that come one after the other in the minute", async () => {
    const first = { ...(await relayKey()), port: 47_300 };
    const second = { ...(await relayKey()), port: 47_301 };
    const relays: Relay[] = [first];
    const { Socket, open } = socketsTo(relays);
    const trust = trustOf();
    const { bridge, asked } = bridgeOf({ Socket, trust, confirm: async () => true });
    bridge.connect();
    await until(() => bridge.getSnapshot().status === "connected");
    // That relay goes, and another key answers within the minute.
    relays.splice(0, 1, second);
    for (const socket of open) socket.close();
    await until(() => bridge.getSnapshot().status === "several", 1_000);
    expect(trust.any).toBe(false);
    expect(asked).toEqual([]);
  });

  it("asks about a new one met by itself only once in a page", async () => {
    const relay = { ...(await relayKey()), port: 47_300 };
    const { Socket } = socketsTo([relay]);
    const trust = trustOf();
    const { bridge, asked } = bridgeOf({ Socket, trust, auto: true, confirm: async () => false });
    await bridge.start();
    await until(() => bridge.getSnapshot().status === "refused");
    bridge.autoConnectChanged(true);
    await new Promise((done) => setTimeout(done, 50));
    expect(asked).toHaveLength(1);
  });

  it("says why it cannot connect: the browser said no, or the relay does not take this site", async () => {
    const { Socket } = socketsTo([]);
    const denied = bridgeOf({ Socket, trust: trustOf(), permission: "denied" });
    denied.bridge.connect();
    await until(() => denied.bridge.getSnapshot().status === "denied");
    const asked: string[] = [];
    const notAllowed = bridgeOf({
      Socket,
      trust: trustOf(),
      fetch: (async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify({ relay: true, allowed: false }));
      }) as unknown as typeof fetch,
    });
    notAllowed.bridge.connect();
    await until(() => notAllowed.bridge.getSnapshot().status === "not-allowed");
    expect(asked[0]).toBe("http://127.0.0.1:47300/ping");
  });
});
