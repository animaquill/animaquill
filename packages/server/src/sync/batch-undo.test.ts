import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { clock, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import {
  CODE,
  LINES,
  archiveAndMerge,
  conflictsOf,
  linkRow,
  mergeWorld,
  platformFiles,
  projectFilesOf,
  pushOnGitHub,
  withLine,
  workingFiles,
  Window,
  type MergeWorld,
} from "../test/merge-support.ts";
import { projectBatches, projectRepos, repoMerges } from "../schema.ts";

/**
 * Taking back a merge of changes on GitHub as a whole, and doing it again: on the platform, from
 * what the batch keeps, in the project's turn; the next archive writes the project as it is then,
 * so GitHub goes back too. What anybody changed since stays; what people chose to take out ("drop")
 * never comes back. On a real PostgreSQL and the fake GitHub. Needs AQ_TEST_DATABASE, see
 * vitest.config.ts.
 */

const SCENE = "scenes/intro/index.html";
const LINE2 = "export const v2 = 22;\n";

describe.skipIf(!TEST_DATABASE)("taking back merges of GitHub as a whole, on a database", () => {
  let t: TestDatabase;
  let w: World;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db, clock(new Date()));
  });

  const tipOf = (m: MergeWorld) => m.w.github.history(m.repo.id)[0]!;
  const batchesOf = (m: MergeWorld) =>
    t.db.select().from(projectBatches).where(eq(projectBatches.projectId, m.project));
  /** GitHub changes two files, and the platform merges them: resolves to the merge's batch. */
  const mergeTwo = async (m: MergeWorld) => {
    const theirs = pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 2, LINE2), [SCENE]: "<p>GitHub</p>\n" },
    });
    const outcomes = await archiveAndMerge(m, "check");
    expect(outcomes[0]).toMatchObject({ kind: "merging" });
    const [batch] = (await batchesOf(m)).filter(({ kind }) => kind === "repo");
    expect(batch).toMatchObject({ files: 2 });
    return { theirs, batch: batch!.id };
  };
  const takeBack = (m: MergeWorld, batch: string) => m.hub.takeBack(m.project, w.userId, batch);
  const platformPushes = (m: MergeWorld) =>
    m.w.github
      .takeDeliveries()
      .filter(
        (delivery) =>
          delivery.event === "push" &&
          (delivery.payload.sender as { login?: string } | undefined)?.login?.endsWith("[bot]"),
      );

  test("a merge of two files goes back in the working copy, and the next archive puts GitHub back too", async () => {
    const m = await mergeWorld(w);
    const before = workingFiles(m);
    expect(before.get(SCENE)).toBeDefined();
    const { theirs, batch } = await mergeTwo(m);
    expect(workingFiles(m).get(CODE)).toContain("v2 = 22");
    expect(workingFiles(m).get(SCENE)).toBe("<p>GitHub</p>\n");
    expect(await m.hub.batchState(m.project, w.userId, batch)).toEqual({
      kind: "state",
      state: expect.objectContaining({
        id: batch,
        kind: "repo",
        undone: false,
        next: { batch, direction: "undo" },
      }),
    });

    const taken = await takeBack(m, batch);
    expect(taken).toMatchObject({ kind: "taken", direction: "undo", keptCount: 0 });
    if (taken.kind !== "taken") throw new Error("not taken");
    expect(taken.backCount).toBeGreaterThanOrEqual(2);
    // Windows hear of it as a batch of its own, which says what it takes back.
    const [heard] = m.window.peer.of("update").slice(-1);
    expect(heard?.by).toMatchObject({ batch: taken.batch, kind: "undo", undoes: batch, files: 2 });
    const now = workingFiles(m);
    expect(now.get(CODE)).toBe(before.get(CODE));
    expect(now.get(SCENE)).toBe(before.get(SCENE));
    expect(await platformFiles(m)).toEqual(now);
    // A window that catches up later hears each batch as what it is.
    const later = await Window.open(m.hub, m.who, m.project);
    expect(later.peer.of("update").flatMap(({ by }) => (by ? [by] : []))).toEqual([
      expect.objectContaining({ batch, kind: "repo", files: 2 }),
      expect.objectContaining({ batch: taken.batch, kind: "undo", undoes: batch, files: 2 }),
    ]);
    const rows = await batchesOf(m);
    expect(rows.find(({ id }) => id === batch)?.undoneAt).not.toBeNull();
    expect(rows.find(({ id }) => id === taken.batch)).toMatchObject({
      kind: "undo",
      undoes: batch,
    });

    // The next archive: GitHub goes back too, on top of its own commit, which stays in the history.
    platformPushes(m);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    const files = projectFilesOf(m);
    expect(files.get(CODE)).toBe(before.get(CODE));
    expect(files.get(SCENE)).toBe(before.get(SCENE));
    expect(tipOf(m).parents[0]).toBe(theirs);
    for (const push of platformPushes(m)) expect(push.payload.forced).toBe(false);
    // ...and nothing merges GitHub's change again.
    const again = await archiveAndMerge(m, "check");
    expect(again.map(({ kind }) => kind)).not.toContain("merging");
    expect(workingFiles(m).get(CODE)).toBe(before.get(CODE));
    expect(await linkRow(m)).toMatchObject({ state: "ready", mergedSha: null });
  });

  test("a place changed since stays as it is, and is said: the rest goes back", async () => {
    const m = await mergeWorld(w);
    const before = workingFiles(m);
    const { batch } = await mergeTwo(m);
    await m.window.change({ type: "file.write", params: { path: SCENE, text: "<p>editor</p>\n" } });
    const taken = await takeBack(m, batch);
    expect(taken).toMatchObject({ kind: "taken", keptCount: 1, obstacle: "changed" });
    if (taken.kind !== "taken") throw new Error("not taken");
    expect(taken.kept.map((path) => path.join("/"))).toEqual([expect.stringContaining("intro")]);
    const now = workingFiles(m);
    expect(now.get(SCENE)).toBe("<p>editor</p>\n");
    expect(now.get(CODE)).toBe(before.get(CODE));
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    expect(projectFilesOf(m).get(SCENE)).toBe("<p>editor</p>\n");
    expect(projectFilesOf(m).get(CODE)).toBe(before.get(CODE));
  });

  test("done again, and taken back once more: each from where the last one left it", async () => {
    const m = await mergeWorld(w);
    const before = workingFiles(m);
    const { batch } = await mergeTwo(m);
    const undone = await takeBack(m, batch);
    if (undone.kind !== "taken") throw new Error("not taken");
    expect(undone.next).toEqual({ batch: undone.batch, direction: "redo" });
    // The merge itself is taken back already: what goes the other way is the batch that did it.
    expect(await takeBack(m, batch)).toEqual({ kind: "refused", why: "undone" });
    expect(await m.hub.batchState(m.project, w.userId, batch)).toMatchObject({
      state: { undone: true, next: { batch: undone.batch, direction: "redo" } },
    });
    const redone = await takeBack(m, undone.batch);
    expect(redone).toMatchObject({ kind: "taken", direction: "redo", keptCount: 0 });
    if (redone.kind !== "taken") throw new Error("not taken");
    expect(workingFiles(m).get(CODE)).toContain("v2 = 22");
    expect(workingFiles(m).get(SCENE)).toBe("<p>GitHub</p>\n");
    // An older step is done with.
    expect(await takeBack(m, undone.batch)).toEqual({ kind: "refused", why: "notLatest" });
    const again = await takeBack(m, redone.batch);
    expect(again).toMatchObject({ kind: "taken", direction: "undo" });
    expect(workingFiles(m).get(CODE)).toBe(before.get(CODE));
    expect(workingFiles(m).get(SCENE)).toBe(before.get(SCENE));
  });

  test("files people chose to take out are never brought back", async () => {
    const m = await mergeWorld(w);
    const { batch } = await mergeTwo(m);
    // As a merge that took files out ("drop") keeps itself, with a record that would bring them back.
    await t.db.update(projectBatches).set({ kind: "drop" }).where(eq(projectBatches.id, batch));
    const was = workingFiles(m);
    expect(await takeBack(m, batch)).toEqual({ kind: "refused", why: "drop" });
    expect(await m.hub.batchState(m.project, w.userId, batch)).toMatchObject({
      state: { why: "drop" },
    });
    expect(workingFiles(m)).toEqual(was);
    expect((await batchesOf(m)).filter(({ kind }) => kind === "undo")).toEqual([]);
  });

  test("a merge that went with the copy it was in (P3) cannot be taken back", async () => {
    const m = await mergeWorld(w);
    const { batch } = await mergeTwo(m);
    await t.db.update(repoMerges).set({ state: "superseded" }).where(eq(repoMerges.id, batch));
    const was = workingFiles(m);
    expect(await takeBack(m, batch)).toEqual({ kind: "refused", why: "rebuilt" });
    expect(workingFiles(m)).toEqual(was);
  });

  test("only the owner, and only batches of the project", async () => {
    const m = await mergeWorld(w);
    const { batch } = await mergeTwo(m);
    expect(await m.hub.takeBack(m.project, "00000000-0000-7000-8000-000000000000", batch)).toEqual({
      kind: "missing",
    });
    expect(await takeBack(m, "no-such-batch")).toEqual({ kind: "missing" });
    expect(await m.hub.takeBack("elsewhere", w.userId, batch)).toEqual({ kind: "missing" });
  });

  test("two windows asking at once take it back once", async () => {
    const m = await mergeWorld(w);
    const { batch } = await mergeTwo(m);
    const both = await Promise.all([takeBack(m, batch), takeBack(m, batch)]);
    expect(both.map(({ kind }) => kind).toSorted()).toEqual(["refused", "taken"]);
    expect(both.find(({ kind }) => kind === "refused")).toEqual({ kind: "refused", why: "undone" });
    expect((await batchesOf(m)).filter(({ kind }) => kind === "undo")).toHaveLength(1);
  });

  test("a push on GitHub after it is merged as ever, and what was taken back stays so", async () => {
    const m = await mergeWorld(w);
    const before = workingFiles(m);
    const { batch } = await mergeTwo(m);
    expect(await takeBack(m, batch)).toMatchObject({ kind: "taken" });
    // GitHub still has its change: the next commit there goes on from it.
    const later = pushOnGitHub(m, {
      files: { [CODE]: withLine(withLine(LINES.join(""), 2, LINE2), 5, "export const v5 = 55;\n") },
    });
    const outcomes = await archiveAndMerge(m, "check");
    expect(outcomes.map(({ kind }) => kind)).toContain("merging");
    const code = workingFiles(m).get(CODE) ?? "";
    expect(code).toContain("v5 = 55");
    expect(code).not.toContain("v2 = 22");
    expect(workingFiles(m).get(SCENE)).toBe(before.get(SCENE));
    expect(tipOf(m).parents[0] ?? tipOf(m).sha).toBeDefined();
    // ...and archived on top of it, with GitHub's first change put back.
    await archiveAndMerge(m);
    const files = projectFilesOf(m);
    expect(files.get(CODE)).toContain("v5 = 55");
    expect(files.get(CODE)).not.toContain("v2 = 22");
    expect(files.get(SCENE)).toBe(before.get(SCENE));
    expect(m.w.github.history(m.repo.id).map(({ sha }) => sha)).toContain(later);
  });

  test("its conflicts are stale once it is taken back, and archiving goes on", async () => {
    const m = await mergeWorld(w);
    const before = workingFiles(m);
    await m.window.change({
      type: "file.write",
      params: { path: CODE, text: withLine(LINES.join(""), 2, "export const v2 = 1000;\n") },
    });
    pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 2, LINE2), [SCENE]: "<p>GitHub</p>\n" },
    });
    await archiveAndMerge(m);
    expect(await linkRow(m)).toMatchObject({ state: "paused", pauseReason: "conflicts" });
    const [batch] = (await batchesOf(m)).filter(({ kind }) => kind === "repo");
    m.archivesQueued.splice(0);
    const taken = await takeBack(m, batch!.id);
    expect(taken).toMatchObject({ kind: "taken" });
    const conflicts = await conflictsOf(m);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.filter(({ state }) => state === "open")).toEqual([]);
    expect(await linkRow(m)).toMatchObject({ state: "ready" });
    expect(m.archivesQueued).toContain(m.project);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    const files = projectFilesOf(m);
    expect(files.get(CODE)).toContain("v2 = 1000");
    expect(files.get(SCENE)).toBe(before.get(SCENE));
  });

  test("a change made without it, sent after it, keeps what it wrote said where it went: nothing goes unseen", async () => {
    const m = await mergeWorld(w);
    pushOnGitHub(m, { files: { "code/added.js": "export const added = 1;\n" } });
    await archiveAndMerge(m, "check");
    expect(workingFiles(m).get("code/added.js")).toBe("export const added = 1;\n");
    const [batch] = (await batchesOf(m)).filter(({ kind }) => kind === "repo");
    // Made on the merge, before the window heard it taken back: into the file it brought.
    m.window.changeOffline({
      type: "file.write",
      params: { path: "code/added.js", text: "export const added = 2;\n" },
    });
    m.window.changeOffline({ type: "project.rename", params: { name: "离线改的" } });
    const taken = await takeBack(m, batch!.id);
    if (taken.kind !== "taken") throw new Error("not taken");
    for (const answer of await m.window.flush()) expect(answer.t).toBe("ack");
    const now = workingFiles(m);
    expect(JSON.parse(now.get("animaquill.json")!).name).toBe("离线改的");
    // What went of the editor's is a conflict of the batch that took the file away.
    const open = (await conflictsOf(m)).filter(({ state }) => state === "open");
    expect(now.has("code/added.js")).toBe(false);
    expect(open).toEqual([
      expect.objectContaining({ batch: taken.batch, lost: "change", file: "code/added.js" }),
    ]);
    // Nothing of the merge's own side comes up as lost: it was taken back.
    expect(open.filter(({ lost }) => lost === "batch")).toEqual([]);
  });

  test("done again after GitHub's history took it away: refused, and GitHub never gets it back", async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    pushOnGitHub(m, { files: { "code/secret.js": "export const key = 'sk';\n" } });
    await archiveAndMerge(m, "check");
    const [merge] = (await batchesOf(m)).filter(({ kind }) => kind === "repo");
    const undone = await takeBack(m, merge!.id);
    if (undone.kind !== "taken") throw new Error("not taken");
    expect(workingFiles(m).has("code/secret.js")).toBe(false);
    // Forced away on GitHub, and GitHub's version as it is now merged.
    m.w.github.forcePush(m.repo.id, m.w.person, start);
    const clean = pushOnGitHub(m, { files: { "code/clean.js": "export const c = 1;\n" } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "rewritten" }]);
    await m.service.mergeNow({ userId: w.userId } as never, m.project, clean);
    await archiveAndMerge(m);
    expect(await m.hub.batchState(m.project, w.userId, merge!.id)).toMatchObject({
      state: { why: "history" },
    });
    expect(await takeBack(m, undone.batch)).toEqual({ kind: "refused", why: "history" });
    await archiveAndMerge(m);
    expect(workingFiles(m).has("code/secret.js")).toBe(false);
    expect(m.w.github.files(m.repo.id).has("code/secret.js")).toBe(false);
  });

  test("done again where people chose to take its files out since, or are taking them out: refused", async () => {
    const m = await mergeWorld(w);
    pushOnGitHub(m, { files: { "code/secret.js": "export const key = 'sk';\n" } });
    await archiveAndMerge(m, "check");
    const [merge] = (await batchesOf(m)).filter(({ kind }) => kind === "repo");
    const undone = await takeBack(m, merge!.id);
    if (undone.kind !== "taken") throw new Error("not taken");
    // Being taken out, as `replace` with `drop` notes it.
    await t.db
      .update(projectRepos)
      .set({ dropping: ["code/secret.js"] })
      .where(eq(projectRepos.projectId, m.project));
    expect(await takeBack(m, undone.batch)).toEqual({ kind: "refused", why: "drop" });
    await t.db
      .update(projectRepos)
      .set({ dropping: null })
      .where(eq(projectRepos.projectId, m.project));
    // Taken out since, by a batch of its own ("drop").
    const [drop] = await t.db
      .insert(repoMerges)
      .values({
        projectId: m.project,
        repoId: m.repo.id,
        fromSha: "a".repeat(40),
        toSha: "a".repeat(40),
        state: "applied",
        result: { drops: ["code/secret.js"] },
      })
      .returning({ id: repoMerges.id });
    const [row] = await batchesOf(m).then((rows) => rows.filter(({ id }) => id === undone.batch));
    await t.db.insert(projectBatches).values({
      ...row!,
      id: drop!.id,
      kind: "drop",
      undoes: null,
      mergeId: drop!.id,
      seq: row!.seq + 1,
    });
    expect(await takeBack(m, undone.batch)).toEqual({ kind: "refused", why: "drop" });
    expect(workingFiles(m).has("code/secret.js")).toBe(false);
  });

  test("a change made without it being done again, sent after, that writes over GitHub's side is a conflict", async () => {
    const m = await mergeWorld(w);
    pushOnGitHub(m, {
      calls: [{ type: "project.rename", params: { name: "GitHub 上的名字" } }],
    });
    await archiveAndMerge(m, "check");
    const [merge] = (await batchesOf(m)).filter(({ kind }) => kind === "repo");
    const undone = await takeBack(m, merge!.id);
    if (undone.kind !== "taken") throw new Error("not taken");
    m.window.hear();
    m.window.changeOffline({ type: "project.rename", params: { name: "离线改的" } });
    const redone = await takeBack(m, undone.batch);
    if (redone.kind !== "taken") throw new Error("not taken");
    for (const answer of await m.window.flush()) expect(answer.t).toBe("ack");
    expect(JSON.parse(workingFiles(m).get("animaquill.json")!).name).toBe("离线改的");
    expect((await conflictsOf(m)).filter(({ state }) => state === "open")).toEqual([
      expect.objectContaining({ batch: redone.batch, lost: "batch", file: "animaquill.json" }),
    ]);
  });
});
