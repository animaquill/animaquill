import type { AccessGate } from "../access.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Accounts, SignedIn } from "../auth/accounts.ts";
import { fromThisSite } from "../auth/guard.ts";
import { clientOf, Limits, RateLimit } from "../auth/limits.ts";
import { describeError } from "../database.ts";
import { hashOf } from "../seal.ts";
import {
  RESOLVE_MOST,
  RepositoryRefused,
  type RepositoryChoice,
  type RepositoryService,
} from "./service.ts";
import type { SessionCredentials } from "../auth/credentials.ts";

/**
 * Saving projects to GitHub, for the editor:
 *
 * - `GET /api/github/repositories?page=`: what the person's installation covers, to choose from,
 *   and where on GitHub they choose that (`manageUrl`). One that a project of theirs is saved to
 *   says which (`linkedProject`).
 * - `POST /api/github/repositories/check` with `{create:{name}}` or `{existing:{id}, confirmPublic?}`:
 *   whether that repository could take a project, before anything is made or linked. What it finds
 *   is always 200: `{ok: true}`, or `{ok: false, reason, files?, project?}` with `reason` one of
 *   nameTaken, invalidName, hasProject, linkedElsewhere, notPushable, public, notFound,
 *   notInstalled. Only what keeps it from looking is an error, as everywhere here.
 * - `POST /api/projects/:id/repository` with `{create:{name}}` or `{existing:{id}, confirmPublic?}`,
 *   and `switch: true` to take another repository in place of one whose archiving goes as it
 *   should (without it: alreadyLinked). The project is held for it meanwhile: another link of it is
 *   busy (429), and deleting it says it has a repository. Where GitHub takes longer than about a
 *   minute, unavailable (503), and the link is made all the same once GitHub is done: asked again,
 *   it is there, or busy a little longer.
 * - `GET /api/projects/:id/repository`: the repository, and how archiving goes; also for one without
 *   a repository (`state: "none"`). `repository.place` is "github" or "local" (a repository of the
 *   server's own, archive/local/), which has no `url` (nor have its archives and merges) and has
 *   `clone`, its folder for `git clone`; `failure: "diskFull"` while archives fail for want of room. Always `copy` (whether the platform has the working copy:
 *   live, released, restoring), `generation` (which copy it is), `copyProblem?` (`{code, at,
 *   files?, reason?}`, why making it from the repository failed the last time), and, once the copy
 *   was made again, `rebuiltFrom: {generation, archivedSeq}`: which copy was before, and the update
 *   of it that the archive this one began as has (0: nothing in common), for a window of that copy
 *   to put its changes onto this one. Where the repository
 *   cannot be used, and so the project cannot be edited, `unusable: {reason, since, deleteAt?}`: the
 *   pause it is (gone, transferred, uninstalled, suspended), since when the platform found it so,
 *   and when the project goes unless it can be used again (milliseconds since 1970; only once the
 *   deployment takes such projects away, `deletesFrom`). For "gone",
 *   `gone` says "deleted" only where GitHub said so, "unauthorized" where it is there and the App may
 *   not touch it; neither where nothing tells ("not found").
 * - `POST /api/projects/:id/archive`, with `{replace}` to write over files that changed on GitHub.
 *   For a repository that cannot be used, GitHub is asked first, as by the next one: archiving goes
 *   on only where it can be used again, and the status says so either way (202).
 * - `POST /api/projects/:id/repository/check` ("check again"): for a repository that cannot be used,
 *   GitHub is asked now, with the App's token, whether it can be used again; where it can, archiving
 *   goes on and an archive looks at it, and the project can be edited again. For any other, an
 *   archive that only looks is queued. 200 with the status as it is then; unavailable (503) where
 *   GitHub could not be asked; busy (429, with Retry-After) more than once a minute for a project;
 *   notLinked (404) for one that has no repository.
 *
 * Repositories of the server's own (archive/local/):
 *
 * - `GET /api/local-repositories`: `{repositories: [{dir, name, project}]}`, those no project is saved
 *   to, made for this person or for nobody known, that have a project ("从本机仓库恢复…").
 * - `POST /api/projects/restore` with `{local:{dir}}`: restores one of them as `existing` does a
 *   repository on GitHub, in its folder as it is: notFound (404) for one not listed.
 * - `POST /api/projects/:id/repository/restart` ("重新建一个", "从项目重新开始存档"): for a repository
 *   here that is gone or broken, what is there is put into `repos/broken/`, and archiving starts
 *   over into a new one; notBroken (409) for any other; busy (429) while an archive runs.
 *
 * - `POST /api/projects/restore` with `{existing:{id}, confirmPublic?}` ("从这个仓库恢复成云端项目"):
 *   a repository of the person's that has a project at its top (which linking turns away as
 *   "hasProject") becomes a new project of theirs, saved to it, made from the last commit of its
 *   branch by the worker, see `RepositoryService.restore`. 201 `{project: {id, name}, copy: "live"}`
 *   once it is there; 202 with `copy: "restoring"` where that takes longer than about a minute (the
 *   list says once it is, or, with `copyProblem`, that it could not be). Refused as for linking one
 *   they have (notInstalled, notFound, notPushable, public, linkedElsewhere), and: noProject (409,
 *   no animaquill.json at the top, or not the project it said), unreadable (422, `files` the
 *   documents that do not read as the format says), tooLarge (413), tooNew (409, a newer format),
 *   quota (409, as many projects as they may have, or bytes), unavailable (503: GitHub or the
 *   worker failed, nothing is left of it, ask again).
 *
 * Merging changes on GitHub (while the switch of the admin site has merges on):
 *
 * - `GET /api/projects/:id/repository` says too: `merge?: {at, sha, files, url}`, the last merge;
 *   `conflicts`, how many wait; `blocked: [{path, reason, detail?}]`, files on GitHub the merge did
 *   not take in; and for "rewritten" `diverged.base`, the commit both histories have. Pauses of
 *   merges: conflicts, blocked, locked, rewritten, too-large, unmerged.
 * - `GET /api/projects/:id/conflicts`: `{conflicts: [...]}`, open first, at most 500; a row whose
 *   values are too large says `large: true`, and `GET /api/projects/:id/conflicts/:conflict` has it
 *   whole.
 * - `POST /api/projects/:id/conflicts/resolve` `{ids, keep: "ours" | "theirs", seq?}`: `{resolved,
 *   status}`; `behind` (409) where the platform does not have update `seq` yet.
 * - `POST /api/projects/:id/repository/blocked` `{path, use: "editor"}`: notBlocked (409) for a file
 *   that does not wait.
 * - `POST /api/projects/:id/repository/merge-now` `{sha}`, for "rewritten": notRewritten (409),
 *   diverged (409) where GitHub's commit is not that one any more, noCommonBase (409).
 * - `POST /api/projects/:id/archive` with `{replace}` ends any pause of merges, keeping the project's
 *   side everywhere; without it, conflicts and blocked files stay, and the status says so (202).
 *   `drop` (with `replace` only): files of `diverged.files` to take out of the project first, as
 *   GitHub took them away (a rewritten history); invalid (400) for any other path.
 * - `POST /api/projects/:id/repository/prefer` `{prefer: "editor" | "github"}`: which side merges
 *   keep first where both changed the same place; the status says it as `prefer`.
 *
 * All of it is for the project's owner only: the names of files and what both sides wrote are not
 * for whoever may read the project once there are members.
 *
 * Errors are `{error: <code>}`: signedOut, notInstalled, nameTaken, hasProject, linkedElsewhere
 * (with `project`, where the repository is of a project of the person's own), notPushable, public;
 * and notFound, invalidName, alreadyLinked, notLinked, diverged, behind, notBlocked, notRewritten, notBroken,
 * noCommonBase, busy, invalid, unavailable, and nothing else. What changes something takes requests from pages of this site only, see guard.ts;
 * so does the check, which asks GitHub in the person's name.
 */

