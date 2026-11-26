import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GitHubUnavailable } from "../github/client.ts";
import { migrationsDue, NewerDatabase } from "../database.ts";
import { users } from "../schema.ts";
import { createSealer, parseMasterKeys } from "../seal.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { createAccounts, LOCAL_PERSON } from "./accounts.ts";

/**
 * Accounts without GitHub, as the backend of `npx animaquill` has them: the person of this machine
 * signs in with `localSession`, and there is one of them at the most. And how a database stands to
 * the migrations of this version (`migrationsDue`), which that backend asks before it starts.
 */
describe.skipIf(!TEST_DATABASE)("the person of this machine", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const accountsOf = () =>
    createAccounts({
      db: t.db,
      sealer: createSealer(parseMasterKeys(`1:${randomBytes(32).toString("base64")}`)),
      github: undefined,
      callbackUrl: "http://animaquill.localhost:7651/api/auth/github/callback",
    });

  test("signs in without GitHub, as one person however many sessions come at once", async () => {
    const accounts = accountsOf();
    expect(accounts.withGitHub).toBe(false);
    const sessions = await Promise.all(
      Array.from({ length: 6 }, () => accounts.localSession("Mozilla/5.0 Chrome/150")),
    );
    expect(new Set(sessions).size).toBe(6);
    const people = await t.db.select().from(users).where(eq(users.kind, "local"));
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ login: LOCAL_PERSON, githubId: null });
    for (const session of sessions) {
      const who = await accounts.session(session);
      expect(who).toMatchObject({ userId: people[0]!.id, githubId: null, installed: false });
    }
    // Signing out of one leaves the others, and needs no GitHub.
    await accounts.logout(sessions[0]!);
    expect(await accounts.session(sessions[0]!)).toBeUndefined();
    expect(await accounts.session(sessions[1]!)).toBeDefined();
    await expect(accounts.cleanUp()).resolves.toBeDefined();
  });

  test("has nothing to start a sign-in of GitHub with", async () => {
    await expect(accountsOf().startLogin("/")).rejects.toBeInstanceOf(GitHubUnavailable);
  });

  test("a database says how many migrations are due, and refuses one a newer version had", async () => {
    expect(await migrationsDue(t.db)).toBe(0);
    const last = await t.query(
      "select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1",
    );
    const row = last.rows[0] as { id: number; hash: string; created_at: string };
    await t.query("delete from drizzle.__drizzle_migrations where id = $1", [row.id]);
    expect(await migrationsDue(t.db)).toBe(1);
    await t.query(
      "insert into drizzle.__drizzle_migrations (id, hash, created_at) values ($1, $2, $3)",
      [row.id, row.hash, row.created_at],
    );
    await t.query("insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)", [
      "from-a-newer-version",
      String(Number(row.created_at) + 1000),
    ]);
    await expect(migrationsDue(t.db)).rejects.toBeInstanceOf(NewerDatabase);
  });
});
