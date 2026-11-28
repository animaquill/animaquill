import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "@animaquill/server/database.ts";
import { digestsOf, SERVER_SCOPE } from "@animaquill/server/data/transfer.ts";
import { openedOf } from "@animaquill/server/data/sealed.ts";
import { sealSecret } from "@animaquill/server/me/ai-sync.ts";
import {
  projects,
  projectUpdates,
  userAiKeys,
  userChats,
  users,
} from "@animaquill/server/schema.ts";
import { createSealer, parseMasterKeys } from "@animaquill/server/seal.ts";
import { masterKeyOf, passwordOf } from "./data-dir.ts";
import { findPrograms, MAJOR, NoPostgres, Postgres, type Programs } from "./postgres.ts";
import { startBackend, type StartedBackend } from "./run.ts";
import { madeFolders, upgradePostgres, upgradingOf, type UpgradeFault } from "./upgrade.ts";
import { serverExport, serverImport } from "./commands.ts";

/**
 * A new major version of the PostgreSQL of `npx animaquill`, for real (upgrade.ts): PostgreSQL 17,
 * as the alias of npm of the workspace has it (`@embedded-postgres/<platform>-pg17`, which the
 * version that changes the major version would have as the one before), to this version's 18.
 * The data out of the one, into the other, every table compared; the folder of the one before
 * named as old only after; and where any step fails, the one before as it was, which the backend
 * then runs on. Then the backup of the server (`server export|import`) while it runs and while it
 * does not. PostgreSQL does not run as root, and neither do these: see postgres.test.ts.
 */

const FROM = 17;
const root = process.platform !== "win32" && process.getuid?.() === 0;
const orNone = (error: unknown) => {
  if (error instanceof NoPostgres) return undefined;
  throw error;
};
const programs = await findPrograms().catch(orNone);
const before: Programs | undefined = await findPrograms(undefined, undefined, FROM).catch(orNone);
const runs = !root && programs !== undefined && before !== undefined;

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "aq-up-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = "sk-of-the-upgrade-test";
const quiet = { info() {}, warn() {}, error() {} };
const UUIDV7 = `create function public.uuidv7() returns uuid language sql volatile as $$
  select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing
    substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
    from 1 for 6), 52, 1), 53, 1), 'hex')::uuid $$`;

/** The connection of a PostgreSQL of the data folder that runs, as its `postmaster.pid` says it. */
const connectionOf = (dataDir: string, major: number) => {
  const pid = readFileSync(join(dataDir, `pg${major}`, "postmaster.pid"), "utf8").split("\n");
  return {
    host: "127.0.0.1",
    port: Number(pid[3]),
    user: "animaquill",
    password: readFileSync(join(dataDir, `pg${major}.password`), "utf8").trim(),
    database: "animaquill",
  };
};

/** The digest and rows of every table, as an export compares them. */
const tablesOf = async (connection: ReturnType<typeof connectionOf>) => {
  const client = new Client(connection);
  await client.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set time zone 'UTC'");
    await client.query("set extra_float_digits = 1");
    const digests = await digestsOf(client, SERVER_SCOPE);
    await client.query("rollback");
    return Object.fromEntries(
      [...digests].map(([name, { rows, digest }]) => [name, { rows, digest }]),
    );
  } finally {
    await client.end();
  }
};

/**
 * A data folder of a backend of PostgreSQL 17, with a bit of everything: a person, projects with
 * their updates (bytes), a sealed key, a conversation. Resolves to its tables, as they are.
 */
