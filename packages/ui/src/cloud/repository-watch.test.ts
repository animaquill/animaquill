import { CloudSignedOut, RepositoryRefused } from "@animaquill/host";
import { afterEach, describe, expect, it } from "vitest";
import { TestTime } from "./cloud-support.ts";
import { FakeRepositories, TestWindow } from "./repository-support.ts";
import { RepositoryWatch } from "./repository-watch.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const watches: RepositoryWatch[] = [];
afterEach(() => {
  for (const watch of watches.splice(0)) watch.close();
});

function setUp() {
  const time = new TestTime();
  const window = new TestWindow(time);
  const platform = new FakeRepositories();
  const watch = new RepositoryWatch({ access: platform, project: "p1", environment: window });
  watches.push(watch);
  const asked = () => platform.calls.filter((call) => call.startsWith("status")).length;
  return { time, window, platform, watch, asked };
}

describe("RepositoryWatch", () => {
  it("asks once a minute while the window is in front, and once as it comes back", async () => {
    const { time, window, watch, asked } = setUp();
    watch.start();
    await time.advance(0);
    expect(asked()).toBe(1);
    expect(watch.getSnapshot().status?.state).toBe("none");
    await time.advance(59 * SECOND);
    expect(asked()).toBe(1);
    await time.advance(SECOND);
    expect(asked()).toBe(2);

    // In the back: not a word, however long.
    window.show(false);
    await time.advance(10 * MINUTE);
    expect(asked()).toBe(2);
    window.show(true);
    await time.advance(0);
    expect(asked()).toBe(3);
    await time.advance(MINUTE);
    expect(asked()).toBe(4);
  });

  it("asks every 3 seconds after archiving now, until it is done", async () => {
    const { time, platform, watch, asked } = setUp();
    platform.answer = { ...platform.answer, state: "ready", head: 4, archivedSeq: 3 };
    watch.start();
    await time.advance(0);
    expect(await watch.archiveNow()).toEqual({ kind: "started" });
    expect(watch.getSnapshot()).toMatchObject({ hurrying: true, status: { archiving: true } });
    const before = asked();
    await time.advance(9 * SECOND);
    expect(asked()).toBe(before + 3);
    platform.archived(time.now());
    await time.advance(3 * SECOND);
    expect(watch.getSnapshot()).toMatchObject({
      hurrying: false,
      status: { archiving: false, lastArchive: { kind: "manual" } },
    });
    // Back to once a minute.
    const done = asked();
    await time.advance(30 * SECOND);
    expect(asked()).toBe(done);
    await time.advance(30 * SECOND);
    expect(asked()).toBe(done + 1);
  });

  it("hurries for at most 2 minutes", async () => {
    const { time, platform, watch, asked } = setUp();
    platform.answer = { ...platform.answer, state: "ready" };
    watch.start();
    await time.advance(0);
    await watch.archiveNow();
    const before = asked();
    await time.advance(2 * MINUTE);
    expect(asked() - before).toBe(40);
    expect(watch.getSnapshot().hurrying).toBe(false);
    await time.advance(MINUTE - 1);
    expect(asked() - before).toBe(40);
  });

  it("archives now once the platform takes it again, where it took one a moment ago", async () => {
    const { time, platform, watch } = setUp();
    platform.answer = { ...platform.answer, state: "ready" };
    watch.start();
    await time.advance(0);
    platform.refuse.archiveNow = new RepositoryRefused("busy", { retryAfter: 42 });
    const outcome = await watch.archiveNow();
    expect(outcome).toEqual({ kind: "waiting", at: time.now() + 42 * SECOND });
    expect(watch.getSnapshot().archiveAt).toBe(time.now() + 42 * SECOND);
    await time.advance(41 * SECOND);
    expect(platform.archives).toHaveLength(1);
    await time.advance(SECOND);
    expect(platform.archives).toHaveLength(2);
    expect(watch.getSnapshot()).toMatchObject({ archiveAt: undefined, hurrying: true });
  });

  it("goes on top of what changed on GitHub only with the commit people saw", async () => {
    const { time, platform, watch } = setUp();
    platform.answer = {
      ...platform.answer,
      state: "paused",
      reason: "diverged",
      diverged: { sha: "b".repeat(40), files: ["code/a.js"], deleted: [] },
    };
    watch.start();
    await time.advance(0);
    await watch.archiveNow({ replace: "b".repeat(40) });
    expect(platform.archives).toEqual([{ replace: "b".repeat(40) }]);
    expect(watch.status?.state).toBe("ready");

    platform.refuse.archiveNow = new RepositoryRefused("diverged", {
      diverged: { sha: "c".repeat(40), files: ["code/a.js"], deleted: [] },
    });
    const outcome = await watch.archiveNow({ replace: "b".repeat(40) });
    expect(outcome).toMatchObject({ kind: "refused", code: "diverged" });
  });

  it("keeps what it knew while the platform cannot say, and waits as long as it asks", async () => {
    const { time, platform, watch, asked } = setUp();
    platform.answer = { ...platform.answer, state: "ready" };
    watch.start();
    await time.advance(0);
    platform.refuse.status = new RepositoryRefused("unavailable");
    await time.advance(MINUTE);
    expect(watch.getSnapshot()).toMatchObject({
      trouble: "unavailable",
      status: { state: "ready" },
    });
    await time.advance(MINUTE);
    expect(watch.getSnapshot().trouble).toBeUndefined();

    platform.refuse.status = new RepositoryRefused("busy", { retryAfter: 300 });
    await time.advance(MINUTE);
    const then = asked();
    await time.advance(4 * MINUTE);
    expect(asked()).toBe(then);
    await time.advance(MINUTE);
    expect(asked()).toBe(then + 1);
  });

  it("stops asking while nobody is signed in, until asked again", async () => {
    const { time, platform, watch, asked } = setUp();
    platform.refuse.status = new CloudSignedOut("gone");
    watch.start();
    await time.advance(0);
    expect(watch.getSnapshot().trouble).toBe("signedOut");
    await time.advance(10 * MINUTE);
    expect(asked()).toBe(1);
    await watch.refresh();
    expect(watch.getSnapshot()).toMatchObject({ trouble: undefined, status: { state: "none" } });
  });

  it("never asks more than its budget in ten minutes", async () => {
    const time = new TestTime();
    const window = new TestWindow(time);
    const platform = new FakeRepositories();
    platform.answer = { ...platform.answer, state: "ready" };
    const watch = new RepositoryWatch({
      access: platform,
      project: "p1",
      environment: window,
      timing: { budget: 10 },
    });
    watches.push(watch);
    watch.start();
    await time.advance(0);
    // People keep asking for archives, and it keeps hurrying.
    for (let round = 0; round < 6; round++) {
      await watch.archiveNow();
      await time.advance(MINUTE);
    }
    const asked = platform.calls.filter((call) => call.startsWith("status")).length;
    expect(asked).toBeLessThanOrEqual(10);
  });
  it("asks again a moment after the project changed, where its last word is that everything is archived", async () => {
    const { time, platform, watch, asked } = setUp();
    const archived = {
      sha: "a".repeat(40),
      seq: 4,
      at: time.now(),
      kind: "auto",
      changed: 1,
      removed: 0,
      url: "",
    };
    platform.answer = {
      state: "ready",
      archiving: false,
      head: 4,
      archivedSeq: 4,
      lastArchive: archived,
    };
    watch.start();
    await time.advance(0);
    expect(asked()).toBe(1);
    // Syncing is where the platform's word is: nothing to ask.
    watch.noteSeq(4);
    await time.advance(10 * SECOND);
    expect(asked()).toBe(1);

    // People change something: "archived just now" is of before that. A few changes come
    // together, and count once.
    platform.answer = {
      ...platform.answer,
      head: 7,
      dirtySince: time.now(),
      nextAt: time.now() + 5 * MINUTE,
    };
    watch.noteSeq(5);
    await time.advance(200);
    watch.noteSeq(6);
    watch.noteSeq(7);
    expect(asked()).toBe(1);
    await time.advance(1500);
    expect(asked()).toBe(2);
    expect(watch.getSnapshot().status).toMatchObject({ head: 7, archivedSeq: 4 });

    // It says that changes wait now, which stays right however many more come: nothing more is
    // asked for those, until the question of every minute.
    for (let seq = 8; seq < 40; seq++) {
      watch.noteSeq(seq);
      await time.advance(500);
    }
    expect(asked()).toBe(2);
    await time.advance(MINUTE);
    expect(asked()).toBe(3);
  });

  it("does not ask for a change while it is in the back, paused, or has no repository", async () => {
    const { time, window, platform, watch, asked } = setUp();
    // No repository: nothing is archived, whatever changes.
    watch.start();
    await time.advance(0);
    watch.noteSeq(9);
    await time.advance(10 * SECOND);
    expect(asked()).toBe(1);

    // Paused: what it says is why, and a change does not make that wrong.
    platform.answer = {
      state: "paused",
      reason: "gone",
      archiving: false,
      head: 4,
      archivedSeq: 4,
    };
    await watch.refresh();
    watch.noteSeq(10);
    await time.advance(10 * SECOND);
    expect(asked()).toBe(2);

    // In the back nothing is asked, also not for this: coming back to the front asks.
    platform.answer = { state: "ready", archiving: false, head: 10, archivedSeq: 10 };
    await watch.refresh();
    expect(asked()).toBe(3);
    window.show(false);
    watch.noteSeq(11);
    await time.advance(10 * SECOND);
    expect(asked()).toBe(3);
    platform.answer = { ...platform.answer, head: 11, dirtySince: time.now() };
    window.show(true);
    await time.advance(0);
    expect(asked()).toBe(4);
    await time.advance(10 * SECOND);
    expect(asked()).toBe(4);
  });

  it("does not ask over and over where the platform keeps saying what it said", async () => {
    const { time, platform, watch, asked } = setUp();
    // A platform whose word about archiving stays behind what syncing has.
    platform.answer = { state: "ready", archiving: false, head: 4, archivedSeq: 4 };
    watch.start();
    await time.advance(0);
    watch.noteSeq(5);
    await time.advance(1500);
    expect(asked()).toBe(2);
    // Still "all archived", of before the change: asked again, but not right away.
    await time.advance(13 * SECOND);
    expect(asked()).toBe(2);
    await time.advance(2 * SECOND);
    expect(asked()).toBe(3);
    watch.close();
    await time.advance(MINUTE);
    expect(asked()).toBe(3);
  });
});
