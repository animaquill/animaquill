import { eq, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Executor } from "./database.ts";
import { projects } from "./schema.ts";

/**
 * Who may do what with a project of the server: the one place that says so. Every way into a
 * project asks it: the routes that name a project in their address through `accessGate` (declared
 * in the route's `config.access`, see `checkDeclared`), and what takes projects otherwise in its
 * own transaction (the hub's hello, batches and copies, the marks of the start page, the
 * conversations, lists). Nothing else compares owners.
 *
 * - "read": open it, sync it to read, its files, its cover, its repository's state, its
 *   conversations;
 * - "edit": change it: sync to edit, covers, batches taken back, files into its large file storage,
 *   archives, merges, conflicts, its copy made again;
 * - "manage": what goes beyond its content: take it away, link or switch its repository.
 */
export type ProjectAction = "read" | "edit" | "manage";

/** A project, as far as a policy needs it. */
export interface ProjectOfAccess {
  readonly id: string;
  readonly ownerId: string;
}

export interface AccessPolicy {
  /** Whether the person may do this with the project, in the transaction of the caller. */
  may(
    db: Executor,
    userId: string,
    project: ProjectOfAccess,
    action: ProjectAction,
  ): Promise<boolean>;
  /** The projects the person may read, as a condition on `projects` for lists. */
  visible(userId: string): SQL;
}

/** Only the owner, as the platform has it until members. */
export const OWNER_ONLY: AccessPolicy = {
  may: async (_db, userId, project) => project.ownerId === userId,
  visible: (userId) => eq(projects.ownerId, userId),
};

/**
 * Anyone signed in, with any project: what the server for one team will have (O4, everyone on its
 * list), and what the tests of access take to see that the policy is the only thing that stops them.
 */
export const ANYONE: AccessPolicy = {
  may: async () => true,
  visible: () => sql`true`,
};

/**
 * What a route says of access, in its `config.access`. Every route under /api says something, or
 * the server does not start (`checkDeclared`):
 *
 * - `{ project, action }`: the route names a project in its address (`params[project]`, or the
 *   query's), and
 *   `accessGate` asks the policy before anything is done with it;
 * - `{ inside, why }`: projects come in the body or are listed, and what the route calls asks the
 *   policy itself, in its transaction (`inside` is the action, or "list");
 * - `{ none: why }`: nothing of a project, such as signing in, or what is only the person's own.
 */
export type RouteAccess =
  | {
      readonly project: string;
      readonly action: ProjectAction;
      /** Where the id is: a parameter of the address (`:project`) unless said. */
      readonly from?: "query";
    }
  | { readonly inside: ProjectAction | "list"; readonly why: string }
  | { readonly none: string };

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

/**
 * Has the server refuse to start with a route under /api that says nothing of access, except under
 * the prefixes a deployment answers for itself (`own`, such as the admin site), each with why.
 */
export const checkDeclared = (
  app: FastifyInstance,
  own: () => readonly { readonly prefix: string; readonly why: string }[],
) => {
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/")) return;
    if (own().some(({ prefix }) => route.url === prefix || route.url.startsWith(`${prefix}/`)))
      return;
    const access = (route.config as { access?: RouteAccess } | undefined)?.access;
    if (access === undefined)
      throw new Error(
        `${route.method} ${route.url} says nothing of access: give it config.access (access.ts)`,
      );
    // A project said to be in the address has to be one of its parameters, or the check would
    // never find it.
    if (
      "project" in access &&
      access.from === undefined &&
      !route.url.split("/").includes(`:${access.project}`)
    )
      throw new Error(
        `${route.method} ${route.url} has no parameter :${access.project} for its project`,
      );
  });
};

/**
 * The check of a route that names a project: for one that is not there, or that the person may not
 * do this with, 404 `{error: "notFound"}`, the same for both, before the route does anything (reads
 * its body, counts its limits of a project), so that nothing tells the two apart; also where the id
 * is not to be found (never let through). True where the route goes on. Called by each route's
 * sign-in, right after it knows who it is, so that the limits and errors before it are as they were.
 * What has to go on for an id that is not there, as taking a project away, which notes the id, asks
 * inside (`{ inside }`) instead.
 */
export type AccessGate = (
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
) => Promise<boolean>;

export const accessGate =
  (access: AccessPolicy, db: () => Executor | undefined): AccessGate =>
  async (request, reply, userId) => {
    const rule = request.routeOptions.config.access;
    if (rule === undefined || !("project" in rule)) return true;
    const refuse = async () => {
      await reply.code(404).send({ error: "notFound" });
      return false;
    };
    // In the address, or in its query, as the conversations of a project are listed.
    const id = (
      (rule.from === "query" ? request.query : request.params) as
        Record<string, unknown> | undefined
    )?.[rule.project];
    if (typeof id !== "string" || id.length === 0) return refuse();
    const database = db();
    // The route says that it cannot be reached now.
    if (!database) return true;
    const [row] = await database
      .select({ id: projects.id, ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, id));
    if (!row || !(await access.may(database, userId, row, rule.action))) return refuse();
    return true;
  };