async function dataFolderOf17(): Promise<{
  dataDir: string;
  tables: Awaited<ReturnType<typeof tablesOf>>;
}> {
  const dataDir = folder();
  const logFile = join(dataDir, "logs", "postgres.log");
  await masterKeyOf(dataDir, false);
  const sealer = createSealer(
    parseMasterKeys(readFileSync(join(dataDir, "master.key"), "utf8").trim()),
  );
  const old = new Postgres({
    programs: before!,
    dataDir,
    major: FROM,
    password: await passwordOf(dataDir, FROM),
    logFile,
  });
  await old.init();
  await old.start();
  try {
    const { host, port, user, password, database } = old.connection();
    const db = createDatabase({ host, port, name: database, user, password }, quiet, "test");
    try {
      // The tables of this version take their ids from `uuidv7()`, which PostgreSQL has from 18 on:
      // a server of before on 17 had one of its own (as the 18 of a version that brings 19 has it
      // built in). The data goes over as it is; a function is no table, and stays behind.
      const polyfill = new Client(old.connection());
      await polyfill.connect();
      await polyfill.query(UUIDV7);
      await polyfill.end();
      await db.migrate();
      const [person] = await db.db
        .insert(users)
        .values({ githubId: 70_000_001, login: "artist" })
        .returning({ id: users.id });
      const w = { userId: person!.id };
      await db.db.insert(userAiKeys).values({
        userId: w.userId,
        service: "s1",
        sealed: sealSecret(sealer, w.userId, "s1", { key: KEY }),
        format: 2,
        at: new Date(),
      });
      const project = { id: "p-upgrade" };
      await db.db.insert(projects).values({
        id: project.id,
        ownerId: w.userId,
        projectId: "00000000-0000-4000-8000-00000000abcd",
        name: "升级前的项目",
        head: 1,
        digest: "d1",
        bytes: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
        dirtySince: new Date(),
      });
      await db.db.insert(projectUpdates).values({
        projectId: project.id,
        seq: 1,
        digest: "d1",
        data: randomBytes(100),
        kind: "first",
        device: "d1",
        window: "w1",
        base: 0,
      });
      for (let seq = 2; seq <= 3; seq++)
        await db.db.insert(projectUpdates).values({
          projectId: project.id,
          seq,
          digest: `d${seq}`,
          data: randomBytes(200_000),
          kind: "user",
          device: "d1",
          window: "w1",
          base: 1,
        });
      await db.db.insert(userChats).values({
        userId: w.userId,
        projectId: project.id,
        chatId: "c1",
        revision: 1,
        summary: { id: "c1", title: "升级前的对话", updatedAt: 1 },
        body: { entries: [{ text: "😀" }] },
        size: 10,
        updatedAt: new Date(),
      });
    } finally {
      await db.close();
    }
    return { dataDir, tables: await tablesOf(connectionOf(dataDir, FROM)) };
  } finally {
    await old.stop(4000);
  }
}

const upgrade = (dataDir: string, fault?: UpgradeFault) =>
  upgradePostgres({
    dataDir,
    from: { major: FROM, programs: before! },
    to: { programs: programs! },
    logFile: join(dataDir, "logs", "postgres.log"),
    version: "test",
    log: quiet,
    ...(fault && { fault }),
  });

/** Starts the PostgreSQL of a major version of the data folder, for what the test reads of it. */
async function running<T>(
  dataDir: string,
  major: number,
  work: (c: ReturnType<typeof connectionOf>) => Promise<T>,
) {
  const postgres = new Postgres({
    programs: major === MAJOR ? programs! : before!,
    dataDir,
    major,
    password: await passwordOf(dataDir, major),
    logFile: join(dataDir, "logs", "postgres.log"),
  });
  await postgres.start();
  try {
    return await work(connectionOf(dataDir, major));
  } finally {
    await postgres.stop(4000);
  }
}

const call = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Buffer,
) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
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
  });

/** The person of this machine, signed in as the page does: its cookie and key of binding. */
async function signIn(backend: StartedBackend, port: number) {
  const token = (await backend.addressToOpen()).url.split("#aq-token=")[1]!;
  const origin = `http://animaquill.localhost:${port}`;
  const answer = await call(
    port,
    "POST",
    "/api/local/session",
    { origin, "x-animaquill": "1", "content-type": "application/json" },
    JSON.stringify({ token }),
  );
  const cookie = String(answer.headers["set-cookie"]).split(";")[0]!;
  const { binding } = JSON.parse(answer.body) as { binding: string };
  const page = { cookie, "x-animaquill-binding": binding };
  const change = { ...page, origin, "x-animaquill": "1" };
  return { page, change };
}

const port = () => 21_000 + Math.floor(Math.random() * 20_000);
const startOn = (dataDir: string, said: string[], at: number, fault?: UpgradeFault) =>
  startBackend({
    dataDir,
    port: at,
    version: "test",
    site: folder(),
    scenePage: "<!doctype html><html></html>",
    say: (line) => said.push(line),
    ...(fault && { upgradeFault: fault }),
  });

