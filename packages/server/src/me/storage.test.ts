import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform } from "../test/platform-support.ts";
import { SyncHub } from "../sync/hub.ts";
import { fixedLimits } from "../limits.ts";

/**
 * The cloud space of whoever is signed in (me/routes.ts, `GET /api/me/storage`), as `PersonLimits`
 * says how much they may keep (limits.ts): no limit unless the server is given one. On a real
 * PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */
describe.skipIf(!TEST_DATABASE)("the cloud space of an account, as the limits say", () => {
  let t: TestDatabase;
  let w: World;
  let hub: SyncHub;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    hub = new SyncHub({ db: t.db, log: quiet });
  });
  afterEach(() => hub.stop());

  test("no limit unless one is given; what is given is said, for the person who asks", async () => {
    const asked: [string, string][] = [];
    const open = await platform(w, { hub });
    expect((await open.send("GET", "/api/me/storage")).json).toEqual({
      mode: "off",
      limit: null,
      used: 0,
    });
    const limited = await platform(w, {
      hub,
      limits: {
        scope: "person",
        of: async (_db, userId, key) => {
          asked.push([userId, key]);
          return 5;
        },
        all: async () => fixedLimits({}).all(t.db, w.userId),
      },
    });
    expect((await limited.send("GET", "/api/me/storage")).json).toEqual({
      mode: "off",
      limit: 5,
      used: 0,
    });
    expect(asked).toEqual([[w.userId, "storage.cloud"]]);
  });
});
