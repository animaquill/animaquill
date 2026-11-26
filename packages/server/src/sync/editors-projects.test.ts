import { accessGate, OWNER_ONLY } from "../access.ts";
import { SYNC_PROTOCOL } from "@animaquill/host/sync";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { browserCloudProjects, projectSummaryOf } from "../../../host/src/cloud-projects.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { TestPeer, someone } from "../test/sync-support.ts";
import type { Accounts } from "../auth/accounts.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { REQUEST_HEADER } from "../auth/guard.ts";
import { projectRepos, projects } from "../schema.ts";
import { SyncHub } from "./hub.ts";
import { projectRoutes } from "./routes.ts";
import { HOSTED_CREDENTIALS } from "../auth/credentials.ts";

/**
 * The editor's own reading of the projects of the platform (`browserCloudProjects` of
 * @animaquill/host, as the editor's site uses it) against the routes as they answer: the editor reads every
 * field by its type, and leaves out what is not of it without a word, so what the platform says has
 * to be what the editor reads. On a real PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 * In a file of the editor's own (tsconfig.editor.json), as its code needs the types of a browser:
 * so only the routes of the projects, without the rest of the API, and rows put in as the hub and
 * linking leave them.
 */

const ORIGIN = "https://editor.example.com";
const WEB = "https://github.test";
const SESSION = "a-session-of-ada-0123456789abcdef";
const quiet = { info() {}, warn() {}, error() {} };

