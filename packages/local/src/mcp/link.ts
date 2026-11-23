import { randomBytes } from "node:crypto";
import { BRIDGE_PROTOCOL, RELAY_PORTS } from "@animaquill/tools";
import { WebSocket, type RawData } from "ws";
import type { RelayIdentity } from "./identity.ts";
import { fromPeer, peerHello, peerOk, peerProof, readPeer, relayProof, toPeer } from "./peer.ts";
import {
  Relay,
  type CallAnswer,
  type CallRequest,
  type RelayOptions,
  type Router,
  type SessionInfo,
} from "./relay.ts";
import { isOwnUser } from "./uid.ts";

/**
 * How one `animaquill mcp` gets its calls to the relay (docs/design/online-offline.md of AnimaQuill
 * Cloud, 5.1): it is the relay itself where it got the first free port of the range, or else a peer
 * of the relay that has it. Port by port it tries to listen; where something listens already, it
 * tries to connect as a peer, which only the relay of this user lets it; something else there is
 * passed by. Once the relay goes, its peers do the same again, and one of them is the relay then:
 * sessions say again what they work on, and calls that had no answer go again under the same id,
 * which the page answers once (a later `animaquill mcp` of the backend on this computer, O4 of the
 * design, comes before all this, see `RelayLink`).
 */

/** What a session does with the relay, whichever process has it. */
export interface RelayLink {
  session(info: SessionInfo): void;
  end(session: string): void;
  call(request: CallRequest, signal?: AbortSignal): Promise<CallAnswer>;
  close(): Promise<void>;
}

export interface ElectionOptions extends RelayOptions {
  readonly identity: RelayIdentity;
  /** The range of ports, see `RELAY_PORTS`. */
  readonly ports?: { readonly first: number; readonly count: number };
  /** What happens, for tests and for stderr. */
  readonly log?: (text: string) => void;
}

const textOf = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.from(data as ArrayBuffer).toString("utf8");

