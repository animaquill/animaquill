import { RELAY_PORTS_KEY, RELAY_TRUST_KEY, scoped } from "@animaquill/host";
import {
  BRIDGE_PROTOCOL,
  RELAY_PORTS,
  proofText,
  readMessage,
  toPage,
  type BridgeSession,
  type FromPage,
  type PageProject,
  type ToPage,
} from "@animaquill/tools";
import { Emitter } from "../../workbench/emitter.ts";
import type { BridgeExecutor } from "./executor.ts";

/**
 * The editor's end of the AI tools on this computer (docs/design/online-offline.md of AnimaQuill
 * Cloud, 5.2, 5.3, 5.7): it connects to the relay of `animaquill mcp` on 127.0.0.1, checks that it
 * is the relay people allowed by its signature, says what project this window has open, and runs
 * the calls the relay sends it (`BridgeExecutor`).
 *
 * - **When it connects:** only once people asked for it (连接 in the guide), or where the browser
 *   already lets the page at this computer and people allowed a relay here before, or where people
 *   turned on connecting by itself. A page that opens does not try the ports otherwise: browsers
 *   ask people whether a site may reach this computer, and nobody should be asked for nothing.
 * - **Which relay:** the one whose key this browser remembers. A new one is remembered when people
 *   connect from the guide (that click is the yes); met otherwise, people are asked first.
 * - **Which window takes calls:** one window in a browser for each project, by a Web Lock; the next
 *   one takes over when it goes.
 */

/** What the bridge is doing, for the guide and the settings. */
export type BridgeStatus =
  /** Not connected, and not trying. */
  | "off"
  | "connecting"
  | "connected"
  /** Nothing to connect to: no `animaquill mcp` runs, or the browser does not let the page. */
  | "no-relay"
  /** People did not allow the relay that is there. */
  | "refused";

export interface BridgeSnapshot {
  readonly status: BridgeStatus;
  /** Every session of an AI tool the relay has. */
  readonly sessions: readonly BridgeSession[];
  /** This window takes the calls for its project. */
  readonly serving: boolean;
  /** The relay lists other tools than this editor has: an older or newer `animaquill`. */
  readonly mismatch: boolean;
}

/** What this window has open, as the relay is told. */
export interface BridgePage {
  readonly project: PageProject | undefined;
  /** It may take calls for it: offline, only the window that writes the folder. */
  readonly eligible: boolean;
}

/** The keys of relays people allowed, in this browser, for every mode: it is this computer's. */
export interface RelayTrust {
  has(key: string): boolean;
  add(key: string): void;
  readonly any: boolean;
}