describe.skipIf(!TEST_DATABASE)("the editor reads the projects of the platform", () => {
  let t: TestDatabase;
  let hub: SyncHub;
  let userId: string;
  let app: ReturnType<typeof Fastify>;
  let made = 0;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    userId = (await someone(t.db)).userId;
    hub = new SyncHub({ db: t.db, log: quiet });
    // Only what the routes ask of accounts: who a session is.
    const accounts = {
      session: async (id: string) => (id === SESSION ? { userId } : undefined),
    } as unknown as Accounts;
    app = Fastify();
    await app.register(projectRoutes, {
      origin: ORIGIN,
      accounts: () => accounts,
      credentials: HOSTED_CREDENTIALS,
      db: () => t.db,
      hub: () => hub,
      webUrl: WEB,
      gate: accessGate(OWNER_ONLY, () => t.db),
    });
  });
  afterEach(async () => {
    hub.stop();
    await app.close();
  });

  /**
   * The editor's requests as its page sends them: the browser adds the session and where the page
   * is from, and the editor the header the platform asks of what changes something.
   */
  const fromThePage: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET") as "GET" | "DELETE";
    const answer = await app.inject({
      method,
      url: String(input),
      headers: {
        cookie: `${SESSION_COOKIE}=${SESSION}`,
        ...(method !== "GET" && { origin: ORIGIN }),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    return new Response(answer.statusCode === 204 ? null : answer.body, {
      status: answer.statusCode,
      headers: { "content-type": "application/json" },
    });
  };
  const editor = () =>
    browserCloudProjects({
      api: (path) => `/api${path}`,
      changeHeaders: { [REQUEST_HEADER]: "1" },
      fetch: fromThePage,
    });

  /** A project of the person as the hub keeps one, changed at `at`. */
  const project = async (name: string, at: Date, owner = userId) => {
    const id = `ed${Date.now().toString(36)}n${++made}`;
    await t.db.insert(projects).values({
      id,
      ownerId: owner,
      projectId: `p-${made}`,
      name,
      head: 3,
      digest: "d",
      bytes: 1234 + made,
      createdAt: new Date(at.getTime() - 3600_000),
      updatedAt: at,
    });
    return id;
  };

  /** Its repository, as linking and archives leave the row. */
  const repository = async (
    id: string,
    repoId: number,
    more: Partial<typeof projectRepos.$inferInsert>,
  ) =>
    t.db.insert(projectRepos).values({
      projectId: id,
      installationId: 1,
      repoId,
      ownerId: 77,
      ownerLogin: "ada",
      name: `repo-${repoId}`,
      branch: "main",
      private: true,
      createdHere: true,
      ...more,
    });

  test("every field of the list is one the editor reads, as the platform said it", async () => {
    const now = Date.now();
    const base = 9_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    // Without a repository.
    const bare = await project("还没有仓库", new Date(now - 3 * 60_000));
    // Archived, with a change since, and assets an archive counted.
    const saved = await project("存好了", new Date(now - 2 * 60_000));
    await repository(saved, base + 1, {
      archivedSeq: 2,
      archivedAt: new Date(now - 10 * 60_000),
      checkedAt: new Date(now - 5 * 60_000),
    });
    await t.db
      .update(projects)
      .set({ stats: { assets: { count: 3, bytes: 4096, elsewhere: 2 } } })
      .where(eq(projects.id, saved));
    // Paused, public, and its working copy not here.
    const paused = await project("停住了", new Date(now - 60_000));
    await repository(paused, base + 2, {
      private: false,
      state: "paused",
      pauseReason: "gone",
      archivedSeq: 3,
      archivedAt: new Date(now - 20 * 60_000),
      checkedAt: new Date(now - 15 * 60_000),
    });
    await t.db.update(projects).set({ copyState: "released" }).where(eq(projects.id, paused));

    const answer = await app.inject({
      url: "/api/projects",
      headers: { cookie: `${SESSION_COOKIE}=${SESSION}` },
    });
    expect(answer.statusCode).toBe(200);
    const said = (answer.json() as { projects: Record<string, any>[] }).projects;
    expect(said.map((each) => each["id"])).toEqual([paused, saved, bare]);
    // Each as the editor's own reader has it: nothing left out, nothing read as something else.
    for (const each of said) expect(projectSummaryOf(each), each["name"]).toEqual(each);
    const read = await editor().list();
    expect(read).toEqual(said);

    // And by the types the editor asks for, field by field.
    for (const each of said) {
      expect(typeof each["id"]).toBe("string");
      expect(typeof each["name"]).toBe("string");
      expect(Number.isFinite(each["updatedAt"])).toBe(true);
      expect(Number.isFinite(each["createdAt"])).toBe(true);
      expect(typeof each["copy"]).toBe("string");
      expect(Number.isFinite(each["size"].documents)).toBe(true);
    }
    for (const each of said.slice(0, 2)) {
      expect(Number.isFinite(each["repository"].id)).toBe(true);
      expect(typeof each["repository"].owner).toBe("string");
      expect(typeof each["repository"].name).toBe("string");
      expect(typeof each["repository"].fullName).toBe("string");
      expect(typeof each["repository"].private).toBe("boolean");
      expect(typeof each["repository"].url).toBe("string");
      expect(Number.isFinite(each["repository"].checkedAt)).toBe(true);
      expect(Number.isFinite(each["archive"].at)).toBe(true);
      expect(Number.isFinite(each["archive"].seq)).toBe(true);
      expect(typeof each["archive"].behind).toBe("boolean");
    }
    // What the start page goes by: what is there, in milliseconds, and nothing where it is not so.
    expect(read[2]).toEqual({
      id: bare,
      name: "还没有仓库",
      createdAt: now - 3 * 60_000 - 3600_000,
      updatedAt: now - 3 * 60_000,
      copy: "live",
      size: { documents: said[2]!["size"].documents },
      attention: "noRepository",
    });
    expect(read[1]).toEqual({
      id: saved,
      name: "存好了",
      createdAt: now - 2 * 60_000 - 3600_000,
      updatedAt: now - 2 * 60_000,
      copy: "live",
      size: {
        documents: said[1]!["size"].documents,
        assets: { count: 3, bytes: 4096, elsewhere: 2 },
      },
      repository: {
        id: base + 1,
        owner: "ada",
        name: `repo-${base + 1}`,
        fullName: `ada/repo-${base + 1}`,
        private: true,
        url: `${WEB}/ada/repo-${base + 1}`,
        state: "ready",
        checkedAt: now - 5 * 60_000,
      },
      archive: { at: now - 10 * 60_000, seq: 2, behind: true },
    });
    expect(read[0]).toEqual({
      id: paused,
      name: "停住了",
      createdAt: now - 60_000 - 3600_000,
      updatedAt: now - 60_000,
      copy: "released",
      size: { documents: said[0]!["size"].documents },
      repository: {
        id: base + 2,
        owner: "ada",
        name: `repo-${base + 2}`,
        fullName: `ada/repo-${base + 2}`,
        private: false,
        url: `${WEB}/ada/repo-${base + 2}`,
        state: "paused",
        reason: "gone",
        checkedAt: now - 15 * 60_000,
      },
      archive: { at: now - 20 * 60_000, seq: 3, behind: false },
      attention: "repository",
    });
  });

  test("taking a project away answers in the words the editor knows", async () => {
    const now = new Date();
    const mine = await project("我的", now);
    const linked = await project("有仓库", now);
    await repository(linked, 8_000_000 + Math.floor(Math.random() * 1_000_000), {});
    const theirs = await project("别人的", now, (await someone(t.db)).userId);
    // A window of the editor is connected to the one that goes.
    await t.db.update(projects).set({ head: 0, digest: "" }).where(eq(projects.id, mine));
    const peer = new TestPeer(hub, { userId, session: "s" });
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: mine,
      after: 0,
      generation: 1,
      device: "d1",
      window: "w1",
      editor: "test",
      payload: new Uint8Array(0),
    });
    await peer.until(() => peer.of("synced").length > 0, "synced");

    const cloud = editor();
    expect(await cloud.remove(linked)).toBe("hasRepository");
    expect(await cloud.remove(theirs)).toBe("missing");
    expect(await cloud.remove("no-such-project")).toBe("missing");
    expect(await cloud.remove(mine)).toBe("removed");
    // Again, as an editor that asks twice to be sure: there is none, and none comes back.
    expect(await cloud.remove(mine)).toBe("missing");
    expect((await cloud.list()).map((each) => each.id)).toEqual([linked]);
    // The window heard what stops an editor.
    expect((await peer.connection.closed).code).toBe(4410);
  });
});
