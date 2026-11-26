import { describe, expect, test } from "vitest";
import { databaseFrom, DATABASE_VARIABLE } from "./database-option.ts";

/** `--database` or `AQ_DATABASE_URL`: where a password is better kept, and which one wins. */

const ENV = "postgres://ada:secret@db.example/aq";
const FLAG = "postgres://bob@other.example/aq";

describe("the database of people's own", () => {
  test("is read from the environment, which is cleared of it at once", () => {
    const env: NodeJS.ProcessEnv = { [DATABASE_VARIABLE]: ENV, KEEP: "1" };
    expect(databaseFrom(undefined, env)).toEqual({ database: ENV });
    expect(env).toEqual({ KEEP: "1" });
  });

  test("is none where neither is given, and an empty variable is none", () => {
    expect(databaseFrom(undefined, {})).toEqual({ database: undefined });
    const env: NodeJS.ProcessEnv = { [DATABASE_VARIABLE]: "" };
    expect(databaseFrom(undefined, env).database).toBeUndefined();
    expect(DATABASE_VARIABLE in env).toBe(false);
  });

  test("with a password in the command line says that others can see it, and still uses it", () => {
    const result = databaseFrom(ENV, {});
    expect(result.database).toBe(ENV);
    expect(result.warning).toMatch(/--database 里的密码.*AQ_DATABASE_URL/);
    expect(databaseFrom(FLAG, {}).warning).toBeUndefined();
    expect(databaseFrom("not a url", {}).warning).toBeUndefined();
  });

  test("is the one of the command line where both are given, and the environment is cleared too", () => {
    const env: NodeJS.ProcessEnv = { [DATABASE_VARIABLE]: ENV };
    expect(databaseFrom(FLAG, env)).toEqual({ database: FLAG });
    expect(env[DATABASE_VARIABLE]).toBeUndefined();
  });
});
