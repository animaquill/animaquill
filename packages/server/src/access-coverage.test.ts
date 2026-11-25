import { mkdtempSync } from "node:fs";
import { RepoHosts } from "./archive/repo-host.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNC_CLOSE, SYNC_PROTOCOL } from "@animaquill/host/sync";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  ANYONE,
  OWNER_ONLY,
  type AccessPolicy,
  type ProjectAction,
  type RouteAccess,
} from "./access.ts";
import { LfsDownloads } from "./lfs/downloads.ts";
import { LfsUploads } from "./lfs/uploads.ts";
import { changeLfs } from "./me/lfs.ts";
import {
  deletedProjects,
  lfsObjects,
  lfsUploads,
  projectBatches,
  projectCovers,
  projectMarks,
  projectRepos,
  projects,
  projectUpdates,
  repoConflicts,
  repoMerges,
  userChats,
} from "./schema.ts";
import { SyncHub } from "./sync/hub.ts";
import { wakeCopy } from "./sync/wake.ts";
import { linkTo, newProject, quiet, world, type World } from "./test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "./test/database.ts";
import { RoomyStaging } from "./test/lfs-support.ts";
import { platform } from "./test/platform-support.ts";
import { TestPeer } from "./test/sync-support.ts";

/**
 * Every way into a project goes by the policy of access (access.ts), and nothing else decides.
 * Route by route, someone else's project:
 *
 * - with the platform's policy (`OWNER_ONLY`) the answer is 404 `{error: "notFound"}`, as for a
 *   project that is not there, and nothing of the project changes;
 * - with a policy that lets anyone (`ANYONE`) the same request gets past that, whatever it then
 *   says: taking the check away is seen;
 * - the policy is asked about that project, for the action the route declares.
 *
 * The same for what takes projects otherwise (lists, the marks of the start page, the repositories
 * to choose from, conversations, the hub's hello), and every route of the server under /api is in
 * one of the tables here, or says why it has nothing of a project. Last, a round at random.
 * On a real PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

/** A picture the covers take: a WebP's first bytes. */
const webp = (size = 64) => {
  const bytes = Buffer.alloc(size, 1);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(size - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8 ", 12, "ascii");
  bytes.writeUInt32LE(size - 20, 16);
  return bytes;
};

const SHA = "a".repeat(40);
const OID = "b".repeat(64);

/** A project of A's with something of everything that points at a project. */
interface Fixture {
  readonly id: string;
  readonly batch: string;
  readonly conflict: string;
  readonly repoId: number;
}

interface ProjectRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** As the route is declared, which the server's own list of routes is checked against. */
  readonly route: string;
  readonly action: ProjectAction;
  readonly url: (f: Fixture) => string;
  readonly body?: (f: Fixture) => unknown;
  readonly raw?: { readonly type: string; readonly bytes: () => Buffer };
  readonly headers?: Record<string, string>;
}