export interface RepositoryRoutesOptions {
  /** The check of the routes that name a project, see access.ts. */
  readonly gate: AccessGate;
  readonly origin: string;
  /** Undefined while nobody can sign in, or the database is not there yet. */
  readonly accounts: () => Accounts | undefined;
  /** How the browser shows its session, see auth/credentials.ts. */
  readonly credentials: SessionCredentials;
  readonly repositories: () => RepositoryService | undefined;
  readonly now?: () => number;
}

const TEN_MINUTES = 10 * 60_000;
/** Files one "archive now" with `replace` takes out of the project at most (`drop`). */
const DROP_MOST = 2000;

type Params = { readonly id: string };

export const repositoryRoutes = async (app: FastifyInstance, options: RepositoryRoutesOptions) => {
  const { accounts, repositories } = options;
  const now = options.now ?? Date.now;
  const guard = fromThisSite(options.origin);
  const limits = {
    read: new Limits({ perClient: 300, perOwn: 120, ceiling: 6000 }, TEN_MINUTES, now),
    change: new Limits({ perClient: 60, perOwn: 30, ceiling: 600 }, TEN_MINUTES, now),
  };
  /** "Archive now" of a project at most once a minute, and "check again" too. */
  const archiveNow = new RateLimit(1, 60_000, now);
  const checkNow = new RateLimit(1, 60_000, now);

  // What goes wrong is said with the codes of these routes, not Fastify's own ("Bad Request"):
  // a request the editor got wrong is "invalid", and whatever goes wrong here "unavailable".
  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: describeError(error) }, "failed");
      return reply.code(503).send({ error: "unavailable" });
    }
    return reply.code(status).send({ error: "invalid" });
  });

  // Nothing to say is no body, whatever its type; a body is small.
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

  const refuse = (reply: FastifyReply, error: RepositoryRefused) => {
    const { retryAfter, ...extra } = error.extra ?? {};
    if (typeof retryAfter === "number") reply.header("retry-after", String(retryAfter));
    return reply.code(error.status).send({ error: error.code, ...extra });
  };

  /** Who is signed in, after the limit of this kind of request; undefined once answered. */
  const signedIn = async (
    request: FastifyRequest,
    reply: FastifyReply,
    limit: Limits,
  ): Promise<{ user: SignedIn; service: RepositoryService } | undefined> => {
    const session = options.credentials.sessionOf(request);
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
    const service = repositories();
    if (!work || !service) {
      await reply.code(503).send({ error: "unavailable" });
      return undefined;
    }
    const user = await work.session(session);
    if (!user) {
      await reply.code(401).send({ error: "signedOut" });
      return undefined;
    }
    if (!(await options.gate(request, reply, user.userId))) return undefined;
    return { user, service };
  };

  /** Runs what a route does, answering what it refuses with its code. */
  const answer = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RepositoryRefused) return refuse(reply, error);
      throw error;
    }
  };

  app.get<{ Querystring: { page?: string } }>(
    "/api/github/repositories",
    {
      config: {
        access: {
          inside: "list",
          why: "names the project a repository is saved to only where the person may read it",
        },
      },
    },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.read);
      if (!who) return reply;
      const page = Number(request.query.page ?? "1");
      if (!Number.isInteger(page) || page < 1 || page > 100)
        return reply.code(400).send({ error: "invalid" });
      return answer(reply, () => who.service.list(who.user, page));
    },
  );

  app.get(
    "/api/local-repositories",
    {
      config: {
        access: {
          inside: "list",
          why: "repositories of the server's own that no project is saved to, made for this person or for nobody known",
        },
      },
    },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.read);
      if (!who) return reply;
      return answer(reply, () => who.service.localRepositories(who.user));
    },
  );

  /** The repository a request chooses, a new one or one people have: undefined for neither. */
  const choiceOf = (body: unknown): RepositoryChoice | undefined => {
    const said = body as
      | { create?: { name?: unknown }; existing?: { id?: unknown }; confirmPublic?: unknown }
      | undefined;
    const name = said?.create?.name;
    const id = said?.existing?.id;
    if (typeof name === "string" && id === undefined) return { create: { name } };
    if (typeof id === "number" && name === undefined)
      return { existing: { id }, confirmPublic: said?.confirmPublic === true };
    return undefined;
  };

  // Asked as people type a name: counted with what reads.
  app.post<{ Body: unknown }>(
    "/api/github/repositories/check",
    {
      config: {
        access: {
          inside: "list",
          why: "names the project a repository is saved to only where the person may read it",
        },
      },
      preHandler: guard,
    },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.read);
      if (!who) return reply;
      const choice = choiceOf(request.body);
      if (!choice) return reply.code(400).send({ error: "invalid" });
      return answer(reply, () => who.service.check(who.user, choice));
    },
  );

  app.post<{ Body: unknown }>(
    "/api/projects/restore",
    {
      config: {
        access: {
          inside: "list",
          why: "a new project of the person; names one a repository is saved to only where the person may read it",
        },
      },
      preHandler: guard,
    },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      const local = (request.body as { local?: { dir?: unknown } } | undefined)?.local?.dir;
      if (typeof local === "string") {
        if (local.length > 300) return reply.code(400).send({ error: "invalid" });
        return answer(reply, async () => {
          const restored = await who.service.restoreLocal(who.user, local);
          return reply.code(restored.copy === "live" ? 201 : 202).send(restored);
        });
      }
      const choice = choiceOf(request.body);
      if (!choice || !("existing" in choice)) return reply.code(400).send({ error: "invalid" });
      return answer(reply, async () => {
        const restored = await who.service.restore(who.user, choice);
        return reply.code(restored.copy === "live" ? 201 : 202).send(restored);
      });
    },
  );

  app.get<{ Params: Params }>(
    "/api/projects/:id/repository",
    { config: { access: { project: "id", action: "read" } } },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.read);
      if (!who) return reply;
      return answer(reply, () => who.service.status(who.user, request.params.id));
    },
  );

  app.get<{ Params: Params }>(
    "/api/projects/:id/conflicts",
    { config: { access: { project: "id", action: "read" } } },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.read);
      if (!who) return reply;
      return answer(reply, () => who.service.conflicts(who.user, request.params.id));
    },
  );

  app.get<{ Params: Params & { readonly conflict: string } }>(
    "/api/projects/:id/conflicts/:conflict",
    { config: { access: { project: "id", action: "read" } } },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.read);
      if (!who) return reply;
      return answer(reply, () =>
        who.service.conflict(who.user, request.params.id, request.params.conflict),
      );
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/conflicts/resolve",
    // The ids of every conflict people settle at once: the one body here that is larger.
    {
      config: { access: { project: "id", action: "edit" } },
      preHandler: guard,
      bodyLimit: 64 * 1024,
    },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      const body = request.body as { ids?: unknown; keep?: unknown; seq?: unknown } | undefined;
      const ids = body?.ids;
      const keep = body?.keep;
      const seq = body?.seq;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > RESOLVE_MOST ||
        !ids.every((id) => typeof id === "string") ||
        (keep !== "ours" && keep !== "theirs") ||
        (seq !== undefined && (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0))
      )
        return reply.code(400).send({ error: "invalid" });
      return answer(reply, () =>
        who.service.resolveConflicts(who.user, request.params.id, {
          ids: ids as string[],
          keep,
          ...(seq !== undefined && { seq: seq as number }),
        }),
      );
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/repository/blocked",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      const body = request.body as { path?: unknown; use?: unknown } | undefined;
      if (typeof body?.path !== "string" || body.path.length > 1024 || body.use !== "editor")
        return reply.code(400).send({ error: "invalid" });
      const path = body.path;
      return answer(reply, () => who.service.useEditorFor(who.user, request.params.id, path));
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/repository/merge-now",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      const sha = (request.body as { sha?: unknown } | undefined)?.sha;
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
        return reply.code(400).send({ error: "invalid" });
      return answer(reply, () => who.service.mergeNow(who.user, request.params.id, sha));
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/repository/prefer",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      const prefer = (request.body as { prefer?: unknown } | undefined)?.prefer;
      if (prefer !== "editor" && prefer !== "github")
        return reply.code(400).send({ error: "invalid" });
      return answer(reply, () => who.service.setPrefer(who.user, request.params.id, prefer));
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/repository",
    { config: { access: { project: "id", action: "manage" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      const choice = choiceOf(request.body);
      if (!choice) return reply.code(400).send({ error: "invalid" });
      const instead = (request.body as { switch?: unknown } | undefined)?.switch === true;
      return answer(reply, async () => {
        const status = await who.service.link(who.user, request.params.id, {
          ...choice,
          switch: instead,
        });
        return reply.code(201).send(status);
      });
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/archive",
    // The files people take out with `replace` (`drop`) can be a long list.
    {
      config: { access: { project: "id", action: "edit" } },
      preHandler: guard,
      bodyLimit: 256 * 1024,
    },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      const body = request.body as { replace?: unknown; drop?: unknown } | undefined;
      const replace = body?.replace;
      const drop = body?.drop;
      if (replace !== undefined && (typeof replace !== "string" || !/^[0-9a-f]{40}$/.test(replace)))
        return reply.code(400).send({ error: "invalid" });
      // Only with `replace`, and only paths: which of them may go, the service says.
      if (
        drop !== undefined &&
        (replace === undefined ||
          !Array.isArray(drop) ||
          drop.length > DROP_MOST ||
          !drop.every((path) => typeof path === "string" && path.length > 0 && path.length <= 1024))
      )
        return reply.code(400).send({ error: "invalid" });
      const project = request.params.id;
      return answer(reply, async () => {
        const status = await who.service.archiveNow(
          who.user,
          project,
          replace,
          () => (archiveNow.take(project) ? undefined : archiveNow.retryAfter(project)),
          (drop as string[] | undefined) ?? [],
        );
        return reply.code(202).send(status);
      });
    },
  );

  app.post<{ Params: Params }>(
    "/api/projects/:id/repository/check",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      const project = request.params.id;
      return answer(reply, () =>
        who.service.recheck(who.user, project, () =>
          checkNow.take(project) ? undefined : checkNow.retryAfter(project),
        ),
      );
    },
  );

  app.post<{ Params: Params }>(
    "/api/projects/:id/repository/restart",
    { config: { access: { project: "id", action: "edit" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.change);
      if (!who) return reply;
      return answer(reply, () => who.service.restart(who.user, request.params.id));
    },
  );
};