describe.skipIf(!runs)("PostgreSQL 17 to 18", () => {
  test("every table goes over as it was, the folder before is named old after, and what it sealed opens", async () => {
    const { dataDir, tables } = await dataFolderOf17();
    const outcome = await upgrade(dataDir);
    expect(outcome).toMatchObject({ kind: "upgraded", old: "pg17.old" });
    const names = readdirSync(dataDir);
    expect(names).toContain("pg18");
    expect(names).toContain("pg17.old");
    expect(names).not.toContain("pg17");
    expect(names).not.toContain(upgradingOf(MAJOR));
    expect(names).not.toContain("upgrade");
    expect(readFileSync(join(dataDir, "pg18", "PG_VERSION"), "utf8").trim()).toBe("18");
    expect(await madeFolders(dataDir)).toEqual([18]);
    await running(dataDir, MAJOR, async (connection) => {
      expect(await tablesOf(connection)).toEqual(tables);
      const db = createDatabase({ ...connection, name: connection.database }, quiet, "test");
      try {
        const sealer = createSealer(
          parseMasterKeys(readFileSync(join(dataDir, "master.key"), "utf8").trim()),
        );
        expect((await openedOf(db.db, sealer)).aiKeys).toEqual({ total: 1, opened: 1 });
      } finally {
        await db.close();
      }
    });
    // The folder before is as it was, until people take it away.
    expect(readFileSync(join(dataDir, "pg17.old", "PG_VERSION"), "utf8").trim()).toBe("17");
  }, 300_000);

  test.each(["export", "import", "verify", "switch"] as const)(
    "failing after the %s leaves the one before as it was, and nothing of the new one",
    async (fault) => {
      const { dataDir, tables } = await dataFolderOf17();
      const outcome = await upgrade(dataDir, fault);
      expect(outcome.kind).toBe("failed");
      const names = readdirSync(dataDir);
      expect(names).toContain("pg17");
      for (const gone of ["pg18", upgradingOf(MAJOR), `${upgradingOf(MAJOR)}.making`, "upgrade"])
        expect(names).not.toContain(gone);
      expect(await running(dataDir, FROM, tablesOf)).toEqual(tables);
    },
    300_000,
  );

  test("the backend goes on with the one before where the upgrade fails, says why, and upgrades the start after", async () => {
    const { dataDir, tables } = await dataFolderOf17();
    const said: string[] = [];
    const at = port();
    const first = await startOn(dataDir, said, at, "import");
    if (first.kind !== "started") throw new Error("not started");
    try {
      expect(said).toContain("数据库要从 PostgreSQL 17 升级到 18（只做这一次，数据多时要几分钟）…");
      expect(
        said.some((line) => line.startsWith("数据库没能升级到 PostgreSQL 18，这次照旧用 17")),
      ).toBe(true);
      const { page } = await signIn(first, at);
      const state = JSON.parse((await call(at, "GET", "/api/local/server", page)).body);
      expect(state).toMatchObject({
        database: { kind: "own", major: 17 },
        upgradeFailed: { from: 17, to: 18 },
        old: [],
      });
    } finally {
      await first.stop();
    }
    expect(readdirSync(dataDir)).not.toContain("pg18");

    said.length = 0;
    const second = await startOn(dataDir, said, at);
    if (second.kind !== "started") throw new Error("not started");
    try {
      expect(said.some((line) => line.startsWith("数据库已升级到 PostgreSQL 18"))).toBe(true);
      const { page, change } = await signIn(second, at);
      const state = JSON.parse((await call(at, "GET", "/api/local/server", page)).body);
      expect(state.database).toEqual({ kind: "own", major: 18 });
      expect(state.upgradeFailed).toBeUndefined();
      expect(state.old).toEqual([{ name: "pg17.old", major: 17, bytes: expect.any(Number) }]);
      // Only what an upgrade left, and only from a page of the editor's site.
      expect((await call(at, "DELETE", "/api/local/server/old/pg18", change)).status).toBe(404);
      expect((await call(at, "DELETE", "/api/local/server/old/..", change)).status).toBe(404);
      expect((await call(at, "DELETE", "/api/local/server/old/pg17.old", page)).status).toBe(403);
      expect(existsSync(join(dataDir, "pg17.old"))).toBe(true);
      expect((await call(at, "DELETE", "/api/local/server/old/pg17.old", change)).status).toBe(204);
      expect(existsSync(join(dataDir, "pg17.old"))).toBe(false);
    } finally {
      await second.stop();
    }
    // What the backend wrote as it ran is besides: what was there before is all there.
    const now = await running(dataDir, MAJOR, tablesOf);
    for (const name of [
      "public.users",
      "public.user_ai_keys",
      "public.user_chats",
      "public.project_updates",
    ])
      expect(now[name]?.rows).toBeGreaterThanOrEqual(tables[name]!.rows);
    expect(now["public.user_chats"]).toEqual(tables["public.user_chats"]);
    expect(now["public.project_updates"]).toEqual(tables["public.project_updates"]);
  }, 300_000);

  test("what a try that was killed halfway left goes as the next one begins; a crash between the renames keeps the new one", async () => {
    const { dataDir, tables } = await dataFolderOf17();
    // A folder of the new one half made, and half an export.
    const half = join(dataDir, upgradingOf(MAJOR));
    mkdirSync(half, { recursive: true });
    writeFileSync(join(half, "PG_VERSION"), "18\n");
    mkdirSync(join(dataDir, "upgrade", "pg17-to-pg18", "tables"), { recursive: true });
    writeFileSync(join(dataDir, "upgrade", "pg17-to-pg18", "half.jsonl"), "{");
    expect(await upgrade(dataDir)).toMatchObject({ kind: "upgraded" });
    expect(await running(dataDir, MAJOR, tablesOf)).toEqual(tables);

    // As if the machine stopped after the new one was put in place, before the old one was named.
    renameSync(join(dataDir, "pg17.old"), join(dataDir, "pg17"));
    cpSync(join(dataDir, "pg18"), half, { recursive: true });
    const said: string[] = [];
    const at = port();
    const backend = await startOn(dataDir, said, at);
    if (backend.kind !== "started") throw new Error("not started");
    await backend.stop();
    expect(said[0]).toMatch(/^旧版本的数据库留在数据目录的 pg17\.old 里/);
    const names = readdirSync(dataDir);
    expect(names).toContain("pg17.old");
    expect(names).not.toContain("pg17");
    expect(names).not.toContain(upgradingOf(MAJOR));
  }, 300_000);
});

