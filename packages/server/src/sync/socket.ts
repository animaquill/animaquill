import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { SYNC_CLOSE, SYNC_LIMITS, SYNC_MESSAGE_BYTES } from "@animaquill/host/sync";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { Accounts } from "../auth/accounts.ts";
import type { SessionCredentials } from "../auth/credentials.ts";
import { clientOf, Limits } from "../auth/limits.ts";
import { describeError } from "../database.ts";
import type { TrustedProxies } from "../proxies.ts";
import { hashOf } from "../seal.ts";
import type { SyncHub } from "./hub.ts";

/**
 * The WebSocket of syncing, `/api/sync`, which the gateway sends here like the rest of /api. Only
 * pages of this site get one, signed in: the browser sends the session cookie and the Origin with
 * the request for it, and nothing else can be checked, as a page cannot add a header of its own to
 * it. Then it is the protocol of `SyncHub`.
 *
 * A connection that stops answering is let go: every half a minute the platform pings it, as the
 * WebSocket protocol does, which browsers answer by themselves, see `heartbeat`.
 */

export const SYNC_PATH = "/api/sync";
/** How often a connection is asked whether it is still there. */
const PING_MS = 30_000;
/** How often whoever is on a connection is looked up again: signing out elsewhere ends it. */
const SESSION_MS = 5 * 60_000;
/**
 * A connection that does not take what it is sent is let go before it takes the memory. The hub
 * puts no more into a socket than it takes, see `Outbox`: this is only where that goes wrong.
 */
const MOST_BUFFERED = 2 * SYNC_LIMITS.state;

/** What the heartbeat needs of a WebSocket. */
export interface Pinged {
  readonly bufferedAmount: number;
  ping(): void;
  terminate(): void;
}

/**
 * Lets go of the connections that did not answer since the last time, and asks the others again. One
 * that still takes in what it was sent, however slowly, is there: the answer to the ping waits
 * behind that, and a large project gets through a slow line.
 */
export function heartbeat(
  sockets: Iterable<Pinged>,
  alive: WeakSet<Pinged>,
  left: WeakMap<Pinged, number>,
): void {
  for (const socket of sockets) {
    const now = socket.bufferedAmount;
    const isMoving = now > 0 && now < (left.get(socket) ?? Number.POSITIVE_INFINITY);
    left.set(socket, now > 0 ? now : Number.POSITIVE_INFINITY);
    if (!alive.has(socket) && !isMoving) {
      socket.terminate();
      continue;
    }
    alive.delete(socket);
    socket.ping();
  }
}

export interface SyncSocketOptions {
  readonly origin: string;
  /** Undefined while nobody can sign in, or the database is not there yet. */
  readonly accounts: () => Accounts | undefined;
  /** How the browser shows its session, see auth/credentials.ts. */
  readonly credentials: SessionCredentials;
  readonly hub: () => SyncHub | undefined;
  readonly proxies: TrustedProxies;
  readonly now?: () => number;
}

/** The address of the browser, as the gateway says it where it is the gateway that asks. */
const addressOf = (request: IncomingMessage, proxies: TrustedProxies): string => {
  const peer = request.socket.remoteAddress ?? "";
  const forwarded = request.headers["x-forwarded-for"];
  if (!proxies.trusts(peer) || typeof forwarded !== "string") return peer;
  return forwarded.split(",").at(-1)?.trim() || peer;
};

/** Answers a request for a WebSocket without one. */
const refuse = (socket: Duplex, status: number, text: string) => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

