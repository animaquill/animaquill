import type { AccessGate } from "../access.ts";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Accounts, SignedIn } from "../auth/accounts.ts";
import { ourValue, readCookies, SESSION_COOKIE } from "../auth/cookies.ts";
import { fromThisSite } from "../auth/guard.ts";
import { clientOf, Limits } from "../auth/limits.ts";
import { describeError } from "../database.ts";
import { hashOf } from "../seal.ts";
import { UploadRefused, type LfsUploads, type UploadAnswer } from "./uploads.ts";

/**
 * Sending files into the large file storage of a project's repository, for the editor, see
 * `LfsAccess` of its host:
 *
 * - `POST /api/projects/:id/lfs/objects` with `{oid, size}`: "present", the upload on its way, or a
 *   new one (201). The answer says how large pieces may be: `minChunk` to `chunk` bytes.
 * - `PUT /api/lfs/uploads/:id`, a piece of the file (application/octet-stream) at `Upload-Offset`.
 *   The gateway takes 9 MB for these, 1 MB for the rest of /api. The last piece is answered like
 *   the others, "receiving" with all of the file received: the platform reads the file through for
 *   its hash after that, and `GET` says how it went.
 * - `GET /api/lfs/uploads/:id`, and `DELETE` to give it up.
 *
 * Answers are the upload as it is; errors `{error: <code>}`: tooLarge, busy (with Retry-After),
 * notLinked, unsupported (the repository is one of the server's own, which has no large file
 * storage yet), gone, githubQuota, offset (with `received`), slow, notFound, invalid, unavailable,
 * signedOut, forbidden. A file that is not what it was said to be fails as an upload
 * (`error: "changed"`). Only the person whose project it is, and what changes something only from
 * pages of this site.
 *
 * A piece is in memory from its first byte until it is on the disk, so only so many are taken at
 * once, of everybody and of one person, and only from someone who is signed in: who it is is asked
 * before a byte of the piece is read, and before it takes a place. A place is let go once the
 * answer is out or the connection is gone, whichever comes first, however the request ends. And a
 * piece has to keep coming: one that comes slower than `PIECE_PACE` is turned away ("slow", 408),
 * so that a line that went dead does not hold a place for the minute the API gives a request. A
 * slow line sends smaller pieces: `minChunk` gets through at 5 KiB a second.
 */

export interface LfsRoutesOptions {
  /** The check of the routes that name a project, see access.ts. */
  readonly gate: AccessGate;
  readonly origin: string;
  /** Undefined while nobody can sign in, or the database is not there yet. */
  readonly accounts: () => Accounts | undefined;
  /** Undefined where uploads are off: no staging folder, or no GitHub App. */
  readonly uploads: () => LfsUploads | undefined;
  readonly now?: () => number;
  /** Pieces that the API holds in memory at the same time at most, of everybody. */
  readonly piecesAtOnce?: number;
  /** And of one person: a few windows that each send a file. */
  readonly piecesPerPerson?: number;
  /** How fast a piece has to come, see `PIECE_PACE`. */
  readonly pace?: Partial<PiecePace>;
  /**
   * For tests: hears how many places for pieces are taken, each time that changes, and each time
   * the routes are done asking who sends a piece (`asked`), whatever came of it.
   */
  readonly watch?: {
    readonly places?: (taken: number) => void;
    readonly asked?: () => void;
    /** Each time how fast a piece comes is looked at. */
    readonly paced?: () => void;
  };
}

/** How fast a piece has to come in. */
export interface PiecePace {
  /** Bytes a second, on average since it began, */
  readonly bytesPerSecond: number;
  /** after this long to get going: a piece that is all there before that is never too slow. */
  readonly graceMs: number;
  /** How often that is looked at. */
  readonly checkMs: number;
}

/**
 * 16 KiB a second after ten seconds: a line that went dead lets go of its place after ten seconds,
 * not after the minute or more that the API gives a whole request (`requestTimeout` in app.ts,
 * which still holds: 8 MiB take 1.1 Mbit/s up, and a slower line sends smaller pieces).
 */
export const PIECE_PACE: PiecePace = { bytesPerSecond: 16 * 1024, graceMs: 10_000, checkMs: 1000 };

