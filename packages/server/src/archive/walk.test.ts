import { SYNC_PROTOCOL } from "@animaquill/host/sync";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Editor, quiet, world, write, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform } from "../test/platform-support.ts";
import { TestPeer } from "../test/sync-support.ts";
import { SyncHub } from "../sync/hub.ts";
import { takeDue } from "./schedule.ts";

/**
 * Saving a project to GitHub end to end, with the fake GitHub: the editor's changes come through
 * the hub as they do from a browser, people link a new repository through the API, the worker's
 * part runs what is queued and what is due, and GitHub's webhooks come signed through the API. In
 * the order of: link a new repository, change the project, archived once it is due; a README
 * changed on GitHub and archiving goes on; a timeline changed on GitHub and it pauses; the
 * repository taken out of what the App may touch and it pauses. Needs AQ_TEST_DATABASE.
 */

const MINUTE = 60_000;

describe.skipIf(!TEST_DATABASE)("saving a project to GitHub, end to end", () => {
  let t: TestDatabase;
  let w: World;
  beforeAll(async () => {
    t = await createTestDatabase();
    w = await world(t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });

  test("link, change, archived when due; README elsewhere goes on; timeline elsewhere pauses; taken out pauses", async () => {
    const hub = new SyncHub({ db: t.db, log: quiet, now: () => w.time.now });
    const p = await platform(w, { hub });
    const editor = new Editor("走一遍");
    const id = `walk${Date.now().toString(36)}`;
    const peer = new TestPeer(hub, { userId: w.userId, session: "s1" });
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: id,
      after: 0,
      device: "d1",
      window: "w1",
      editor: "test",
      create: { name: "走一遍", projectId: editor.projectId },
      payload: editor.store.encodeState(),
    });
    await peer.until(() => peer.of("synced").length > 0, "synced");
    let pushes = 0;
    const change = async (path: string, text: string) => {
      const sent = ++pushes;
      peer.send({
        t: "push",
        id: sent,
        kind: "user",
        base: 0,
        at: w.time.now.getTime(),
        window: "w1",
        behind: false,
        payload: editor.change(write(path, text)),
      });
      await peer.until(() => peer.of("ack").some((ack) => ack.id === sent), `ack ${sent}`);
    };
    /** The worker's minute: what is due goes into the queue, and the queue is worked. */
    const minute = async () => {
      for (const project of await takeDue(t.db, w.time.now)) {
        if (!p.queued.some((job) => job.project === project))
          p.queued.push({ project, kind: "auto" });
      }
      return p.work();
    };
    const status = async () => (await p.request("GET", `/api/projects/${id}/repository`)).json;

    // Link a new private repository: its first archive has the project.
    const linked = await p.request("POST", `/api/projects/${id}/repository`, {
      create: { name: "walk" },
    });
    expect(linked.status).toBe(201);
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 1 }]);
    const repo = [...w.github.repos.values()].find((each) => each.name === "walk")!;
    expect(w.github.files(repo.id).get("animaquill.json")).toBe(
      editor.store.exportFiles().files.get("animaquill.json"),
    );
    await p.deliver();
    await p.work();

    // Changes, while people go on: not before five minutes of quiet.
    await change("code/intro.js", "export const title = '你好';\n");
    w.time.later(2 * MINUTE);
    await change("code/intro.js", "export const title = '大家好';\n");
    expect((await status()).dirtySince).toBeDefined();
    w.time.later(3 * MINUTE);
    expect(await minute()).toEqual([]);
    w.time.later(2 * MINUTE + 1);
    expect(await minute()).toMatchObject([{ kind: "archived", seq: 3 }]);
    expect(w.github.files(repo.id).get("code/intro.js")).toBe("export const title = '大家好';\n");
    expect(await status()).toMatchObject({
      state: "ready",
      archivedSeq: 3,
      lastArchive: { kind: "auto" },
    });
    expect((await status()).dirtySince).toBeUndefined();
    await p.deliver();
    expect(p.queued).toEqual([]);

    // A README written on GitHub: checked, fine, and the next archive goes on top of it.
    const readme = w.github.commitAs(
      repo.id,
      w.person,
      { "README.md": "# 走一遍\n" },
      "Add README",
    );
    expect(await p.deliver()).toEqual([204]);
    expect(await p.work()).toEqual([{ kind: "checked" }]);
    await change("code/intro.js", "export const title = 'README 之后';\n");
    w.time.later(6 * MINUTE);
    expect(await minute()).toMatchObject([{ kind: "archived", seq: 4 }]);
    expect(w.github.history(repo.id)[0]!.parents).toEqual([readme]);
    expect(w.github.files(repo.id).get("README.md")).toBe("# 走一遍\n");
    await p.deliver();

    // The timeline written on GitHub: archiving pauses, and says which files.
    const timeline = w.github.commitAs(
      repo.id,
      w.person,
      { "timelines/main/timeline.json": '{"edited":"on GitHub"}\n' },
      "Edit the timeline",
    );
    await p.deliver();
    expect(await p.work()).toEqual([{ kind: "paused", reason: "diverged" }]);
    await change("code/intro.js", "export const title = '暂停中';\n");
    w.time.later(6 * MINUTE);
    expect(await minute()).toEqual([]);
    expect(w.github.history(repo.id)[0]!.sha).toBe(timeline);
    expect(await status()).toMatchObject({
      state: "paused",
      reason: "diverged",
      diverged: { sha: timeline, files: ["timelines/main/timeline.json"] },
    });

    // People choose the editor's version: on top of theirs.
    const going = await p.request("POST", `/api/projects/${id}/archive`, { replace: timeline });
    expect(going.status).toBe(202);
    expect(await p.work()).toMatchObject([{ kind: "archived", seq: 5 }]);
    expect(w.github.history(repo.id)[0]!.parents).toEqual([timeline]);
    expect(w.github.files(repo.id).get("code/intro.js")).toBe("export const title = '暂停中';\n");
    await p.deliver();

    // The repository taken out of what the App may touch: paused, and saying why.
    w.github.unselect(repo.id);
    await p.deliver();
    expect(await status()).toMatchObject({ state: "paused", reason: "gone" });
    await change("code/intro.js", "export const title = '没有仓库';\n");
    w.time.later(6 * MINUTE);
    expect(await minute()).toEqual([]);
    hub.stop();
  }, 120_000);
});
