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
});