const TEN_MINUTES = 10 * 60_000;
/** With 8 MiB a piece, what the API holds of them at most: the rest come back in a moment. */
const PIECES_AT_ONCE = 12;
const PIECES_PER_PERSON = 3;
/** Seconds after which a piece that found no place comes back. */
const COME_BACK = "2";

type Params = { readonly id: string };

const OID = /^[0-9a-f]{64}$/;
const OFFSET = /^(?:0|[1-9][0-9]{0,15})$/;

/**
 * The places for pieces in memory: so many of everybody's at once, and so many of one person's, so
 * that one account does not take them all.
 */
class Places {
  readonly #most: number;
  readonly #perPerson: number;
  readonly #byPerson = new Map<string, number>();
  readonly #watch: ((taken: number) => void) | undefined;
  #taken = 0;

  constructor(most: number, perPerson: number, watch?: (taken: number) => void) {
    this.#most = most;
    this.#perPerson = perPerson;
    this.#watch = watch;
  }

  /** A place for a piece of this person: let go once, whatever happens. Or who is in the way. */
  take(person: string): { readonly leave: () => void } | "person" | "everyone" {
    const mine = this.#byPerson.get(person) ?? 0;
    if (mine >= this.#perPerson) return "person";
    if (this.#taken >= this.#most) return "everyone";
    this.#taken += 1;
    this.#byPerson.set(person, mine + 1);
    this.#watch?.(this.#taken);
    let left = false;
    return {
      leave: () => {
        if (left) return;
        left = true;
        this.#taken -= 1;
        const still = (this.#byPerson.get(person) ?? 1) - 1;
        if (still > 0) this.#byPerson.set(person, still);
        else this.#byPerson.delete(person);
        this.#watch?.(this.#taken);
      },
    };
  }
}

/** A piece that was not read to its end: too large, too slow, or its connection went. */
class PieceStopped extends Error {
  override name = "PieceStopped";
  readonly why: "tooLarge" | "slow" | "gone";
  constructor(why: "tooLarge" | "slow" | "gone") {
    super(why);
    this.why = why;
  }
}

/**
 * Reads the body of a request as one piece, of `most` bytes at most, that comes no slower than
 * `pace`. Rejects with `PieceStopped`, and reads no more of it then.
 */
const readPiece = (
  raw: IncomingMessage,
  most: number,
  pace: PiecePace,
  now: () => number,
  paced?: () => void,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    let over = false;
    const started = now();
    const end = (stopped?: PieceStopped) => {
      if (over) return;
      over = true;
      clearInterval(watching);
      raw.off("data", onData).off("end", onEnd).off("error", onGone);
      raw.off("aborted", onGone).off("close", onGone);
      if (!stopped) return resolve(Buffer.concat(parts, bytes));
      raw.pause();
      reject(stopped);
    };
    const onData = (part: Buffer) => {
      bytes += part.length;
      if (bytes > most) return end(new PieceStopped("tooLarge"));
      parts.push(part);
    };
    const onEnd = () => end();
    const onGone = () => end(new PieceStopped("gone"));
    const watching = setInterval(() => {
      const due = ((now() - started - pace.graceMs) / 1000) * pace.bytesPerSecond;
      if (bytes < due) end(new PieceStopped("slow"));
      paced?.();
    }, pace.checkMs);
    raw.on("data", onData).on("end", onEnd).on("error", onGone);
    raw.on("aborted", onGone).on("close", onGone);
  });

/** Whoever asked is not there any more to take an answer. */
const isGone = (request: FastifyRequest, reply: FastifyReply) =>
  reply.raw.destroyed || request.raw.socket?.destroyed === true;

/** A piece that has a place: whose it is, and when what holds it in memory began and ended. */
interface Held {
  readonly user: SignedIn;
  readonly work: LfsUploads;
  readonly begin: () => void;
  readonly end: () => void;
}

export const lfsRoutes = async (app: FastifyInstance, options: LfsRoutesOptions) => {
  const { accounts, uploads } = options;
  const now = options.now ?? Date.now;
  const guard = fromThisSite(options.origin);
  const limits = {
    begin: new Limits({ perClient: 300, perOwn: 150, ceiling: 3000 }, TEN_MINUTES, now),
    // 2 GB is 256 pieces of the largest size: a few files of that, and then some. A line that
    // sends the smallest pieces is no faster than a few of them a second.
    piece: new Limits({ perClient: 3000, perOwn: 3000, ceiling: 30_000 }, TEN_MINUTES, now),
    read: new Limits({ perClient: 1200, perOwn: 600, ceiling: 12_000 }, TEN_MINUTES, now),
  };
  const places = new Places(
    options.piecesAtOnce ?? PIECES_AT_ONCE,
    options.piecesPerPerson ?? PIECES_PER_PERSON,
    options.watch?.places,
  );
  const pace: PiecePace = { ...PIECE_PACE, ...options.pace };
  /** The pieces that have a place, by their requests. */
  const holding = new WeakMap<FastifyRequest, Held>();

  // What goes wrong is said with the codes of these routes, not Fastify's own ("Bad Request").
  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: describeError(error) }, "failed");
      return reply.code(503).send({ error: "unavailable" });
    }
    if (status === 413) return reply.code(413).send({ error: "tooLarge" });
    return reply.code(status).send({ error: "invalid" });
  });

  // A small body of JSON to start. The pieces of a file are not read here: the route reads them
  // itself, once it knows who sends them and has a place for them, see `readPiece`.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 4096 },
    (_request, body, done) => {
      if (typeof body !== "string" || body.trim() === "") return done(null, undefined);
      try {
        done(null, JSON.parse(body));
      } catch {
        done(Object.assign(new Error("the body is not JSON"), { statusCode: 400 }), undefined);
      }
    },
  );
  app.addContentTypeParser("application/octet-stream", (_request, _payload, done) =>
    done(null, undefined),
  );

  const own = (request: FastifyRequest) => {
    const session = ourValue(readCookies(request.headers.cookie)[SESSION_COOKIE]);
    return session && { session, own: hashOf(session).toString("base64url").slice(0, 22) };
  };

  /** Who is signed in, after the limit of this kind of request; undefined once answered. */
  const signedIn = async (
    request: FastifyRequest,
    reply: FastifyReply,
    limit: Limits,
  ): Promise<{ user: SignedIn; work: LfsUploads } | undefined> => {
    const asked = own(request);
    if (!asked) {
      await reply.code(401).send({ error: "signedOut" });
      return undefined;
    }
    if (!limit.take(clientOf(request.ip), asked.own)) {
      await reply
        .code(429)
        .header("retry-after", String(limit.retryAfter(clientOf(request.ip), asked.own)))
        .send({ error: "busy" });
      return undefined;
    }
    const people = accounts();
    const work = uploads();
    if (!people || !work) {
      await reply.code(503).send({ error: "unavailable" });
      return undefined;
    }
    const user = await people.session(asked.session);
    if (!user) {
      await reply.code(401).send({ error: "signedOut" });
      return undefined;
    }
    if (!(await options.gate(request, reply, user.userId))) return undefined;
    return { user, work };
  };

  /** Runs what a route does, answering what it refuses with its code. */
  const answer = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof UploadRefused)) throw error;
      const { retryAfter, ...extra } = error.extra ?? {};
      if (typeof retryAfter === "number") reply.header("retry-after", String(retryAfter));
      return reply.code(error.status).send({ error: error.code, ...extra });
    }
  };

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/lfs/objects",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.begin);
      if (!who) return reply;
      const body = request.body as { oid?: unknown; size?: unknown } | undefined;
      const { oid, size } = body ?? {};
      if (
        typeof oid !== "string" ||
        !OID.test(oid) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 1
      )
        return reply.code(400).send({ error: "invalid" });
      return answer(reply, async () => {
        const begun = await who.work.begin(who.user, request.params.id, { oid, size });
        return reply.code(begun.fresh ? 201 : 200).send(begun.answer);
      });
    },
  );

  app.put<{ Params: Params }>(
    "/api/lfs/uploads/:id",
    {
      config: {
        access: { none: "an upload of the person's own, which only its project's route began" },
      },
      // Before a byte of the piece is read: from elsewhere, nobody signed in, too many, or no
      // place for it now. Who it is is asked first, so that only someone signed in takes a place.
      onRequest: [
        guard,
        async (request, reply) => {
          if (reply.sent) return;
          const who = await signedIn(request, reply, limits.piece).finally(() =>
            options.watch?.asked?.(),
          );
          if (!who) return;
          // Gone while it was asked who it is: no place, and nobody to answer.
          if (isGone(request, reply)) {
            reply.hijack();
            return;
          }
          const place = places.take(who.user.userId);
          if (typeof place === "string")
            return reply
              .code(place === "person" ? 429 : 503)
              .header("retry-after", COME_BACK)
              .send({ error: "busy" });
          // Let go once the answer is out or the connection is gone, and nothing of the piece
          // is in memory any more: whichever way the request ends, also one that Fastify never
          // hears the end of, as when the browser goes once all of the piece is in.
          let closed = false;
          let busy = false;
          const settle = () => {
            if (closed && !busy) place.leave();
          };
          const onClosed = () => {
            closed = true;
            settle();
          };
          reply.raw.once("finish", onClosed);
          reply.raw.once("close", onClosed);
          holding.set(request, {
            ...who,
            begin: () => {
              busy = true;
            },
            end: () => {
              busy = false;
              settle();
            },
          });
        },
      ],
    },
    async (request, reply) => {
      const held = holding.get(request);
      // Answered before it got a place.
      if (!held) return reply;
      const offset = request.headers["upload-offset"];
      const type = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (typeof offset !== "string" || !OFFSET.test(offset) || type !== "application/octet-stream")
        return reply.code(400).send({ error: "invalid" });
      const most = held.work.chunkBytes;
      const length = request.headers["content-length"];
      if (length !== undefined && !(Number(length) <= most))
        return reply.code(413).send({ error: "tooLarge" });
      // Where the piece cannot go, it is said before a byte of it is read: no upload of this
      // person's, one that is over, or a piece that does not go where it got. What is left of the
      // piece is not read, and its connection goes with the answer.
      let over: UploadAnswer | undefined;
      try {
        over = await held.work.expecting(
          held.user,
          request.params.id,
          Number(offset),
          length === undefined ? undefined : Number(length),
        );
      } catch (error) {
        held.end();
        reply.header("connection", "close");
        if (error instanceof UploadRefused) return answer(reply, () => Promise.reject(error));
        throw error;
      }
      if (over) {
        held.end();
        return reply
          .header("connection", "close")
          .header("upload-offset", String(over.received))
          .send(over);
      }
      held.begin();
      try {
        let piece: Buffer;
        try {
          piece = await readPiece(request.raw, most, pace, now, options.watch?.paced);
        } catch (error) {
          if (!(error instanceof PieceStopped)) throw error;
          // Nobody to answer.
          if (error.why === "gone") return reply.hijack();
          // What is left of the piece is not read: its connection goes with the answer.
          reply.header("connection", "close");
          return error.why === "slow"
            ? reply.code(408).send({ error: "slow" })
            : reply.code(413).send({ error: "tooLarge" });
        }
        return await answer(reply, async () => {
          const state = await held.work
            .send(held.user, request.params.id, Number(offset), piece)
            // On the disk, or not taken: either way no longer in memory, whatever becomes of
            // the answer.
            .finally(held.end);
          return reply.header("upload-offset", String(state.received)).send(state);
        });
      } finally {
        held.end();
      }
    },
  );

  app.get<{ Params: Params }>(
    "/api/lfs/uploads/:id",
    { config: { access: { none: "an upload of the person's own" } } },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.read);
      if (!who) return reply;
      return answer(reply, async () => {
        const state = await who.work.state(who.user, request.params.id);
        return reply.header("upload-offset", String(state.received)).send(state);
      });
    },
  );

  app.delete<{ Params: Params }>(
    "/api/lfs/uploads/:id",
    { config: { access: { none: "an upload of the person's own" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.begin);
      if (!who) return reply;
      return answer(reply, async () => {
        await who.work.cancel(who.user, request.params.id);
        return reply.code(204).send();
      });
    },
  );
};
