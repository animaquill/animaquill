import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isAlive, isPostgresName, LeftOverRunning, Postgres, programNameOf } from "./postgres.ts";

/**
 * A number in `postmaster.pid` that is another program's now (the computer was restarted) is a file
 * left behind, not a database, and nothing is signalled; one that cannot be told is asked about.
 * No PostgreSQL is needed: only the file and a process of ours that is not one.
 */

const posix = process.platform !== "win32";
const made: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const withPostmasterOf = (pid: number, nameOf?: (pid: number) => Promise<string | undefined>) => {
  const dir = mkdtempSync(join(tmpdir(), "aq-pm-"));
  made.push(dir);
  mkdirSync(join(dir, "pg18"));
  writeFileSync(join(dir, "pg18", "postmaster.pid"), `${pid}\n${dir}\n1\n1\n\n127.0.0.1\n`);
  return new Postgres({
    programs: {} as never,
    dataDir: dir,
    password: "pw",
    logFile: join(dir, "pg.log"),
    answerMs: 600,
    ...(nameOf ? { programNameOf: nameOf } : {}),
  });
};

describe("the program behind a process number", () => {
  test("is PostgreSQL by its name, as each system says it", () => {
    for (const name of [
      "postgres",
      "postgres\n",
      "postgres.exe",
      "/opt/x/bin/postgres",
      "C:\\x\\POSTGRES.EXE",
    ])
      expect(isPostgresName(name)).toBe(true);
    for (const name of ["sleep", "postgres-helper", "mypostgres", "node.exe", ""])
      expect(isPostgresName(name)).toBe(false);
  });

  test("is asked from tasklist on Windows and ps on macOS, by the number", async () => {
    const asked: string[][] = [];
    const answers: Record<string, string> = {
      tasklist: '"postgres.exe","4242","Console","1","20,000 K"\r\n',
      ps: "/usr/local/bin/postgres\n",
    };
    const run = async (program: string, args: readonly string[]) => {
      asked.push([program, ...args]);
      return answers[program];
    };
    expect(await programNameOf(4242, "win32", run)).toBe("postgres.exe");
    expect(await programNameOf(4242, "darwin", run)).toBe("/usr/local/bin/postgres");
    expect(asked).toEqual([
      ["tasklist", "/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
      ["ps", "-p", "4242", "-o", "comm="],
    ]);
    // No such process, or no answer: not known.
    answers["tasklist"] = "INFO: No tasks are running which match the specified criteria.\r\n";
    expect(await programNameOf(4242, "win32", run)).toBeUndefined();
    expect(await programNameOf(4242, "win32", async () => undefined)).toBeUndefined();
  });

  test.skipIf(!posix)("is read here, of a process that is alive", async () => {
    expect(isPostgresName((await programNameOf(process.pid)) ?? "")).toBe(false);
    expect(await programNameOf(process.pid)).toBeTruthy();
  });
});

describe("a postmaster.pid left running", () => {
  test.skipIf(!posix)(
    "whose number is another program's is stale, and that program lives on",
    async () => {
      const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
      children.push(stranger);
      expect(isAlive(stranger.pid!)).toBe(true);
      // The real names, here: sleep is not PostgreSQL.
      expect(await withPostmasterOf(stranger.pid!).stopLeftOver()).toBe("stale");
      expect(isAlive(stranger.pid!)).toBe(true);
    },
  );

  test.skipIf(!posix)(
    "whose program cannot be told, and does not answer, is said and left alone",
    async () => {
      const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
      children.push(stranger);
      await expect(
        withPostmasterOf(stranger.pid!, async () => undefined).stopLeftOver(),
      ).rejects.toEqual(new LeftOverRunning(stranger.pid!));
      expect(isAlive(stranger.pid!)).toBe(true);
      // And one that says it is PostgreSQL, but does not answer as ours, is the same.
      await expect(
        withPostmasterOf(stranger.pid!, async () => "postgres").stopLeftOver(),
      ).rejects.toEqual(new LeftOverRunning(stranger.pid!));
    },
  );
});