/** The routes that name a project in their address: each with a request that works for the owner. */
const PROJECT_ROUTES: readonly ProjectRoute[] = [
  {
    method: "GET",
    route: "/api/projects/:id/batches/:batch",
    action: "read",
    url: (f) => `/api/projects/${f.id}/batches/${f.batch}`,
  },
  {
    method: "POST",
    route: "/api/projects/:id/batches/:batch/undo",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/batches/${f.batch}/undo`,
  },
  {
    method: "PUT",
    route: "/api/projects/:id/name",
    action: "manage",
    url: (f) => `/api/projects/${f.id}/name`,
    body: () => ({ name: "别的名字" }),
  },
  {
    method: "POST",
    route: "/api/projects/:id/wake",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/wake`,
    body: () => ({}),
  },
  {
    method: "PUT",
    route: "/api/projects/:id/cover",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/cover?chosen=1`,
    raw: { type: "image/webp", bytes: webp },
  },
  {
    method: "PATCH",
    route: "/api/projects/:id/cover",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/cover?durationMs=1000`,
  },
  {
    method: "DELETE",
    route: "/api/projects/:id/cover",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/cover`,
  },
  {
    method: "GET",
    route: "/api/projects/:id/cover",
    action: "read",
    url: (f) => `/api/projects/${f.id}/cover`,
  },
  {
    method: "GET",
    route: "/api/projects/:id/repository",
    action: "read",
    url: (f) => `/api/projects/${f.id}/repository`,
  },
  {
    method: "GET",
    route: "/api/projects/:id/conflicts",
    action: "read",
    url: (f) => `/api/projects/${f.id}/conflicts`,
  },
  {
    method: "GET",
    route: "/api/projects/:id/conflicts/:conflict",
    action: "read",
    url: (f) => `/api/projects/${f.id}/conflicts/${f.conflict}`,
  },
  {
    method: "POST",
    route: "/api/projects/:id/conflicts/resolve",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/conflicts/resolve`,
    body: (f) => ({ ids: [f.conflict], keep: "ours" }),
  },
  {
    method: "POST",
    route: "/api/projects/:id/repository/blocked",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/repository/blocked`,
    body: () => ({ path: "notes.bin", use: "editor" }),
  },
  {
    method: "POST",
    route: "/api/projects/:id/repository/merge-now",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/repository/merge-now`,
    body: () => ({ sha: SHA }),
  },
  {
    method: "POST",
    route: "/api/projects/:id/repository/prefer",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/repository/prefer`,
    body: () => ({ prefer: "github" }),
  },
  {
    method: "POST",
    route: "/api/projects/:id/repository",
    action: "manage",
    url: (f) => `/api/projects/${f.id}/repository`,
    body: () => ({ create: { name: "another" }, switch: true }),
  },
  {
    method: "POST",
    route: "/api/projects/:id/archive",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/archive`,
    body: () => ({}),
  },
  {
    method: "POST",
    route: "/api/projects/:id/repository/check",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/repository/check`,
  },
  {
    method: "POST",
    route: "/api/projects/:id/repository/restart",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/repository/restart`,
  },
  {
    method: "POST",
    route: "/api/projects/:id/lfs/objects",
    action: "edit",
    url: (f) => `/api/projects/${f.id}/lfs/objects`,
    body: () => ({ oid: OID, size: 3 }),
  },
  {
    method: "POST",
    route: "/api/projects/:id/lfs/lookup",
    action: "read",
    url: (f) => `/api/projects/${f.id}/lfs/lookup`,
    body: () => ({ objects: [{ oid: OID, size: 3 }] }),
  },
  {
    method: "GET",
    route: "/api/projects/:id/lfs/objects/:oid",
    action: "read",
    url: (f) => `/api/projects/${f.id}/lfs/objects/${OID}?size=3`,
    headers: { "x-animaquill": "1" },
  },
  {
    method: "GET",
    route: "/api/me/chats",
    action: "read",
    url: (f) => `/api/me/chats?project=${f.id}`,
  },
  {
    method: "GET",
    route: "/api/me/chats/:project/:id",
    action: "read",
    url: (f) => `/api/me/chats/${f.id}/c1`,
  },
  {
    method: "PUT",
    route: "/api/me/chats/:project/:id",
    action: "read",
    url: (f) => `/api/me/chats/${f.id}/c1`,
    body: () => ({ base: null, chat: { id: "c1", title: "别人的", updatedAt: 2, entries: [] } }),
  },
];

/** Routes whose projects come otherwise, each tested below by name. */
const INSIDE_ROUTES = [
  "DELETE /api/projects/:id",
  "GET /api/projects",
  "GET /api/organizer",
  "POST /api/organizer",
  "GET /api/me/lfs",
  "GET /api/github/repositories",
  "POST /api/github/repositories/check",
  "POST /api/projects/restore",
  "GET /api/local-repositories",
];

