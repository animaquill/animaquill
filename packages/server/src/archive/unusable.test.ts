import { mergeUpdates } from "@animaquill/core";
import { SYNC_CLOSE, SYNC_PROTOCOL } from "@animaquill/host/sync";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { edit, newProject, quiet, world, write, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { TestPeer } from "../test/sync-support.ts";
import {
  deletedProjects,
  installations,
  projectRepos,
  projects,
  type PauseReason,
} from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import type { ReleaseSwitches } from "../switches.ts";
import { listenForLinks } from "../sync/link-listener.ts";
import { recheckDue, sweepProjects } from "../sync/sweep.ts";
import { CONFIRM_AFTER_MS } from "./archiver.ts";
import {
  checkUnusableSwitches,
  deleteAtOf,
  isUnusable,
  pauseLink,
  UNUSABLE_REASONS,
} from "./links.ts";
import { recheckLink } from "./recheck.ts";

/**
 * A project whose repository cannot be used: which pauses say so and since when, that such a
 * project is not edited, that a window may still read it, that it goes seven days on once GitHub
 * says so again, and that archives failing for GitHub's or the platform's sake are told from the
 * rest. On a real PostgreSQL, the fake GitHub and a hub. Needs AQ_TEST_DATABASE, see
 * vitest.config.ts.
 */

/** The switch of a release that takes no project away. */
const OFF: ReleaseSwitches = { deletesFrom: undefined };

/** The editor of the windows. */
const NEW = "0.3.60";
const DAY = 24 * 3600_000;

describe("the switches of a project that cannot be edited", () => {
  test("seven days on, and never before seven days after taking projects away began", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    // Nothing goes while none is taken away: no time to say.
    expect(deleteAtOf(since, undefined)).toBeUndefined();
    expect(deleteAtOf(since, "2026-10-01T00:00:00Z")!.getTime()).toBe(since.getTime() + 7 * DAY);
    expect(deleteAtOf(since, "2026-11-20T00:00:00Z")!.toISOString()).toBe(
      "2026-11-27T00:00:00.000Z",
    );
  });

  test("a switch written wrong stops the API as it starts, rather than counting as off", () => {
    for (const deletesFrom of [
      "2026-11-20T00:00:00Z",
      "2026-11-20T08:30Z",
      "2026-11-20T08:30:00.000Z",
      undefined,
    ])
      expect(() => checkUnusableSwitches({ deletesFrom }), deletesFrom).not.toThrow();
    for (const deletesFrom of [
      "",
      "2026-11-20",
      "2026-11-20T00:00:00",
      "2026-11-20T00:00:00+08:00",
      "2026-13-40T00:00:00Z",
      "tomorrow",
    ])
      expect(() => checkUnusableSwitches({ deletesFrom }), deletesFrom).toThrow(/deletesFrom/);
  });

  test("four pauses say that the repository cannot be used, and no other", () => {
    expect([...UNUSABLE_REASONS].toSorted()).toEqual([
      "gone",
      "suspended",
      "transferred",
      "uninstalled",
    ]);
    for (const other of ["diverged", "archived", "protected", "manifest", "invalid", null])
      expect(isUnusable(other as PauseReason | null), String(other)).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE)("a project whose repository cannot be used, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  /** A hub that keeps such projects from being edited, as once editors know it. */
  let hub: SyncHub;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    w.github.repositoryEvents = true;
    hub = new SyncHub({ db: t.db, log: quiet });
    p = await platform(w, { hub });
  });
  afterEach(() => {
    hub.stop();
  });

  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0];
  const rowOf = async (id: string) =>
    (await t.db.select().from(projects).where(eq(projects.id, id)))[0];
  const tombOf = async (id: string) =>
    (await t.db.select().from(deletedProjects).where(eq(deletedProjects.id, id)))[0];
  const setLink = (id: string, values: Partial<typeof projectRepos.$inferInsert>) =>
    t.db.update(projectRepos).set(values).where(eq(projectRepos.projectId, id));

  /** A project with a change, saved to a new repository, and archived. */
  const archived = async (name: string) => {
    // What earlier steps queued is done with by now.
    p.queued.length = 0;
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const linked = await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name },
    });
    expect(linked.status).toBe(201);
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    w.github.takeDeliveries();
    const repo = [...w.github.repos.values()].find((each) => each.name === name)!;
    return { project, repo };
  };

  /** Takes the repository out of what the App may touch, as people do on GitHub, and says so. */
  const takeOut = async (repoId: number) => {
    w.github.unselect(repoId);
    expect(await p.deliver()).toEqual([204]);
  };

  /**
   * Archives find the repository gone, without a word from GitHub: the second one, a few minutes
   * after the first, says so.
   */
  const foundGone = async (id: string) => {
    expect(await w.archiver().run(id, "auto")).toMatchObject({ kind: "failed" });
    expect((await linkOf(id))!.unusableSince).toBeNull();
    w.time.later(CONFIRM_AFTER_MS);
    expect(await w.archiver().run(id, "auto")).toMatchObject({ kind: "paused", reason: "gone" });
  };

  /** Puts it back without GitHub saying so, as a delivery that was lost. */
  const putBackQuietly = (repoId: number) => {
    w.github.installed.get(w.person.id)!.repos.add(repoId);
  };

  const hello = (
    hubOf: SyncHub,
    id: string,
    editor: string,
    more: { readonly readOnly?: boolean; readonly after?: number } = {},
  ) => {
    const peer = new TestPeer(hubOf, { userId: w.userId, session: "s" });
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: id,
      after: more.after ?? 0,
      device: "d2",
      window: "w2",
      editor,
      ...(more.readOnly !== undefined && { readOnly: more.readOnly }),
      payload: new Uint8Array(0),
    });
    return peer;
  };
  const connect = async (hubOf: SyncHub, id: string, editor: string, readOnly?: boolean) => {
    const peer = hello(hubOf, id, editor, readOnly === undefined ? {} : { readOnly });
    await peer.until(() => peer.of("synced").length > 0, "synced");
    return peer;
  };
  /** How a connection closed, or undefined where it is still open a moment from now. */
  const closeOf = (peer: TestPeer) =>
    Promise.race([
      peer.connection.closed,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
    ]);
  /** A change of the project sent on a window: resolves to it, as the window keeps it. */
  const push = (
    peer: TestPeer,
    project: Awaited<ReturnType<typeof newProject>>,
    base: number,
    kind: "user" | "ai" = "user",
    payload = project.editor.change(write(`code/${kind}.js`, `${kind}\n`)),
  ) => {
    peer.send({
      t: "push",
      id: 1,
      kind,
      base,
      at: Date.now(),
      window: "w2",
      behind: false,
      payload,
    });
    return payload;
  };

  // Six repositories in a row, each archived first: about 9 s alone, over 30 s while the rest of
  // the tests run beside it (ci-local, 2026-11-23).
  test("taken out, uninstalled, suspended or moved, a repository cannot be used from when that was first found; anything else is no such thing", async () => {
    const out = await archived("out");
    const at = w.time.now;
    await takeOut(out.repo.id);
    expect(await linkOf(out.project.id)).toMatchObject({
      pauseReason: "gone",
      unusableSince: at,
    });

    const moved = await archived("moved");
    w.github.transfer(moved.repo.id, { id: w.person.id + 7, login: "someone" });
    // Moving tells the account it went to; here that is what an archive finds.
    w.github.takeDeliveries();
    await edit(w, moved.project, write("code/a.js", "moved\n"));
    await foundGone(moved.project.id);
    expect((await linkOf(moved.project.id))!.unusableSince).toEqual(w.time.now);

    // An archive that finds the repository gone, without a word from GitHub.
    const quiet2 = await archived("quiet");
    w.github.deleteRepo(quiet2.repo.id);
    w.github.takeDeliveries();
    await edit(w, quiet2.project, write("code/a.js", "gone\n"));
    await foundGone(quiet2.project.id);
    expect((await linkOf(quiet2.project.id))!.unusableSince).toEqual(w.time.now);

    // Every other pause leaves the project to be edited.
    for (const reason of ["diverged", "archived", "protected", "manifest", "invalid"] as const) {
      const other = await archived(`other-${reason}`);
      await pauseLink(
        t.db,
        { projectId: other.project.id, repoId: other.repo.id },
        {
          reason,
          detail: reason,
          at,
        },
      );
      expect((await linkOf(other.project.id))!.unusableSince, reason).toBeNull();
    }
    const archivedOnGitHub = await archived("read-only");
    w.github.setArchived(archivedOnGitHub.repo.id, true);
    await p.deliver();
    expect(await linkOf(archivedOnGitHub.project.id)).toMatchObject({
      pauseReason: "archived",
      unusableSince: null,
    });

    // The App uninstalled, and suspended on the account of another person: every link of it.
    const project = await archived("uninstalled");
    w.time.later(60_000);
    w.github.uninstall(w.person);
    await p.deliver();
    expect(await linkOf(project.project.id)).toMatchObject({
      pauseReason: "uninstalled",
      unusableSince: w.time.now,
    });
    // One that could not be used before keeps its reason and its time.
    expect(await linkOf(out.project.id)).toMatchObject({ pauseReason: "gone", unusableSince: at });
  }, 90_000);

  test("suspended, also where archiving had paused for another reason", async () => {
    const { project, repo } = await archived("diverging");
    await pauseLink(
      t.db,
      { projectId: project.id, repoId: repo.id },
      {
        reason: "diverged",
        detail: "files changed",
        at: w.time.now,
      },
    );
    w.github.suspend(w.person);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({
      pauseReason: "suspended",
      unusableSince: w.time.now,
    });
    // Unsuspended: back to normal, and the archive finds what else is the matter, if anything.
    w.time.later(60_000);
    w.github.suspend(w.person, false);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "ready", unusableSince: null });
  });

  test("another reason later does not count again; back to normal ends it, and the next time counts anew", async () => {
    const { project, repo } = await archived("timer");
    const first = w.time.now;
    await takeOut(repo.id);
    expect((await linkOf(project.id))!.unusableSince).toEqual(first);
    // Days later GitHub says it is on another account now: another reason, the same time.
    w.time.later(3 * DAY);
    await p.deliver([
      {
        event: "repository",
        payload: {
          action: "transferred",
          repository: {
            id: repo.id,
            name: repo.name,
            owner: { id: w.person.id + 9, login: "elsewhere" },
          },
          installation: { id: w.installation },
        },
      },
    ]);
    expect(await linkOf(project.id)).toMatchObject({
      pauseReason: "transferred",
      unusableSince: first,
    });
    // And GitHub saying it was deleted, which pauses whatever was paused.
    w.time.later(DAY);
    await p.deliver([
      {
        event: "repository",
        payload: { action: "deleted", repository: { id: repo.id, name: repo.name } },
      },
    ]);
    expect(await linkOf(project.id)).toMatchObject({
      pauseReason: "gone",
      goneCause: "deleted",
      unusableSince: first,
    });
    // Back on the account it was linked on, and in what the App may touch: normal again.
    w.github.select(repo.id);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "ready", unusableSince: null });
    // Later taken out again: counted from then.
    w.time.later(DAY);
    await takeOut(repo.id);
    expect((await linkOf(project.id))!.unusableSince).toEqual(w.time.now);
  });

  test("the list and the status say since when and until when, and what needs people", async () => {
    const { project, repo } = await archived("listed");
    await takeOut(repo.id);
    const since = (await linkOf(project.id))!.unusableSince!;
    // Where the platform takes such projects away, when this one goes.
    const FROM = "2026-01-01T00:00:00Z";
    const on = await platform(w, {
      hub,
      switches: { deletesFrom: FROM },
    });
    const deleteAt = since.getTime() + 7 * DAY;
    expect(
      (await on.request("GET", `/api/projects/${project.id}/repository`)).json.unusable,
    ).toMatchObject({ since: since.getTime(), deleteAt });
    const listedOn = (await on.request("GET", "/api/projects")).json.projects;
    expect(listedOn[0]).toMatchObject({
      attention: "unusable",
      repository: { unusable: { deleteAt } },
    });
    // Where it takes none away: no time is said for it. How it is gone, as GitHub said: taken out
    // of what the App may reach.
    p = await platform(w, { hub, switches: OFF });
    const unusable = { reason: "gone", since: since.getTime(), gone: "unauthorized" };
    const status = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(status.json).toMatchObject({ state: "paused", reason: "gone" });
    expect(status.json.unusable).toEqual(unusable);
    const listed = (await p.request("GET", "/api/projects")).json.projects;
    expect(listed).toMatchObject([
      { id: project.id, repository: { state: "paused", reason: "gone" } },
    ]);
    expect(listed[0].repository.unusable).toEqual(unusable);
    expect(listed[0].attention).toBe("unusable");
    // Normal again: nothing of it.
    w.github.select(repo.id);
    await p.deliver();
    const back = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(back.json.unusable).toBeUndefined();
    expect(
      (await p.request("GET", "/api/projects")).json.projects[0].repository,
    ).not.toHaveProperty("unusable");
  });

  test("windows that edit it close as it is found, hearing why; one that reads stays", async () => {
    const { project, repo } = await archived("closing");
    const fresh = await connect(hub, project.id, NEW);
    const reading = await connect(hub, project.id, NEW, true);
    const head = (await rowOf(project.id))!.head;
    await takeOut(repo.id);
    // As the listener says it, see the test of it below.
    const noted = hub.linkChanged(project.id);
    // A change on its way as it is found, made by AI: not taken, and the window has it still.
    const kept = push(fresh, project, head, "ai");
    await noted;
    expect(await closeOf(fresh)).toEqual({
      code: SYNC_CLOSE.unusable,
      reason: "gone",
    });
    expect(await closeOf(reading)).toBeUndefined();
    expect(fresh.of("ack")).toEqual([]);
    expect((await rowOf(project.id))!.head).toBe(head);

    // Saying hello for it again is turned away the same, before anything is sent.
    for (const [editor, code] of [
      [NEW, SYNC_CLOSE.unusable],
      ["dev", SYNC_CLOSE.unusable],
    ] as const) {
      const again = hello(hub, project.id, editor);
      expect((await closeOf(again))?.code, editor).toBe(code);
      expect(again.of("welcome"), editor).toEqual([]);
    }
    expect((await rowOf(project.id))!.head).toBe(head);

    // Normal again: editing goes on.
    w.github.select(repo.id);
    await p.deliver();
    await hub.linkChanged(project.id);
    const back = await connect(hub, project.id, NEW);
    // What it kept goes now, with what came since.
    const next = project.editor.change(write("code/user.js", "user\n"));
    push(back, project, head, "user", mergeUpdates([kept, next]));
    await back.until(() => back.of("ack").length > 0, "ack");
    expect((await rowOf(project.id))!.head).toBe(head + 1);
  });

  test("the hub hears of it from the database, whichever process found it", async () => {
    const { project, repo } = await archived("heard");
    const listening = listenForLinks(t.db, hub, quiet, { retryMs: 50 });
    try {
      await listening.ready;
      const window = await connect(hub, project.id, NEW);
      // The worker finds it gone, without a word from GitHub.
      w.github.unselect(repo.id);
      w.github.takeDeliveries();
      await edit(w, project, write("code/a.js", "found\n"));
      await foundGone(project.id);
      await vi.waitFor(
        () => expect(window.closedWith).toEqual({ code: SYNC_CLOSE.unusable, reason: "gone" }),
        { timeout: 5000 },
      );
    } finally {
      await listening.stop();
    }
  });

  test("a window may read it, which is not opening it; it sends nothing, and makes nothing", async () => {
    const { project, repo } = await archived("reading");
    await takeOut(repo.id);
    const openedAt = new Date(Date.now() - 5 * 3600_000);
    await t.db.update(projects).set({ openedAt }).where(eq(projects.id, project.id));
    const reading = await connect(hub, project.id, NEW, true);
    expect(reading.of("welcome")).toHaveLength(1);
    // After what a window that opens it does once it has everything.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await rowOf(project.id))!.openedAt).toEqual(openedAt);
    const head = (await rowOf(project.id))!.head;
    push(reading, project, head);
    expect((await closeOf(reading))?.code).toBe(SYNC_CLOSE.protocol);
    expect((await rowOf(project.id))!.head).toBe(head);

    // Nothing is made for one that only reads.
    const making = new TestPeer(hub, { userId: w.userId, session: "s" });
    making.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: "never-made-1",
      after: 0,
      device: "d2",
      window: "w2",
      editor: NEW,
      readOnly: true,
      create: { name: "x", projectId: "p1" },
      payload: new Uint8Array(0),
    });
    expect((await closeOf(making))?.code).toBe(SYNC_CLOSE.protocol);
    expect(await rowOf("never-made-1")).toBeUndefined();

    // A project the platform let go of has nothing to read.
    await t.db.update(projects).set({ copyState: "released" }).where(eq(projects.id, project.id));
    hub.stop();
    hub = new SyncHub({ db: t.db, log: quiet });
    const nothing = hello(hub, project.id, NEW, { readOnly: true });
    expect(await closeOf(nothing)).toEqual({ code: SYNC_CLOSE.unusable, reason: "released" });
  });

  test("a window that opens a project has its repository looked at, where nobody did for an hour", async () => {
    const asked: string[] = [];
    const looking = new SyncHub({
      db: t.db,
      log: quiet,
      lookAgain: async (id) => void asked.push(id),
    });
    try {
      /** After what a window that connected does once it has everything. */
      const settled = () => new Promise((resolve) => setTimeout(resolve, 200));
      const { project } = await archived("look");
      await setLink(project.id, { checkedAt: new Date(Date.now() - 2 * 3600_000) });
      await connect(looking, project.id, NEW);
      await vi.waitFor(() => expect(asked).toEqual([project.id]));
      // Not again from the next window, nor from one that only reads.
      await connect(looking, project.id, NEW);
      await connect(looking, project.id, NEW, true);
      await settled();
      expect(asked).toEqual([project.id]);
      // One looked at lately is not.
      const recent = await archived("recent");
      await setLink(recent.project.id, { checkedAt: new Date(Date.now() - 50 * 60_000) });
      await connect(looking, recent.project.id, NEW);
      await settled();
      expect(asked).toEqual([project.id]);
    } finally {
      looking.stop();
    }
  });

  test("people delete it without more ado", async () => {
    const { project, repo } = await archived("people");
    await edit(w, project, write("code/a.js", "never archived\n"));
    const window = await connect(hub, project.id, NEW);
    await takeOut(repo.id);
    // As the editor out now asks: what it saw archived is not all there is, and it is paused.
    const asked = await p.send("DELETE", `/api/projects/${project.id}?archived=2`);
    expect(asked.status).toBe(409);
    expect(asked.json).toMatchObject({ error: "notArchived", state: "paused", reason: "gone" });
    // Without saying more: it goes, nothing looked at.
    expect((await p.send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect(await rowOf(project.id)).toBeUndefined();
    expect(await tombOf(project.id)).toBeDefined();
    expect((await closeOf(window))?.code).toBe(SYNC_CLOSE.deleted);
    // One whose repository can be used does not, as before.
    const fine = await archived("fine");
    expect((await p.send("DELETE", `/api/projects/${fine.project.id}`)).json).toEqual({
      error: "hasRepository",
    });
  });

  describe("seven days on", () => {
    const FROM = "2026-01-01T00:00:00Z";
    const sweep = (
      options: { readonly deletesFrom?: string | undefined; readonly lookAgain?: string[] } = {},
    ) =>
      sweepProjects({
        db: t.db,
        hub,
        log: quiet,
        recheck: (link) => recheckLink(t.db, w.host, link, w.time.now, w.app),
        lookAgain: async (id) => void options.lookAgain?.push(id),
        deletesFrom: "deletesFrom" in options ? options.deletesFrom : FROM,
        now: () => w.time.now,
      });
    /** Found unusable `days` ago. */
    const foundAgo = (id: string, days: number) =>
      setLink(id, { unusableSince: new Date(w.time.now.getTime() - days * DAY) });

    test("one that GitHub still says cannot be used goes, as people delete it", async () => {
      const { project, repo } = await archived("goes");
      const window = await connect(hub, project.id, NEW, true);
      w.github.deleteRepo(repo.id);
      await p.deliver();
      await foundAgo(project.id, 7.1);
      expect(await sweep()).toMatchObject({ removed: 1, back: 0, unknown: 0 });
      expect(await rowOf(project.id)).toBeUndefined();
      expect(await linkOf(project.id)).toBeUndefined();
      expect(await tombOf(project.id)).toMatchObject({ ownerId: w.userId });
      expect((await closeOf(window))?.code).toBe(SYNC_CLOSE.deleted);
      // Swept again: nothing more.
      expect(await sweep()).toMatchObject({ removed: 0 });
    });

    test("one that can be used again by now stays, and its time is over, also without a word from GitHub", async () => {
      const { project, repo } = await archived("back");
      await takeOut(repo.id);
      putBackQuietly(repo.id);
      await foundAgo(project.id, 8);
      const looked: string[] = [];
      expect(await sweep({ lookAgain: looked })).toMatchObject({ removed: 0, back: 1 });
      expect(await rowOf(project.id)).toBeDefined();
      expect(await linkOf(project.id)).toMatchObject({ state: "ready", unusableSince: null });
      expect(looked).toEqual([project.id]);
      expect(await tombOf(project.id)).toBeUndefined();
    });

    test("nothing goes where GitHub cannot be asked, until it can", async () => {
      const { project, repo } = await archived("unknown");
      await takeOut(repo.id);
      await foundAgo(project.id, 9);
      w.github.faults.unreachable = true;
      expect(await sweep()).toMatchObject({ removed: 0, unknown: 1 });
      w.github.faults.unreachable = false;
      w.github.faults.down = 10;
      expect(await sweep()).toMatchObject({ removed: 0, unknown: 1 });
      expect(await rowOf(project.id)).toBeDefined();
      w.github.faults.down = 0;
      expect(await sweep()).toMatchObject({ removed: 1 });
    });

    test("nothing goes before its time, nor before taking projects away began, nor while that is off", async () => {
      const { project, repo } = await archived("early");
      await takeOut(repo.id);
      await foundAgo(project.id, 6.9);
      expect(await sweep()).toMatchObject({ removed: 0, unknown: 0 });
      await foundAgo(project.id, 30);
      // Off, as until the release whose editor tells people.
      expect(await sweep({ deletesFrom: undefined })).toMatchObject({ removed: 0, unknown: 0 });
      // Began three days ago: four more to go, also for one found a month ago.
      const lately = new Date(w.time.now.getTime() - 3 * DAY).toISOString();
      expect(await sweep({ deletesFrom: lately })).toMatchObject({ removed: 0, unknown: 0 });
      expect(await rowOf(project.id)).toBeDefined();
      expect(await sweep()).toMatchObject({ removed: 1 });
    });

    test("the App uninstalled: what the account has now is asked, and one installed again counts", async () => {
      const { project, repo } = await archived("reinstalled");
      w.github.uninstall(w.person);
      await p.deliver();
      expect(await linkOf(project.id)).toMatchObject({ pauseReason: "uninstalled" });
      await foundAgo(project.id, 8);
      // Installed again, which the platform knows of, but the delivery did not say for this link.
      const again = w.github.install(w.person, "selected", [repo.id]);
      w.github.takeDeliveries();
      await t.db.insert(installations).values({
        id: again,
        accountId: w.person.id,
        accountLogin: w.person.login,
        accountType: "User",
        repositorySelection: "selected",
      });
      expect(await sweep()).toMatchObject({ removed: 0, back: 1 });
      expect(await linkOf(project.id)).toMatchObject({
        state: "ready",
        installationId: again,
        unusableSince: null,
      });
    });
  });

  test("people check again: GitHub is asked now, at most once a minute", async () => {
    const { project, repo } = await archived("check");
    await takeOut(repo.id);
    const since = (await linkOf(project.id))!.unusableSince;
    const check = () => p.request("POST", `/api/projects/${project.id}/repository/check`);
    const still = await check();
    expect(still.status).toBe(200);
    expect(still.json).toMatchObject({
      state: "paused",
      reason: "gone",
      unusable: { reason: "gone" },
    });
    expect((await linkOf(project.id))!.unusableSince).toEqual(since);
    const soon = await check();
    expect(soon.status).toBe(429);
    expect(soon.json).toEqual({ error: "busy" });
    expect(Number(soon.headers["retry-after"])).toBeGreaterThan(0);

    const other = await archived("check-back");
    await takeOut(other.repo.id);
    putBackQuietly(other.repo.id);
    w.github.faults.unreachable = true;
    const away = await p.request("POST", `/api/projects/${other.project.id}/repository/check`);
    expect(away.status).toBe(503);
    expect(away.json).toEqual({ error: "unavailable" });
    w.github.faults.unreachable = false;
    // A minute later it is asked again, and can be used.
    const later = await archived("check-later");
    await takeOut(later.repo.id);
    putBackQuietly(later.repo.id);
    p.queued.length = 0;
    const back = await p.request("POST", `/api/projects/${later.project.id}/repository/check`);
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ state: "ready" });
    expect(back.json.unusable).toBeUndefined();
    expect(p.queued).toEqual([{ project: later.project.id, kind: "check" }]);
    expect((await p.request("POST", `/api/projects/${project.id}/repository/check`)).status).toBe(
      429,
    );
    const none = await newProject(w);
    expect((await p.request("POST", `/api/projects/${none.id}/repository/check`)).json).toEqual({
      error: "notLinked",
    });
  });

  test("archives that fail for GitHub's or the platform's sake are noted from the first, until one gets through", async () => {
    const { project } = await archived("failing");
    await edit(w, project, write("code/a.js", "b\n"));
    w.github.faults.down = 100;
    const first = w.time.now;
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "failed" });
    expect((await linkOf(project.id))!.transientSince).toEqual(first);
    // Editors hear since when, to tell people once it fails for long.
    const failing = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(failing.json.failingSince).toBe(first.getTime());
    const listedFailing = (await p.request("GET", "/api/projects")).json.projects;
    const failingOne = listedFailing.find((each: { id: string }) => each.id === project.id);
    expect(failingOne.archive).toMatchObject({ failingSince: first.getTime() });
    w.time.later(10 * 60_000);
    w.github.faults.limited = 1;
    w.github.faults.down = 0;
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "failed" });
    expect((await linkOf(project.id))!.transientSince).toEqual(first);
    w.github.faults.unreachable = true;
    w.time.later(10 * 60_000);
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "failed" });
    expect((await linkOf(project.id))!.transientSince).toEqual(first);
    w.github.faults.unreachable = false;
    w.time.later(10 * 60_000);
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect((await linkOf(project.id))!.transientSince).toBeNull();
    const through = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(through.json.failingSince).toBeUndefined();
    const listedThrough = (await p.request("GET", "/api/projects")).json.projects;
    const throughOne = listedThrough.find((each: { id: string }) => each.id === project.id);
    expect(throughOne.archive.failingSince).toBeUndefined();

    // A pause is for people: no such note.
    w.github.faults.down = 100;
    await edit(w, project, write("code/a.js", "c\n"));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "failed" });
    expect((await linkOf(project.id))!.transientSince).not.toBeNull();
    w.github.faults.down = 0;
    w.github.setArchived([...w.github.repos.values()].find((r) => r.name === "failing")!.id, true);
    w.github.takeDeliveries();
    w.time.later(10 * 60_000);
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({
      kind: "paused",
      reason: "archived",
    });
    expect((await linkOf(project.id))!.transientSince).toBeNull();
  });

  test("archives failing for three days are said to admins", async () => {
    const { project } = await archived("long");
    const errors: object[] = [];
    const log = { ...quiet, error: (said: object) => void errors.push(said) };
    await setLink(project.id, { transientSince: new Date(w.time.now.getTime() - 2.9 * DAY) });
    const swept = () =>
      sweepProjects({ db: t.db, hub, log, recheck: undefined, now: () => w.time.now });
    expect(await swept()).toMatchObject({ failingLong: 0 });
    expect(errors).toEqual([]);
    await setLink(project.id, { transientSince: new Date(w.time.now.getTime() - 3.1 * DAY) });
    expect((await swept()).failingLong).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([
      expect.objectContaining({ projects: expect.arrayContaining([project.id]) }),
    ]);
  });

  test("what GitHub says of a repository is in the log: renamed, moved, made public or private", async () => {
    const infos: { said: object; message: string | undefined }[] = [];
    const logged = await platform(w, {
      hub,
      log: {
        ...quiet,
        info: (said: object, message?: string) => void infos.push({ said, message }),
      },
    });
    const { project, repo } = await archived("told");
    w.github.setPrivate(repo.id, false);
    w.github.rename(repo.id, "told-again");
    await logged.deliver();
    expect((await linkOf(project.id))!.name).toBe("told-again");
    expect(
      infos
        .filter(({ message }) => message === "GitHub says the repository of a project changed")
        .map(({ said }) => said),
    ).toEqual([
      { project: project.id, repo: repo.id, action: "publicized" },
      { project: project.id, repo: repo.id, action: "renamed" },
    ]);
  });

  describe("after the review (docs: /root/aq-work/p1-review-result.md)", () => {
    /** Where no project is taken away. */
    let off: SyncHub;
    let q: Platform;
    beforeEach(async () => {
      off = new SyncHub({ db: t.db, log: quiet, ...OFF });
      q = await platform(w, { hub: off, switches: OFF });
    });
    afterEach(() => {
      off.stop();
    });

    test("the App installed again, its webhook lost: checking again finds it, and nothing goes", async () => {
      const { project, repo } = await archived("reinstall-lost");
      w.github.uninstall(w.person);
      await p.deliver();
      expect(await linkOf(project.id)).toMatchObject({ pauseReason: "uninstalled" });
      // Installed again on GitHub, the repository selected; "installation created" is lost.
      const again = w.github.install(w.person, "selected", [repo.id]);
      w.github.takeDeliveries();
      const checked = await p.request("POST", `/api/projects/${project.id}/repository/check`);
      expect(checked.status).toBe(200);
      expect(checked.json).toMatchObject({ state: "ready" });
      expect(checked.json.unusable).toBeUndefined();
      expect(await linkOf(project.id)).toMatchObject({
        installationId: again,
        unusableSince: null,
      });
      // The platform knows the installation now, as from the webhook.
      expect(
        await t.db.select().from(installations).where(eq(installations.id, again)),
      ).toMatchObject([{ accountId: w.person.id }]);
      // And the sweep, seven days on, which asks the same: nothing goes.
      const other = await archived("reinstall-sweep");
      w.github.uninstall(w.person);
      await p.deliver();
      w.github.install(w.person, "selected", [other.repo.id]);
      w.github.takeDeliveries();
      await setLink(other.project.id, {
        unusableSince: new Date(w.time.now.getTime() - 8 * DAY),
      });
      const swept = await sweepProjects({
        db: t.db,
        hub,
        log: quiet,
        recheck: (link) => recheckLink(t.db, w.host, link, w.time.now, w.app),
        deletesFrom: "2026-01-01T00:00:00Z",
        now: () => w.time.now,
      });
      expect(swept).toMatchObject({ removed: 0, back: 1 });
      expect(await rowOf(other.project.id)).toBeDefined();
    });

    test("linking holds nothing of the database while GitHub makes the repository", async () => {
      const many = 10;
      const made = await Promise.all(Array.from({ length: many }, () => newProject(w)));
      q.intercept(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if ((init?.method ?? "GET") === "POST" && url.endsWith("/user/repos"))
          await new Promise((resolve) => setTimeout(resolve, 4000));
        return w.github.fetch(input, init);
      });
      const linking = made.map((project, index) =>
        q.request("POST", `/api/projects/${project.id}/repository`, {
          create: { name: `pool-${index}` },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const before = Date.now();
      const list = await q.send("GET", "/api/projects");
      expect(list.status).toBe(200);
      expect(Date.now() - before).toBeLessThan(1000);
      const links = await Promise.all(linking);
      expect(links.map((link) => link.status)).toEqual(made.map(() => 201));
    }, 60_000);

    test("a project held for linking keeps: deleting it says it has a repository, a second link waits, and a hold of a process that died is over", async () => {
      const project = await newProject(w);
      let reached!: () => void;
      const atGitHub = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      q.intercept(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if ((init?.method ?? "GET") === "POST" && url.endsWith("/user/repos")) {
          reached();
          await held;
        }
        return w.github.fetch(input, init);
      });
      const linking = q.request("POST", `/api/projects/${project.id}/repository`, {
        create: { name: "held" },
      });
      await atGitHub;
      // Taking it away does not wait for GitHub: it has a repository, as far as anyone knows.
      const deleting = await q.send("DELETE", `/api/projects/${project.id}`);
      expect(deleting.status).toBe(409);
      expect(deleting.json).toEqual({ error: "hasRepository" });
      // So does the sweep, and another link waits.
      const second = await q.request("POST", `/api/projects/${project.id}/repository`, {
        create: { name: "other" },
      });
      expect(second.status).toBe(429);
      expect(second.json).toEqual({ error: "busy" });
      release();
      expect((await linking).status).toBe(201);
      expect((await rowOf(project.id))!.linkingUntil).toBeNull();
      // A hold that nobody let go of, as of a process that died, is over in time.
      const stuck = await newProject(w);
      await t.db
        .update(projects)
        .set({ linkingUntil: new Date(Date.now() + 60_000) })
        .where(eq(projects.id, stuck.id));
      expect((await q.send("DELETE", `/api/projects/${stuck.id}`)).status).toBe(409);
      await t.db
        .update(projects)
        .set({ linkingUntil: new Date(Date.now() - 1000) })
        .where(eq(projects.id, stuck.id));
      expect((await q.send("DELETE", `/api/projects/${stuck.id}`)).status).toBe(204);
    });

    test("GitHub is asked again by itself: minutes after, an hour, six hours, then every day; a project found so wrongly can be edited again", async () => {
      const { project, repo } = await archived("asked-again");
      const start = w.time.now;
      await takeOut(repo.id);
      // Only this project's: the database has those of other tests too.
      let asked = 0;
      const recheck = async (link: Parameters<typeof recheckLink>[2]) => {
        if (link.projectId !== project.id) return { kind: "unknown", detail: "another" } as const;
        asked += 1;
        return recheckLink(t.db, w.host, link, w.time.now, w.app);
      };
      const looked: string[] = [];
      const due = async () => {
        asked = 0;
        const { back } = await recheckDue({
          db: t.db,
          recheck,
          lookAgain: async (id) => void looked.push(id),
          log: quiet,
          now: () => w.time.now,
        });
        return { back, asked };
      };
      expect((await linkOf(project.id))!.recheckAt).toEqual(new Date(start.getTime() + 5 * 60_000));
      w.time.later(4 * 60_000);
      expect(await due()).toEqual({ back: 0, asked: 0 });
      for (const [after, next] of [
        [60_000, 3600_000],
        [3600_000, 6 * 3600_000],
        [6 * 3600_000, DAY],
        [DAY, DAY],
      ] as const) {
        w.time.later(after);
        expect(await due()).toEqual({ back: 0, asked: 1 });
        expect((await linkOf(project.id))!.recheckAt).toEqual(
          new Date(w.time.now.getTime() + next),
        );
      }
      expect((await linkOf(project.id))!.rechecks).toBe(4);
      // GitHub away: asked again a quarter of an hour on, and nothing else changes.
      w.time.later(DAY);
      w.github.faults.unreachable = true;
      expect(await due()).toEqual({ back: 0, asked: 1 });
      expect(await linkOf(project.id)).toMatchObject({
        rechecks: 4,
        recheckAt: new Date(w.time.now.getTime() + 15 * 60_000),
        pauseReason: "gone",
      });
      w.github.faults.unreachable = false;
      // Put back, which GitHub did not say: the next time finds it, and it can be edited again.
      putBackQuietly(repo.id);
      w.time.later(15 * 60_000);
      expect(await due()).toEqual({ back: 1, asked: 1 });
      expect(await linkOf(project.id)).toMatchObject({
        state: "ready",
        unusableSince: null,
        recheckAt: null,
        rechecks: 0,
      });
      expect(looked).toEqual([project.id]);
    });

    test("opening such a project, or listing it, has GitHub asked soon, at most every ten minutes", async () => {
      const { project, repo } = await archived("soon");
      await takeOut(repo.id);
      const later = new Date(Date.now() + DAY);
      await setLink(project.id, {
        recheckAt: later,
        recheckedAt: new Date(Date.now() - 3600_000),
      });
      // A window that would edit it, which is turned away.
      expect((await closeOf(hello(off, project.id, NEW)))?.code).toBe(SYNC_CLOSE.unusable);
      expect((await linkOf(project.id))!.recheckAt!.getTime()).toBeLessThanOrEqual(Date.now());
      // Asked a moment ago: not again.
      await setLink(project.id, {
        recheckAt: later,
        recheckedAt: new Date(),
      });
      expect((await closeOf(hello(off, project.id, NEW)))?.code).toBe(SYNC_CLOSE.unusable);
      expect((await linkOf(project.id))!.recheckAt).toEqual(later);
      // Listed: the same.
      await setLink(project.id, { recheckAt: later, recheckedAt: null });
      expect((await q.request("GET", "/api/projects")).status).toBe(200);
      expect((await linkOf(project.id))!.recheckAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    test("an archive that finds the repository gone says so only where the next one, minutes on, finds the same", async () => {
      const { project, repo } = await archived("blip");
      w.github.unselect(repo.id);
      w.github.takeDeliveries();
      // A clean project: nothing to archive, only to look.
      expect(await w.archiver().run(project.id, "check")).toMatchObject({ kind: "failed" });
      expect(await linkOf(project.id)).toMatchObject({
        state: "ready",
        unusableSince: null,
        unusableSeenAt: w.time.now,
        transientSince: null,
      });
      // The next archive is due by itself, changes or not, once the few minutes are over.
      const { takeDue } = await import("./schedule.ts");
      expect(await takeDue(t.db, new Date(w.time.now.getTime() + 60_000))).not.toContain(
        project.id,
      );
      w.time.later(CONFIRM_AFTER_MS);
      expect(await takeDue(t.db, w.time.now)).toContain(project.id);
      // GitHub answered 404 for a while: back by now, and nothing was said.
      putBackQuietly(repo.id);
      const outcome = await w.archiver().run(project.id, "auto");
      expect(["paused", "failed"]).not.toContain(outcome.kind);
      expect(await linkOf(project.id)).toMatchObject({ state: "ready", unusableSeenAt: null });
    });

    test("the sweep asks about those GitHub was asked about the longest ago first: one it cannot say anything about does not hold up the rest", async () => {
      const first = await archived("unknown-first");
      const second = await archived("known-second");
      await takeOut(first.repo.id);
      await takeOut(second.repo.id);
      w.github.deleteRepo(second.repo.id);
      w.github.takeDeliveries();
      await setLink(first.project.id, { unusableSince: new Date(w.time.now.getTime() - 9 * DAY) });
      await setLink(second.project.id, { unusableSince: new Date(w.time.now.getTime() - 8 * DAY) });
      const asked: string[] = [];
      const sweepOne = () =>
        sweepProjects({
          db: t.db,
          hub,
          log: quiet,
          most: 1,
          // GitHub cannot say anything about the first.
          recheck: (link) => {
            asked.push(link.projectId);
            return link.projectId === first.project.id
              ? recheckLink(
                  t.db,
                  { open: () => ({ info: () => Promise.reject(new Error("down")) }) } as never,
                  link,
                  w.time.now,
                )
              : recheckLink(t.db, w.host, link, w.time.now, w.app);
          },
          deletesFrom: "2026-01-01T00:00:00Z",
          now: () => w.time.now,
        });
      // One at a time: the one found the longest ago first, which GitHub says nothing about.
      expect(await sweepOne()).toMatchObject({ unknown: 1, removed: 0 });
      expect((await linkOf(first.project.id))!.recheckedAt).toEqual(w.time.now);
      // The next time, the other one: it goes.
      w.time.later(3600_000);
      expect(await sweepOne()).toMatchObject({ unknown: 0, removed: 1 });
      expect(asked).toEqual([first.project.id, second.project.id]);
      expect(await rowOf(second.project.id)).toBeUndefined();
    });

    test("the hub hears again after its connection to the database broke, and reads what it missed", async () => {
      const { project, repo } = await archived("reconnect");
      const listening = listenForLinks(t.db, hub, quiet, { retryMs: 50, heartbeatMs: 60_000 });
      try {
        await listening.ready;
        const window = await connect(hub, project.id, NEW);
        // The connection that listens breaks, as when the database restarts.
        await t.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and query ilike 'listen %'",
        );
        // Meanwhile the repository is found gone: what is said now nobody hears.
        await takeOut(repo.id);
        await vi.waitFor(
          () => expect(window.closedWith).toEqual({ code: SYNC_CLOSE.unusable, reason: "gone" }),
          { timeout: 5000 },
        );
      } finally {
        await listening.stop();
      }
    });
  });
});
