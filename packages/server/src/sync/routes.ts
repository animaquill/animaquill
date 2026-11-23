import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Accounts, SignedIn } from "../auth/accounts.ts";
import { ourValue, readCookies, SESSION_COOKIE } from "../auth/cookies.ts";
import { fromThisSite } from "../auth/guard.ts";
import { clientOf, Limits, RateLimit } from "../auth/limits.ts";
import { describeError, type Db } from "../database.ts";
import type { CoverType } from "../schema.ts";
import { hashOf } from "../seal.ts";
import {
  COVER_BYTES,
  COVER_TYPES,
  coverOf,
  durationOf,
  isPictureOf,
  putCover,
  putDuration,
  removeCover,
} from "./covers.ts";
import { PLATFORM_ID, type RemoveCondition, type SyncHub } from "./hub.ts";
import { OWNER_ONLY, type AccessGate, type AccessPolicy } from "../access.ts";
import { recheckSoon } from "../archive/links.ts";
import { listProjects } from "./list.ts";
import { applyOrganizer, changesOf, readOrganized } from "./organize.ts";
import { wakeCopy } from "./wake.ts";

/**
 * The projects of whoever is signed in, for the editor (the interface of 1A):
 *
 * - `GET /api/projects`: `{projects}`, each a `ProjectSummary` of list.ts, most recently changed
 *   first: what people open one from, with the repository it is saved to and what needs them
 *   (`repository.unusable`, `{reason, since, deleteAt?}`, where it cannot be used: GitHub is asked
 *   about such repositories again soon). It
 *   only reads, so it needs nothing but the session: a page elsewhere cannot read the answer.
 * - `DELETE /api/projects/:id[?archived=<seq>|?discard=1]`: takes a project away for good, see
 *   `SyncHub.remove`; the repository it is saved to stays as it is. 204. One that is saved to a
 *   repository goes only with `archived`, the update the editor saw archived: where the
 *   repository has everything up to the head, that is this update, and archiving goes as it
 *   should (not paused, no archive people asked for still to be done, the last one did not fail);
 *   otherwise 409 `{error: "notArchived", head, archivedSeq, state, reason?, archiving,
 *   failures?}` (`state` "ready" or "paused" with its `reason`, as `GET .../repository` says
 *   them; `archiving`: one people asked for is not done yet): archive, wait, and ask again. Or with
 *   `discard=1`, where people let go of whatever the repository does not have. Without either 409
 *   `{error: "hasRepository"}`, as before; except one whose repository cannot be used (the list
 *   and `GET .../repository` say `unusable`), which goes without either, nothing looked at, as
 *   nothing can be archived. One that
 *   a repository is being linked to says "hasRepository" too. Files still on their way into the
 *   large file storage
 *   keep any project, without `discard`: 409 `{error: "uploading", uploads}`, how many. 404
 *   `{error: "notFound"}` for one that is not there (also one that was taken away before), or not
 *   the person's own; 400 `{error: "invalid"}` for an `archived` that is no number, or a `discard`
 *   that is not 1. Its windows close with `SYNC_CLOSE.deleted`, or `missing` for an editor that
 *   does not know that. Its id is kept: no project is made under it again, whoever asks. So is the
 *   id of one that is not there, which the editor asks to take away when it gives up connecting a
 *   project that may still be on its way.
 * - `PUT /api/projects/:id/cover[?durationMs=][&chosen=1]`, the picture as the body (`image/webp`
 *   or `image/jpeg`, `COVER_BYTES` at most): the project's cover, in place of the one it had, and
 *   how long its main timeline is. With `chosen=1` one people chose themselves; without, one the
 *   editor made, which does not take the place of one people chose: that stays, with the new
 *   duration. 200 `{etag, at, chosen?: true}`, of the cover the project has now. 415 `{error:
 *   "unsupported"}` for another type, 413 `{error: "tooLarge"}`, 400 `{error: "invalid"}` for bytes
 *   that are not a picture of that type, a duration that is none, or a `chosen` that is not 1, 429
 *   `busy` for a second one the editor made of a project within a minute, or more than ten chosen
 *   ones in ten minutes, 404 `notFound`. Only from pages of this site.
 * - `PATCH /api/projects/:id/cover?durationMs=`: how long the main timeline is now, without a
 *   picture, as the editor says it where people chose the cover. 204; 400 `invalid` for a duration
 *   that is none; 404 `notFound` also for a project without a cover; 429 `busy` as for one the
 *   editor made, which it counts as. Only from pages of this site.
 * - `DELETE /api/projects/:id/cover`: takes the cover away, as people go back to the one the
 *   editor makes. 204, also where there was none; 404 `notFound`; 429 `busy` as for chosen ones.
 *   Only from pages of this site.
 * - `POST /api/projects/:id/wake`: the working copy of a project that the platform let go of
 *   (`copy: "released"` in the list) is made again from its repository, by the worker (see
 *   archive/rebuild.ts), as a window that says hello for it does too. 200 `{copy: "live"}` for one
 *   that is here; 202 `{copy: "restoring"}` once it is on its way (also where it was): the list
 *   says when it is "live", or "released" again with `copyProblem` where it could not be made.
 *   409 `{error: "noRepository" | "unusable", copy: "released"}` where it cannot be made: no
 *   repository, or one that cannot be used. 429 `{error: "busy", copyProblem}` with Retry-After
 *   where it failed lately (`copyProblem.retryAt`: a minute and more for GitHub or the platform,
 *   hours for what the repository has). With `{fromBranch: true}`: made from the branch as it is,
 *   not from the last archive, at once, where that last failed for what the repository had
 *   (`copyProblem.code` unreadable, notProject, tooLarge, tooNew), as after people put it right
 *   on GitHub; otherwise 409 `{error: "notAllowed"}`. Such a copy has nothing in common with the
 *   one before (`rebuiltFrom.commonBase: false` in the status). 404 `notFound`. Only from pages of
 *   this site.
 * - `PUT /api/projects/:id/name` `{name}`: renames the project, as people do on the start page without
 *   opening it, see `SyncHub.rename`: the same rename as in the editor, which its windows hear at
 *   once, and which the list says from then on. The name is taken as it is but for the spaces around
 *   it, and has to be something. 200 `{name, batch, seq}` (`batch` takes it back as a whole, see
 *   below), or `{name}` where it is called that already. 400 `{error: "invalid"}` for no name, or
 *   a body that is none; 409 `{error: "locked" | "unusable"}` for a project with locked tags or
 *   whose repository cannot be used; 409 `{error: "waking", copy: "restoring"}` where its working
 *   copy was let go of and is being made again now, as `POST .../wake` does: ask again once the
 *   list says it is "live"; 409 `{error: "noRepository" | ..., copy: "released"}` and 429 `busy` as
 *   `wake` says them where it cannot be made; 413 `{error: "quota"}`; 404 `notFound`. Only for
 *   who may manage the project, and only from pages of this site.
 * - `GET /api/projects/:id/cover`: the picture, with its `ETag` (what the list says), which only the
 *   browser keeps (`private`) and asks about again each time (`If-None-Match`, 304). 404
 *   `notFound` for a project that has none, is not there, or is not the person's.
 *
 * - `GET /api/organizer`: `{now, account, groups, marks}`, how the person organises their projects on the
 *   start page, see sync/organize.ts: each group `{id, name, at, deleted?}`, the marks of each of
 *   their projects `{project, star?: {starred, at}, group?: {id | null, at}}`, times in
 *   milliseconds by the platform's clock, which `now` says.
 * - `POST /api/organizer` `{now, account, groups?, marks?}`: changes of them, `ORGANIZER_BATCH` of
 *   each at most, by the editor's clock, which `now` says as it sends them, of `account`, whom the
 *   page takes to be signed in. 200 `{now, groups, marks, state}`: what came of each, in the same
 *   order ("kept", "older", "missing", "tooMany", "invalid" for a name no group has, `{taken}` for
 *   a group; `{project, missing?, star?, group?}` for marks), and everything as it is then, as
 *   `GET` says it. 409 `{error: "otherAccount"}` where the session is of somebody else than
 *   `account`, as after signing out and in again in another window: nothing is kept. 400 `{error:
 *   "invalid"}` where it is not made as it should be: nothing is kept then. Counted by the changes
 *   in it too: `ORGANIZER_CHANGES` of a person in ten minutes. Only from pages of this site.
 *
 * Batches the platform wrote into a project itself, such as merges from GitHub (the same for what
 * AI writes through the platform later, 6.5), for the project's owner only:
 *
 * - `GET /api/projects/:id/batches/:batch`: `{batch: {id, kind, label, files, at, undone, undoes?,
 *   next?: {batch, direction}, why?}}`, see `BatchState`: what it is, and what taking it back would
 *   do now. `next` is the batch to take back to go the other way from where it is (the batch
 *   itself, or the last that took it back); `why` says why that would not go now: drop, notLatest,
 *   history, undone, count, age, unusable, gone, format, rebuilt, done, changed, inUse, locked,
 *   failed.
 * - `POST /api/projects/:id/batches/:batch/undo`: takes the batch back as a whole, in the project's
 *   turn, see `SyncHub.takeBack`: a merge, or the batch that took one back (it is done again
 *   then), or the one that did it again. What anybody changed since stays. 200 `{batch, seq?,
 *   direction, back, kept, backCount, keptCount, obstacle?, next}`: the batch that took it back,
 *   the update it is (none where nothing changed), the places that went back and those that
 *   stayed (500 of each at most), and what goes the other way again. 409 `{error: "notUndoable",
 *   why}` with the codes of `why` above. Only from pages of this site.
 *
 * 404 `notFound` for a project or a batch that is not there, or not the person's.
 *
 * Other errors are `{error}` too: signedOut (401), forbidden (403), busy (429, with Retry-After),
 * unavailable (503).
 */

