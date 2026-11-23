import { isProjectFile } from "@animaquill/core";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clock, world } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import {
  CODE,
  LINES,
  archiveAndMerge,
  conflictsOf,
  linkRow,
  mergeWorld,
  mergesOf,
  platformFiles,
  pushOnGitHub,
  withLine,
  workingFiles,
  type MergeWorld,
} from "../test/merge-support.ts";
import { projectBatches } from "../schema.ts";

/**
 * Editors, people on GitHub and the platform's archives and merges, in a random order: changes of a
 * window sent at once or made offline and sent late, commits on GitHub to the project's code and to
 * files that are not the project's, now and then a forced push back to an older commit, archives
 * that look, merges the hub does late, and people settling what waits. What has to hold, whatever
 * the order:
 *
 * 1. The branch only ever moves forward by the platform: none of its pushes is forced.
 * 2. Files that are not the project's are, in each commit of the platform, as in its first parent:
 *    the platform never touches them.
 * 3. Nothing of either side goes without a word: a line GitHub last wrote, or the editor last wrote
 *    and the platform took, that the project does not have in the end has a conflict of that file.
 * 4. Once quiet, the branch has what the working copy has, and every commit others made that was
 *    not forced away is in its history.
 * 5. What a forced push took away of GitHub's (a file, a line), and nobody wrote again, is not on
 *    the branch in the end, unless the editor changed it since and people chose to keep that.
 * 6. Taking a merge back as a whole (2E) only ever takes back what GitHub wrote: what the editor
 *    or a later merge wrote stays as it is; and what it took back, nobody wrote again, and no
 *    rewritten history brought in again, is not on the branch in the end.
 *
 * AQ_FUZZ_SEEDS sets how many seeds (30 unless said); a failing seed runs alone with AQ_FUZZ_SEED.
 */

const SEEDS = Number(process.env["AQ_FUZZ_SEEDS"] ?? 30);
const ONLY = process.env["AQ_FUZZ_SEED"];
const STEPS = 14;

/** A generator of numbers that is the same for a seed, as mulberry32. */
const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** What the seeds came to, all of them together: each has to have come at least once. */
const covered = new Set<string>();

const lineOf = (index: number, mark: string) => `export const v${index} = "${mark}";\n`;
const linesOf = (text: string) => text.split(/(?<=\n)/);