describe.skipIf(!runs)("a folder of 18 that no upgrade made", () => {
  test("beside one of 17 with data: the one of 17 is left as it is, and that is said", async () => {
    const { dataDir, tables } = await dataFolderOf17();
    mkdirSync(join(dataDir, "pg18"));
    writeFileSync(join(dataDir, "pg18", "PG_VERSION"), "18\n");
    const said: string[] = [];
    await expect(startOn(dataDir, said, port())).rejects.toThrow();
    expect(
      said.some((line) => line.includes("pg17/（PostgreSQL 17），它不是这一版升级过来的")),
    ).toBe(true);
    const names = readdirSync(dataDir);
    expect(names).toContain("pg17");
    expect(names).not.toContain("pg17.old");
    expect(await running(dataDir, FROM, tablesOf)).toEqual(tables);
    // Taken away, the start after upgrades from it.
    rmSync(join(dataDir, "pg18"), { recursive: true });
    said.length = 0;
    const backend = await startOn(dataDir, said, port());
    if (backend.kind !== "started") throw new Error("not started");
    await backend.stop();
    expect(existsSync(join(dataDir, "pg18", "animaquill-upgraded.json"))).toBe(true);
    expect(readdirSync(dataDir)).toContain("pg17.old");
  }, 300_000);
});