export function syncSocket(app: FastifyInstance, options: SyncSocketOptions): void {
  const { origin, accounts, credentials, hub, proxies } = options;
  const now = options.now ?? Date.now;
  const { socketProtocol } = credentials;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: SYNC_MESSAGE_BYTES,
    perMessageDeflate: false,
    // Only where part of the session comes in Sec-WebSocket-Protocol, see auth/credentials.ts:
    // without, ws would answer with the first the page offers.
    ...(socketProtocol && { handleProtocols: (offered: Set<string>) => socketProtocol(offered) }),
  });
  /** Connections that start, by address, or by session where the address says nothing. */
  const starts = new Limits({ perClient: 120, perOwn: 60, ceiling: 3000 }, 10 * 60_000, now);
  const alive = new WeakSet<Pinged>();
  const left = new WeakMap<Pinged, number>();
  const sockets = new Set<WebSocket>();

  const pinger = setInterval(() => heartbeat(sockets, alive, left), PING_MS);
  pinger.unref?.();

  const accept = (socket: WebSocket, request: IncomingMessage) => {
    sockets.add(socket);
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.terminate());
    return request;
  };

  /** Closes a WebSocket at once, saying why: the editor knows what to do about each. */
  const closeWith = (socket: WebSocket, code: number, reason: string) => {
    socket.close(code, reason);
    setTimeout(() => socket.terminate(), 5000).unref?.();
  };

  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== SYNC_PATH) {
      refuse(socket, 404, "Not Found");
      return;
    }
    if (request.headers.origin !== origin) {
      app.log.warn({ origin: request.headers.origin ?? null }, "a sync connection from elsewhere");
      refuse(socket, 403, "Forbidden");
      return;
    }
    const session = credentials.sessionOf(request);
    const own =
      session === undefined ? undefined : hashOf(session).toString("base64url").slice(0, 22);
    if (!starts.take(clientOf(addressOf(request, proxies)), own)) {
      refuse(socket, 429, "Too Many Requests");
      return;
    }
    const work = accounts();
    const sync = hub();
    let userId: string | undefined;
    try {
      userId = work && session ? (await work.session(session))?.userId : undefined;
    } catch (error) {
      app.log.warn({ err: describeError(error) }, "who is syncing could not be found out");
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      accept(ws, request);
      if (!work || !sync) {
        closeWith(ws, SYNC_CLOSE.unavailable, "not ready");
        return;
      }
      if (!session || !userId) {
        closeWith(ws, SYNC_CLOSE.signedOut, "not signed in");
        return;
      }
      const sessionHash = hashOf(session).toString("base64url");
      const connection = sync.open(
        {
          send: (data) => {
            if (ws.readyState !== ws.OPEN) return;
            if (ws.bufferedAmount > MOST_BUFFERED) {
              closeWith(ws, SYNC_CLOSE.tooMany, "too slow");
              return;
            }
            ws.send(data);
          },
          close: (code, reason) => closeWith(ws, code, reason),
          // Nothing more is read while what came is taken in: the browser waits, not the memory.
          pause: () => ws.pause(),
          resume: () => ws.resume(),
          buffered: () => ws.bufferedAmount,
        },
        { userId, session: sessionHash },
      );
      // Signing out elsewhere, being disabled, or the session running out, ends the connection too.
      const recheck = () =>
        void work.session(session).then(
          (still) => {
            if (!still) closeWith(ws, SYNC_CLOSE.signedOut, "signed out");
          },
          () => {},
        );
      // Once more now: what ended the person's connections a moment ago, after the session was
      // looked up above, did not find this one yet.
      recheck();
      const check = setInterval(recheck, SESSION_MS);
      check.unref?.();
      ws.on("message", (data, isBinary) => {
        alive.add(ws);
        if (!isBinary) {
          closeWith(ws, SYNC_CLOSE.protocol, "binary messages only");
          return;
        }
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        connection.receive(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      });
      ws.on("close", () => {
        clearInterval(check);
        connection.closed();
      });
    });
  };

  app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    upgrade(request, socket, head).catch((error: unknown) => {
      app.log.error({ err: describeError(error) }, "a sync connection failed");
      socket.destroy();
    });
  });

  app.addHook("onClose", async () => {
    clearInterval(pinger);
    hub()?.stop();
    for (const socket of sockets)
      closeWith(socket, SYNC_CLOSE.unavailable, "the platform is stopping");
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
}
