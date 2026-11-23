import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { describeError } from "./database.ts";

describe("what the log says about an error", () => {
  test("of a query is what the database said, never the query or what went into it", () => {
    const cause = Object.assign(new Error('relation "sessions" does not exist'), { code: "42P01" });
    const failed = new DrizzleQueryError(
      'select "id" from "sessions" where "id_hash" = $1',
      [Buffer.from("a hash nobody may see"), "ghu_secret"],
      cause,
    );
    const said = describeError(failed);
    expect(said).toEqual({
      name: "Error",
      message: 'relation "sessions" does not exist',
      code: "42P01",
    });
    expect(JSON.stringify(said)).not.toMatch(/select|params|ghu_secret|hash nobody/);
  });

  test("of a query without a cause says only that a query failed", () => {
    const said = describeError(new DrizzleQueryError("select $1", ["ghu_secret"]));
    expect(said).toEqual({ name: "DrizzleQueryError", message: "a query failed" });
  });

  test("of anything else is its name, message and code", () => {
    expect(describeError(Object.assign(new TypeError("x"), { code: "E1" }))).toEqual({
      name: "TypeError",
      message: "x",
      code: "E1",
    });
    expect(describeError("plain")).toEqual({ message: "plain" });
  });
});