describe.skipIf(!runs)("the backup of the server", () => {
  test("exported while it runs, with a picture of a conversation, and into an empty data folder with its master key", async () => {
    const dataDir = folder();
    const said: string[] = [];
    const at = port();
    const backend = await startOn(dataDir, said, at);
    if (backend.kind !== "started") throw new Error("not started");
    const out = join(folder(), "backup");
    let pictureHash: string;
    const picture = randomBytes(3000);
    try {
      const { page, change } = await signIn(backend, at);
      // A picture of a conversation, into the data folder through the server.
      pictureHash = (await import("node:crypto"))
        .createHash("sha256")
        .update(picture)
        .digest("hex");
      const begun = await call(
        at,
        "POST",
        "/api/me/chat-images",
        { ...change, "content-type": "application/json" },
        JSON.stringify({ hash: pictureHash, bytes: picture.length, type: "image/png" }),
      );
      expect(begun.status).toBe(200);
      const { url } = JSON.parse(begun.body).upload as { url: string };
      expect(new URL(url).pathname).toBe(`/api/me/chat-images/${pictureHash}/content`);
      const put = await call(
        at,
        "PUT",
        new URL(url).pathname,
        { ...change, "content-type": "image/png" },
        picture,
      );
      expect(put.status).toBe(204);
      expect(
        (await call(at, "POST", `/api/me/chat-images/${pictureHash}/done`, change)).status,
      ).toBe(200);
      expect(
        readFileSync(
          join(
            dataDir,
            "chat-images",
            "u",
            readdirSync(join(dataDir, "chat-images", "u"))[0]!,
            pictureHash,
          ),
        ).equals(picture),
      ).toBe(true);

      // The master key, once, for the page of this machine only; noted as saved by its digest.
      const state = JSON.parse((await call(at, "GET", "/api/local/server", page)).body);
      expect(state.masterKey).toMatchObject({ saved: false, madeAgain: false });
      expect((await call(at, "POST", "/api/local/server/master-key", page)).status).toBe(403);
      const key = await call(at, "POST", "/api/local/server/master-key", change);
      expect(key.body).toBe(readFileSync(join(dataDir, "master.key"), "utf8"));
      expect(
        (
          await call(
            at,
            "POST",
            "/api/local/server/master-key/saved",
            { ...change, "content-type": "application/json" },
            JSON.stringify({ fingerprint: "0".repeat(16) }),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            at,
            "POST",
            "/api/local/server/master-key/saved",
            { ...change, "content-type": "application/json" },
            JSON.stringify({ fingerprint: state.masterKey.fingerprint }),
          )
        ).status,
      ).toBe(204);
      expect(
        JSON.parse((await call(at, "GET", "/api/local/server", page)).body).masterKey.saved,
      ).toBe(true);

      // Exported through the backend that runs: not into its own data folder.
      const lines: string[] = [];
      expect(
        await serverExport({
          dataDir,
          dir: join(dataDir, "x"),
          version: "test",
          say: (l) => lines.push(l),
        }).catch((error: Error) => error.message),
      ).toMatch(/in the data folder/);
      expect(
        await serverExport({ dataDir, dir: out, version: "test", say: (l) => lines.push(l) }),
      ).toBe(0);
      expect(lines[0]).toMatch(/^AnimaQuill 正在运行/);
      expect(lines.some((line) => line.includes("对话里的图片 1 张"))).toBe(true);
      // And it answers again as before.
      expect((await call(at, "GET", "/api/auth/session", page)).body).toContain("signedIn");
    } finally {
      await backend.stop();
    }
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.chatImages.files).toBe(1);

    // Into a data folder that has something: refused, and nothing changes there.
    const lines: string[] = [];
    await expect(
      serverImport({ dataDir, dir: out, version: "test", say: (l) => lines.push(l) }),
    ).rejects.toThrow(/not empty/);
    // Into an empty one, with the master key: everything as it was, and the key opens.
    const other = join(folder(), "server");
    expect(
      await serverImport({
        dataDir: other,
        dir: out,
        version: "test",
        masterKey: join(dataDir, "master.key"),
        say: (l) => lines.push(l),
      }),
    ).toBe(0);
    expect(readFileSync(join(other, "master.key"), "utf8")).toBe(
      readFileSync(join(dataDir, "master.key"), "utf8"),
    );
    const person = readdirSync(join(other, "chat-images", "u"))[0]!;
    expect(
      readFileSync(join(other, "chat-images", "u", person, pictureHash!)).equals(picture),
    ).toBe(true);
    const imported = await running(other, MAJOR, tablesOf);
    for (const table of manifest.tables as {
      schema: string;
      name: string;
      rows: number;
      digest: string;
    }[])
      expect(imported[`${table.schema}.${table.name}`]).toEqual({
        rows: table.rows,
        digest: table.digest,
      });

    // Exported again while nothing runs: the same tables.
    const again = join(folder(), "again");
    expect(await serverExport({ dataDir: other, dir: again, version: "test", say: () => {} })).toBe(
      0,
    );
    const second = JSON.parse(readFileSync(join(again, "manifest.json"), "utf8"));
    expect(second.tables.map((t: { digest: string }) => t.digest)).toEqual(
      manifest.tables.map((t: { digest: string }) => t.digest),
    );
  }, 300_000);

  test("an import that fails leaves the data folder as empty as it was", async () => {
    const out = join(folder(), "nothing");
    mkdirSync(out);
    writeFileSync(
      join(out, "manifest.json"),
      JSON.stringify({
        format: "animaquill-data",
        version: 3,
        tables: [],
        migrations: {},
        scope: { schemas: ["public"], migrations: ["__drizzle_migrations"] },
      }),
    );
    const target = join(folder(), "server");
    await expect(
      serverImport({ dataDir: target, dir: out, version: "test", say: () => {} }),
    ).rejects.toThrow();
    expect(readdirSync(target).filter((name) => name !== "logs")).toEqual([]);
  }, 300_000);
});