describe.skipIf(!TEST_DATABASE)("access to projects, route by route, on a database", () => {
  let t: TestDatabase;
  let a: World;
  let b: World;
  let hubs: SyncHub[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    a = await world(t.db);
    b = await world(t.db, a.time);
    for (const w of [a, b])
      await changeLfs(t.db, w.userId, { account: w.userId, acknowledged: true }, Date.now());
  });
  afterEach(() => {
    for (const hub of hubs.splice(0)) hub.stop();
  });

  /** What the policy was asked, as a test wraps it. */
  type Asked = { userId: string; project: string; action: ProjectAction };
  const recording = (policy: AccessPolicy, asked: Asked[]): AccessPolicy => ({
    may: async (db, userId, project, action) => {
      asked.push({ userId, project: project.id, action });
      return policy.may(db, userId, project, action);
    },
    visible: (userId) => policy.visible(userId),
  });

  /** The server as `who` sees it, with this policy, and what it has of routes. */
  const serverOf = async (who: World, access: AccessPolicy) => {
    const hub = new SyncHub({ db: t.db, log: quiet, access });
    hubs.push(hub);
    const staging = new RoomyStaging(mkdtempSync(join(tmpdir(), "aq-access-")));
    const lfs = new LfsUploads({
      db: t.db,
      staging,
      hosts: RepoHosts.github(who.host),
      enqueue: async () => {},
      log: quiet,
      limits: { minChunkBytes: 1 },
      now: () => who.time.now,
    });
    const lfsDownloads = new LfsDownloads({
      db: t.db,
      hosts: RepoHosts.github(who.host),
      log: quiet,
      fetch: who.github.fetch,
      plain: true,
      now: () => who.time.now.getTime(),
    });
    const routes: { method: string; url: string; access: RouteAccess | undefined }[] = [];
    const p = await platform(who, {
      hub,
      access,
      lfs,
      lfsDownloads,
      rebuild: async () => {},
      extend: (app) => {
        app.addHook("onRoute", (route) => {
          for (const method of [route.method].flat())
            routes.push({
              method,
              url: route.url,
              access: (route.config as { access?: RouteAccess } | undefined)?.access,
            });
        });
      },
    });
    return { p, hub, routes };
  };

  /** A project of A's, saved to a repository, with a batch, a conflict, a cover and a conversation. */
  const fixture = async (): Promise<Fixture> => {
    const project = await newProject(a);
    const repo = a.github.addRepo(a.person, { name: `film-${project.id}`, select: true });
    await linkTo(a, project.id, repo);
    const [merge] = await t.db
      .insert(repoMerges)
      .values({
        projectId: project.id,
        repoId: repo.id,
        fromSha: "a",
        toSha: "b",
        state: "applied",
      })
      .returning({ id: repoMerges.id });
    const batch = merge!.id;
    await t.db.insert(projectBatches).values({
      id: batch,
      projectId: project.id,
      kind: "repo",
      mergeId: batch,
      seq: 1,
      label: "GitHub 上的改动",
      files: 1,
      writes: Buffer.from([0]),
      formatVersion: 1,
    });
    const [conflict] = await t.db
      .insert(repoConflicts)
      .values({
        projectId: project.id,
        mergeId: batch,
        batch,
        source: "merge",
        lost: "batch",
        file: "animaquill.json",
        path: ["manifest", "name"],
        label: "项目的名字",
        kind: "value",
      })
      .returning({ id: repoConflicts.id });
    await t.db.insert(projectCovers).values({
      projectId: project.id,
      bytes: webp(),
      type: "image/webp",
      etag: "e",
    });
    await t.db.insert(lfsObjects).values({ repoId: repo.id, oid: OID, size: 3 });
    // A conversation of A's, and one of B's about A's project, as there could be from before.
    for (const userId of [a.userId, b.userId])
      await t.db.insert(userChats).values({
        userId,
        projectId: project.id,
        chatId: "c1",
        revision: 1,
        summary: { id: "c1", title: "对话", updatedAt: 1 },
        body: { entries: [] },
        size: 10,
        updatedAt: new Date(),
      });
    return { id: project.id, batch, conflict: conflict!.id, repoId: repo.id };
  };

  /** Everything the database has of a project, to see that nothing of it changed. */
  const stateOf = async (id: string) => {
    const of = async (
      table:
        | typeof projectUpdates
        | typeof projectCovers
        | typeof projectBatches
        | typeof repoConflicts
        | typeof projectRepos
        | typeof userChats
        | typeof lfsUploads
        | typeof projectMarks
        | typeof repoMerges,
    ) => t.db.select().from(table).where(eq(table.projectId, id));
    return JSON.stringify({
      project: await t.db.select().from(projects).where(eq(projects.id, id)),
      deleted: await t.db.select().from(deletedProjects).where(eq(deletedProjects.id, id)),
      updates: await of(projectUpdates),
      covers: await of(projectCovers),
      batches: await of(projectBatches),
      conflicts: await of(repoConflicts),
      repos: await of(projectRepos),
      chats: await of(userChats),
      uploads: await of(lfsUploads),
      marks: await of(projectMarks),
      merges: await of(repoMerges),
    });
  };

  const sendAs = (
    p: Awaited<ReturnType<typeof serverOf>>["p"],
    route: ProjectRoute,
    f: Fixture,
  ) => {
    const body = route.raw
      ? { payload: route.raw.bytes(), type: route.raw.type }
      : route.body && { payload: JSON.stringify(route.body(f)), type: "application/json" };
    return p.send(route.method, route.url(f), {
      ...(body && { payload: body.payload }),
      headers: { ...route.headers, ...(body && { "content-type": body.type }) },
    });
  };

  const NOT_FOUND = { status: 404, json: { error: "notFound" } };
  const said = (answer: { status: number; json: unknown }) => ({
    status: answer.status,
    json: answer.json,
  });

  test("every route under /api says what it has of a project, and the tables here have each", async () => {
    const { p, routes } = await serverOf(a, OWNER_ONLY);
    // The routes are there once the server is: after its first request.
    await p.send("GET", "/api/health");
    const api = routes.filter((route) => route.url.startsWith("/api/") && route.method !== "HEAD");
    const project = api.filter((route) => route.access && "project" in route.access);
    expect(project.map(({ method, url }) => `${method} ${url}`).toSorted()).toEqual(
      PROJECT_ROUTES.map(({ method, route }) => `${method} ${route}`).toSorted(),
    );
    for (const route of PROJECT_ROUTES)
      expect(
        project.find((each) => each.method === route.method && each.url === route.route)?.access,
        `${route.method} ${route.route}`,
      ).toMatchObject({ action: route.action });
    const inside = api.filter((route) => route.access && "inside" in route.access);
    expect(inside.map(({ method, url }) => `${method} ${url}`).toSorted()).toEqual(
      INSIDE_ROUTES.toSorted(),
    );
    // The rest says why: nothing of a project.
    for (const route of api.filter((each) => each.access && "none" in each.access))
      expect(
        (route.access as { none: string }).none.length,
        `${route.method} ${route.url}`,
      ).toBeGreaterThan(5);
    expect(api.filter((route) => route.access === undefined)).toEqual([]);
    console.info(
      `access: ${api.length} routes under /api; ${project.length} name a project, ${inside.length} ask inside, ${api.length - project.length - inside.length} have none`,
    );
  });

  test("the server does not start with a route that says nothing of access", async () => {
    await expect(
      serverOf(a, OWNER_ONLY).then(async () =>
        platform(a, {
          extend: (app) => {
            app.get("/api/forgotten", async () => ({}));
          },
        }),
      ),
    ).rejects.toThrow(/says nothing of access/);
  });

  describe.each(PROJECT_ROUTES)("$method $route", (route) => {
    test("someone else's project: not there, nothing changes; with anyone let in, it gets past; the policy is asked", async () => {
      const asked: Asked[] = [];
      const denied = await serverOf(b, recording(OWNER_ONLY, asked));
      const f = await fixture();
      const before = await stateOf(f.id);
      const refused = said(await sendAs(denied.p, route, f));
      expect(refused).toEqual(NOT_FOUND);
      await denied.hub.idle();
      expect(await stateOf(f.id)).toBe(before);
      expect(asked).toContainEqual({ userId: b.userId, project: f.id, action: route.action });
      // Exactly as one that is not there.
      expect(said(await sendAs(denied.p, route, { ...f, id: `nope${f.id}` }))).toEqual(refused);

      // The same request, on a project of the same making, with the check taken away.
      const open = await serverOf(b, ANYONE);
      const g = await fixture();
      const through = said(await sendAs(open.p, route, g));
      expect(through, JSON.stringify(through)).not.toEqual(NOT_FOUND);

      // And the owner, with the platform's policy, gets past too.
      const own = await serverOf(a, OWNER_ONLY);
      const h = await fixture();
      expect(said(await sendAs(own.p, route, h))).not.toEqual(NOT_FOUND);
      console.info(
        `access: ${route.method} ${route.route} → other ${refused.status}, anyone ${through.status}`,
      );
    });
  });

  test("requests that are wrong themselves are answered for someone else's project as for one that is not there", async () => {
    const f = await fixture();
    const { p } = await serverOf(b, OWNER_ONLY);
    const json = { "content-type": "application/json" };
    const probes: {
      method: "DELETE" | "POST" | "PUT";
      url: (id: string) => string;
      payload?: string;
      headers?: Record<string, string>;
    }[] = [
      { method: "DELETE", url: (id) => `/api/projects/${id}?archived=x` },
      { method: "DELETE", url: (id) => `/api/projects/${id}` },
      {
        method: "PUT",
        url: (id) => `/api/projects/${id}/cover`,
        payload: "x",
        headers: { "content-type": "text/plain" },
      },
      {
        method: "POST",
        url: (id) => `/api/projects/${id}/archive`,
        payload: JSON.stringify({ replace: 5 }),
        headers: json,
      },
      {
        method: "POST",
        url: (id) => `/api/projects/${id}/repository/prefer`,
        payload: JSON.stringify({ prefer: 1 }),
        headers: json,
      },
      { method: "PUT", url: (id) => `/api/me/chats/${id}/c1`, payload: "{}", headers: json },
    ];
    for (const probe of probes) {
      const ask = async (id: string) =>
        said(
          await p.send(probe.method, probe.url(id), {
            ...(probe.payload !== undefined && { payload: probe.payload }),
            headers: probe.headers ?? {},
          }),
        );
      expect(await ask(f.id), `${probe.method} ${probe.url("…")}`).toEqual(
        await ask(`nope${f.id}`),
      );
    }
    // Nor do the limits of a project tell them apart.
    const covers = async (id: string) => {
      const statuses: number[] = [];
      for (let index = 0; index < 3; index++)
        statuses.push(
          (
            await p.send("PUT", `/api/projects/${id}/cover`, {
              payload: webp(),
              headers: { "content-type": "image/webp" },
            })
          ).status,
        );
      return statuses;
    };
    expect(await covers(f.id)).toEqual(await covers(`nope${f.id}`));
  });

  test("a route that says its project is in the address, and is not, stops the server", async () => {
    await expect(
      platform(a, {
        extend: (app) => {
          app.get(
            "/api/projects/:other/x",
            { config: { access: { project: "id", action: "read" } } },
            async () => ({}),
          );
        },
      }),
    ).rejects.toThrow(/no parameter :id/);
  });

  test("the hub, the service of repositories and the routes go by one policy: another with the hub is refused", async () => {
    const f = await fixture();
    const hub = new SyncHub({ db: t.db, log: quiet });
    hubs.push(hub);
    const p = await platform(b, { hub, access: ANYONE, rebuild: async () => {} });
    expect(
      (await p.send("GET", `/api/projects/${f.id}/batches/${f.batch}`)).status,
    ).toBeGreaterThanOrEqual(500);
    // With all three of the same: B is let in everywhere, the hub and the service included.
    const { p: open } = await serverOf(b, ANYONE);
    expect((await open.send("GET", `/api/projects/${f.id}/batches/${f.batch}`)).status).toBe(200);
    expect((await open.send("GET", `/api/projects/${f.id}/repository`)).status).toBe(200);
  });

  describe("the hub, asked as nothing but a route would", () => {
    test("DELETE /api/projects/:id: taking someone else's project away is not there, also with nothing to say; with anyone let in it goes", async () => {
      const f = await fixture();
      const before = await stateOf(f.id);
      const denied = await serverOf(b, OWNER_ONLY);
      const refused = said(await denied.p.send("DELETE", `/api/projects/${f.id}?discard=1`));
      expect(refused).toEqual(NOT_FOUND);
      expect(said(await denied.p.send("DELETE", `/api/projects/nope${f.id}?discard=1`))).toEqual(
        refused,
      );
      await denied.hub.idle();
      expect(await stateOf(f.id)).toBe(before);
      const open = await serverOf(b, ANYONE);
      expect((await open.p.send("DELETE", `/api/projects/${f.id}?discard=1`)).status).toBe(204);
    });

    test("batches, taking one back, taking the project away and making its copy again: someone else's are missing, without the routes", async () => {
      const f = await fixture();
      const owner = new SyncHub({ db: t.db, log: quiet });
      const anyone = new SyncHub({ db: t.db, log: quiet, access: ANYONE });
      hubs.push(owner, anyone);
      const before = await stateOf(f.id);
      expect(await owner.batchState(f.id, b.userId, f.batch)).toEqual({ kind: "missing" });
      expect(await owner.takeBack(f.id, b.userId, f.batch)).toEqual({ kind: "missing" });
      expect(await owner.remove(f.id, b.userId, { discard: true })).toBe("missing");
      expect(
        await wakeCopy(t.db, f.id, { userId: b.userId, access: OWNER_ONLY }, a.time.now),
      ).toEqual({
        copy: "missing",
      });
      await owner.idle();
      expect(await stateOf(f.id)).toBe(before);
      // The same with anyone let in: past the check, whatever comes then.
      expect((await anyone.batchState(f.id, b.userId, f.batch)).kind).not.toBe("missing");
      expect((await anyone.takeBack(f.id, b.userId, f.batch)).kind).not.toBe("missing");
      expect(await wakeCopy(t.db, f.id, { userId: b.userId, access: ANYONE }, a.time.now)).toEqual({
        copy: "live",
      });
      expect(await anyone.remove(f.id, b.userId, { discard: true })).toBe("removed");
    });
  });

  describe("what takes projects otherwise", () => {
    test("GET /api/projects: someone else's are in nobody's list but with anyone let in", async () => {
      const f = await fixture();
      const listed = async (policy: AccessPolicy) =>
        (
          (await (await serverOf(b, policy)).p.send("GET", "/api/projects")).json.projects as {
            id: string;
          }[]
        ).map((each) => each.id);
      expect(await listed(OWNER_ONLY)).not.toContain(f.id);
      expect(await listed(ANYONE)).toContain(f.id);
    });

    test("POST and GET /api/organizer: a mark of someone else's project is not kept, but with anyone let in", async () => {
      const f = await fixture();
      const mark = async (policy: AccessPolicy) => {
        const { p } = await serverOf(b, policy);
        const now = Date.now();
        const answer = await p.send("POST", "/api/organizer", {
          payload: JSON.stringify({
            now,
            account: b.userId,
            marks: [{ project: f.id, star: { starred: true, at: now } }],
          }),
          headers: { "content-type": "application/json" },
        });
        expect(answer.status).toBe(200);
        const read = await p.send("GET", "/api/organizer");
        return {
          said: answer.json.marks[0],
          marked: (read.json.marks as { project: string }[]).some((each) => each.project === f.id),
        };
      };
      const before = await stateOf(f.id);
      expect(await mark(OWNER_ONLY)).toMatchObject({ said: { missing: true }, marked: false });
      expect(await stateOf(f.id)).toBe(before);
      expect(await mark(ANYONE)).toMatchObject({ marked: true });
    });

    test("GET /api/me/lfs: what someone else's project has in the large file storage is not said", async () => {
      const f = await fixture();
      const projectsOf = async (policy: AccessPolicy) =>
        JSON.stringify((await (await serverOf(b, policy)).p.send("GET", "/api/me/lfs")).json);
      expect(await projectsOf(OWNER_ONLY)).not.toContain(f.id);
      expect(await projectsOf(ANYONE)).toContain(f.id);
    });

    test("the repositories to choose from, and checking one: the project saved to it is named only where it may be read", async () => {
      const f = await fixture();
      // A repository B's installation reaches, which A's project is saved to.
      const theirs = b.github.addRepo(b.person, { name: "shared", select: true });
      await t.db
        .update(projectRepos)
        .set({ repoId: theirs.id })
        .where(eq(projectRepos.projectId, f.id));
      const listed = async (policy: AccessPolicy) => {
        const { p } = await serverOf(b, policy);
        const list = await p.send("GET", "/api/github/repositories?page=1");
        const check = await p.send("POST", "/api/github/repositories/check", {
          payload: JSON.stringify({ existing: { id: theirs.id } }),
          headers: { "content-type": "application/json" },
        });
        return {
          list: JSON.stringify(list.json).includes(f.id),
          check: JSON.stringify(check.json).includes(f.id),
          linked: (list.json.repositories as { id: number; linked: boolean }[]).find(
            (each) => each.id === theirs.id,
          )?.linked,
        };
      };
      expect(await listed(OWNER_ONLY)).toEqual({ list: false, check: false, linked: true });
      expect(await listed(ANYONE)).toEqual({ list: true, check: true, linked: true });
    });

    test("POST /api/projects/restore: a repository saved to someone else's project is not restored over it, nor named", async () => {
      const f = await fixture();
      const theirs = b.github.addRepo(b.person, { name: "taken", select: true });
      await t.db
        .update(projectRepos)
        .set({ repoId: theirs.id })
        .where(eq(projectRepos.projectId, f.id));
      const before = await stateOf(f.id);
      const answer = await (
        await serverOf(b, OWNER_ONLY)
      ).p.send("POST", "/api/projects/restore", {
        payload: JSON.stringify({ existing: { id: theirs.id } }),
        headers: { "content-type": "application/json" },
      });
      expect(answer.status).toBe(409);
      expect(JSON.stringify(answer.json)).not.toContain(f.id);
      expect(await stateOf(f.id)).toBe(before);
      const open = await (
        await serverOf(b, ANYONE)
      ).p.send("POST", "/api/projects/restore", {
        payload: JSON.stringify({ existing: { id: theirs.id } }),
        headers: { "content-type": "application/json" },
      });
      expect(JSON.stringify(open.json)).toContain(f.id);
    });

    test("the hub's hello, to edit and to read: someone else's project is not there; with anyone let in it is", async () => {
      const f = await fixture();
      const hello = async (policy: AccessPolicy, readOnly: boolean) => {
        const asked: Asked[] = [];
        const { hub } = await serverOf(b, recording(policy, asked));
        const peer = new TestPeer(hub, { userId: b.userId, session: "s" });
        peer.send({
          t: "hello",
          v: SYNC_PROTOCOL,
          project: f.id,
          after: 0,
          device: "d1",
          window: "w1",
          editor: "dev",
          ...(readOnly && { readOnly: true }),
          payload: new Uint8Array(0),
        });
        await peer.until(
          () => peer.closedWith !== undefined || peer.of("synced").length > 0,
          "an answer",
        );
        return { closed: peer.closedWith?.code, asked };
      };
      for (const readOnly of [false, true]) {
        const before = await stateOf(f.id);
        const refused = await hello(OWNER_ONLY, readOnly);
        expect(refused.closed, String(readOnly)).toBe(SYNC_CLOSE.missing);
        expect(refused.asked).toContainEqual({
          userId: b.userId,
          project: f.id,
          action: readOnly ? "read" : "edit",
        });
        expect(await stateOf(f.id)).toBe(before);
        expect((await hello(ANYONE, readOnly)).closed, String(readOnly)).toBeUndefined();
      }
    });

    test("the hub's hello for a copy let go of: not made again for someone else, but with anyone let in", async () => {
      const f = await fixture();
      const rebuilt: string[] = [];
      const hello = async (policy: AccessPolicy) => {
        const hub = new SyncHub({
          db: t.db,
          log: quiet,
          access: policy,
          rebuild: async (id) => void rebuilt.push(id),
        });
        hubs.push(hub);
        const peer = new TestPeer(hub, { userId: b.userId, session: "s" });
        peer.send({
          t: "hello",
          v: SYNC_PROTOCOL,
          project: f.id,
          after: 0,
          device: "d1",
          window: "w1",
          editor: "dev",
          payload: new Uint8Array(0),
        });
        await peer.until(() => peer.closedWith !== undefined, "closed");
        return peer.closedWith?.code;
      };
      await t.db.update(projects).set({ copyState: "released" }).where(eq(projects.id, f.id));
      expect(await hello(OWNER_ONLY)).toBe(SYNC_CLOSE.missing);
      expect(rebuilt).toEqual([]);
      expect((await t.db.select().from(projects).where(eq(projects.id, f.id)))[0]!.copyState).toBe(
        "released",
      );
      expect(await hello(ANYONE)).not.toBe(SYNC_CLOSE.missing);
    });
  });

  test("at random: whoever asks with whichever policy, reading or writing, someone else's project is refused exactly where the policy says no", async () => {
    let seed = 20261123;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const servers = {
      a: { owner: await serverOf(a, OWNER_ONLY), anyone: await serverOf(a, ANYONE) },
      b: { owner: await serverOf(b, OWNER_ONLY), anyone: await serverOf(b, ANYONE) },
    };
    // What only reads goes on one project; what writes, on one of its own each time.
    const read = await fixture();
    for (let round = 0; round < 50; round++) {
      const route = PROJECT_ROUTES[random(PROJECT_ROUTES.length)]!;
      const who = random(2) === 0 ? "a" : "b";
      const policy = random(2) === 0 ? "owner" : "anyone";
      const f = route.method === "GET" ? read : await fixture();
      const before = await stateOf(f.id);
      const answer = said(await sendAs(servers[who][policy].p, route, f));
      const refusedByPolicy = who === "b" && policy === "owner";
      const what = `${round}: ${who} ${policy} ${route.method} ${route.route} → ${JSON.stringify(answer)}`;
      if (refusedByPolicy) {
        expect(answer, what).toEqual(NOT_FOUND);
        await servers[who][policy].hub.idle();
        expect(await stateOf(f.id), what).toBe(before);
      } else expect(answer, what).not.toEqual(NOT_FOUND);
    }
  });
});