describe.skipIf(!TEST_DATABASE)("merging in any order, on a database", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const seeds = ONLY ? [Number(ONLY)] : Array.from({ length: SEEDS }, (_, index) => index + 1);
  for (const seed of seeds) {
    test(`seed ${seed}`, { timeout: 240_000 }, async () => {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const w = await world(t.db, clock(new Date()));
      const m = await mergeWorld(w);
      const repo = m.w.github.repos.get(m.repo.id)!;
      const log: string[] = [];
      /** What each side last wrote of each line, and every line written, in the order made. */
      const github = new Map<number, string>();
      const editor = new Map<number, string>();
      const written = new Map<number, { readonly line: string; readonly order: number }[]>();
      let order = 0;
      const wrote = (side: Map<number, string>, index: number, line: string) => {
        side.set(index, line);
        written.set(index, [...(written.get(index) ?? []), { line, order: ++order }]);
      };
      /** Commits of others that the branch is to keep: those after the last forced push. */
      let kept: string[] = [];
      let forced = false;
      /** Files and lines of GitHub's that a forced push took away: they stay away. */
      const forcedAway = new Set<string>();
      let marks = 0;
      const deliveriesSeen = { count: 0 };
      /** Lines of GitHub's that a merge taken back took away, and forced pushes after it. */
      const undoneLines = new Set<string>();
      /** ...those of them a forced push came after, which a rewritten history may bring back. */
      const undoneBeforeForce = new Set<string>();
      /** A forced push back to an older commit, and what it took away of GitHub's. */
      const forceTo = (back: string) => {
        const was = m.w.github.files(m.repo.id);
        m.w.github.forcePush(m.repo.id, m.w.person, back);
        forced = true;
        for (const mark of undoneLines) undoneBeforeForce.add(mark);
        // What the history taken away had of GitHub's, and the commit it goes back to does not.
        const now = m.w.github.files(m.repo.id);
        for (const path of was.keys())
          if (/^code\/g\d+\.js$/.test(path) && !now.has(path)) forcedAway.add(path);
        for (const mark of (was.get(CODE) ?? "").match(/"g\d+"/g) ?? [])
          if (!(now.get(CODE) ?? "").includes(mark)) forcedAway.add(mark);
        log.push(`  forced back to ${back.slice(0, 7)}: ${[...forcedAway].join(", ")}`);
        kept = kept.filter((sha) => repo.objects.isAncestor(sha, back));
        // What GitHub has of each line is what the older commit has.
        const text = m.w.github.files(m.repo.id).get(CODE) ?? "";
        github.clear();
        linesOf(text).forEach((line, index) => {
          if (/"g\d+"/.test(line)) github.set(index, line);
        });
      };

      const checkPushes = () => {
        const deliveries = m.w.github.deliveries.slice(deliveriesSeen.count);
        deliveriesSeen.count = m.w.github.deliveries.length;
        for (const delivery of deliveries) {
          if (delivery.event !== "push") continue;
          const sender = (delivery.payload.sender as { login?: string } | undefined)?.login ?? "";
          if (!sender.endsWith("[bot]")) continue;
          // 1.
          expect(delivery.payload.forced, log.join("\n")).toBe(false);
          // 2.
          const after = delivery.payload.after as string;
          const commit = repo.objects.readCommit(after);
          const outside = (sha: string) =>
            new Map(
              [...m.w.github.filesAt(m.repo.id, sha)].filter(
                ([path]) => !isProjectFile(path) && path !== ".gitattributes",
              ),
            );
          expect(outside(after), log.join("\n")).toEqual(outside(commit.parents[0]!));
        }
      };

      const currentCode = () =>
        m.w.github.files(m.repo.id).get(CODE) ?? workingFiles(m).get(CODE) ?? LINES.join("");

      for (let step = 0; step < STEPS; step++) {
        const what = pick([
          "edit",
          "edit",
          "offline",
          "flush",
          "github",
          "github",
          "github-other",
          "github-file",
          "github-bad",
          "archive",
          "archive",
          "look",
          "merge",
          "settle",
          "undo",
          "undo",
          ...(forced ? [] : ["force", "undo-force-redo"]),
        ]);
        log.push(`${step}: ${what}`);
        switch (what) {
          case "edit":
          case "offline": {
            const index = Math.floor(next() * LINES.length);
            const mark = `e${++marks}`;
            m.window.hear();
            const text = m.window.store.exportFiles().files.get(CODE) ?? LINES.join("");
            const call = {
              type: "file.write",
              params: { path: CODE, text: withLine(text, index, lineOf(index, mark)) },
            } as const;
            if (what === "edit") {
              const answer = await m.window.change(call);
              log.push(
                `  ${mark} line ${index}: ${answer.t}${"reason" in answer ? ` ${answer.reason}` : ""}`,
              );
              if (answer.t === "ack" || answer.t === "later")
                wrote(editor, index, lineOf(index, mark));
            } else {
              log.push(`  ${mark} line ${index} offline`);
              m.window.changeOffline(call);
              wrote(editor, index, lineOf(index, mark));
            }
            break;
          }
          case "flush":
            for (const answer of await m.window.flush())
              log.push(`  sent: ${answer.t}${"reason" in answer ? ` ${answer.reason}` : ""}`);
            break;
          case "github": {
            const index = Math.floor(next() * LINES.length);
            const mark = `g${++marks}`;
            const sha = pushOnGitHub(m, {
              files: { [CODE]: withLine(currentCode(), index, lineOf(index, mark)) },
            });
            wrote(github, index, lineOf(index, mark));
            log.push(`  ${mark} line ${index} on GitHub`);
            kept.push(sha);
            break;
          }
          case "github-other": {
            const sha = pushOnGitHub(m, { files: { "README.md": `# ${++marks}\n` } });
            kept.push(sha);
            break;
          }
          case "github-file": {
            const sha = pushOnGitHub(m, {
              files: { [`code/g${++marks}.js`]: `export const g${marks} = ${marks};\n` },
            });
            log.push(`  code/g${marks}.js on GitHub`);
            kept.push(sha);
            break;
          }
          case "github-bad": {
            // A document that does not read: blocked, and written over once people choose.
            const sha = pushOnGitHub(m, { files: { "scenes/intro/scene.json": "{ broken" } });
            kept.push(sha);
            break;
          }
          case "archive":
            await archiveAndMerge(m, "auto", 3);
            break;
          case "look": {
            // Looks, and leaves what it queued for the hub to do later.
            await m.archiver().run(m.project, "check");
            break;
          }
          case "merge":
            for (const merge of m.queued.splice(0)) await m.hub.mergeRepo(merge);
            m.window.hear();
            break;
          case "settle":
            await settle(m, false);
            break;
          case "undo": {
            // A merge of GitHub's, taken back as a whole, as people do from the list of operations.
            const live = await m.w.db
              .select({ id: projectBatches.id })
              .from(projectBatches)
              .where(and(eq(projectBatches.projectId, m.project), eq(projectBatches.kind, "repo")));
            if (live.length === 0) break;
            const batch = pick(live).id;
            const before = linesOf((await platformFiles(m)).get(CODE) ?? "");
            const filesBefore = await platformFiles(m);
            const taken = await m.hub.takeBack(m.project, m.w.userId, batch);
            log.push(
              `  undo ${batch.slice(-6)}: ${taken.kind}${"why" in taken ? ` ${taken.why}` : ""}${taken.kind === "taken" ? ` back ${taken.backCount} kept ${taken.keptCount}` : ""}`,
            );
            if (taken.kind !== "taken") {
              covered.add(`undo ${taken.kind === "refused" ? taken.why : taken.kind}`);
              break;
            }
            covered.add(taken.keptCount > 0 ? "undo kept" : "undo all");
            const filesAfter = await platformFiles(m);
            const after = linesOf(filesAfter.get(CODE) ?? "");
            // 6. Only GitHub's own goes: a line or a file of the editor's never does.
            expect(after.length, log.join("\n")).toBe(before.length);
            before.forEach((line, index) => {
              if (after[index] === line) return;
              expect({ index, line, undone: /"g\d+"/.test(line ?? "") }, log.join("\n")).toEqual({
                index,
                line,
                undone: true,
              });
              undoneLines.add(line!.match(/"g\d+"/)![0]);
              if (github.get(index) === line) github.delete(index);
              // What is there again counts as written now, after whatever was before it.
              written.set(index, [
                ...(written.get(index) ?? []),
                { line: after[index]!, order: ++order },
              ]);
            });
            for (const path of filesBefore.keys())
              if (!filesAfter.has(path))
                expect({ path, github: /^code\/g\d+\.js$/.test(path) }, log.join("\n")).toEqual({
                  path,
                  github: true,
                });
            m.window.hear();
            break;
          }
          case "force": {
            const history = m.w.github.history(m.repo.id);
            if (history.length < 3) break;
            forceTo(history[Math.floor(next() * (history.length - 2)) + 1]!.sha);
            break;
          }
          case "undo-force-redo": {
            // A file GitHub brought, taken back, then forced away on GitHub and GitHub's version
            // merged as it is now: doing it again must not bring the file back (5.).
            const base = m.w.github.history(m.repo.id)[0]!.sha;
            const path = `code/g${++marks}.js`;
            pushOnGitHub(m, { files: { [path]: `export const g${marks} = ${marks};\n` } });
            await archiveAndMerge(m, "check");
            const [merge] = await m.w.db
              .select({ id: projectBatches.id, files: projectBatches.files })
              .from(projectBatches)
              .where(and(eq(projectBatches.projectId, m.project), eq(projectBatches.kind, "repo")))
              .orderBy(desc(projectBatches.seq))
              .limit(1);
            if (!merge || !workingFiles(m).has(path)) break;
            const undone = await m.hub.takeBack(m.project, m.w.userId, merge.id);
            log.push(`  ${path}: undo ${undone.kind}`);
            if (undone.kind !== "taken") break;
            forceTo(base);
            // Until GitHub's version as it is now is merged, which takes the merge out.
            await settle(m, true);
            const redone = await m.hub.takeBack(m.project, m.w.userId, undone.batch);
            log.push(`  redo: ${redone.kind}${"why" in redone ? ` ${redone.why}` : ""}`);
            covered.add(`redo after force ${redone.kind === "refused" ? redone.why : redone.kind}`);
            m.window.hear();
            break;
          }
        }
        checkPushes();
      }

      for (const commit of m.w.github.history(m.repo.id))
        if (commit.parents.length === 2) covered.add("merge commit with two parents");
      // Quiet: everything sent, merged, settled, archived.
      for (const answer of await m.window.flush())
        log.push(`  sent: ${answer.t}${"reason" in answer ? ` ${answer.reason}` : ""}`);
      await settle(m, true);
      checkPushes();
      log.push(`done: ${JSON.stringify(await linkRow(m))}`);
      const link = await linkRow(m);
      expect(link.state, log.join("\n")).toBe("ready");
      expect(link.mergedSha, log.join("\n")).toBeNull();
      // 4.
      const files = new Map(
        [...m.w.github.files(m.repo.id)].filter(([path]) => isProjectFile(path)),
      );
      expect(files, log.join("\n")).toEqual(await platformFiles(m));
      expect(workingFiles(m), log.join("\n")).toEqual(await platformFiles(m));
      const tip = m.w.github.history(m.repo.id)[0]!.sha;
      for (const sha of kept) expect(repo.objects.isAncestor(sha, tip), log.join("\n")).toBe(true);
      const conflicts = await conflictsOf(m);
      // 5. What a forced push took away, and nobody wrote again, is not on the branch: unless the
      //    editor changed it since, which is a conflict people chose for.
      const branch = m.w.github.files(m.repo.id);
      for (const away of forcedAway) {
        const file = away.startsWith("code/") ? away : CODE;
        const there = away.startsWith("code/")
          ? branch.has(away)
          : (branch.get(CODE) ?? "").includes(away);
        if (there)
          expect(
            { away, conflicted: conflicts.some((conflict) => conflict.file === file) },
            log.join("\n"),
          ).toMatchObject({ conflicted: true });
        else covered.add("forced away stays away");
      }
      // 6. What was taken back, and nobody wrote again, is not on the branch.
      // Each mark is written once: what has it again is GitHub's line, brought back.
      for (const mark of undoneLines) {
        if (undoneBeforeForce.has(mark)) continue;
        expect({ mark, there: (branch.get(CODE) ?? "").includes(mark) }, log.join("\n")).toEqual({
          mark,
          there: false,
        });
        covered.add("taken back stays away");
      }
      // 3.
      const conflicted = conflicts.some(({ file }) => file === CODE);
      for (const { source } of conflicts) covered.add(`conflict ${source}`);
      for (const { state } of await mergesOf(m)) covered.add(`merge ${state}`);
      if (forced) covered.add("forced");
      for (const commit of m.w.github.history(m.repo.id))
        if (commit.parents.length === 2) covered.add("merge commit with two parents");
      const final = linesOf(workingFiles(m).get(CODE) ?? "");
      for (let index = 0; index < LINES.length; index++) {
        // Each line is one somebody wrote: nothing made up. A change made offline that comes after
        // a merge wrote the same text (Y.Text) can leave both in it, a known limit of code: only
        // with a conflict that says to look.
        const known = [LINES[index], ...(written.get(index) ?? []).map(({ line }) => line)];
        if (!known.includes(final[index]))
          expect({ index, now: final[index], conflicted }, log.join("\n")).toMatchObject({
            conflicted: true,
          });
      }
      for (const [side, last] of [
        ["github", github],
        ["editor", editor],
      ] as const) {
        if (side === "github" && forced) continue;
        for (const [index, line] of last) {
          if (final[index] === line) continue;
          // Written over by a line made after it: that one saw it, or says so with a conflict.
          const made = written.get(index)?.find((each) => each.line === line)?.order ?? 0;
          const now = written.get(index)?.find((each) => each.line === final[index]);
          if (now && now.order > made) continue;
          expect(
            { side, index, line, now: final[index], conflicted },
            log.join("\n"),
          ).toMatchObject({ conflicted: true });
        }
      }
    });
  }

  test.skipIf(ONLY !== undefined || SEEDS < 30)("the seeds came to every case", () => {
    expect([...covered].toSorted()).toEqual(
      expect.arrayContaining([
        "blocked",
        "conflict late",
        "conflict merge",
        "forced",
        "forced away stays away",
        "merge applied",
        "merge commit with two parents",
        "paused rewritten",
        "undo all",
        "taken back stays away",
        "redo after force history",
      ]),
    );
  });
});

