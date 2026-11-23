import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  Editor,
  confirmed,
  edit,
  linkTo,
  newProject,
  world,
  write,
  type World,
} from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { FakeGitHub } from "../test/fake-github.ts";
import { platform, WEB, WEBHOOK_SECRET, type Platform } from "../test/platform-support.ts";
import { installations, projectRepos, projects, repoConflicts } from "../schema.ts";
import { changeSetting } from "../settings.ts";
import { REPO_MERGE_SETTING } from "./merging.ts";
import { descriptionOf } from "./service.ts";

/**
 * Saving a project to GitHub as the editor asks for it: choosing a repository, linking it, how
 * archiving goes, archiving now, and what webhooks change. On a real PostgreSQL and the fake
 * GitHub. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe.skipIf(!TEST_DATABASE)("saving to GitHub through the API, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    p = await platform(w);
  });

  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0];

  test("lists the repositories the installation covers, which are linked, and where to choose them", async () => {
    const mine = w.github.addRepo(w.person, { name: "film", select: true });
    w.github.addRepo(w.person, {
      name: "notes",
      select: true,
      private: false,
      files: { "a.md": "a" },
    });
    w.github.addRepo(w.person, { name: "hidden" });
    const other = await newProject(w);
    await linkTo(w, other.id, mine);
    const { status, json } = await p.request("GET", "/api/github/repositories");
    expect(status).toBe(200);
    expect(json).toEqual({
      repositories: [
        expect.objectContaining({
          name: "film",
          private: true,
          pushable: true,
          empty: true,
          linked: true,
        }),
        expect.objectContaining({ name: "notes", private: false, empty: false, linked: false }),
      ],
      page: 1,
      more: false,
      manageUrl: `${WEB}/settings/installations/${w.installation}`,
    });
    expect(json.repositories[0]).toMatchObject({
      fullName: `${w.person.login}/film`,
      owner: w.person.login,
    });
  });

  test("says who is not signed in, and who has not installed the App", async () => {
    const anonymous = await p.app.inject({ method: "GET", url: "/api/github/repositories" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ error: "signedOut" });
    await t.db.delete(installations).where(eq(installations.id, w.installation));
    const { status, json } = await p.request("GET", "/api/github/repositories");
    expect(status).toBe(409);
    expect(json).toEqual({ error: "notInstalled" });
    const project = await newProject(w);
    const linking = await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "film" },
    });
    expect(linking.json).toEqual({ error: "notInstalled" });
  });

  test("makes a new private repository, links it, and queues the first archive", async () => {
    const project = await newProject(w);
    const { status, json } = await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "my-film" },
    });
    expect(status).toBe(201);
    expect(json).toMatchObject({
      repository: {
        owner: w.person.login,
        name: "my-film",
        fullName: `${w.person.login}/my-film`,
        private: true,
        branch: "main",
        url: `${WEB}/${w.person.login}/my-film`,
        createdHere: true,
      },
      state: "ready",
      archiving: true,
      head: 1,
      archivedSeq: 0,
    });
    const repo = [...w.github.repos.values()].find((each) => each.name === "my-film")!;
    expect(repo).toMatchObject({ private: true, description: descriptionOf("测试") });
    expect(p.queued).toEqual([{ project: project.id, kind: "first", by: w.userId }]);
    // The same request again, as when its answer did not come back: the same.
    const again = await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "my-film" },
    });
    expect(again.status).toBe(201);
    expect(again.json.repository.id).toBe(repo.id);
    expect(p.queued).toHaveLength(1);
    // The first archive, as the worker runs it.
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    const status2 = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(status2.json).toMatchObject({
      state: "ready",
      archiving: false,
      lastArchive: { seq: 1, kind: "first", changed: 2, removed: 0 },
      archivedSeq: 1,
    });
    expect(status2.json.lastArchive.url).toBe(
      `${WEB}/${w.person.login}/my-film/commit/${status2.json.lastArchive.sha}`,
    );
    expect(status2.json.dirtySince).toBeUndefined();
  });

  test("a name that is taken is for people to change; a repository made a moment ago by a try that lost its answer is that one", async () => {
    w.github.addRepo(w.person, { name: "taken", select: true });
    const project = await newProject(w);
    const taken = await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "taken" },
    });
    expect(taken.status).toBe(409);
    expect(taken.json).toEqual({ error: "nameTaken" });
    // Made, and the answer lost on the way back: tried again, the name is "taken", by ours.
    let lost = false;
    p.intercept(async (input, init) => {
      const response = await w.github.fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!lost && url.pathname === "/api/user/repos" && init?.method === "POST") {
        lost = true;
        throw new TypeError("fetch failed");
      }
      return response;
    });
    const made = await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "made-twice" },
    });
    expect(lost).toBe(true);
    expect(made.status).toBe(201);
    expect([...w.github.repos.values()].filter((repo) => repo.name === "made-twice")).toHaveLength(
      1,
    );
    // A name taken by one of ours from long ago, or one with files in it, is not that one.
    p.intercept(w.github.fetch);
    const old = w.github.addRepo(w.person, {
      name: "old",
      select: true,
      description: descriptionOf("测试"),
    });
    old.createdAt -= 11 * 60_000;
    const second = await newProject(w);
    expect(
      (
        await p.request("POST", `/api/projects/${second.id}/repository`, {
          create: { name: "old" },
        })
      ).json,
    ).toEqual({ error: "nameTaken" });
    expect(
      (
        await p.request("POST", `/api/projects/${second.id}/repository`, {
          create: { name: "bad name" },
        })
      ).json,
    ).toEqual({ error: "invalidName" });
  });

  test("takes a repository people have only where an archive can go into it", async () => {
    const project = await newProject(w);
    const link = (id: number, confirmPublic?: boolean) =>
      p.request("POST", `/api/projects/${project.id}/repository`, {
        existing: { id },
        ...(confirmPublic !== undefined && { confirmPublic }),
      });
    const withProject = w.github.addRepo(w.person, {
      name: "has-project",
      select: true,
      files: { "animaquill.json": "{}" },
    });
    expect((await link(withProject.id)).json).toEqual({
      error: "hasProject",
      files: ["animaquill.json"],
    });
    const withCode = w.github.addRepo(w.person, {
      name: "has-code",
      select: true,
      files: { "code/tool.js": "x", "README.md": "r" },
    });
    expect((await link(withCode.id)).json).toEqual({ error: "hasProject", files: ["code"] });
    const archived = w.github.addRepo(w.person, { name: "archived", select: true });
    archived.archived = true;
    expect((await link(archived.id)).json).toEqual({ error: "notPushable" });
    // Not one the installation covers: to the person's token, not there at all.
    const notSelected = w.github.addRepo(w.person, { name: "not-selected" });
    expect((await link(notSelected.id)).json).toEqual({ error: "notFound" });
    const someoneElse = w.github.addRepo(
      { id: 1, login: "acme" },
      { name: "org", select: true, ownerType: "Organization" },
    );
    expect((await link(someoneElse.id)).status).toBe(404);
    const elsewhere = w.github.addRepo(w.person, { name: "elsewhere", select: true });
    const other = await newProject(w);
    await linkTo(w, other.id, elsewhere);
    // Which project it is, as that is the person's own.
    expect((await link(elsewhere.id)).json).toEqual({
      error: "linkedElsewhere",
      project: { id: other.id, name: "测试" },
    });
    const open = w.github.addRepo(w.person, { name: "open", select: true, private: false });
    const refused = await link(open.id);
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "public" });
    const fine = w.github.addRepo(w.person, {
      name: "fine",
      select: true,
      files: { "README.md": "# fine\n", "docs/notes.md": "n" },
    });
    const linked = await link(fine.id);
    expect(linked.status).toBe(201);
    expect(linked.json.repository).toMatchObject({ id: fine.id, createdHere: false });
    // Another one while archiving goes as it should: no.
    expect((await link(open.id, true)).json).toEqual({ error: "alreadyLinked" });
    // Once its repository is gone, another one: the public one, said to be fine.
    await t.db
      .update(projectRepos)
      .set({ state: "paused", pauseReason: "gone" })
      .where(eq(projectRepos.projectId, project.id));
    const replaced = await link(open.id, true);
    expect(replaced.status).toBe(201);
    expect((await linkOf(project.id))!).toMatchObject({
      repoId: open.id,
      state: "ready",
      private: false,
    });
  });

  test("only takes changes from pages of this site, and from the owner of the project", async () => {
    const project = await newProject(w);
    const forged = await p.request(
      "POST",
      `/api/projects/${project.id}/repository`,
      { create: { name: "x" } },
      {
        origin: "https://evil.example",
      },
    );
    expect(forged.status).toBe(403);
    const someone = await world(t.db);
    const theirs = await newProject(someone);
    expect((await p.request("GET", `/api/projects/${theirs.id}/repository`)).status).toBe(404);
    expect(
      (await p.request("POST", `/api/projects/${theirs.id}/repository`, { create: { name: "x" } }))
        .status,
    ).toBe(404);
    expect((await p.request("POST", `/api/projects/${theirs.id}/archive`)).status).toBe(404);
  });

  test("archives now, once a minute, and goes on after a pause where people dealt with it", async () => {
    const project = await newProject(w);
    expect((await p.request("POST", `/api/projects/${project.id}/archive`)).json).toEqual({
      error: "notLinked",
    });
    await p.request("POST", `/api/projects/${project.id}/repository`, { create: { name: "now" } });
    await p.work();
    await edit(w, project, write("code/a.js", "a"));
    const now = await p.request("POST", `/api/projects/${project.id}/archive`);
    expect(now.status).toBe(202);
    expect(now.json).toMatchObject({ archiving: true });
    expect(p.queued).toEqual([{ project: project.id, kind: "manual", by: w.userId }]);
    const again = await p.request("POST", `/api/projects/${project.id}/archive`);
    expect(again.status).toBe(429);
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 2 }]);

    // Paused, as the repository was taken out: archiving now tries again.
    await t.db
      .update(projectRepos)
      .set({ state: "paused", pauseReason: "gone", detail: "gone" })
      .where(eq(projectRepos.projectId, project.id));
    const status = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(status.json).toMatchObject({ state: "paused", reason: "gone", detail: "gone" });
  });

  test("writes over files changed on GitHub only with the commit people saw them on", async () => {
    const project = await newProject(w);
    await p.request("POST", `/api/projects/${project.id}/repository`, { create: { name: "both" } });
    await p.work();
    const repo = [...w.github.repos.values()].find((each) => each.name === "both")!;
    const theirs = w.github.commitAs(repo.id, w.person, { "timelines/main/timeline.json": "{}\n" });
    await edit(w, project, write("code/a.js", "mine"));
    p.queued.push({ project: project.id, kind: "auto" });
    expect(await p.work()).toEqual([{ kind: "paused", reason: "diverged" }]);
    const paused = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(paused.json).toMatchObject({
      state: "paused",
      reason: "diverged",
      diverged: { sha: theirs, files: ["timelines/main/timeline.json"] },
    });
    const plain = await p.request("POST", `/api/projects/${project.id}/archive`);
    expect(plain.status).toBe(409);
    expect(plain.json).toEqual({
      error: "diverged",
      diverged: { sha: theirs, files: ["timelines/main/timeline.json"], deleted: [] },
    });
    const stale = await p.request("POST", `/api/projects/${project.id}/archive`, {
      replace: "f".repeat(40),
    });
    expect(stale.json.error).toBe("diverged");
    const replaced = await p.request("POST", `/api/projects/${project.id}/archive`, {
      replace: theirs,
    });
    expect(replaced.status).toBe(202);
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    const history = w.github.history(repo.id);
    // On top of theirs, never forced: theirs stays in the history.
    expect(history[0]!.parents).toEqual([theirs]);
    expect(w.github.files(repo.id).get("timelines/main/timeline.json")).toBe(
      project.editor.store.exportFiles().files.get("timelines/main/timeline.json"),
    );
    expect((await p.request("GET", `/api/projects/${project.id}/repository`)).json).toMatchObject({
      state: "ready",
    });
  });

  test("webhooks: a push elsewhere is checked, the platform's own is not, and the App and repositories come and go", async () => {
    const project = await newProject(w);
    await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "hooks" },
    });
    w.github.takeDeliveries();
    await p.work();
    const repo = [...w.github.repos.values()].find((each) => each.name === "hooks")!;
    // The platform's own pushes come back as webhooks: its archive is nothing to check; the first
    // commit of the repository is checked, and is fine.
    const own = w.github.takeDeliveries();
    expect(await p.deliver(own.slice(1))).toEqual([204]);
    expect(p.queued).toEqual([]);
    expect(await p.deliver(own.slice(0, 1))).toEqual([204]);
    expect(await p.work()).toEqual([{ kind: "checked" }]);
    w.github.commitAs(repo.id, w.person, { "README.md": "# hooks\n" });
    const [push] = w.github.takeDeliveries();
    expect(await p.deliver([push!])).toEqual([204]);
    expect(p.queued).toEqual([{ project: project.id, kind: "check" }]);
    expect(await p.work()).toEqual([{ kind: "checked" }]);
    expect((await linkOf(project.id))!.headSha).toBe(w.github.history(repo.id)[0]!.sha);
    // The same delivery again is taken in once.
    const later = { event: "push", payload: { ...push!.payload, after: "2".repeat(40) } };
    const { body, headers } = FakeGitHub.signed(
      later,
      WEBHOOK_SECRET,
      "6b7d6c5e-0000-4000-8000-000000000001",
    );
    for (let time = 0; time < 2; time++)
      await p.app.inject({ method: "POST", url: "/api/github/webhook", headers, payload: body });
    expect(p.queued).toEqual([{ project: project.id, kind: "check" }]);
    p.queued.length = 0;
    // The platform's own commit, whose push comes before the archive noted that the branch has it.
    await t.db
      .update(projectRepos)
      .set({ pendingSha: "3".repeat(40) })
      .where(eq(projectRepos.projectId, project.id));
    await p.deliver([{ event: "push", payload: { ...push!.payload, after: "3".repeat(40) } }]);
    expect(p.queued).toEqual([]);
    await t.db
      .update(projectRepos)
      .set({ pendingSha: null })
      .where(eq(projectRepos.projectId, project.id));
    // A push to another branch is not about the archive.
    await p.deliver([
      {
        event: "push",
        payload: { ...push!.payload, ref: "refs/heads/other", after: "1".repeat(40) },
      },
    ]);
    expect(p.queued).toEqual([]);

    w.github.unselect(repo.id);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "paused", pauseReason: "gone" });
    w.github.select(repo.id);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "ready", pauseReason: null });
    expect(p.queued).toEqual([{ project: project.id, kind: "check" }]);
    await p.work();

    w.github.suspend(w.person);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "paused", pauseReason: "suspended" });
    w.github.suspend(w.person, false);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "ready" });
    await p.work();

    w.github.uninstall(w.person);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "paused", pauseReason: "uninstalled" });
    const again = w.github.install(w.person, "selected", [repo.id]);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "ready", installationId: again });
    expect(await p.work()).toEqual([{ kind: "checked" }]);
  });
  test("writing over files changed on GitHub writes the editor's version, also with nothing newer to archive", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    await p.request("POST", `/api/projects/${project.id}/repository`, { create: { name: "rep" } });
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    w.github.takeDeliveries();
    const repo = [...w.github.repos.values()].find((each) => each.name === "rep")!;
    const theirs = w.github.commitAs(repo.id, w.person, { "code/a.js": "theirs\n" });
    // The push comes to the webhook: a check, which pauses.
    await p.deliver();
    expect(await p.work()).toEqual([{ kind: "paused", reason: "diverged" }]);
    const replaced = await p.request("POST", `/api/projects/${project.id}/archive`, {
      replace: theirs,
    });
    expect(replaced.status).toBe(202);
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    expect(w.github.files(repo.id).get("code/a.js")).toBe("a\n");
    expect(w.github.history(repo.id)[0]!.parents).toEqual([theirs]);
    const status = (await p.request("GET", `/api/projects/${project.id}/repository`)).json;
    expect(status).toMatchObject({
      state: "ready",
      archiving: false,
      lastArchive: { kind: "manual" },
    });
    expect(status.archivedSeq).toBe(status.head);
  });

  test("archiving now while a check of a push waits in the queue archives all the same", async () => {
    const project = await newProject(w);
    await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "waits" },
    });
    await p.work();
    await edit(w, project, write("code/a.js", "now\n"));
    // A push came in: its check waits in the queue, where a project waits only once.
    p.queued.push({ project: project.id, kind: "check" });
    const now = await p.request("POST", `/api/projects/${project.id}/archive`);
    expect(now.status).toBe(202);
    expect(now.json.archiving).toBe(true);
    expect(p.queued).toEqual([{ project: project.id, kind: "check" }]);
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 2 }]);
    const repo = [...w.github.repos.values()].find((each) => each.name === "waits")!;
    expect(w.github.files(repo.id).get("code/a.js")).toBe("now\n");
    const status = (await p.request("GET", `/api/projects/${project.id}/repository`)).json;
    expect(status).toMatchObject({ archiving: false, lastArchive: { kind: "manual" } });
  });

  test("says what is wrong with a request in the words the editor knows", async () => {
    const project = await newProject(w);
    const url = `/api/projects/${project.id}/repository`;
    expect(await p.requestRaw(url, "{not json")).toEqual({
      status: 400,
      json: { error: "invalid" },
    });
    const large = JSON.stringify({ create: { name: "x".repeat(5000) } });
    expect(await p.requestRaw(url, large)).toEqual({ status: 413, json: { error: "invalid" } });
    expect(await p.requestRaw(`/api/projects/${project.id}/archive`, "[1,")).toEqual({
      status: 400,
      json: { error: "invalid" },
    });
  });

  test("a repository put back into another account's installation is someone else's: it stays paused", async () => {
    const project = await newProject(w);
    await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "moved" },
    });
    await p.work();
    w.github.takeDeliveries();
    const repo = [...w.github.repos.values()].find((each) => each.name === "moved")!;
    w.github.unselect(repo.id);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "paused", pauseReason: "gone" });
    // Moved to another account, which has the App: GitHub says it was added there.
    const other = { id: w.person.id + 7, login: `${w.person.login}-elsewhere` };
    w.github.install(other, "selected");
    repo.owner = { id: other.id, login: other.login, type: "User" };
    w.github.select(repo.id);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({
      state: "paused",
      pauseReason: "transferred",
      installationId: w.installation,
    });
    expect(p.queued).toEqual([]);
  });

  /** Asks whether a repository could take a project, as the editor does before it links one. */
  const check = (choice: unknown, how: Parameters<Platform["send"]>[2] = {}) =>
    p.send("POST", "/api/github/repositories/check", {
      payload: JSON.stringify(choice),
      ...how,
      headers: { "content-type": "application/json", ...how.headers },
    });

  test("says whether a new repository of a name could be made, and makes nothing", async () => {
    w.github.addRepo(w.person, { name: "Taken", select: true });
    const repos = w.github.repos.size;
    const fine = await check({ create: { name: "my-film" } });
    expect(fine.status).toBe(200);
    expect(fine.json).toEqual({ ok: true });
    // Whatever it finds is an answer, not a failure: names are as GitHub tells them apart.
    const taken = await check({ create: { name: "taken" } });
    expect(taken.status).toBe(200);
    expect(taken.json).toEqual({ ok: false, reason: "nameTaken" });
    for (const name of ["bad name", "", ".", "..", "film.git", "x".repeat(101)]) {
      const invalid = await check({ create: { name } });
      expect(invalid.status, name).toBe(200);
      expect(invalid.json, name).toEqual({ ok: false, reason: "invalidName" });
    }
    // A name a repository had before it was renamed is free again, as it is on GitHub.
    const renamed = w.github.addRepo(w.person, { name: "first-name", select: true });
    w.github.rename(renamed.id, "second-name");
    expect((await check({ create: { name: "first-name" } })).json).toEqual({ ok: true });
    expect((await check({ create: { name: "second-name" } })).json).toEqual({
      ok: false,
      reason: "nameTaken",
    });
    // What a try of the platform's made a moment ago, whose answer was lost, is the one linking
    // takes: its name is no one else's. Not so one with files in it, or one from long ago.
    w.github.addRepo(w.person, { name: "ours", select: true, description: descriptionOf("x") });
    expect((await check({ create: { name: "ours" } })).json).toEqual({ ok: true });
    const old = w.github.addRepo(w.person, {
      name: "ours-old",
      select: true,
      description: descriptionOf("x"),
    });
    old.createdAt -= 11 * 60_000;
    expect((await check({ create: { name: "ours-old" } })).json).toMatchObject({ ok: false });
    w.github.addRepo(w.person, {
      name: "ours-used",
      select: true,
      description: descriptionOf("x"),
      files: { "README.md": "r" },
    });
    expect((await check({ create: { name: "ours-used" } })).json).toMatchObject({ ok: false });

    // Nothing was made, linked or queued.
    expect(w.github.repos.size).toBe(repos + 4);
    expect(w.github.calls.filter((call) => call === "POST /user/repos")).toEqual([]);
    expect(
      await t.db.select().from(projectRepos).where(eq(projectRepos.linkedBy, w.userId)),
    ).toEqual([]);
    expect(p.queued).toEqual([]);
  });

  test("says whether a repository people have could take a project, by what linking goes by", async () => {
    /** What a check of a repository people have finds, which is always an answer. */
    const existing = async (id: number, confirmPublic?: boolean) => {
      const answer = await check({
        existing: { id },
        ...(confirmPublic !== undefined && { confirmPublic }),
      });
      expect(answer.status, `the check of ${id}`).toBe(200);
      return answer.json;
    };
    const empty = w.github.addRepo(w.person, { name: "empty", select: true });
    expect(await existing(empty.id)).toEqual({ ok: true });
    const others = w.github.addRepo(w.person, {
      name: "others",
      select: true,
      files: { "README.md": "# mine\n", "docs/a.md": "a" },
    });
    expect(await existing(others.id)).toEqual({ ok: true });
    const withProject = w.github.addRepo(w.person, {
      name: "has-project",
      select: true,
      files: { "animaquill.json": "{}", "code/tool.js": "x" },
    });
    expect(await existing(withProject.id)).toEqual({
      ok: false,
      reason: "hasProject",
      files: ["animaquill.json", "code"],
    });
    const archived = w.github.addRepo(w.person, { name: "archived", select: true });
    archived.archived = true;
    expect(await existing(archived.id)).toEqual({ ok: false, reason: "notPushable" });
    const readOnly = w.github.addRepo(w.person, { name: "read-only", select: true });
    readOnly.readOnly = true;
    expect(await existing(readOnly.id)).toEqual({ ok: false, reason: "notPushable" });
    // Public: for people to say yes to, and with their yes, looked at like any other.
    const open = w.github.addRepo(w.person, { name: "open", select: true, private: false });
    expect(await existing(open.id)).toEqual({ ok: false, reason: "public" });
    expect(await existing(open.id, false)).toEqual({ ok: false, reason: "public" });
    expect(await existing(open.id, true)).toEqual({ ok: true });
    const openProject = w.github.addRepo(w.person, {
      name: "open-project",
      select: true,
      private: false,
      files: { "timelines/main/timeline.json": "{}" },
    });
    expect(await existing(openProject.id, true)).toEqual({
      ok: false,
      reason: "hasProject",
      files: ["timelines"],
    });
    // Not the person's to choose: not covered by their installation, an organization's, no such.
    const notSelected = w.github.addRepo(w.person, { name: "not-selected" });
    expect(await existing(notSelected.id)).toEqual({ ok: false, reason: "notFound" });
    const org = w.github.addRepo(
      { id: 1, login: "acme" },
      { name: "org", select: true, ownerType: "Organization" },
    );
    expect(await existing(org.id)).toEqual({ ok: false, reason: "notFound" });
    expect(await existing(987654321)).toEqual({ ok: false, reason: "notFound" });
    expect(await existing(-1)).toEqual({ ok: false, reason: "notFound" });

    // The repository of another project: which one, where that is the person's own.
    const mine = await newProject(w);
    const taken = w.github.addRepo(w.person, { name: "taken", select: true });
    await linkTo(w, mine.id, taken);
    expect(await existing(taken.id)).toEqual({
      ok: false,
      reason: "linkedElsewhere",
      project: { id: mine.id, name: "测试" },
    });
    // Someone else's project has it, as after it moved to this account: only that it is taken.
    const someone = await world(t.db);
    const theirs = await newProject(someone);
    const moved = w.github.addRepo(w.person, { name: "moved-here", select: true });
    await linkTo(someone, theirs.id, moved);
    expect(await existing(moved.id)).toEqual({ ok: false, reason: "linkedElsewhere" });

    // Each of them an answer, and the same rules linking refuses by, in the same words.
    const project = await newProject(w);
    const link = async (id: number) =>
      (await p.request("POST", `/api/projects/${project.id}/repository`, { existing: { id } }))
        .json;
    expect(await link(withProject.id)).toEqual({
      error: "hasProject",
      files: ["animaquill.json", "code"],
    });
    expect(await link(archived.id)).toEqual({ error: "notPushable" });
    expect(await link(open.id)).toEqual({ error: "public" });
    expect(await link(notSelected.id)).toEqual({ error: "notFound" });
    expect(await link(taken.id)).toEqual({
      error: "linkedElsewhere",
      project: { id: mine.id, name: "测试" },
    });
    expect(await link(moved.id)).toEqual({ error: "linkedElsewhere" });
    expect(p.queued).toEqual([]);
  });

  test("a check that could not look says so in the ways the other requests do", async () => {
    const repo = w.github.addRepo(w.person, { name: "any", select: true });
    // No App on the account: an answer, as people can do something about it.
    await t.db.delete(installations).where(eq(installations.id, w.installation));
    for (const choice of [{ create: { name: "film" } }, { existing: { id: repo.id } }]) {
      const answer = await check(choice);
      expect(answer.status).toBe(200);
      expect(answer.json).toEqual({ ok: false, reason: "notInstalled" });
    }
    await t.db.insert(installations).values({
      id: w.installation,
      accountId: w.person.id,
      accountLogin: w.person.login,
      accountType: "User",
      repositorySelection: "selected",
    });
    // What is no choice of a repository.
    for (const wrong of [{}, { create: {} }, { existing: { id: "1" } }, { create: { name: 1 } }]) {
      const answer = await check(wrong);
      expect(answer.status, JSON.stringify(wrong)).toBe(400);
      expect(answer.json).toEqual({ error: "invalid" });
    }
    expect((await check({ create: { name: "a" }, existing: { id: repo.id } })).status).toBe(400);
    // Nobody signed in, a page elsewhere, GitHub away: not an answer about the repository.
    const nobody = await check({ create: { name: "film" } }, { signedIn: false });
    expect(nobody.status).toBe(401);
    expect(nobody.json).toEqual({ error: "signedOut" });
    const elsewhere = await check({ create: { name: "film" } }, { fromHere: false });
    expect(elsewhere.status).toBe(403);
    w.github.faults.down = 1;
    const away = await check({ create: { name: "film" } });
    expect(away.status).toBe(503);
    expect(away.json).toEqual({ error: "unavailable" });
    w.github.faults.down = 1;
    const awayToo = await check({ existing: { id: repo.id } });
    expect(awayToo.status).toBe(503);
    expect((await check({ existing: { id: repo.id } })).json).toEqual({ ok: true });
  });

  test("the list of repositories says which project of the person's own each is saved to", async () => {
    const mine = w.github.addRepo(w.person, { name: "mine", select: true });
    const theirs = w.github.addRepo(w.person, { name: "theirs", select: true });
    w.github.addRepo(w.person, { name: "free", select: true });
    const project = await newProject(w);
    await linkTo(w, project.id, mine);
    const someone = await world(t.db);
    await linkTo(someone, (await newProject(someone)).id, theirs);
    const { json } = await p.request("GET", "/api/github/repositories");
    const byName = Object.fromEntries(
      (json.repositories as any[]).map((repo) => [repo.name, repo]),
    );
    expect(byName["mine"]).toMatchObject({
      linked: true,
      linkedProject: { id: project.id, name: "测试" },
    });
    expect(byName["theirs"].linked).toBe(true);
    expect("linkedProject" in byName["theirs"]).toBe(false);
    expect(byName["free"].linked).toBe(false);
    expect("linkedProject" in byName["free"]).toBe(false);
  });

  test("takes another repository in place of one whose archiving goes as it should only when told to", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const url = `/api/projects/${project.id}/repository`;
    await p.request("POST", url, { create: { name: "first" } });
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 2 }]);
    const first = [...w.github.repos.values()].find((each) => each.name === "first")!;
    const history = w.github.history(first.id).length;
    const files = new Map(w.github.files(first.id));
    const second = w.github.addRepo(w.person, { name: "second", select: true });

    // Not by itself: neither one people have, nor a new one.
    for (const choice of [{ existing: { id: second.id } }, { create: { name: "third" } }]) {
      const refused = await p.request("POST", url, choice);
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({ error: "alreadyLinked" });
      // Nor with anything but a plain yes.
      expect((await p.request("POST", url, { ...choice, switch: "yes" })).json).toEqual({
        error: "alreadyLinked",
      });
    }
    expect([...w.github.repos.values()].some((each) => each.name === "third")).toBe(false);
    expect((await linkOf(project.id))!.repoId).toBe(first.id);

    // The same one again is the same, also when told to switch.
    const same = await p.request("POST", url, { existing: { id: first.id }, switch: true });
    expect(same.status).toBe(201);
    expect(same.json.repository.id).toBe(first.id);
    expect(p.queued).toEqual([]);

    // Told to: the other one from now on, and all of the project goes into it.
    const switched = await p.request("POST", url, { existing: { id: second.id }, switch: true });
    expect(switched.status).toBe(201);
    expect(switched.json).toMatchObject({
      repository: { id: second.id, name: "second", createdHere: false },
      state: "ready",
      archiving: true,
      archivedSeq: 0,
    });
    expect(switched.json.lastArchive).toBeUndefined();
    expect(await linkOf(project.id)).toMatchObject({
      repoId: second.id,
      state: "ready",
      headSha: null,
      archivedSeq: 0,
    });
    expect(p.queued).toEqual([{ project: project.id, kind: "first", by: w.userId }]);
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 2 }]);
    expect(w.github.files(second.id).get("code/a.js")).toBe("a\n");
    expect(w.github.files(second.id).has("animaquill.json")).toBe(true);
    // What was archived stays in the old repository, which nothing touched.
    expect(w.github.history(first.id)).toHaveLength(history);
    expect(w.github.files(first.id)).toEqual(files);
    const status = (await p.request("GET", url)).json;
    expect(status).toMatchObject({
      repository: { id: second.id },
      lastArchive: { kind: "first", seq: 2 },
      archivedSeq: 2,
    });

    // And a new one made in place of that, the same way.
    await edit(w, project, write("code/a.js", "b\n"));
    const made = await p.request("POST", url, { create: { name: "fresh" }, switch: true });
    expect(made.status).toBe(201);
    expect(made.json.repository).toMatchObject({ name: "fresh", createdHere: true });
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 3 }]);
    const fresh = [...w.github.repos.values()].find((each) => each.name === "fresh")!;
    expect(w.github.files(fresh.id).get("code/a.js")).toBe("b\n");
    expect(w.github.files(second.id).get("code/a.js")).toBe("a\n");
    // The old one is free for another project now.
    const other = await newProject(w);
    const taken = await p.request("POST", `/api/projects/${other.id}/repository`, {
      existing: { id: second.id },
    });
    // It has the first project's files, which archives of another would write over.
    expect(taken.json.error).toBe("hasProject");
  });

  /** Events of repositories, which the App hears once it is subscribed to them. */
  const subscribed = async (name: string) => {
    w.github.repositoryEvents = true;
    const project = await newProject(w);
    await p.request("POST", `/api/projects/${project.id}/repository`, { create: { name } });
    await p.work();
    w.github.takeDeliveries();
    const repo = [...w.github.repos.values()].find((each) => each.name === name)!;
    return {
      project,
      repo,
      status: () => p.request("GET", `/api/projects/${project.id}/repository`),
    };
  };

  test("webhooks: a repository renamed, or made public or private, is shown as it is now", async () => {
    const { project, repo, status } = await subscribed("before");
    w.github.rename(repo.id, "after");
    expect(await p.deliver()).toEqual([204]);
    expect(await linkOf(project.id)).toMatchObject({ name: "after", state: "ready" });
    expect((await status()).json.repository).toMatchObject({
      name: "after",
      fullName: `${w.person.login}/after`,
      url: `${WEB}/${w.person.login}/after`,
    });
    // An archive looks for itself, as a delivery can be older than the one before it.
    expect(p.queued).toEqual([{ project: project.id, kind: "check" }]);
    expect(await p.work()).toEqual([{ kind: "checked" }]);

    w.github.setPrivate(repo.id, false);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ private: false, state: "ready" });
    w.github.setPrivate(repo.id, true);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ private: true, state: "ready" });
    await p.work();

    w.github.setDefaultBranch(repo.id, "trunk");
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ branch: "trunk", state: "ready" });
    await p.work();

    // Two renames whose deliveries come the wrong way round: the look puts the name right.
    w.github.rename(repo.id, "second");
    w.github.rename(repo.id, "third");
    const [second, third] = w.github.takeDeliveries();
    await p.deliver([third!, second!]);
    expect((await linkOf(project.id))!.name).toBe("second");
    expect(await p.work()).toEqual([{ kind: "checked" }, { kind: "checked" }]);
    expect((await linkOf(project.id))!.name).toBe("third");

    // A repository no project is saved to is nobody's business here.
    const other = w.github.addRepo(w.person, { name: "other", select: true });
    w.github.rename(other.id, "another");
    expect(await p.deliver()).toEqual([204]);
    expect(p.queued).toEqual([]);
  });

  test("webhooks: a repository archived pauses, and goes on once it is not", async () => {
    const { project, repo, status } = await subscribed("shelved");
    w.github.setArchived(repo.id, true);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "paused", pauseReason: "archived" });
    expect((await status()).json).toMatchObject({ state: "paused", reason: "archived" });
    expect(p.queued).toEqual([]);
    w.github.setArchived(repo.id, false);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "ready", pauseReason: null });
    expect(p.queued).toEqual([{ project: project.id, kind: "check" }]);
    expect(await p.work()).toEqual([{ kind: "checked" }]);
  });

  test("webhooks: a repository moved to another account pauses with its new names, and goes on once it is back", async () => {
    const { project, repo, status } = await subscribed("moving");
    // The other account has the App on all its repositories, so GitHub tells of the move.
    const other = { id: w.person.id + 3, login: `${w.person.login}-studio` };
    w.github.install(other, "all");
    w.github.takeDeliveries();
    w.github.transfer(repo.id, other);
    expect(await p.deliver()).toEqual([204]);
    expect(await linkOf(project.id)).toMatchObject({
      state: "paused",
      pauseReason: "transferred",
      ownerLogin: other.login,
      name: "moving",
      // The account it was linked on, which is what tells that it moved.
      ownerId: w.person.id,
    });
    expect((await status()).json).toMatchObject({
      state: "paused",
      reason: "transferred",
      repository: { owner: other.login, fullName: `${other.login}/moving` },
    });
    expect(p.queued).toEqual([]);
    // Renamed there: still shown as it is, still someone else's.
    w.github.rename(repo.id, "moved");
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({
      state: "paused",
      pauseReason: "transferred",
      name: "moved",
    });
    // Back on the account it was linked on, and in what the App may touch there.
    w.github.transfer(repo.id, w.person);
    w.github.select(repo.id);
    const back = w.github.takeDeliveries();
    // The one about the move is only told where the App covers the repository by then: all
    // GitHub says is that the installation of the account has it again.
    expect(back.map(({ event }) => event)).toEqual(["installation_repositories"]);
    await p.deliver(back);
    // Which is enough: on the account it was linked on, archiving goes on, and an archive looks.
    expect(await linkOf(project.id)).toMatchObject({ state: "ready", pauseReason: null });
    expect(p.queued).toEqual([{ project: project.id, kind: "check" }]);
    expect(await p.work()).toEqual([{ kind: "checked" }]);
    expect(await linkOf(project.id)).toMatchObject({
      state: "ready",
      ownerLogin: w.person.login,
      name: "moved",
    });

    // Moved away once more, and back, and this time what says so is a delivery about the
    // repository itself: the one that it is in the installation again never came.
    w.github.transfer(repo.id, other);
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({ state: "paused", pauseReason: "transferred" });
    w.github.transfer(repo.id, w.person);
    w.github.select(repo.id);
    w.github.takeDeliveries();
    w.github.rename(repo.id, "home");
    await p.deliver();
    expect(await linkOf(project.id)).toMatchObject({
      state: "ready",
      pauseReason: null,
      ownerLogin: w.person.login,
      name: "home",
    });
    expect(p.queued).toEqual([{ project: project.id, kind: "check" }]);
    expect(await p.work()).toEqual([{ kind: "checked" }]);
    // Put into the installation of another account, it is someone else's: that never brings a
    // link back, whatever it was paused for.
    w.github.transfer(repo.id, other);
    await p.deliver();
    const theirs = w.github.install({ id: other.id + 1, login: `${other.login}-2` }, "selected");
    expect(theirs).toBeGreaterThan(0);
    await p.deliver([
      {
        event: "installation_repositories",
        payload: {
          action: "added",
          installation: { id: theirs, account: { id: other.id + 1, login: `${other.login}-2` } },
          repository_selection: "selected",
          repositories_added: [{ id: repo.id, name: "home" }],
          repositories_removed: [],
        },
      },
    ]);
    expect(await linkOf(project.id)).toMatchObject({ state: "paused", pauseReason: "transferred" });
  });

  test("a repository that was deleted is told from one taken out of what the App may touch", async () => {
    // Deleted, and GitHub says so.
    const deleted = await subscribed("deleted");
    w.github.deleteRepo(deleted.repo.id);
    expect(await p.deliver()).toEqual([204]);
    expect(await linkOf(deleted.project.id)).toMatchObject({
      state: "paused",
      pauseReason: "gone",
      goneCause: "deleted",
    });
    const mark = w.github.calls.length;
    expect((await deleted.status()).json).toMatchObject({
      state: "paused",
      reason: "gone",
      gone: "deleted",
    });
    // What a webhook said needs no asking.
    expect(w.github.calls.length).toBe(mark);
    // Archiving now asks GitHub first, which finds it gone again: nothing is queued, and what is
    // known of why stays.
    w.time.later(2 * 60_000);
    const again = await p.request("POST", `/api/projects/${deleted.project.id}/archive`);
    expect(again.status).toBe(202);
    expect(again.json).toMatchObject({ state: "paused", reason: "gone", gone: "deleted" });
    expect(await p.work()).toEqual([]);
    expect((await deleted.status()).json).toMatchObject({ reason: "gone", gone: "deleted" });

    // Taken out of what the App may touch, which GitHub says too: it is still there.
    const removed = await subscribed("removed");
    w.github.unselect(removed.repo.id);
    await p.deliver();
    expect(await linkOf(removed.project.id)).toMatchObject({
      state: "paused",
      pauseReason: "gone",
      goneCause: "removed",
    });
    expect((await removed.status()).json).toMatchObject({ reason: "gone", gone: "unauthorized" });
    // Put back: archiving goes on, and nothing is left of why it stopped.
    w.github.select(removed.repo.id);
    await p.deliver();
    expect(await linkOf(removed.project.id)).toMatchObject({ state: "ready", goneCause: null });
    expect("gone" in (await removed.status()).json).toBe(false);
    await p.work();
    // Taken out and then deleted, the deliveries the other way round: deleted is what it is.
    const both = await subscribed("both");
    w.github.unselect(both.repo.id);
    const [out] = w.github.takeDeliveries();
    await p.deliver([
      {
        event: "repository",
        payload: { action: "deleted", repository: { id: both.repo.id, name: "both" } },
      },
      out!,
    ]);
    expect((await linkOf(both.project.id))!.goneCause).toBe("deleted");
    expect((await both.status()).json.gone).toBe("deleted");
  });

  test("without a webhook, the person's own token says what it can about a repository that is gone", async () => {
    const gone = async (name: string, options: { private?: boolean } = {}) => {
      const project = await newProject(w);
      const repo = w.github.addRepo(w.person, { name, select: true, ...options });
      await linkTo(w, project.id, repo, false);
      expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
      return {
        project,
        repo,
        /** An archive finds it not there, and says no more than that. */
        found: async () => {
          await edit(w, project, write("code/a.js", `${name}\n`));
          expect(await confirmed(w, project.id)).toEqual({
            kind: "paused",
            reason: "gone",
          });
          expect((await linkOf(project.id))!.goneCause).toBeNull();
        },
        status: async () => (await p.request("GET", `/api/projects/${project.id}/repository`)).json,
      };
    };
    const asked = (id: number) =>
      w.github.calls.filter((call) => call === `GET /repositories/${id}`).length;

    // A public one taken out of what the App may touch: their token still sees it.
    const open = await gone("open", { private: false });
    w.github.unselect(open.repo.id);
    w.github.takeDeliveries();
    await open.found();
    const before = asked(open.repo.id);
    expect(await open.status()).toMatchObject({ reason: "gone", gone: "unauthorized" });
    // Asked once: the editor asks how archiving goes over and over.
    expect(await open.status()).toMatchObject({ gone: "unauthorized" });
    expect(asked(open.repo.id)).toBe(before + 1);

    // A private one taken out, or deleted, on an account with selected repositories: their token
    // sees neither, as it sees no more than the App does. Nothing is said, rather than a guess.
    const hidden = await gone("hidden");
    w.github.unselect(hidden.repo.id);
    w.github.takeDeliveries();
    await hidden.found();
    const hiddenStatus = await hidden.status();
    expect(hiddenStatus).toMatchObject({ state: "paused", reason: "gone" });
    expect("gone" in hiddenStatus).toBe(false);
    const lost = await gone("lost");
    w.github.deleteRepo(lost.repo.id);
    await lost.found();
    expect("gone" in (await lost.status())).toBe(false);

    // A private one that was put back, which nobody told the platform: their token sees it, as
    // the App may touch it again. Not taken out any more, so that is not said: archiving now goes on.
    const back = await gone("back");
    w.github.unselect(back.repo.id);
    await back.found();
    w.github.select(back.repo.id);
    w.github.takeDeliveries();
    expect("gone" in (await back.status())).toBe(false);
    w.time.later(2 * 60_000);
    await p.request("POST", `/api/projects/${back.project.id}/archive`);
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    expect(await back.status()).toMatchObject({ state: "ready" });
    // A public one that moved to another account, where the App is not: there for their token to
    // see, and someone else's. Not theirs to put back, so that is not said either.
    const moved = await gone("moved", { private: false });
    w.github.transfer(moved.repo.id, { id: w.person.id + 5, login: `${w.person.login}-away` });
    await moved.found();
    expect("gone" in (await moved.status())).toBe(false);

    // Where the App may touch every repository of the account, one that is not there was deleted,
    // or moved to another account where the App is not: nothing tells which, and nothing is said
    // ("not found").
    await t.db
      .update(installations)
      .set({ repositorySelection: "all" })
      .where(eq(installations.id, w.installation));
    w.github.installed.get(w.person.id)!.selection = "all";
    const everything = await gone("everything");
    w.github.deleteRepo(everything.repo.id);
    await everything.found();
    const everythingStatus = await everything.status();
    expect(everythingStatus).toMatchObject({ reason: "gone" });
    expect("gone" in everythingStatus).toBe(false);

    // GitHub away: how archiving goes is said all the same, without what is not known.
    const unknown = await gone("unknown");
    w.github.deleteRepo(unknown.repo.id);
    await unknown.found();
    w.github.faults.unreachable = true;
    const answer = await p.request("GET", `/api/projects/${unknown.project.id}/repository`);
    w.github.faults.unreachable = false;
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ state: "paused", reason: "gone" });
    expect("gone" in answer.json).toBe(false);

    // The list of projects never asks GitHub about any of them.
    const mark = w.github.calls.length;
    const listed = (await p.request("GET", "/api/projects")).json.projects as any[];
    expect(listed.filter((each) => each.repository?.reason === "gone")).toHaveLength(6);
    expect(w.github.calls.length).toBe(mark);
    expect(await t.db.select().from(projects).where(eq(projects.ownerId, w.userId))).toHaveLength(
      7,
    );
  });

  test("a repository the platform made that was deleted on GitHub: a new one of the same name takes its place", async () => {
    const named = (name: string) =>
      [...w.github.repos.values()].filter((each) => each.name.toLowerCase() === name);
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const url = `/api/projects/${project.id}/repository`;
    await p.request("POST", url, { create: { name: "atom" } });
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    const [first] = named("atom");
    // People deleted it on GitHub, which the next archive finds out.
    w.github.deleteRepo(first!.id);
    await edit(w, project, write("code/a.js", "b\n"));
    expect(await confirmed(w, project.id)).toMatchObject({ kind: "paused", reason: "gone" });
    // The name is free again, as the check says: it is the one the editor proposes.
    expect((await check({ create: { name: "atom" } })).json).toEqual({ ok: true });
    // A new repository of that name: made, and the project's from now on.
    const made = await p.request("POST", url, { create: { name: "atom" } });
    expect(made.status).toBe(201);
    const [second] = named("atom");
    expect(named("atom")).toHaveLength(1);
    expect(second!.id).not.toBe(first!.id);
    expect(made.json).toMatchObject({
      state: "ready",
      archiving: true,
      archivedSeq: 0,
      repository: { id: second!.id, name: "atom", createdHere: true },
    });
    expect("reason" in made.json).toBe(false);
    expect(await linkOf(project.id)).toMatchObject({
      repoId: second!.id,
      state: "ready",
      pauseReason: null,
      headSha: null,
    });
    expect(p.queued).toEqual([{ project: project.id, kind: "first", by: w.userId }]);
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 3 }]);
    expect(w.github.files(second!.id).get("code/a.js")).toBe("b\n");
    // The same request again, as after an answer that did not come back, however it is spelled
    // and whether or not it says to switch: that repository, and nothing more.
    for (const body of [
      { create: { name: "atom" } },
      { create: { name: "ATOM" }, switch: true },
      { create: { name: "atom" }, switch: true },
    ]) {
      const again = await p.request("POST", url, body);
      expect(again.status).toBe(201);
      expect(again.json).toMatchObject({ state: "ready", repository: { id: second!.id } });
    }
    expect(named("atom")).toHaveLength(1);
    expect(p.queued).toEqual([]);

    // Deleted, and the platform has not found out yet: archiving still looks fine. Told to take
    // another one, of the same name: a new one is made. Not told to: as it is, as ever.
    w.github.deleteRepo(second!.id);
    const same = await p.request("POST", url, { create: { name: "atom" } });
    expect(same.status).toBe(201);
    expect(same.json.repository.id).toBe(second!.id);
    expect(named("atom")).toHaveLength(0);
    const third = await p.request("POST", url, { create: { name: "atom" }, switch: true });
    expect(third.status).toBe(201);
    expect(named("atom")).toHaveLength(1);
    expect(third.json).toMatchObject({
      state: "ready",
      repository: { id: named("atom")[0]!.id, createdHere: true },
    });
    expect(third.json.repository.id).not.toBe(second!.id);
    expect(p.queued).toEqual([{ project: project.id, kind: "first", by: w.userId }]);
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    expect(w.github.files(named("atom")[0]!.id).get("code/a.js")).toBe("b\n");
  });

  test("a repository another project was just linked to is not what a failed try left: its name is taken", async () => {
    const first = await newProject(w, new Editor("甲"));
    const made = await p.request("POST", `/api/projects/${first.id}/repository`, {
      create: { name: "shared" },
    });
    expect(made.status).toBe(201);
    // Its first archive has not run: empty, private, made a moment ago, with the platform's
    // description, as what a try that lost its answer leaves. But a project is saved to it.
    expect((await check({ create: { name: "shared" } })).json).toEqual({
      ok: false,
      reason: "nameTaken",
    });
    // As linking says, of a project of another name and of one of the same.
    const second = await newProject(w, new Editor("乙"));
    const other = await p.request("POST", `/api/projects/${second.id}/repository`, {
      create: { name: "shared" },
    });
    expect(other.status).toBe(409);
    expect(other.json).toEqual({ error: "nameTaken" });
    const third = await newProject(w, new Editor("甲"));
    const same = await p.request("POST", `/api/projects/${third.id}/repository`, {
      create: { name: "shared" },
    });
    expect(same.status).toBe(409);
    expect(same.json).toEqual({
      error: "linkedElsewhere",
      project: { id: first.id, name: "甲" },
    });
    // What a try really left, which no project is saved to, is free to take, as linking takes it.
    w.github.addRepo(w.person, { name: "left", select: true, description: descriptionOf("甲") });
    expect((await check({ create: { name: "left" } })).json).toEqual({ ok: true });
    const taken = await p.request("POST", `/api/projects/${third.id}/repository`, {
      create: { name: "left" },
    });
    expect(taken.status).toBe(201);
    expect(taken.json.repository).toMatchObject({ name: "left", createdHere: true });
    // And now that a project has it, it is not.
    expect((await check({ create: { name: "left" } })).json).toEqual({
      ok: false,
      reason: "nameTaken",
    });
  });

  test("switching the repository while an archive into the old one is on its way leaves the new link untouched", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const url = `/api/projects/${project.id}/repository`;
    await p.request("POST", url, { create: { name: "first" } });
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 2 }]);
    const first = [...w.github.repos.values()].find((each) => each.name === "first")!;
    const second = w.github.addRepo(w.person, { name: "second", select: true });
    await edit(w, project, write("code/a.js", "b\n"));
    // The archive has made its commit and noted it, and is about to move the branch, when people
    // take another repository.
    let switched: { status: number; json: any } | undefined;
    let done = false;
    w.github.onCall = async (call) => {
      if (done || !/^PATCH .*\/git\/refs\/heads\//.test(call)) return;
      done = true;
      switched = await p.request("POST", url, { existing: { id: second.id }, switch: true });
    };
    const outcome = await w.archiver().run(project.id, "auto");
    w.github.onCall = undefined;
    expect(switched?.status).toBe(201);
    // Not this archive's to finish any more.
    expect(outcome).toEqual({ kind: "none" });
    // The old repository has that commit: its history stays there.
    expect(w.github.files(first.id).get("code/a.js")).toBe("b\n");
    // The new link has nothing of the old repository: no commit of it, nothing on its way, no
    // paths written, nothing archived yet, and the first archive still asked for.
    const link = (await linkOf(project.id))!;
    expect(link).toMatchObject({
      repoId: second.id,
      state: "ready",
      headSha: null,
      pendingSha: null,
      pending: null,
      archivedSeq: 0,
      archivedAt: null,
      lfsPaths: [],
      failures: 0,
    });
    expect(link.requestedAt).not.toBeNull();
    expect(
      (await t.db.select().from(projects).where(eq(projects.id, project.id)))[0]!.dirtySince,
    ).not.toBeNull();
    // Which puts all of the project into the new one.
    expect(p.queued).toEqual([{ project: project.id, kind: "first", by: w.userId }]);
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 3 }]);
    expect(w.github.files(second.id).get("code/a.js")).toBe("b\n");
    expect(w.github.files(second.id).has("animaquill.json")).toBe(true);
    expect((await linkOf(project.id))!.archivedSeq).toBe(3);
  });

  test("conflicts with GitHub, blocked files and merging what GitHub has now, as the editor asks", async () => {
    const project = await newProject(w);
    await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "merged" },
    });
    await p.work();
    const status = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(status.json).toMatchObject({ state: "ready", conflicts: 0, blocked: [] });
    expect(status.json.merge).toBeUndefined();
    const [conflict] = await t.db
      .insert(repoConflicts)
      .values({
        projectId: project.id,
        batch: "01900000-0000-7000-8000-000000000000",
        source: "merge",
        lost: "batch",
        file: "code/a.js",
        path: [],
        label: "代码 code/a.js 第 1 行",
        kind: "lines",
        ours: ["mine\n"],
        theirs: ["theirs\n"],
      })
      .returning({ id: repoConflicts.id });
    await t.db
      .update(projectRepos)
      .set({
        state: "paused",
        pauseReason: "conflicts",
        blocked: [{ path: "timelines/main/timeline.json", reason: "invalid", detail: "第 1 行" }],
      })
      .where(eq(projectRepos.projectId, project.id));
    // A push while paused for what waits is looked at all the same while merges are on: merging
    // goes on meanwhile. Off, nothing is queued for it, as before merges.
    p.queued.splice(0);
    const repo = [...w.github.repos.values()].find((each) => each.name === "merged")!;
    w.github.takeDeliveries();
    w.github.commitAs(repo.id, w.person, { "README.md": "# 别人的\n" });
    await p.deliver();
    expect(p.queued).toEqual([]);
    await changeSetting(t.db, REPO_MERGE_SETTING, { enabled: true }, { adminId: null });
    try {
      w.github.commitAs(repo.id, w.person, { "README.md": "# 又改了\n" });
      await p.deliver();
      expect(p.queued).toEqual([expect.objectContaining({ project: project.id, kind: "check" })]);
    } finally {
      await changeSetting(t.db, REPO_MERGE_SETTING, { enabled: false }, { adminId: null });
    }
    const listed = await p.request("GET", `/api/projects/${project.id}/conflicts`);
    expect(listed.status).toBe(200);
    expect(listed.json.conflicts).toEqual([
      expect.objectContaining({ id: conflict!.id, state: "open", ours: ["mine\n"], kind: "lines" }),
    ]);
    const one = await p.request("GET", `/api/projects/${project.id}/conflicts/${conflict!.id}`);
    expect(one.json).toMatchObject({ id: conflict!.id, theirs: ["theirs\n"] });
    expect((await p.request("GET", `/api/projects/${project.id}/conflicts/not-an-id`)).status).toBe(
      404,
    );
    // "Archive now" goes past neither.
    const now = await p.request("POST", `/api/projects/${project.id}/archive`);
    expect(now.status).toBe(202);
    expect(now.json).toMatchObject({ state: "paused", reason: "conflicts", conflicts: 1 });
    expect(
      (
        await p.request("POST", `/api/projects/${project.id}/conflicts/resolve`, {
          ids: [conflict!.id],
          keep: "both",
        })
      ).status,
    ).toBe(400);
    const resolved = await p.request("POST", `/api/projects/${project.id}/conflicts/resolve`, {
      ids: [conflict!.id],
      keep: "ours",
    });
    expect(resolved.status).toBe(200);
    // The blocked file still waits: paused for it now.
    expect(resolved.json).toMatchObject({
      resolved: 1,
      status: { state: "paused", reason: "blocked", conflicts: 0 },
    });
    expect(
      (
        await p.request("POST", `/api/projects/${project.id}/repository/blocked`, {
          path: "nothing.json",
          use: "editor",
        })
      ).json,
    ).toEqual({ error: "notBlocked" });
    p.queued.splice(0);
    const used = await p.request("POST", `/api/projects/${project.id}/repository/blocked`, {
      path: "timelines/main/timeline.json",
      use: "editor",
    });
    expect(used.json).toMatchObject({ state: "ready", blocked: [] });
    expect(p.queued).toEqual([expect.objectContaining({ project: project.id, kind: "auto" })]);
    const merge = await p.request("POST", `/api/projects/${project.id}/repository/merge-now`, {
      sha: "a".repeat(40),
    });
    expect(merge.json).toEqual({ error: "notRewritten" });
    expect(
      (await p.request("POST", `/api/projects/${project.id}/repository/merge-now`, { sha: "x" }))
        .status,
    ).toBe(400);
  });
});
