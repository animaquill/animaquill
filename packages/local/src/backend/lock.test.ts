import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  STARTING_MS,
  takeOver,
  BACKEND_FILE,
  LOCK_FILE,
  LockHeld,
  takeLock,
  type BackendNote,
  type HeldLock,
} from "./lock.ts";

/**
 * One backend for a data folder: a second start finds the first and opens it, a lock of a process
 * that is gone or that is nothing of ours is taken over, and one that does not answer is said.
 */

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "aq-lock-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A clock that the waits move on. */
const clock = () => {
  let now = 1_000_000;
  return { now: () => now, wait: async (ms: number) => void (now += ms) };
};

/** A process that is alive and not this one. */
const OTHER = process.ppid;

const lockOf = (dir: string, note: object) =>
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify(note));
const backendOf = (dir: string, note: Partial<BackendNote>) =>
  writeFileSync(join(dir, BACKEND_FILE), JSON.stringify(note));

describe("the lock", () => {
  test("is taken, 600, and goes with what it wrote", async () => {
    const dir = folder();
    const lock = (await takeLock(dir)) as HeldLock;
    expect(lock.note.pid).toBe(process.pid);
    if (process.platform !== "win32")
      expect(statSync(join(dir, LOCK_FILE)).mode & 0o777).toBe(0o600);
    await lock.announce({
      version: "1",
      port: 7651,
      origin: "http://animaquill.localhost:7651",
      adminKey: "k",
    });
    const written = JSON.parse(readFileSync(join(dir, BACKEND_FILE), "utf8")) as BackendNote;
    expect(written).toMatchObject({
      format: 1,
      instance: lock.note.instance,
      pid: process.pid,
      adminKey: "k",
    });
    if (process.platform !== "win32")
      expect(statSync(join(dir, BACKEND_FILE)).mode & 0o777).toBe(0o600);
    await lock.release();
    expect(() => statSync(join(dir, LOCK_FILE))).toThrow();
    expect(() => statSync(join(dir, BACKEND_FILE))).toThrow();
  });

  test("of a process that is gone is taken over", async () => {
    const dir = folder();
    lockOf(dir, { pid: 2 ** 22 + 17, instance: "gone", startedAt: 0 });
    const lock = (await takeLock(dir)) as HeldLock;
    expect(lock.note.pid).toBe(process.pid);
  });

  test("of a backend that answers finds it", async () => {
    const dir = folder();
    const time = clock();
    lockOf(dir, { pid: OTHER, instance: "first", startedAt: time.now() });
    backendOf(dir, { instance: "first", port: 7651, adminKey: "k", origin: "x" });
    const found = await takeLock(dir, { ...time, ping: async () => "ours" });
    expect(found).toMatchObject({ kind: "running", backend: { instance: "first" } });
  });

  test("of one that is starting waits for it to answer", async () => {
    const dir = folder();
    const time = clock();
    lockOf(dir, { pid: OTHER, instance: "first", startedAt: time.now() });
    let asked = 0;
    const found = await takeLock(dir, {
      now: time.now,
      wait: async (ms) => {
        await time.wait(ms);
        // It answers after a few seconds of PostgreSQL.
        if (time.now() > 1_005_000)
          backendOf(dir, { instance: "first", port: 7651, adminKey: "k", origin: "x" });
      },
      ping: async () => (++asked > 0 ? "ours" : "refused"),
    });
    expect(found).toMatchObject({ kind: "running" });
  });

  test("of a process of that number that is nothing of ours is taken over", async () => {
    const dir = folder();
    const time = clock();
    // As after a restart: the number is another process's now, and nothing answers there.
    lockOf(dir, { pid: OTHER, instance: "before", startedAt: time.now() - 3_600_000 });
    backendOf(dir, { instance: "before", port: 7651, adminKey: "k", origin: "x" });
    const lock = (await takeLock(dir, { ...time, ping: async () => "refused" })) as HeldLock;
    expect(lock.note.pid).toBe(process.pid);
    // And without a backend.json, once it had its minute to start.
    const other = folder();
    lockOf(other, { pid: OTHER, instance: "x", startedAt: time.now() - STARTING_MS - 1000 });
    expect(
      ((await takeLock(other, { ...time, ping: async () => "ours" })) as HeldLock).note.pid,
    ).toBe(process.pid);
  });

  test("of a backend that is there and does not answer as itself is said, after ten seconds", async () => {
    const dir = folder();
    const time = clock();
    lockOf(dir, { pid: OTHER, instance: "first", startedAt: time.now() });
    backendOf(dir, { instance: "first", port: 7651, adminKey: "k", origin: "x" });
    const start = time.now();
    await expect(takeLock(dir, { ...time, ping: async () => "other" })).rejects.toEqual(
      new LockHeld(OTHER),
    );
    expect(time.now() - start).toBeGreaterThanOrEqual(10_000);
  });

  test("of one that is starting is waited for for minutes, as a first start on Windows may take", async () => {
    const dir = folder();
    const time = clock();
    lockOf(dir, { pid: OTHER, instance: "slow", startedAt: time.now() });
    const told: number[] = [];
    const found = await takeLock(dir, {
      now: time.now,
      wait: async (ms) => {
        await time.wait(ms);
        if (time.now() > 1_000_000 + 4 * 60_000)
          backendOf(dir, { instance: "slow", port: 7651, adminKey: "k", origin: "x" });
      },
      ping: async () => "ours",
      waiting: (pid) => told.push(pid),
    });
    expect(found).toMatchObject({ kind: "running" });
    expect(told).toEqual([OTHER]);
  });

  test("taken over by two at once, neither takes the other's new lock away", async () => {
    const dir = folder();
    const path = join(dir, LOCK_FILE);
    const stale = JSON.stringify({ pid: 2 ** 22 + 17, instance: "gone", startedAt: 0 });
    writeFileSync(path, stale);
    // A takes it over and makes its own; B read the stale one before, and takes over late.
    await takeOver(path, stale);
    const a = (await takeLock(dir)) as HeldLock;
    await takeOver(path, stale);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ instance: a.note.instance });
    // And while one is taking over, the other waits for it.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${path}.taking`);
    let waited = 0;
    await takeOver(path, readFileSync(path, "utf8"), async () => void (waited += 1));
    expect(waited).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ instance: a.note.instance });
  });

  test("is written whole: nothing of it is there half written", async () => {
    const dir = folder();
    const lock = (await takeLock(dir)) as HeldLock;
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8"))).toEqual(lock.note);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).toSorted()).toEqual([LOCK_FILE]);
  });
});
