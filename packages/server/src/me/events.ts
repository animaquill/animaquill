import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { AccessGate } from "../access.ts";
import type { Accounts } from "../auth/accounts.ts";
import { Limits } from "../auth/limits.ts";
import { signedInWith } from "../auth/signed-in.ts";
import type { Db, Executor, Logger } from "../database.ts";
import { listenToChannel } from "../sync/channel-listener.ts";
import type { SessionCredentials } from "../auth/credentials.ts";

/**
 * What changed of a person's list of projects, said to their pages at once (`GET /api/me/events`,
 * Server-Sent Events): a project renamed, made or taken away, how they organise them (stars,
 * groups, what they opened last). The page reads its list again then; nothing else is in a message,
 * so nothing is said that the list does not say to whoever may read it. Said in the transaction
 * that makes the change (`notifyPerson`, over PostgreSQL's `pg_notify`), so whichever process makes
 * it, every process with pages of the person open tells them, once it is committed. Where this
 * process missed some, as its connection to the database broke for a while, it tells everyone.
 *
 * - `GET /api/me/events`: `text/event-stream`. First `event: ready`, then `data: {"t":"projects"}`
 *   for each change; `event: agents` with what the person's conversations of a project said to each
 *   other (`AgentsSaid` of me/agents.ts, with `p` the project, or `{"k":"missed"}`); and a comment every `HEARTBEAT_MS`, which keeps gateways and browsers from
 *   taking it for gone; the session is looked at again each time, and the stream ends where it is
 *   not signed in any more, and after `STREAM_MS` in any case: the browser comes again by itself
 *   (`retry`). `PER_PERSON` at most of a person at once: 429 `busy` for one more. 401 `signedOut`;
 *   403 `forbidden` for a page of another site. Only for the person's own pages.
 */

export const PERSON_CHANNEL = "person_projects";

/** How often a stream says something, at the least. */
export const HEARTBEAT_MS = 25_000;
/** How long a stream lasts at most: then the browser comes again. */
export const STREAM_MS = 30 * 60_000;
/** Streams of one person at once, at most: a few windows on a few computers. */
export const PER_PERSON = 16;
/** How long a browser waits before it comes again, as the stream tells it. */
const RETRY_MS = 3000;

/** Tells the pages of these people that their list changed, once `db`'s transaction commits. */
export const notifyPerson = async (db: Executor, userIds: readonly string[]): Promise<void> => {
  for (const id of new Set(userIds))
    await db.execute(sql`select pg_notify(${PERSON_CHANNEL}, ${id})`);
};

/** A stream of a person: what it says as their list changes, and as their agents say something. */
interface Stream {
  readonly tell: () => void;
  readonly agents: ((data: string) => void) | undefined;
}

/** The streams this process has open, by person. */
export class PersonEvents {
  readonly #streams = new Map<string, Set<Stream>>();
  readonly #ends = new Set<() => void>();
  readonly #perPerson: number;
  /** How often a stream says something, and how long it lasts: `HEARTBEAT_MS` and `STREAM_MS`. */
  readonly heartbeatMs: number;
  readonly streamMs: number;

  constructor(
    options: {
      readonly perPerson?: number;
      readonly heartbeatMs?: number;
      readonly streamMs?: number;
    } = {},
  ) {
    this.#perPerson = options.perPerson ?? PER_PERSON;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.streamMs = options.streamMs ?? STREAM_MS;
  }

