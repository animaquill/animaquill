import { OWNER_ONLY, type AccessGate, type AccessPolicy } from "../access.ts";
import type { FastifyInstance } from "fastify";
import { AI_SYNC_BYTES } from "@animaquill/host/ai-sync";
import type { Accounts } from "../auth/accounts.ts";
import { fromThisSite } from "../auth/guard.ts";
import { Limits, RateLimit } from "../auth/limits.ts";
import { signedInWith } from "../auth/signed-in.ts";
import { describeError, type Db } from "../database.ts";
import type { LibraryMode } from "../library/config.ts";
import { usageOf, NO_USAGE } from "../library/usage.ts";
import { NO_LIMITS, type PersonLimits } from "../limits.ts";
import type { Sealer } from "../seal.ts";
import { changeLfs, lfsChangesOf, readLfs } from "./lfs.ts";
import { imageStartOf, isImageHash, type ChatImages } from "./chat-images.ts";
import { PLATFORM_ID } from "../sync/hub.ts";
import { aiChangesOf, applyAiSync, readAiSync } from "./ai-sync.ts";
import {
  CHAT_BYTES,
  CHAT_ID,
  chatWriteOf,
  listChats,
  loadChat,
  removeChat,
  saveChat,
} from "./chats.ts";
import { editorAtLeast } from "../sync/hub.ts";