export function browserRelayTrust(): RelayTrust {
  const read = (): string[] => {
    try {
      const value = JSON.parse(localStorage.getItem(RELAY_TRUST_KEY) ?? "[]") as unknown;
      return Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    has: (key) => read().includes(key),
    add(key) {
      const keys = read();
      if (keys.includes(key)) return;
      try {
        localStorage.setItem(RELAY_TRUST_KEY, JSON.stringify([...keys, key].slice(-10)));
      } catch {
        // Asked again next time.
      }
    },
    get any() {
      return read().length > 0;
    },
  };
}

export interface ToolBridgeOptions {
  readonly executor: BridgeExecutor;
  readonly page: () => BridgePage;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads a file of the open project folder, for a probe; undefined where there is none. */
  readonly readFile: (path: string) => Promise<string | undefined>;
  readonly trust: RelayTrust;
  /** People turned on connecting by itself. */
  readonly autoConnect: () => boolean;
  /** Asks people whether to allow a relay they did not allow yet. */
  readonly confirm: () => Promise<boolean>;
  /** `TOOLSET_VERSION`, and the hash of the list as `animaquill mcp` lists it. */
  readonly toolset: string;
  readonly list: string;
  readonly browser: string;
  readonly origin: string;
  /** What the browser says of letting the page at this computer, where it says. */
  readonly permission?: () => Promise<PermissionState | undefined>;
  readonly locks?: () => LockManager | undefined;
  readonly WebSocket?: typeof WebSocket;
  readonly ports?: { readonly first: number; readonly count: number };
  readonly hidden?: () => boolean;
  readonly now?: () => number;
}

/**
 * Other ports than `RELAY_PORTS`, as tests run relays of their own (`ANIMAQUILL_RELAY_PORTS` of
 * `animaquill mcp`): "<first>:<count>" in `animaquill.mcp.ports`. Which ports it looks on is all it
 * changes: what answers there still has to prove the key people allowed.
 */
function portsMoved(): { first: number; count: number } | undefined {
  try {
    const given = /^(\d+):(\d+)$/.exec(localStorage.getItem(RELAY_PORTS_KEY) ?? "");
    return given ? { first: Number(given[1]), count: Math.min(Number(given[2]), 20) } : undefined;
  } catch {
    return undefined;
  }
}

/** How long a relay has to say hello, and how often to look again for one that is not there. */
const HELLO_MS = 3_000;
const AGAIN_MS = 2_000;
/** How long after people asked to connect a relay found is the one they allow. */
const ASKED_MS = 60_000;

const nonceOf = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** Whether a relay's signature of the proof is by its key. */
export async function provesKey(key: string, signature: string, text: string): Promise<boolean> {
  try {
    const imported = await crypto.subtle.importKey(
      "spki",
      bytesOf(key),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      imported,
      bytesOf(signature),
      new TextEncoder().encode(text),
    );
  } catch {
    return false;
  }
}

/** Whether the browser lets this page at this computer without asking. */
export async function loopbackPermission(): Promise<PermissionState | undefined> {
  try {
    const status = await navigator.permissions.query({
      name: "loopback-network" as PermissionName,
    });
    return status.state;
  } catch {
    return undefined;
  }
}

interface Hello {
  readonly ws: WebSocket;
  readonly key: string;
  readonly toolset: string;
  readonly list: string;
}

export class ToolBridge {
  readonly #options: ToolBridgeOptions;
  readonly #emitter = new Emitter();
  readonly pageId = nonceOf();
  #snapshot: BridgeSnapshot = { status: "off", sessions: [], serving: false, mismatch: false };
  #ws: WebSocket | undefined;
  /** People want it connected: it keeps connecting again while they do. */
  #wanted = false;
  /** When people last asked to connect. */
  #askedAt: number | undefined;
  #scanning: Promise<void> | undefined;
  #again: ReturnType<typeof setTimeout> | undefined;
  #frontAt: number;
  /** The project the lock is held for, and how to let go of it. */
  #lock: { readonly key: string; readonly release: () => void } | undefined;
  #stops: (() => void)[] = [];

  constructor(options: ToolBridgeOptions) {
    this.#options = options;
    this.#frontAt = this.#now();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): BridgeSnapshot => this.#snapshot;

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** Connects where the top says it may without being asked; otherwise does nothing. */
  async start(): Promise<void> {
    const onFront = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this.#say();
        return;
      }
      this.#frontAt = this.#now();
      this.#say();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onFront);
      addEventListener("focus", onFront);
      this.#stops.push(() => {
        document.removeEventListener("visibilitychange", onFront);
        removeEventListener("focus", onFront);
      });
    }
    this.#stops.push(this.#options.subscribe(() => this.#follow()));
    const { trust, autoConnect, permission } = this.#options;
    if (autoConnect()) {
      this.#want(false);
      return;
    }
    if (!trust.any) return;
    if ((await permission?.()) === "granted") this.#want(false);
  }

  /** People asked to connect (连接): the relay there is the one they allow. */
  connect(): void {
    this.#want(true);
  }

  /** People turned connecting by itself on or off. */
  autoConnectChanged(on: boolean): void {
    if (on) this.#want(false);
  }

  #want(asked: boolean): void {
    this.#wanted = true;
    if (asked) this.#askedAt = this.#now();
    if (this.#ws) return;
    this.#set({ status: "connecting" });
    void this.#scan();
  }

  /**
   * Looks for the relay on each port, once at a time. What people asked for in the last minute is
   * a relay they allow: the one they just started, most likely. Later, one they did not allow yet is
   * asked about.
   */
  #scan(): Promise<void> {
    const asked = this.#askedAt !== undefined && this.#now() - this.#askedAt < ASKED_MS;
    this.#scanning ??= this.#look(asked).finally(() => {
      this.#scanning = undefined;
    });
    return this.#scanning;
  }

  async #look(asked: boolean): Promise<void> {
    clearTimeout(this.#again);
    const { first, count } = this.#options.ports ?? portsMoved() ?? RELAY_PORTS;
    let stranger: Hello | undefined;
    let found: Hello | undefined;
    for (let port = first; port < first + count && !found; port += 1) {
      const hello = await this.#hello(port);
      if (!hello) continue;
      if (this.#options.trust.has(hello.key)) {
        found = hello;
        stranger?.ws.close();
      } else if (!stranger) {
        stranger = hello;
      } else {
        hello.ws.close();
      }
    }
    if (!found && stranger) {
      const allowed = asked || (await this.#options.confirm());
      if (allowed) {
        this.#options.trust.add(stranger.key);
        found = stranger;
      } else {
        stranger.ws.close();
        this.#wanted = false;
        this.#askedAt = undefined;
        this.#set({ status: "refused" });
        return;
      }
    }
    if (!found) {
      this.#set({ status: "no-relay" });
      if (this.#wanted) this.#again = setTimeout(() => void this.#scan(), AGAIN_MS);
      return;
    }
    this.#attach(found);
  }

  /** Connects to a port, and resolves to the relay once it proved its key there. */
  #hello(port: number): Promise<Hello | undefined> {
    const Socket = this.#options.WebSocket ?? WebSocket;
    const nonce = nonceOf();
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new Socket(`ws://127.0.0.1:${port}/page?nonce=${nonce}`);
      } catch {
        resolve(undefined);
        return;
      }
      // What it listens to until it knows, and no longer.
      const listening = new AbortController();
      const { signal } = listening;
      const done = (hello: Hello | undefined) => {
        clearTimeout(timer);
        listening.abort();
        if (!hello) ws.close();
        resolve(hello);
      };
      const timer = setTimeout(() => done(undefined), HELLO_MS);
      ws.addEventListener("error", () => done(undefined), { signal });
      ws.addEventListener("close", () => done(undefined), { signal });
      ws.addEventListener(
        "message",
        (event) => {
          const message = readMessage(toPage, String(event.data));
          if (message?.t !== "hello" || message.protocol !== BRIDGE_PROTOCOL) {
            done(undefined);
            return;
          }
          const text = proofText(nonce, this.#options.origin, port);
          void provesKey(message.key, message.signature, text).then((ok) =>
            done(
              ok
                ? { ws, key: message.key, toolset: message.toolset, list: message.list }
                : undefined,
            ),
          );
        },
        { signal },
      );
    });
  }

  #attach({ ws, toolset, list }: Hello): void {
    this.#ws = ws;
    this.#set({
      status: "connected",
      mismatch: toolset !== this.#options.toolset || list !== this.#options.list,
    });
    ws.addEventListener("message", (event) => {
      const message = readMessage(toPage, String(event.data));
      if (message) void this.#hear(message);
    });
    ws.addEventListener("close", () => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      this.#letGo();
      this.#set({ status: this.#wanted ? "connecting" : "off", sessions: [], serving: false });
      // The relay changed, most likely: another `animaquill mcp` of this user is the relay in a
      // moment, with the same key. One with another key is asked about, as it was not asked for.
      if (this.#wanted) void this.#scan();
    });
    ws.addEventListener("error", () => ws.close());
    this.#follow();
  }

  async #hear(message: ToPage): Promise<void> {
    switch (message.t) {
      case "ping":
        this.#send({ t: "pong" });
        return;
      case "sessions":
        this.#set({ sessions: message.sessions });
        return;
      case "probe": {
        const text = await this.#options.readFile(message.path).catch(() => undefined);
        let found = false;
        try {
          found =
            text !== undefined && (JSON.parse(text) as { nonce?: unknown }).nonce === message.nonce;
        } catch {
          found = false;
        }
        this.#send({ t: "probed", probe: message.probe, found });
        return;
      }
      case "call": {
        const result = this.#snapshot.serving
          ? await this.#options.executor.run({
              call: message.call,
              session: message.session,
              answer: message.answer,
              tool: message.tool,
              args: message.args,
              ...(message.client && { client: message.client }),
            })
          : {
              text: "error editor-not-open: the editor that got the call does not take calls for its project now, so nothing was done.",
              isError: true,
            };
        this.#send({ t: "result", call: message.call, result });
        return;
      }
      case "cancel":
        this.#options.executor.cancel(message.call);
        return;
      case "hello":
        return;
    }
  }

  #send(message: FromPage): void {
    const ws = this.#ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  /** What this window has open now: takes the lock of its project, and tells the relay. */
  #follow(): void {
    const { project, eligible } = this.#options.page();
    const key = project && eligible ? project.key : undefined;
    if (this.#lock?.key !== key) {
      this.#letGo();
      this.#options.executor.reset();
      if (key !== undefined && this.#ws) this.#take(key);
    }
    this.#say();
  }

  /** Waits for the lock of a project, and takes calls for it while it holds it. */
  #take(key: string): void {
    const locks = (this.#options.locks ?? (() => navigator.locks))();
    let release = () => {};
    let over = false;
    this.#lock = {
      key,
      release: () => {
        over = true;
        release();
      },
    };
    if (!locks) {
      this.#set({ serving: true });
      this.#say();
      return;
    }
    void locks
      .request(scoped(`aq-mcp:${key}`), () => {
        if (over) return undefined;
        this.#set({ serving: true });
        this.#say();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => {});
  }

  #letGo(): void {
    this.#lock?.release();
    this.#lock = undefined;
    if (this.#snapshot.serving) this.#set({ serving: false });
  }

  #say(): void {
    if (!this.#ws) return;
    const { project } = this.#options.page();
    const hidden =
      this.#options.hidden?.() ??
      (typeof document !== "undefined" && document.visibilityState === "hidden");
    this.#send({
      t: "page",
      page: this.pageId,
      browser: this.#options.browser,
      toolset: this.#options.toolset,
      list: this.#options.list,
      ...(project && { project }),
      serving: this.#snapshot.serving && project !== undefined,
      hidden,
      frontAt: this.#frontAt,
    });
  }

  /** Stops connecting, and lets go of the relay. */
  disconnect(): void {
    this.#wanted = false;
    clearTimeout(this.#again);
    const ws = this.#ws;
    this.#ws = undefined;
    this.#letGo();
    ws?.close();
    this.#set({ status: "off", sessions: [] });
  }

  /** The sessions whose project is the one of this window. */
  get here(): readonly BridgeSession[] {
    return this.#snapshot.sessions.filter(({ page }) => page === this.pageId);
  }

  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop();
    this.disconnect();
  }

  #set(next: Partial<BridgeSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    this.#emitter.emit();
  }
}
