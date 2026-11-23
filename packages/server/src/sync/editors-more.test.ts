import { afterAll, beforeAll, describe, test } from "vitest";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { runEditors } from "./editors-support.ts";

/**
 * The editor's sync against this platform at random, see editors-support.ts. Needs
 * AQ_TEST_DATABASE, see vitest.config.ts. The seeds are in two files, so that they run at the same
 * time.
 */
describe.skipIf(!TEST_DATABASE)("the editor's sync with the platform", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });

  for (const seed of [13, 14]) {
    test(`keeps every window and the database in step, and loses nothing (seed ${seed})`, async () => {
      await runEditors(database, seed, 120);
    }, 180_000);
  }
});
