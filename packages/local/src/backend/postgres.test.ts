import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { findPrograms, isAlive, makeLinks, NoPostgres, Postgres } from "./postgres.ts";
import { NewerDatabase } from "@animaquill/server/database.ts";
import { readBackend } from "./lock.ts";
import { startBackend, type StartedBackend } from "./run.ts";

/**
 * The PostgreSQL of `npx animaquill` and the backend on it, for real: the programs of the package of
 * this platform. PostgreSQL does not run as root, so neither do these: CI runs them as its user,
 * and scripts/oss-local-run of AnimaQuill Cloud as one of a container's own.
 */

const root = process.platform !== "win32" && process.getuid?.() === 0;
const programs = await findPrograms().catch((error: unknown) => {
  if (error instanceof NoPostgres) return undefined;
  throw error;
});
const runs = !root && programs !== undefined;

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "aq-pg-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the links of the libraries", () => {
  test.skipIf(programs === undefined || process.platform === "win32")(
    "are made where the package was installed without its script",
    async () => {
      const real = join(programs!.initdb, "..", "..", "..");
      const copy = join(folder(), "package");
      cpSync(real, copy, { recursive: true, verbatimSymlinks: true });
      const links = JSON.parse(readFileSync(join(copy, "native", "pg-symlinks.json"), "utf8")) as {
        target: string;
      }[];
      if (links.length === 0) return;
      for (const { target } of links)
        if (existsSync(join(copy, target))) unlinkSync(join(copy, target));
      await makeLinks(copy);
      for (const { target } of links) expect(existsSync(join(copy, target))).toBe(true);
    },
  );
});

describe.skipIf(!runs)("PostgreSQL of the data folder", () => {
  test("is made once, listens on 127.0.0.1 only, and stops", async () => {
    const dir = folder();
    const postgres = new Postgres({
      programs: programs!,
      dataDir: dir,
      password: "the-password",
      logFile: join(dir, "pg.log"),
    });
    expect(await postgres.isMade()).toBe(false);
    await postgres.init();
    expect(await postgres.version()).toBe(18);
    await postgres.start();
    const pid = Number(
      readFileSync(join(postgres.folder, "postmaster.pid"), "utf8").split("\n")[0],
    );
    const lines = readFileSync(join(postgres.folder, "postmaster.pid"), "utf8").split("\n");
    // No Unix socket, the loopback only.
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe("127.0.0.1");
    const { Client } = await import("pg");
    const wrong = new Client({ ...postgres.connection(), password: "nope" });
    await expect(wrong.connect()).rejects.toMatchObject({ code: "28P01" });
    const client = new Client(postgres.connection());
    await client.connect();
    expect((await client.query("select current_database() as name")).rows[0].name).toBe(
      "animaquill",
    );
    await client.end();
    await postgres.stop(4000);
    expect(isAlive(pid)).toBe(false);
  });

  test("left running by a start that was killed is stopped first; a stranger of that number never", async () => {
    const dir = folder();
    const options = {
      programs: programs!,
      dataDir: dir,
      password: "pw",
      logFile: join(dir, "pg.log"),
    };
    const before = new Postgres(options);
    await before.init();
    await before.start();
    const file = join(before.folder, "postmaster.pid");
    const pid = Number(readFileSync(file, "utf8").split("\n")[0]);
    // As after `kill -9` of the process that started it: it runs on, alone.
    const after = new Postgres(options);
    expect(await after.stopLeftOver()).toBe("stopped");
    expect(isAlive(pid)).toBe(false);
    await after.start();
    await after.stop(4000);
    // A number that is another process's now.
    if (process.platform === "win32") return;
    const stranger = spawnSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], {
      encoding: "utf8",
    });
    const other = Number(stranger.stdout.trim());
    writeFileSync(file, `${other}\n${before.folder}\n1\n5432\n\n127.0.0.1\n`);
    expect(await after.stopLeftOver()).toBe("foreign");
    expect(isAlive(other)).toBe(true);
    process.kill(other);
    await after.start();
    await after.stop(4000);
  });
});