export interface ProjectRoutesOptions {
  /** The check of the routes that name a project, see access.ts. */
  readonly gate: AccessGate;
  /** Who may do what with which project, see access.ts: only the owner unless said. */
  readonly access?: AccessPolicy | undefined;
  /** The editor's site: what changes something takes requests from its pages only. */
  readonly origin: string;
  /** Undefined while nobody can sign in, or the database is not there yet. */
  readonly accounts: () => Accounts | undefined;
  readonly db: () => Db | undefined;
  /** The projects as editors are connected to them: taking one away goes through it. */
  readonly hub: () => SyncHub | undefined;
  /** github.com, or a GitHub of a company: where people see a repository. */
  readonly webUrl: string;
  /**
   * Has the repositories of these projects looked at again soon, as nobody did for a day, see
   * `listProjects`. Undefined where projects are not saved to GitHub here.
   */
  readonly lookAgain?: ((projects: readonly string[]) => Promise<void>) | undefined;
  /**
   * Has the worker make the working copy of a project again, see archive/rebuild.ts. Undefined
   * where nothing does: waking a project is unavailable.
   */
  readonly rebuild?: ((projectId: string) => Promise<void>) | undefined;
  /** Only tests: the time of the limits and of what counts as looked at lately. */
  readonly now?: (() => number) | undefined;
  /** Since when such projects are taken away, see `deleteAtOf`: none unless said. */
  readonly deletesFrom?: string | undefined;
}