/**
 * What goes with the account of whoever is signed in, for the editor: their AI settings and keys,
 * and their conversations about projects of theirs.
 *
 * - `GET /api/me/ai-settings[?since=<revision>]`: `{now, account, revision, format, entries,
 *   keys}`, see me/ai-sync.ts: entries `{<name>: {at, value} | {at, deleted: true}}`, keys
 *   `{<service>: {at, secret, key?} | {at, deleted: true}}` (what is secret of each service:
 *   `{key?, baseUrl?, headers?, models?}`; `key` again for editors of before), times in
 *   milliseconds by the platform's clock, which `now` says. They are opened for the person they are
 *   of only. With `since`, and nothing changed since: `{now, account, revision, unchanged: true}`.
 *   Never kept on the way. The online mode of the editor has them here only, see me/ai-sync.ts.
 * - `POST /api/me/ai-settings` `{now, account, format, entries?, keys?}`: changes, each entry
 *   `{name, at, value}` or `{name, at, deleted: true}`, each key `{service, at, secret}` (or
 *   `{service, at, key}` of editors of before) or `{service, at, deleted: true}`, by the editor's
 *   clock, which `now` says as it sends them. 200
 *   `{now, refused, tooLarge, state}`: the names of the entries (`key:<service>` of keys) not
 *   taken, as not made as they should be (`refused`), or as the entries would be larger than
 *   `AI_SYNC_BYTES` with them (`tooLarge`; keys and what takes something away always go); and
 *   everything as `GET` says it. 409 `{error: "otherAccount"}` where the session
 *   is of somebody else than `account`: nothing is kept; 409 `{error: "newer"}` where a newer
 *   editor wrote them (`format`). Only from pages of this site.
 * - `GET /api/me/chats?project=`: `{chats: [{revision, summary}]}` of a project of the person's,
 *   written last first; 404 `notFound` for another.
 * - `GET /api/me/chats/:project/:id`: `{revision, chat}`; 404 `notFound`.
 * - `PUT /api/me/chats/:project/:id` `{base, chat}` (header `x-animaquill-editor`: the version of
 *   the page; one older than `oldestEditor`, or none, gets 409 `outdated`): writes the conversation
 *   over the revision it
 *   was read at (`base`, null for a new one). 200 `{revision}`; 409 `{error: "newer", revision}`
 *   where another device wrote it since; 404 `notFound` for a project that is not the person's; 413
 *   `tooLarge` beyond `CHAT_BYTES`, or beyond `CHAT_BYTES_PER_USER` of all the person's. Fields of
 *   the summary larger than `SUMMARY_FIELD_BYTES` go with the rest, not into the list. Only from pages of this site.
 * - `DELETE /api/me/chats/:project/:id`: 204, also where there was none. Only from pages of this
 *   site.
 * - The pictures of the conversations (me/chat-images.ts), each by the SHA-256 of its bytes in
 *   hexadecimal, of the person only: `POST /api/me/chat-images` `{hash, bytes, type}`: 200 `{have:
 *   true}` where the platform has it, else `{upload: {method, url, headers}}`, an address of the
 *   storage to PUT exactly these bytes at, for ten minutes; 413 `{error: "full", used, limit}`
 *   where the person's room for pictures has no room for it, 413 `tooLarge` beyond 2 MB; 503
 *   `unavailable` where pictures cannot go up now. Then `POST /api/me/chat-images/:hash/done`: 200
 *   `{state: "ready"}` once the platform read it back and it is what was said; 422 `mismatch`
 *   where it was not, and it is gone; 409 `notUploaded` where nothing is there yet; 404 where it
 *   was never begun. `GET /api/me/chat-images/:hash`: `{url, type}`, an address to read it at, for
 *   five minutes; 404 `notFound` for one the person does not have. `GET /api/me/chat-images`:
 *   `{used, limit, chats: [{project, projectName, chat, title, images, bytes}]}`, the room their
 *   pictures take and which conversations have them.
 * - Writing a conversation that names pictures the platform does not have (and that do not say
 *   they stayed on their device, `held`) is 409 `{error: "missingImages", images: [hash]}`; one with
 *   more than 100 is 413 `tooManyImages`.
 * - The online mode of the editor has all of it here only: the platform takes nothing away unless
 *   people take it away themselves.
 * - `GET /api/me/storage`: `{mode, limit, used}`, the person's cloud space for the settings: `mode`
 *   whether the platform keeps files at all now (`on`, `readonly`, `off`, see library/config.ts),
 *   `limit` the bytes they may keep there (`cloudSpace` of limits.ts; null for no limit), `used`
 *   the bytes kept and on their way.
 * - `GET /api/me/lfs`: `{account, acknowledgedAt?, repositories}`, what the person has in the large
 *   file storage of GitHub through the platform (me/lfs.ts): `repositories` `[{repo, fullName, url,
 *   project: {id, name}, files, bytes}]`, the largest first; `acknowledgedAt` when they first said
 *   they know what putting files there means.
 * - `POST /api/me/lfs` `{account, acknowledged?: true}`: says so. 200 as `GET`; 409
 *   `otherAccount`. `auto` of pages from before 0.3.120 is left out. Only from pages of this site.
 *
 * Other errors are `{error}` too: signedOut (401), forbidden (403), invalid (400), busy (429, with
 * Retry-After), unavailable (503). Nothing of what is asked or answered is ever logged.
 */

export interface MeRoutesOptions {
  /** The check of the routes that name a project, see access.ts. */
  readonly gate: AccessGate;
  /** Who may do what with which project, see access.ts: only the owner unless said. */
  readonly access?: AccessPolicy | undefined;
  readonly origin: string;
  readonly accounts: () => Accounts | undefined;
  readonly db: () => Db | undefined;
  /** Seals the keys; undefined without a master key: keys and settings are unavailable then. */
  readonly sealer: Sealer | undefined;
  readonly now?: (() => number) | undefined;
  /** Whether the cloud space keeps files now; "off" unless said. */
  readonly libraryMode?: (() => LibraryMode) | undefined;
  /** The pictures of conversations; undefined where there is no storage for them. */
  readonly chatImages?: (() => ChatImages | undefined) | undefined;
  /**
   * The oldest editor that may write conversations, as the hub syncs with (`OLDEST_EDITOR`): an
   * older page would write back without what it cannot read, such as the summaries of 0.3.82.
   * Undefined: every editor, as in the tests.
   */
  readonly oldestEditor?: string | undefined;
  /** How much each person may have, see limits.ts: nothing is limited unless said. */
  readonly limits?: PersonLimits | undefined;
}