  /**
   * Adds a stream of `userId`, which `tell` tells and `end` ends, and `agents` tells what their
   * conversations say to each other (me/agents.ts, `AgentsSaid` as JSON); undefined where they have
   * as many as they may already. Returns how to take it away.
   */
  add(
    userId: string,
    tell: () => void,
    end: () => void,
    agents?: (data: string) => void,
  ): (() => void) | undefined {
    const streams = this.#streams.get(userId) ?? new Set();
    if (streams.size >= this.#perPerson) return undefined;
    const stream: Stream = { tell, agents };
    streams.add(stream);
    this.#streams.set(userId, streams);
    this.#ends.add(end);
    return () => {
      this.#ends.delete(end);
      streams.delete(stream);
      if (streams.size === 0 && this.#streams.get(userId) === streams) this.#streams.delete(userId);
    };
  }

  /** Ends every stream, as the server stops: the browsers come again to another. */
  close(): void {
    for (const end of Array.from(this.#ends)) end();
  }

  /** The list of `userId` changed. */
  heard(userId: string): void {
    for (const stream of this.#streams.get(userId) ?? []) stream.tell();
  }

  /** Something may have changed for anyone: everyone reads their list again. */
  missed(): void {
    for (const streams of this.#streams.values()) for (const stream of streams) stream.tell();
  }

  /** The conversations of `userId` said something to each other, see me/agents.ts. */
  agents(userId: string, data: string): void {
    for (const stream of this.#streams.get(userId) ?? []) stream.agents?.(data);
  }

  /** Something may have been said for anyone: every page asks again what there is for it. */
  agentsMissed(): void {
    for (const streams of this.#streams.values())
      for (const stream of streams) stream.agents?.(MISSED);
  }

  /** How many streams are open, of everyone. */
  get size(): number {
    let size = 0;
    for (const streams of this.#streams.values()) size += streams.size;
    return size;
  }
}

/** What a stream says of agents where something may have been missed: `{"k":"missed"}`. */
const MISSED = JSON.stringify({ k: "missed" });

/** Hears what any process says on `PERSON_CHANNEL`, see `listenToChannel`. Resolves to what stops it. */
export const listenForPeople = (
  db: Db,
  events: PersonEvents,
  log: Logger,
  options: { readonly retryMs?: number; readonly heartbeatMs?: number } = {},
) =>
  listenToChannel(
    db,
    PERSON_CHANNEL,
    { heard: (userId) => events.heard(userId), missed: async () => events.missed() },
    log,
    options,
  );

export interface PersonEventsRoutesOptions {
  readonly events: PersonEvents;
  readonly accounts: () => Accounts | undefined;
  /** How the browser shows its session, see auth/credentials.ts. */
  readonly credentials: SessionCredentials;
  readonly db: () => Db | undefined;
  readonly gate?: AccessGate | undefined;
  /** Only tests: the time of the limits. */
  readonly now?: (() => number) | undefined;
}

export async function personEventsRoutes(
  app: FastifyInstance,
  options: PersonEventsRoutesOptions,
): Promise<void> {
  const { events, accounts, db } = options;
  const now = options.now ?? Date.now;
  const { heartbeatMs, streamMs } = events;
  const signedIn = signedInWith(
    options.credentials,
    accounts,
    () => db() !== undefined,
    options.gate,
  );
  // A stream is one request each half hour, and again where the network went: a few per minute.
  const limits = new Limits({ perClient: 120, perOwn: 60, ceiling: 3000 }, 10 * 60_000, now);
  app.addHook("onClose", async () => events.close());

  app.get(
    "/api/me/events",
    { config: { access: { none: "what changed of the person's own list, of no project" } } },
    async (request, reply) => {
      // Pages of this site only: browsers say where a request comes from.
      const site = request.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin")
        return reply.code(403).send({ error: "forbidden" });
      const user = await signedIn(request, reply, limits);
      if (!user) return reply;
      const session = options.credentials.sessionOf(request) as string;
      const raw = reply.raw;
      let ended = false;
      const send = (text: string) => {
        if (!ended && !raw.destroyed) raw.write(text);
      };
      const stop = events.add(
        user.userId,
        () => send(`data: {"t":"projects"}\n\n`),
        () => end(),
        // Named, so that pages from before, which hear only what is not, hear none of it.
        (data) => send(`event: agents\ndata: ${data}\n\n`),
      );
      if (!stop) return reply.code(429).header("retry-after", "60").send({ error: "busy" });
      reply.hijack();
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        // Not held back by a gateway that would gather the response first.
        "x-accel-buffering": "no",
        connection: "keep-alive",
      });
      send(`retry: ${RETRY_MS}\nevent: ready\ndata: {}\n\n`);
      function end() {
        if (ended) return;
        ended = true;
        stop?.();
        clearInterval(beat);
        clearTimeout(last);
        if (!raw.destroyed) raw.end();
      }
      // Said now and then, and the session looked at again: one signed out hears no more.
      const beat = setInterval(() => {
        void (async () => {
          const still = await accounts()
            ?.session(session)
            .catch(() => undefined);
          if (!still || still.userId !== user.userId) return end();
          send(`: \n\n`);
        })();
      }, heartbeatMs);
      beat.unref?.();
      const last = setTimeout(end, streamMs);
      last.unref?.();
      raw.on("close", end);
      request.raw.on("close", end);
      return reply;
    },
  );
}