describe.skipIf(!runs)("the backend", () => {
  let backend: StartedBackend | undefined;
  afterAll(async () => {
    await backend?.stop();
  });

  const call = (
    port: number,
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (done, fail) => {
        const sent = request(
          {
            host: "127.0.0.1",
            port,
            method,
            path,
            headers: { host: `animaquill.localhost:${port}`, ...headers },
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (part: string) => (text += part));
            response.on("end", () =>
              done({ status: response.statusCode ?? 0, headers: response.headers, body: text }),
            );
          },
        );
        sent.on("error", fail);
        sent.end(body);
      },
    );

  test("starts, signs in once by its token, and keeps who it was through a restart", async () => {
    const dir = folder();
    const port = 21_000 + Math.floor(Math.random() * 20_000);
    const said: string[] = [];
    const options = {
      dataDir: dir,
      port,
      version: "test",
      site: folder(),
      scenePage: "<!doctype html><html></html>",
      say: (line: string) => said.push(line),
    };
    const first = await startBackend(options);
    if (first.kind !== "started") throw new Error("not started");
    backend = first;
    expect(said).toEqual(["第一次准备数据库（几秒）…", "启动数据库…", "更新数据库结构…"]);
    const token = first.addressToOpen().split("#aq-token=")[1]!;
    const origin = `http://animaquill.localhost:${port}`;
    const exchange = () =>
      call(
        port,
        "POST",
        "/api/local/session",
        { origin, "x-animaquill": "1", "content-type": "application/json" },
        JSON.stringify({ token }),
      );
    const answer = await exchange();
    expect(answer.status).toBe(200);
    const cookie = String(answer.headers["set-cookie"]).split(";")[0]!;
    const { binding } = JSON.parse(answer.body) as { binding: string };
    const who = () =>
      call(port, "GET", "/api/auth/session", { cookie, "x-animaquill-binding": binding });
    expect(JSON.parse((await who()).body)).toMatchObject({
      status: "signedIn",
      user: { login: "本机" },
      repositories: "local",
    });
    expect((await exchange()).status).toBe(401);
    expect((await call(port, "GET", "/api/auth/session", { cookie })).body).toContain("signedOut");

    // A second start of the same folder finds this one.
    const second = await startBackend(options);
    expect(second.kind).toBe("running");
    expect((await readBackend(dir))?.port).toBe(port);

    const stopping = Date.now();
    await first.stop();
    expect(Date.now() - stopping).toBeLessThan(5000);
    expect(await readBackend(dir)).toBeUndefined();

    said.length = 0;
    const again = await startBackend(options);
    if (again.kind !== "started") throw new Error("not started");
    backend = again;
    expect(said).toEqual(["启动数据库…"]);
    expect(JSON.parse((await who()).body)).toMatchObject({ status: "signedIn" });
    await again.stop();

    // Without its master key: a new one, said once, and the keys of binding are new with it.
    rmSync(join(dir, "master.key"));
    said.length = 0;
    const renewed = await startBackend(options);
    if (renewed.kind !== "started") throw new Error("not started");
    backend = renewed;
    expect(said).toEqual(["启动数据库…", expect.stringMatching(/^主密钥 master\.key 不见了/)]);
    expect(JSON.parse((await who()).body)).toMatchObject({ status: "signedOut" });
    const logs = readFileSync(renewed.log, "utf8");
    expect(logs).not.toContain(token);

    // A newer version migrated the database since: this one does not start on it.
    const pid = readFileSync(join(dir, "pg18", "postmaster.pid"), "utf8").split("\n");
    const { Client } = await import("pg");
    const client = new Client({
      host: "127.0.0.1",
      port: Number(pid[3]),
      user: "animaquill",
      password: readFileSync(join(dir, "pg18.password"), "utf8").trim(),
      database: "animaquill",
    });
    await client.connect();
    await client.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ('of a newer version', 9999999999999)",
    );
    await client.end();
    await renewed.stop();
    backend = undefined;
    await expect(startBackend(options)).rejects.toBeInstanceOf(NewerDatabase);
    // And what it started for that is gone again: the folder can be started by the newer one.
    expect(await readBackend(dir)).toBeUndefined();
    expect(existsSync(join(dir, "lock"))).toBe(false);
    expect(existsSync(join(dir, "pg18", "postmaster.pid"))).toBe(false);
  }, 120_000);
});