const TEN_MINUTES = 10 * 60_000;

/** The body of a rename at most: a name, with room to spare. */
export const NAME_BODY_BYTES = 4096;

/**
 * How many changes of how projects are organised a person gives in ten minutes at most: a whole
 * batch of each kind takes the database most of a second, and one person's work is a few at a time.
 * Once, as people sign in first, what a browser kept before goes, as many as they have projects
 * (`projectsPerUser`) and groups (`GROUPS_PER_USER`).
 */
export const ORGANIZER_CHANGES = 3000;

type Params = { readonly id: string };

/** An update of a project, as a query says it: what `head` can be. */
const SEQ = /^(0|[1-9]\d{0,14})$/;

/**
 * What a request to take a project away asks for, or undefined where it says something else than
 * what `RemoveCondition` takes.
 */
const conditionOf = (query: Record<string, unknown>): RemoveCondition | undefined => {
  const { archived, discard } = query;
  if (archived !== undefined && (typeof archived !== "string" || !SEQ.test(archived)))
    return undefined;
  if (discard !== undefined && discard !== "1") return undefined;
  return {
    ...(archived !== undefined && { archived: Number(archived) }),
    ...(discard !== undefined && { discard: true }),
  };
};

export const projectRoutes = async (app: FastifyInstance, options: ProjectRoutesOptions) => {
  const { accounts, db, hub } = options;
  const now = options.now ?? Date.now;
  const access = options.access ?? OWNER_ONLY;
  const guard = fromThisSite(options.origin);
  const limits = {
    read: new Limits({ perClient: 300, perOwn: 120, ceiling: 6000 }, TEN_MINUTES, now),
    change: new Limits({ perClient: 60, perOwn: 30, ceiling: 600 }, TEN_MINUTES, now),
    /**
     * Covers, which a start page on a new computer fetches all at once: as many as a person may
     * have projects (`projectsPerUser`), a few times over.
     */
    covers: new Limits({ perClient: 1200, perOwn: 600, ceiling: 12000 }, TEN_MINUTES, now),
    /**
     * How projects are organised: read as a start page opens, and changed a second or so after
     * people star or move one, each a batch.
     */
    organizer: new Limits({ perClient: 600, perOwn: 300, ceiling: 6000 }, TEN_MINUTES, now),
  };
  /** Changes of how a person organises projects, counted one by one, see `ORGANIZER_CHANGES`. */
  const organizerChanges = new RateLimit(ORGANIZER_CHANGES, TEN_MINUTES, now);
  /**
   * A new cover the editor made of a project once a minute at most, of one person's: the editor
   * sends one every ten minutes, and as people leave a project, not more than once a minute.
   */
  const coverPuts = new RateLimit(1, 60_000, now);
  /** Covers people choose themselves, or take away again, of a project: ten in ten minutes. */
  const coverChoices = new RateLimit(10, TEN_MINUTES, now);

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
    if (status === 415) return reply.code(415).send({ error: "unsupported" });
    return reply.code(status).send({ error: "invalid" });
  });
  // A cover comes as it is, and only so large.
  app.addContentTypeParser(
    [...COVER_TYPES],
    { parseAs: "buffer", bodyLimit: COVER_BYTES },
    (_request, body, done) => done(null, body),
  );
  /**
   * How often a list has repositories looked at again: for one person once a minute, and for
   * everyone together a few times, each time `STALE_MOST` of them at most. The worker looks at one
   * repository at a time, between the archives.
   */
  const looks = {
    own: new RateLimit(1, 60_000, now),
    all: new RateLimit(6, 60_000, now),
  };
  const rechecks = new RateLimit(1, 60_000, now);

  /** Who is signed in, after the limit of this kind of request; undefined once answered. */
  const signedIn = async (
    request: FastifyRequest,
    reply: FastifyReply,
    limit: Limits,
  ): Promise<SignedIn | undefined> => {
    const session = ourValue(readCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) {
      await reply.code(401).send({ error: "signedOut" });
      return undefined;
    }
    const own = hashOf(session).toString("base64url").slice(0, 22);
    if (!limit.take(clientOf(request.ip), own)) {
      await reply
        .code(429)
        .header("retry-after", String(limit.retryAfter(clientOf(request.ip), own)))
        .send({ error: "busy" });
      return undefined;
    }
    const work = accounts();
    if (!work || !db()) {
      await reply.code(503).send({ error: "unavailable" });
      return undefined;
    }
    const user = await work.session(session);
    if (!user) {
      await reply.code(401).send({ error: "signedOut" });
      return undefined;
    }
    if (!(await options.gate(request, reply, user.userId))) return undefined;
    return user;
  };

  app.get(
    "/api/projects",
    {
      config: {
        access: { inside: "list", why: "the projects the person may read (AccessPolicy.visible)" },
      },
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.read);
      const database = db();
      if (!user || !database) return reply;
      const { projects, stale, unusable } = await listProjects(database, user.userId, {
        webUrl: options.webUrl,
        now: now(),
        ...("deletesFrom" in options && { deletesFrom: options.deletesFrom }),
        access,
      });
      const { lookAgain } = options;
      // The person's turn is only taken where there is something to look at, and everyone's only
      // with theirs.
      if (lookAgain && stale.length > 0 && looks.own.take(user.userId) && looks.all.take("all")) {
        // The list is what was asked for: it goes out whether or not that could be queued.
        await lookAgain(stale).catch((error: unknown) => {
          request.log.warn(
            { err: describeError(error) },
            "repositories will not be looked at again",
          );
        });
      }
      // Those whose repository cannot be used: GitHub is asked again soon whether it can by now, at
      // most once in a while for each (`recheckSoon`), and for a person once a minute.
      if (unusable.length > 0 && rechecks.take(user.userId))
        await recheckSoon(database, unusable, new Date(now())).catch((error: unknown) => {
          request.log.warn({ err: describeError(error) }, "repositories will not be asked about");
        });
      return { projects };
    },
  );

  app.delete<{ Params: Params; Querystring: Record<string, unknown> }>(
    "/api/projects/:id",
    {
      config: {
        access: {
          inside: "manage",
          why: "taking a project away notes an id that is not there too: the hub asks in its lock",
        },
      },
      preHandler: guard,
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.change);
      if (!user) return reply;
      const sync = hub();
      if (!sync) return reply.code(503).send({ error: "unavailable" });
      // What is no name of a project is none: nothing is asked about it.
      if (!PLATFORM_ID.test(request.params.id)) return reply.code(404).send({ error: "notFound" });
      const condition = conditionOf(request.query);
      if (!condition) return reply.code(400).send({ error: "invalid" });
      let outcome: Awaited<ReturnType<SyncHub["remove"]>>;
      try {
        outcome = await sync.remove(request.params.id, user.userId, condition);
      } catch (error) {
        request.log.error(
          { err: describeError(error), project: request.params.id },
          "a project could not be deleted",
        );
        return reply.code(503).send({ error: "unavailable" });
      }
      if (outcome === "missing") return reply.code(404).send({ error: "notFound" });
      if (outcome === "hasRepository") return reply.code(409).send({ error: "hasRepository" });
      if (outcome === "removed") return reply.code(204).send();
      const { kind, ...said } = outcome;
      return reply.code(409).send({ error: kind, ...said });
    },
  );

  app.get<{ Params: Params & { readonly batch: string } }>(
    "/api/projects/:id/batches/:batch",
    { config: { access: { project: "id", action: "read" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.read);
      if (!user) return reply;
      const sync = hub();
      if (!sync) return reply.code(503).send({ error: "unavailable" });
      const said = await sync.batchState(request.params.id, user.userId, request.params.batch);
      if (said.kind === "missing") return reply.code(404).send({ error: "notFound" });
      return { batch: said.state };
    },
  );

  app.post<{ Params: Params & { readonly batch: string } }>(
    "/api/projects/:id/batches/:batch/undo",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.change);
      if (!user) return reply;
      const sync = hub();
      if (!sync) return reply.code(503).send({ error: "unavailable" });
      const said = await sync.takeBack(request.params.id, user.userId, request.params.batch);
      if (said.kind === "missing") return reply.code(404).send({ error: "notFound" });
      if (said.kind === "refused")
        return reply.code(409).send({ error: "notUndoable", why: said.why });
      const { kind: _kind, ...taken } = said;
      return taken;
    },
  );

  app.put<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/name",
    {
      config: { access: { project: "id", action: "manage" } },
      preHandler: guard,
      bodyLimit: NAME_BODY_BYTES,
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.change);
      if (!user) return reply;
      const sync = hub();
      const database = db();
      if (!sync || !database) return reply.code(503).send({ error: "unavailable" });
      const body = request.body as { name?: unknown } | undefined;
      const name = typeof body === "object" && body !== null ? body.name : undefined;
      if (typeof name !== "string" || name.trim() === "")
        return reply.code(400).send({ error: "invalid" });
      const said = await sync.rename(request.params.id, user.userId, name);
      switch (said.kind) {
        case "missing":
          return reply.code(404).send({ error: "notFound" });
        case "unchanged":
          return { name: said.name };
        case "renamed":
          return { name: said.name, batch: said.batch, seq: said.seq ?? null };
        case "refused":
          break;
      }
      if (said.why === "invalid") return reply.code(400).send({ error: "invalid" });
      if (said.why === "quota") return reply.code(413).send({ error: "quota" });
      if (said.why === "locked" || said.why === "unusable")
        return reply.code(409).send({ error: said.why });
      if (said.why === "failed") return reply.code(503).send({ error: "unavailable" });
      // Let go of: made again from the repository, as opening it would, and renamed after.
      const { rebuild } = options;
      if (!rebuild) return reply.code(503).send({ error: "unavailable" });
      const woke = await wakeCopy(
        database,
        request.params.id,
        { userId: user.userId, access },
        new Date(now()),
      );
      switch (woke.copy) {
        case "missing":
          return reply.code(404).send({ error: "notFound" });
        case "live":
          // Back meanwhile: ask again.
          return reply.code(409).send({ error: "waking", copy: "live" });
        case "restoring":
          await rebuild(request.params.id);
          return reply.code(409).send({ error: "waking", copy: "restoring" });
        case "released":
          if (woke.why === "later")
            return reply
              .code(429)
              .header(
                "retry-after",
                String(Math.max(1, Math.ceil(((woke.retryAt ?? now()) - now()) / 1000))),
              )
              .send({ error: "busy", ...(woke.problem && { copyProblem: woke.problem }) });
          return reply.code(409).send({
            error: woke.why,
            copy: "released",
            ...(woke.problem && { copyProblem: woke.problem }),
          });
      }
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/wake",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.change);
      const database = db();
      if (!user || !database) return reply;
      const { rebuild } = options;
      if (!rebuild) return reply.code(503).send({ error: "unavailable" });
      if (!PLATFORM_ID.test(request.params.id)) return reply.code(404).send({ error: "notFound" });
      const body = request.body as { fromBranch?: unknown } | undefined;
      if (body !== undefined && body !== null && typeof body !== "object")
        return reply.code(400).send({ error: "invalid" });
      const fromBranch = body?.fromBranch;
      if (fromBranch !== undefined && typeof fromBranch !== "boolean")
        return reply.code(400).send({ error: "invalid" });
      const woke = await wakeCopy(
        database,
        request.params.id,
        { userId: user.userId, access },
        new Date(now()),
        {
          fromBranch: fromBranch === true,
        },
      );
      switch (woke.copy) {
        case "missing":
          return reply.code(404).send({ error: "notFound" });
        case "live":
          return { copy: "live" };
        case "restoring":
          await rebuild(request.params.id);
          return reply.code(202).send({ copy: "restoring" });
        case "released":
          if (woke.why === "later")
            return reply
              .code(429)
              .header(
                "retry-after",
                String(Math.max(1, Math.ceil(((woke.retryAt ?? now()) - now()) / 1000))),
              )
              .send({
                error: "busy",
                ...(woke.problem && { copyProblem: woke.problem }),
              });
          return reply.code(409).send({
            error: woke.why,
            copy: "released",
            ...(woke.problem && { copyProblem: woke.problem }),
          });
      }
    },
  );

  app.put<{ Params: Params; Querystring: Record<string, unknown> }>(
    "/api/projects/:id/cover",
    {
      config: { access: { project: "id", action: "edit" } },
      preHandler: guard,
      bodyLimit: COVER_BYTES,
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.change);
      const database = db();
      if (!user || !database) return reply;
      if (!PLATFORM_ID.test(request.params.id)) return reply.code(404).send({ error: "notFound" });
      const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
      const body = request.body;
      if (!COVER_TYPES.includes(type as CoverType) || !Buffer.isBuffer(body))
        return reply.code(415).send({ error: "unsupported" });
      if (body.length > COVER_BYTES) return reply.code(413).send({ error: "tooLarge" });
      const { durationMs: said, chosen: saidChosen } = request.query;
      const durationMs = said === undefined ? undefined : durationOf(said);
      if (
        !isPictureOf(type as CoverType, body) ||
        (said !== undefined && durationMs === undefined) ||
        (saidChosen !== undefined && saidChosen !== "1")
      )
        return reply.code(400).send({ error: "invalid" });
      const chosen = saidChosen === "1";
      const key = `${user.userId}:${request.params.id}`;
      const limit = chosen ? coverChoices : coverPuts;
      if (!limit.take(key))
        return reply
          .code(429)
          .header("retry-after", String(limit.retryAfter(key)))
          .send({ error: "busy" });
      const kept = await putCover(
        database,
        request.params.id,
        {
          type: type as CoverType,
          bytes: body,
          ...(durationMs !== undefined && { durationMs }),
          chosen,
        },
        new Date(now()),
      );
      if (!kept) return reply.code(404).send({ error: "notFound" });
      return {
        etag: kept.etag,
        at: kept.at,
        ...(kept.chosen && { chosen: true }),
      };
    },
  );

  app.patch<{ Params: Params; Querystring: Record<string, unknown> }>(
    "/api/projects/:id/cover",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.change);
      const database = db();
      if (!user || !database) return reply;
      if (!PLATFORM_ID.test(request.params.id)) return reply.code(404).send({ error: "notFound" });
      const durationMs = durationOf(request.query.durationMs);
      if (durationMs === undefined) return reply.code(400).send({ error: "invalid" });
      // As often as the editor's covers: it is one of them, without the picture.
      const key = `${user.userId}:${request.params.id}`;
      if (!coverPuts.take(key))
        return reply
          .code(429)
          .header("retry-after", String(coverPuts.retryAfter(key)))
          .send({ error: "busy" });
      if (!(await putDuration(database, request.params.id, durationMs)))
        return reply.code(404).send({ error: "notFound" });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: Params }>(
    "/api/projects/:id/cover",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.change);
      const database = db();
      if (!user || !database) return reply;
      if (!PLATFORM_ID.test(request.params.id)) return reply.code(404).send({ error: "notFound" });
      const key = `${user.userId}:${request.params.id}`;
      if (!coverChoices.take(key))
        return reply
          .code(429)
          .header("retry-after", String(coverChoices.retryAfter(key)))
          .send({ error: "busy" });
      if (!(await removeCover(database, request.params.id)))
        return reply.code(404).send({ error: "notFound" });
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/organizer",
    { config: { access: { inside: "list", why: "marks of the projects the person may read" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.organizer);
      const database = db();
      if (!user || !database) return reply;
      const organized = await readOrganized(database, user.userId, access);
      // Never kept by anything on the way: whose it is changes as people sign in and out.
      return { now: now(), ...organized };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/organizer",
    {
      config: {
        access: {
          inside: "list",
          why: "marks only of the projects the person may read, asked in the transaction",
        },
      },
      preHandler: guard,
      bodyLimit: 256 * 1024,
    },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.organizer);
      const database = db();
      if (!user || !database) return reply;
      const changes = changesOf(request.body);
      if (!changes) return reply.code(400).send({ error: "invalid" });
      if (changes.account !== user.userId) return reply.code(409).send({ error: "otherAccount" });
      const count = changes.groups.length + changes.marks.length;
      if (count > 0 && !organizerChanges.take(user.userId, count))
        return reply
          .code(429)
          .header("retry-after", String(organizerChanges.retryAfter(user.userId)))
          .send({ error: "busy" });
      const at = now();
      const answer = await applyOrganizer(database, user.userId, changes, at, access);
      return { now: at, ...answer };
    },
  );

  app.get<{ Params: Params }>(
    "/api/projects/:id/cover",
    { config: { access: { project: "id", action: "read" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits.covers);
      const database = db();
      if (!user || !database) return reply;
      if (!PLATFORM_ID.test(request.params.id)) return reply.code(404).send({ error: "notFound" });
      const cover = await coverOf(database, request.params.id);
      if (!cover) return reply.code(404).send({ error: "notFound" });
      const etag = `"${cover.etag}"`;
      reply
        .header("etag", etag)
        .header("cache-control", "private, no-cache")
        .header("x-content-type-options", "nosniff");
      const asked = request.headers["if-none-match"];
      if (asked !== undefined && asked.split(",").some((tag) => tag.trim() === etag))
        return reply.code(304).send();
      return reply.type(cover.type).send(cover.bytes);
    },
  );
};
