import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./database.ts";

/**
 * The migrations in drizzle/, as the API applies them when it starts (database.ts). Drizzle runs
 * only those whose time (`when` in the journal) is later than that of the last one a database has:
 * one that is older than the one before it, as when two steps were made side by side and the later
 * of them got the earlier number, is never run on a database that has the one before. Nothing says
 * so; the tables are simply not there.
 */

interface Journal {
  readonly entries: readonly {
    readonly idx: number;
    readonly when: number;
    readonly tag: string;
  }[];
}

const journalOf = (folder: string): Journal =>
  JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as Journal;

describe("the migrations", () => {
  test("come one after the other, each made after the one before it", () => {
    const { entries } = journalOf(MIGRATIONS);
    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, index) => index));
    for (let index = 1; index < entries.length; index++)
      expect(
        entries[index]!.when,
        `${entries[index]!.tag} has to be newer than ${entries[index - 1]!.tag}: make it again with db:generate`,
      ).toBeGreaterThan(entries[index - 1]!.when);
    // Each is a file, and each file is one of them.
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));
    expect(files.toSorted()).toEqual(entries.map((entry) => `${entry.tag}.sql`).toSorted());
  });
});

// From the starting migration of O3c on: a test that a database of the version before takes the
// newest comes back with the second migration.