/** The header a page of the editor says its version in, with the conversations it writes. */
export const EDITOR_HEADER = "x-animaquill-editor";

const TEN_MINUTES = 10 * 60_000;
/** Bytes of a request with changes at most: every entry and key there can be, and some. */
const CHANGES_BYTES = AI_SYNC_BYTES + 512 * 1024;
/** Changes of AI settings of a person in ten minutes: a device gives one a second at the most. */
export const AI_CHANGES = 600;

type ChatParams = { readonly project: string; readonly id: string };

export const meRoutes = async (app: FastifyInstance, options: MeRoutesOptions) => {
  const { db, sealer } = options;
  const now = options.now ?? Date.now;
  const guard = fromThisSite(options.origin);
  const signedIn = signedInWith(
    options.accounts,
    () => db() !== undefined && sealer !== undefined,
    options.gate,
  );
  const limits = {
    /** Read as a page opens, as it comes back, and every two minutes, of each browser. */
    read: new Limits({ perClient: 600, perOwn: 300, ceiling: 6000 }, TEN_MINUTES, now),
    change: new Limits({ perClient: 300, perOwn: 150, ceiling: 3000 }, TEN_MINUTES, now),
    /** What the account page reads: the cloud space, the large file storage. */
    cloud: new Limits({ perClient: 600, perOwn: 300, ceiling: 6000 }, TEN_MINUTES, now),
    /** Conversations, written a second after each turn. */
    chats: new Limits({ perClient: 1200, perOwn: 600, ceiling: 12000 }, TEN_MINUTES, now),
    /** Pictures: up to three requests each, as a conversation of 100 of them goes. */
    images: new Limits({ perClient: 3000, perOwn: 1500, ceiling: 30000 }, TEN_MINUTES, now),
  };
  const aiChanges = new RateLimit(AI_CHANGES, TEN_MINUTES, now);
  const signedInHere = signedInWith(options.accounts, () => db() !== undefined, options.gate);

  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      // What the error is, never what was asked: that can be a key.
      request.log.error({ err: describeError(error) }, "failed");
      return reply.code(503).send({ error: "unavailable" });
    }
    if (status === 413) return reply.code(413).send({ error: "tooLarge" });
    if (status === 415) return reply.code(415).send({ error: "unsupported" });
    return reply.code(status).send({ error: "invalid" });
  });
  const log = (what: string) => app.log.warn({ what }, "an AI key could not be opened");

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/me/ai-settings",
    { config: { access: { none: "what is the person's own, of no project" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.read);
      const database = db();
      if (!user || !database || !sealer) return reply;
      const { since } = request.query;
      if (since !== undefined && (typeof since !== "string" || !/^(0|[1-9]\d{0,15})$/.test(since)))
        return reply.code(400).send({ error: "invalid" });
      const state = await readAiSync(
        database,
        sealer,
        user.userId,
        since === undefined ? undefined : Number(since),
        log,
      );
      reply.header("cache-control", "no-store");
      return { now: now(), account: user.userId, ...state };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/me/ai-settings",
    {
      config: { access: { none: "what is the person's own, of no project" } },
      preHandler: guard,
      bodyLimit: CHANGES_BYTES,
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.change);
      const database = db();
      if (!user || !database || !sealer) return reply;
      const changes = aiChangesOf(request.body);
      if (!changes) return reply.code(400).send({ error: "invalid" });
      if (changes.account !== user.userId) return reply.code(409).send({ error: "otherAccount" });
      const count = Math.max(1, changes.entries.length + changes.keys.length);
      if (!aiChanges.take(user.userId, count))
        return reply
          .code(429)
          .header("retry-after", String(aiChanges.retryAfter(user.userId)))
          .send({ error: "busy" });
      const at = now();
      const outcome = await applyAiSync(database, sealer, user.userId, changes, at, log);
      if (outcome === "newer") return reply.code(409).send({ error: "newer" });
      reply.header("cache-control", "no-store");
      return {
        now: at,
        refused: outcome.refused,
        tooLarge: outcome.tooLarge,
        state: outcome.state,
      };
    },
  );

  app.get(
    "/api/me/storage",
    { config: { access: { none: "what is the person's own, of no project" } } },
    async (request, reply) => {
      const user = await signedInHere(request, reply, limits.cloud);
      const database = db();
      if (!user || !database) return reply;
      const limit = await (options.limits ?? NO_LIMITS).of(database, user.userId, "cloudSpace");
      const usage = (await usageOf(database, [user.userId])).get(user.userId) ?? NO_USAGE;
      reply.header("cache-control", "no-store");
      return {
        mode: options.libraryMode?.() ?? "off",
        // Null: no limit.
        limit,
        used: usage.used + usage.uploading,
      };
    },
  );

  app.get(
    "/api/me/lfs",
    {
      config: {
        access: {
          inside: "list",
          why: "the large file storage of the projects the person may read",
        },
      },
    },
    async (request, reply) => {
      const user = await signedInHere(request, reply, limits.cloud);
      const database = db();
      if (!user || !database) return reply;
      const found = await readLfs(database, user.userId, options.access ?? OWNER_ONLY);
      reply.header("cache-control", "no-store");
      return { account: user.userId, ...found };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/me/lfs",
    {
      config: { access: { none: "what is the person's own, of no project" } },
      preHandler: guard,
      bodyLimit: 4096,
    },
    async (request, reply) => {
      const user = await signedInHere(request, reply, limits.cloud);
      const database = db();
      if (!user || !database) return reply;
      const changes = lfsChangesOf(request.body);
      if (!changes) return reply.code(400).send({ error: "invalid" });
      if (changes.account !== user.userId) return reply.code(409).send({ error: "otherAccount" });
      const found = await changeLfs(database, user.userId, changes, now());
      reply.header("cache-control", "no-store");
      return { account: user.userId, ...found };
    },
  );

  const chatOf = (params: ChatParams) =>
    PLATFORM_ID.test(params.project) && CHAT_ID.test(params.id);

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/me/chats",
    { config: { access: { project: "project", action: "read", from: "query" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.chats);
      const database = db();
      if (!user || !database) return reply;
      const { project } = request.query;
      if (typeof project !== "string" || !PLATFORM_ID.test(project))
        return reply.code(404).send({ error: "notFound" });
      const chats = await listChats(database, user.userId, project);
      if (!chats) return reply.code(404).send({ error: "notFound" });
      reply.header("cache-control", "no-store");
      return { chats };
    },
  );

  app.get<{ Params: ChatParams }>(
    "/api/me/chats/:project/:id",
    { config: { access: { project: "project", action: "read" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.chats);
      const database = db();
      if (!user || !database) return reply;
      if (!chatOf(request.params)) return reply.code(404).send({ error: "notFound" });
      const found = await loadChat(
        database,
        user.userId,
        request.params.project,
        request.params.id,
      );
      if (!found) return reply.code(404).send({ error: "notFound" });
      reply.header("cache-control", "no-store");
      return found;
    },
  );

  app.put<{ Params: ChatParams; Body: unknown }>(
    "/api/me/chats/:project/:id",
    {
      config: { access: { project: "project", action: "read" } },
      preHandler: guard,
      bodyLimit: CHAT_BYTES + 64 * 1024,
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.chats);
      const database = db();
      if (!user || !database) return reply;
      if (!chatOf(request.params)) return reply.code(404).send({ error: "notFound" });
      // Too old a page would lose what newer pages wrote: it reloads first.
      const editor = request.headers[EDITOR_HEADER];
      if (
        options.oldestEditor !== undefined &&
        !editorAtLeast(typeof editor === "string" ? editor : "", options.oldestEditor)
      )
        return reply.code(409).send({ error: "outdated" });
      const write = chatWriteOf(request.body, request.params.id);
      if (!write) return reply.code(400).send({ error: "invalid" });
      if (write.size > CHAT_BYTES) return reply.code(413).send({ error: "tooLarge" });
      const outcome = await saveChat(
        database,
        user.userId,
        request.params.project,
        request.params.id,
        write,
        now(),
      );
      if (outcome === "missing") return reply.code(404).send({ error: "notFound" });
      if (outcome === "tooLarge") return reply.code(413).send({ error: "tooLarge" });
      if (outcome === "tooManyImages") return reply.code(413).send({ error: "tooManyImages" });
      if ("missingImages" in outcome)
        return reply.code(409).send({ error: "missingImages", images: outcome.missingImages });
      if ("newer" in outcome)
        return reply.code(409).send({ error: "newer", revision: outcome.newer });
      return outcome;
    },
  );

  app.delete<{ Params: ChatParams }>(
    "/api/me/chats/:project/:id",
    {
      config: {
        access: {
          none: "taking away a conversation of the person's own, whatever became of the project",
        },
      },
      preHandler: guard,
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.chats);
      const database = db();
      if (!user || !database) return reply;
      if (!chatOf(request.params)) return reply.code(404).send({ error: "notFound" });
      await removeChat(database, user.userId, request.params.project, request.params.id, now());
      return reply.code(204).send();
    },
  );

  type ImageParams = { readonly hash: string };

  app.post<{ Body: unknown }>(
    "/api/me/chat-images",
    {
      config: { access: { none: "what is the person's own, of no project" } },
      preHandler: guard,
      bodyLimit: 1024,
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.images);
      const database = db();
      if (!user || !database) return reply;
      const image = imageStartOf(request.body);
      if (!image) return reply.code(400).send({ error: "invalid" });
      const images = options.chatImages?.();
      if (!images) return reply.code(503).send({ error: "unavailable" });
      const outcome = await images.start(user.userId, image);
      if (outcome === "tooLarge") return reply.code(413).send({ error: "tooLarge" });
      if (outcome === "unavailable") return reply.code(503).send({ error: "unavailable" });
      reply.header("cache-control", "no-store");
      if ("full" in outcome) return reply.code(413).send({ error: "full", ...outcome.full });
      return outcome;
    },
  );

  app.post<{ Params: ImageParams }>(
    "/api/me/chat-images/:hash/done",
    { config: { access: { none: "what is the person's own, of no project" } }, preHandler: guard },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.images);
      const database = db();
      if (!user || !database) return reply;
      if (!isImageHash(request.params.hash)) return reply.code(404).send({ error: "notFound" });
      const images = options.chatImages?.();
      if (!images) return reply.code(503).send({ error: "unavailable" });
      const outcome = await images.done(user.userId, request.params.hash);
      if (outcome === "ready") return { state: "ready" };
      if (outcome === "mismatch") return reply.code(422).send({ error: "mismatch" });
      if (outcome === "notUploaded") return reply.code(409).send({ error: "notUploaded" });
      if (outcome === "unavailable") return reply.code(503).send({ error: "unavailable" });
      return reply.code(404).send({ error: "notFound" });
    },
  );

  app.get<{ Params: ImageParams }>(
    "/api/me/chat-images/:hash",
    { config: { access: { none: "what is the person's own, of no project" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.images);
      const database = db();
      if (!user || !database) return reply;
      if (!isImageHash(request.params.hash)) return reply.code(404).send({ error: "notFound" });
      const images = options.chatImages?.();
      if (!images) return reply.code(503).send({ error: "unavailable" });
      const found = await images.read(user.userId, request.params.hash);
      if (found === "unavailable") return reply.code(503).send({ error: "unavailable" });
      if (!found) return reply.code(404).send({ error: "notFound" });
      reply.header("cache-control", "no-store");
      return found;
    },
  );

  app.get(
    "/api/me/chat-images",
    { config: { access: { none: "what is the person's own, of no project" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.chats);
      const database = db();
      if (!user || !database) return reply;
      const images = options.chatImages?.();
      if (!images) return reply.code(503).send({ error: "unavailable" });
      reply.header("cache-control", "no-store");
      return images.usage(user.userId);
    },
  );
};