/** Serves the calls of peers on the router of the relay. A message it cannot read lets the peer go. */
function servePeer(router: Router, ws: WebSocket): void {
  const sessions = new Set<string>();
  const calls = new Map<string, AbortController>();
  const send = (message: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  ws.on("message", (data) => {
    const message = readPeer(fromPeer, textOf(data));
    if (!message) {
      ws.close(1008, "unreadable");
      return;
    }
    switch (message.t) {
      case "session":
        sessions.add(message.info.session);
        router.addSession(message.info as SessionInfo);
        return;
      case "end":
        sessions.delete(message.session);
        router.removeSession(message.session);
        return;
      case "call": {
        const request = message.request as CallRequest;
        if (!sessions.has(request.session)) return;
        const controller = new AbortController();
        calls.set(request.call, controller);
        void router
          .call(request, controller.signal)
          .catch((): CallAnswer => ({ kind: "gone" }))
          .then((answer) => {
            calls.delete(request.call);
            send({ t: "answer", call: request.call, answer });
          });
        return;
      }
      case "cancel":
        calls.get(message.call)?.abort();
    }
  });
  ws.on("close", () => {
    for (const session of sessions) router.removeSession(session);
    for (const controller of calls.values()) controller.abort();
  });
}

/**
 * Connects to a relay as a peer: resolves to the socket once both proved the key, or undefined. On
 * Linux the relay has to be of this user as well.
 */
function connectPeer(
  port: number,
  identity: RelayIdentity,
  ownUser: (localPort: number, remotePort: number) => Promise<boolean>,
): Promise<WebSocket | undefined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/peer`, { handshakeTimeout: 3_000 });
    const nonce = randomBytes(18).toString("base64url");
    let step = 0;
    let ownPort: number | undefined;
    const fail = () => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
      resolve(undefined);
    };
    const timer = setTimeout(fail, 5_000);
    ws.on("upgrade", (response) => {
      ownPort = response.socket.localPort;
    });
    ws.on("error", fail);
    ws.on("close", fail);
    ws.on("message", (data) => {
      const raw = textOf(data);
      if (step === 0) {
        const hello = readPeer(peerHello, raw);
        if (!hello) {
          fail();
          return;
        }
        step = 1;
        void (async () => {
          // The other end of this connection is the relay: of this user, where the system tells.
          if (ownPort === undefined || !(await ownUser(ownPort, port))) {
            fail();
            return;
          }
          ws.send(
            JSON.stringify({
              t: "peer-auth",
              nonce,
              protocol: BRIDGE_PROTOCOL,
              mac: identity.mac(peerProof(hello.nonce, port)),
            }),
          );
        })();
        return;
      }
      const ok = readPeer(peerOk, raw);
      if (step === 1 && ok && identity.checks(relayProof(nonce, port), ok.mac)) {
        clearTimeout(timer);
        ws.removeAllListeners();
        resolve(ws);
      } else {
        fail();
      }
    });
  });
}

/** A call without an answer yet. */
interface Pending {
  readonly request: CallRequest;
  readonly resolve: (answer: CallAnswer) => void;
  readonly signal: AbortSignal | undefined;
  /** It went to a relay once. */
  sent: boolean;
}

type Current =
  | { readonly kind: "relay"; readonly relay: Relay }
  | {
      readonly kind: "peer";
      readonly ws: WebSocket;
      readonly port: number;
    };

/**
 * The relay link of one `animaquill mcp`, elected as the top says. Calls wait while it elects.
 */
export class ElectedLink implements RelayLink {
  readonly #options: ElectionOptions;
  readonly #sessions = new Map<string, SessionInfo>();
  /** Calls without an answer, which go again once the relay changed. */
  readonly #calls = new Map<string, Pending>();
  #current: Current | undefined;
  #electing: Promise<Current> | undefined;
  #closed = false;

  constructor(options: ElectionOptions) {
    this.#options = options;
  }

  /** Whether this process is the relay now, and on which port: for tests and stderr. */
  get role(): { readonly kind: "relay" | "peer"; readonly port: number } | undefined {
    const current = this.#current;
    if (!current) return undefined;
    return current.kind === "relay"
      ? { kind: "relay", port: current.relay.port }
      : { kind: "peer", port: current.port };
  }

  /** The router, where this process is the relay: for tests. */
  get router(): Router | undefined {
    return this.#current?.kind === "relay" ? this.#current.relay.router : undefined;
  }

  start(): Promise<unknown> {
    return this.#elect();
  }

  #elect(): Promise<Current> {
    this.#electing ??= this.#run().finally(() => {
      this.#electing = undefined;
    });
    return this.#electing;
  }

  async #run(): Promise<Current> {
    const { first, count } = this.#options.ports ?? RELAY_PORTS;
    for (let round = 0; !this.#closed; round += 1) {
      for (let port = first; port < first + count; port += 1) {
        const relay = await Relay.listen(port, this.#options).catch(() => undefined);
        if (relay) return this.#became({ kind: "relay", relay });
        const ws = await connectPeer(
          port,
          this.#options.identity,
          this.#options.ownUser ?? isOwnUser,
        );
        if (ws) return this.#became({ kind: "peer", ws, port });
      }
      // Every port is taken, or the relay that had one is going: a moment, and again.
      await new Promise((done) => setTimeout(done, Math.min(2_000, 100 * (round + 1))));
    }
    throw new Error("closed");
  }

  #became(current: Current): Current {
    this.#current = current;
    this.#options.log?.(
      current.kind === "relay"
        ? `AnimaQuill: the relay for AI tools listens on 127.0.0.1:${current.relay.port}`
        : `AnimaQuill: connected to the relay on 127.0.0.1:${current.port}`,
    );
    if (current.kind === "relay") {
      const { router } = current.relay;
      current.relay.onPeer((ws) => servePeer(router, ws));
      for (const info of this.#sessions.values()) router.addSession(info);
      for (const [call, pending] of this.#calls)
        this.#routeLocal(router, call, this.#again(pending), pending.signal);
    } else {
      const { ws } = current;
      ws.on("message", (data) => {
        const message = readPeer(toPeer, textOf(data));
        if (!message) return;
        const pending = this.#calls.get(message.call);
        if (!pending) return;
        this.#calls.delete(message.call);
        pending.resolve(message.answer as CallAnswer);
      });
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        if (this.#current?.kind === "peer" && this.#current.ws === ws) this.#current = undefined;
        if (!this.#closed) void this.#elect().catch(() => {});
      });
      for (const info of this.#sessions.values()) ws.send(JSON.stringify({ t: "session", info }));
      for (const pending of this.#calls.values())
        ws.send(JSON.stringify({ t: "call", request: this.#again(pending) }));
    }
    return current;
  }

  /**
   * A call as it goes to the relay: once it went to one that is gone, it says it comes again, and
   * the page that has no record of it makes no change for it.
   */
  #again(pending: Pending): CallRequest {
    const request = pending.sent ? { ...pending.request, again: true } : pending.request;
    pending.sent = true;
    return request;
  }

  #routeLocal(router: Router, call: string, request: CallRequest, signal?: AbortSignal): void {
    void router
      .call(request, signal)
      .catch((): CallAnswer => ({ kind: "gone" }))
      .then((answer) => {
        const pending = this.#calls.get(call);
        if (!pending) return;
        this.#calls.delete(call);
        pending.resolve(answer);
      });
  }

  session(info: SessionInfo): void {
    this.#sessions.set(info.session, info);
    const current = this.#current;
    if (current?.kind === "relay") current.relay.router.addSession(info);
    else if (current?.kind === "peer") current.ws.send(JSON.stringify({ t: "session", info }));
  }

  end(session: string): void {
    this.#sessions.delete(session);
    const current = this.#current;
    if (current?.kind === "relay") current.relay.router.removeSession(session);
    else if (current?.kind === "peer") current.ws.send(JSON.stringify({ t: "end", session }));
  }

  async call(request: CallRequest, signal?: AbortSignal): Promise<CallAnswer> {
    let pending: Pending | undefined;
    const answer = new Promise<CallAnswer>((resolve) => {
      pending = { request, resolve, signal, sent: false };
      this.#calls.set(request.call, pending);
    });
    signal?.addEventListener(
      "abort",
      () => {
        const current = this.#current;
        if (current?.kind === "peer")
          current.ws.send(JSON.stringify({ t: "cancel", call: request.call }));
      },
      { once: true },
    );
    const current = this.#current;
    if (current?.kind === "relay" && pending) {
      this.#routeLocal(current.relay.router, request.call, this.#again(pending), signal);
    } else if (current?.kind === "peer" && pending) {
      current.ws.send(JSON.stringify({ t: "call", request: this.#again(pending) }));
    } else {
      // `#became` sends it, once there is a relay.
      void this.#elect().catch(() => {
        this.#calls.get(request.call)?.resolve({ kind: "gone" });
        this.#calls.delete(request.call);
      });
    }
    return answer;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const current = this.#current;
    this.#current = undefined;
    for (const { resolve } of this.#calls.values()) resolve({ kind: "gone" });
    this.#calls.clear();
    if (current?.kind === "relay") await current.relay.close();
    else current?.ws.close();
  }
}
