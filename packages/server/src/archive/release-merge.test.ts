import { OWNER_ONLY } from "../access.ts";
import { RepoHosts } from "./repo-host.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { clock, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import {
  CODE,
  LINES,
  archiveAndMerge,
  linkRow,
  mergeWorld,
  mergesOf,
  platformFiles,
  projectFilesOf,
  pushOnGitHub,
  withLine,
} from "../test/merge-support.ts";
import { wakeCopy } from "../sync/wake.ts";
import { ProjectExporter } from "./exporter.ts";
import { Rebuilder } from "./rebuild.ts";

/**
 * A working copy the platform lets go of after changes on GitHub were merged into it and not
 * archived, on a real PostgreSQL and the fake GitHub: the next copy is the last archive, and
 * GitHub's changes are merged into it again from there, then archived as ever. Found by the review
 * of P3. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe.skipIf(!TEST_DATABASE)(
  "letting go of a copy with merges of GitHub's changes in it",
  () => {
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

    /** Makes the copy again from the repository, as opening it does. */
    const rebuild = async (m: Awaited<ReturnType<typeof mergeWorld>>) => {
      await wakeCopy(t.db, m.project, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
      return new Rebuilder({
        db: t.db,
        hosts: RepoHosts.github(w.host),
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: quiet,
        now: () => w.time.now,
        lookAgain: async () => {},
      }).run(m.project);
    };

    test("merges GitHub's changes into the next copy again, and archives as ever", async () => {
      const m = await mergeWorld(w);
      // Both changed the same line: a conflict, archiving paused, the merge in the copy only.
      await m.window.change({
        type: "file.write",
        params: { path: CODE, text: withLine(LINES.join(""), 2, "export const v2 = 1000;\n") },
      });
      pushOnGitHub(m, {
        files: { [CODE]: withLine(LINES.join(""), 2, "export const v2 = 22;\n") },
      });
      await archiveAndMerge(m);
      expect(await linkRow(m)).toMatchObject({ state: "paused", pauseReason: "conflicts" });
      expect((await linkRow(m)).mergedSha).not.toBeNull();
      m.window.peer.connection.close();
      await m.hub.idle();
      expect((await m.hub.release(m.project, { unarchived: true })).kind).toBe("released");
      // The merge was of the copy that went: it is no merge of the next one.
      expect((await mergesOf(m)).map(({ state }) => state)).toEqual(["superseded"]);
      expect(await rebuild(m)).toMatchObject({ kind: "rebuilt" });
      // GitHub's change comes into the next copy again, and archiving goes on.
      const outcomes = await archiveAndMerge(m);
      expect(outcomes.map(({ kind }) => kind)).toContain("merging");
      expect((await platformFiles(m)).get(CODE)).toContain("v2 = 22");
      expect(await linkRow(m)).toMatchObject({ state: "ready", pauseReason: null });
      expect(projectFilesOf(m).get(CODE)).toContain("v2 = 22");
      expect((await mergesOf(m)).map(({ state }) => state).toSorted()).toEqual([
        "applied",
        "superseded",
      ]);
    });
  },
);
