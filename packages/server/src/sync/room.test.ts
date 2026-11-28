import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { someone } from "../test/sync-support.ts";
import { loadConfig } from "../config.ts";
import { fixedLimits, NO_LIMITS } from "../limits.ts";
import { projectCovers, projects } from "../schema.ts";
import { platformHeld, roomFor } from "./room.ts";

/**
 * What a person keeps on the platform, as `storage.platform` and `projects.count` count it, and
 * whether one more project has room (sync/room.ts): for each person on the platform, for everyone
 * together on a server of its own. On a real PostgreSQL. Needs AQ_TEST_DATABASE.
 */
describe.skipIf(!TEST_DATABASE)("room for one more project, on a database", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  let number = 0;
  const project = async (ownerId: string, bytes: number, cover?: number) => {
    const id = `room${Date.now().toString(36)}x${++number}`;
    await t.db.insert(projects).values({
      id,
      ownerId,
      projectId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
      name: "x",
      head: 0,
      digest: "",
      bytes,
    });
    if (cover !== undefined)
      await t.db.insert(projectCovers).values({
        projectId: id,
        bytes: Buffer.alloc(cover),
        type: "image/webp",
        etag: "e",
      });
    return id;
  };
  const room = (ownerId: string, limits: Parameters<typeof roomFor>[1], bytes: number) =>
    t.db.transaction((tx) => roomFor(tx, limits, ownerId, bytes));

  test("counts every project of the person with its cover, also one let go of", async () => {
    const ada = await someone(t.db);
    const bob = await someone(t.db);
    await project(ada.userId, 1000, 300);
    await project(ada.userId, 0, 200);
    await project(ada.userId, 50);
    await project(bob.userId, 7000, 100);
    expect(await platformHeld(t.db, ada.userId, "person")).toEqual({ projects: 3, bytes: 1550 });
    expect(await platformHeld(t.db, bob.userId, "person")).toEqual({ projects: 1, bytes: 7100 });
    // For the whole server: everyone's.
    const everyone = await platformHeld(t.db, ada.userId, "server");
    expect(everyone.projects).toBeGreaterThanOrEqual(4);
    expect(everyone.bytes).toBeGreaterThanOrEqual(8650);
  });

  test("one more by number and by bytes; a restore, of no bytes yet, only where already over", async () => {
    const ada = await someone(t.db);
    await project(ada.userId, 1000, 100);
    expect(await room(ada.userId, NO_LIMITS, 1e12)).toBeUndefined();
    expect(await room(ada.userId, fixedLimits({ "projects.count": 2 }), 0)).toBeUndefined();
    expect(await room(ada.userId, fixedLimits({ "projects.count": 1 }), 0)).toEqual({
      detail: "count",
      used: 1,
      limit: 1,
    });
    const bytes = fixedLimits({ "storage.platform": 1500 });
    expect(await room(ada.userId, bytes, 400)).toBeUndefined();
    expect(await room(ada.userId, bytes, 401)).toEqual({
      detail: "storage",
      used: 1100,
      limit: 1500,
    });
    expect(await room(ada.userId, fixedLimits({ "storage.platform": 1100 }), 0)).toBeUndefined();
    expect(await room(ada.userId, fixedLimits({ "storage.platform": 1099 }), 0)).toMatchObject({
      detail: "storage",
    });
  });

  test("a server of its own: no limit unless its settings say one, then for all of it", async () => {
    const config = (limits?: string) =>
      loadConfig({ ...(limits !== undefined && { AQ_LIMITS: limits }) }, () => undefined);
    const ada = await someone(t.db);
    const bob = await someone(t.db);
    await project(bob.userId, 10);
    const open = fixedLimits(config().limits, "server");
    expect(await room(ada.userId, open, 1e12)).toBeUndefined();
    // Everyone's together: what bob has leaves ada no room.
    const { projects: all } = await platformHeld(t.db, ada.userId, "server");
    const limited = fixedLimits(config(`{"projects.count": ${all}}`).limits, "server");
    expect(await room(ada.userId, limited, 0)).toEqual({ detail: "count", used: all, limit: all });
    const roomy = fixedLimits(config(`{"projects.count": ${all + 1}}`).limits, "server");
    expect(await room(ada.userId, roomy, 0)).toBeUndefined();
  });
});