/**
 * Archives until nothing changes any more, and on the way does what people would for whatever
 * waits: keeps the editor's side of conflicts, overwrites blocked files with the editor's, and,
 * for history rewritten, merges what GitHub has where both have something in common, or writes the
 * editor's on top. `all`: until quiet; otherwise one round.
 */
async function settle(m: MergeWorld, all: boolean): Promise<void> {
  const owner = { userId: m.w.userId } as never;
  for (let round = 0; round < (all ? 12 : 1); round++) {
    const outcomes = await archiveAndMerge(m, "auto", 4);
    const last = outcomes.at(-1)!;
    const link = await linkRow(m);
    const open = (await conflictsOf(m)).filter(({ state }) => state === "open");
    if (open.length > 0) {
      await m.service.resolveConflicts(owner, m.project, {
        ids: open.map(({ id }) => id),
        keep: "ours",
      });
      continue;
    }
    if (link.blocked.length > 0) {
      covered.add("blocked");
      for (const { path } of link.blocked) await m.service.useEditorFor(owner, m.project, path);
      continue;
    }
    if (link.state === "paused") {
      covered.add(`paused ${link.pauseReason}`);
      if (link.pauseReason === "rewritten" && link.diverged?.base) {
        await m.service.mergeNow(owner, m.project, link.diverged.sha);
        continue;
      }
      const sha = link.diverged?.sha ?? link.mergedSha ?? link.headSha;
      if (sha) await m.service.archiveNow(owner, m.project, sha);
      continue;
    }
    if (
      all &&
      (last.kind === "same" || last.kind === "unchanged" || last.kind === "archived") &&
      m.queued.length === 0
    ) {
      // One more that finds nothing to do.
      const again = await archiveAndMerge(m, "auto", 4);
      if (again.at(-1)?.kind === "same") return;
    }
  }
}
