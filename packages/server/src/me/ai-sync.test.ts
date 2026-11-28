import { AI_SYNC_BYTES, DELETED_KEPT } from "@animaquill/host/ai-sync";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { userAiKeys, userAiSettings, users } from "../schema.ts";
import { createSealer } from "../seal.ts";
import { aiChangesOf, keyContext } from "./ai-sync.ts";

/**
 * The AI settings and keys that go with an account (me/ai-sync.ts): entries merged one by one, the
 * later wins, taken away stays as such; keys sealed, opened for their person only; turned off, the
 * platform keeps nothing. On a real PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const KEY = "sk-ant-api03-THIS-IS-A-TEST-KEY-0123456789";
const DAY = 86_400_000;
const service = (id: string, name = id) => ({
  id,
  kind: "anthropic",
  name,
  route: "direct",
  enabled: ["claude-opus-5"],
});

describe("what a request gives", () => {
  test("all of it as it should be, or nothing", () => {
    const ok = {
      account: "u",
      now: 5,
      format: 1,
      entries: [
        { name: "service:s1", at: 1, value: service("s1") },
        { name: "pack:claude-opus-5", at: 2, deleted: true },
      ],
      keys: [
        { service: "s1", at: 3, key: "k" },
        { service: "s2", at: 3, deleted: true },
      ],
    };
    // A key alone, as an editor of before gives it, is all that is secret of its service.
    expect(aiChangesOf(ok)).toEqual({
      ...ok,
      keys: [
        { service: "s1", at: 3, secret: { key: "k" }, fieldsAt: { key: 3 } },
        { service: "s2", at: 3, deleted: true },
      ],
    });
    const secret = {
      key: "k",
      baseUrl: "https://gw.example",
      headers: { "api-key": "x" },
    };
    expect(aiChangesOf({ ...ok, keys: [{ service: "s1", at: 3, secret }] })?.keys).toEqual([
      { service: "s1", at: 3, secret },
    ]);
    for (const wrong of [
      { ...ok, account: "" },
      { ...ok, format: 0 },
      { ...ok, entries: [{ name: "Service:s1", at: 1, value: 1 }] },
      { ...ok, entries: [{ name: "service:s1", at: -1, value: 1 }] },
      { ...ok, entries: [{ name: "service:s1", at: 1 }] },
      { ...ok, entries: [{ name: "service:s1", at: 1, deleted: false }] },
      { ...ok, keys: [{ service: "a b", at: 1, key: "k" }] },
      { ...ok, keys: [{ service: "s1", at: 1, key: "" }] },
      { ...ok, keys: [{ service: "s1", at: 1, key: "k".repeat(9000) }] },
      { ...ok, keys: [{ service: "s1", at: 1, secret: { key: 1 } }] },
      { ...ok, keys: [{ service: "s1", at: 1, secret: "k" }] },
    ])
      expect(aiChangesOf(wrong), JSON.stringify(wrong).slice(0, 120)).toBeUndefined();
  });
});

describe.skipIf(!TEST_DATABASE)("AI settings that go with an account, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  let time: number;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    time = 1_800_000_000_000;
    p = await platform(w, { now: () => time });
  });

  const change = (body: Record<string, unknown>, q = p, account = w.userId) =>
    q.request("POST", "/api/me/ai-settings", {
      now: time,
      account,
      format: 1,
      ...body,
    });
  const read = async (q = p) => (await q.request("GET", "/api/me/ai-settings")).json;
  /** Everything the database has of the person, as text. */
  const stored = async (userId = w.userId) => {
    const rows = await t.db.execute(
      sql`select to_jsonb(s)::text as row from user_ai_settings s where user_id = ${userId}
          union all select to_jsonb(k)::text from user_ai_keys k where user_id = ${userId}`,
    );
    return (rows.rows as { row: string }[]).map(({ row }) => row).join("\n");
  };

  test("nothing at first; entries and keys kept, and given back with what time it is", async () => {
    expect(await read()).toEqual({
      enabled: true,
      now: time,
      account: w.userId,
      revision: 0,
      format: 1,
      entries: {},
      keys: {},
    });
    const answer = await change({
      entries: [
        { name: "service:s1", at: time - 10, value: service("s1") },
        {
          name: "default",
          at: time - 10,
          value: { service: "s1", model: "claude-opus-5" },
        },
      ],
      keys: [{ service: "s1", at: time - 10, key: KEY }],
    });
    expect(answer.status).toBe(200);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.json.refused).toEqual([]);
    expect(answer.json.state).toEqual({
      enabled: true,
      account: w.userId,
      revision: 1,
      format: 1,
      entries: {
        "service:s1": { at: time - 10, value: service("s1") },
        default: {
          at: time - 10,
          value: { service: "s1", model: "claude-opus-5" },
        },
      },
      // What is secret of the service, and the key again for editors of before.
      keys: {
        s1: {
          at: time - 10,
          secret: { key: KEY },
          fieldsAt: { key: time - 10 },
          key: KEY,
        },
      },
    });
    expect(await read()).toEqual({ now: time, ...answer.json.state });
    // Asking whether anything changed.
    expect((await p.request("GET", "/api/me/ai-settings?since=1")).json).toEqual({
      now: time,
      account: w.userId,
      revision: 1,
      unchanged: true,
      enabled: true,
    });
    expect((await p.request("GET", "/api/me/ai-settings?since=0")).json.revision).toBe(1);
  });

  test("the key is sealed: the database has no key, and nothing that says it", async () => {
    await change({ keys: [{ service: "s1", at: time, key: KEY }] });
    const text = await stored();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("THIS-IS-A-TEST-KEY");
    expect(text).not.toContain(Buffer.from(KEY).toString("base64").slice(0, 20));
    expect(text).not.toContain(Buffer.from(KEY).toString("hex").slice(0, 20));
    const [row] = await t.db.select().from(userAiKeys).where(eq(userAiKeys.userId, w.userId));
    expect(row?.sealed?.includes(Buffer.from(KEY))).toBe(false);
    // Sealed for its person and service: moved to another, it does not open, and is not given.
    const other = await world(t.db);
    await t.db.insert(userAiKeys).values({ ...row!, userId: other.userId });
    const q = await platform(other, { now: () => time });
    expect((await read(q)).keys).toEqual({});
    await t.db.update(userAiKeys).set({ service: "s2" }).where(eq(userAiKeys.userId, w.userId));
    expect((await read()).keys).toEqual({});
  });

  test("entry by entry, the later wins: two devices that each add a service keep both", async () => {
    await change({
      entries: [{ name: "service:a", at: time - 5, value: service("a") }],
    });
    await change({
      entries: [{ name: "service:b", at: time - 9, value: service("b") }],
    });
    // The same entry: the later one, whatever came first.
    await change({
      entries: [{ name: "field:maxToolCalls", at: time - 2, value: 80 }],
    });
    const older = await change({
      entries: [{ name: "field:maxToolCalls", at: time - 3, value: 20 }],
    });
    expect(older.json.state.entries["field:maxToolCalls"]).toEqual({
      at: time - 2,
      value: 80,
    });
    // Nothing changed: the revision stays.
    expect(older.json.state.revision).toBe(3);
    const { entries } = await read();
    expect(Object.keys(entries).toSorted()).toEqual([
      "field:maxToolCalls",
      "service:a",
      "service:b",
    ]);
  });

  test("taken away stays as such, and a change from before does not bring it back", async () => {
    await change({
      entries: [{ name: "service:a", at: time - 10, value: service("a") }],
    });
    await change({
      entries: [{ name: "service:a", at: time - 5, deleted: true }],
    });
    await change({
      entries: [{ name: "service:a", at: time - 7, value: service("a", "改名") }],
    });
    expect((await read()).entries["service:a"]).toEqual({
      at: time - 5,
      deleted: true,
    });
    // A tie goes to taking away.
    await change({
      entries: [{ name: "service:b", at: time - 5, value: service("b") }],
    });
    await change({
      entries: [{ name: "service:b", at: time - 5, deleted: true }],
    });
    expect((await read()).entries["service:b"]).toEqual({
      at: time - 5,
      deleted: true,
    });
    // Later, it comes back.
    await change({
      entries: [{ name: "service:a", at: time - 1, value: service("a", "又加回来") }],
    });
    expect((await read()).entries["service:a"].value.name).toBe("又加回来");
    // Keys alike.
    await change({ keys: [{ service: "a", at: time - 10, key: KEY }] });
    await change({ keys: [{ service: "a", at: time - 5, deleted: true }] });
    await change({ keys: [{ service: "a", at: time - 7, key: "sk-older" }] });
    expect((await read()).keys).toEqual({
      a: { at: time - 5, deleted: true },
    });
    // However long after, what was taken away stays so.
    time += 400 * 86_400_000;
    await change({
      entries: [{ name: "field:autoTitle", at: time, value: false }],
    });
    const after = await read();
    expect(after.entries["service:b"]).toEqual({
      at: time - 400 * 86_400_000 - 5,
      deleted: true,
    });
    expect(after.keys).toEqual({
      a: { at: time - 400 * 86_400_000 - 5, deleted: true },
    });
  });

  test("times of a device whose clock is off are taken by the platform's", async () => {
    // Its clock is an hour ahead: what it says now is now.
    await change({
      now: time + 3_600_000,
      entries: [{ name: "field:autoTitle", at: time + 3_600_000 - 1, value: false }],
    });
    expect((await read()).entries["field:autoTitle"].at).toBe(time - 1);
    // Never later than now, whatever it says.
    await change({
      now: undefined,
      entries: [{ name: "field:x", at: time + 999_999, value: 1 }],
    });
    expect((await read()).entries["field:x"].at).toBe(time);
  });

  test("what cannot be such an entry is refused on its own, and the rest is kept", async () => {
    const answer = await change({
      entries: [
        {
          name: "service:a",
          at: time,
          value: { ...service("a"), apiKey: "sk-leak" },
        },
        {
          name: "service:u",
          at: time,
          value: { ...service("u"), baseUrl: "https://api.anthropic.com" },
        },
        { name: "service:b", at: time, value: { ...service("b"), id: "c" } },
        { name: "field:token", at: time, value: "x" },
        { name: "default", at: time, value: 5 },
        { name: "newkind:x", at: time, value: { anything: 1 } },
        { name: "service:d", at: time, value: service("d") },
      ],
    });
    expect(answer.json.refused).toEqual([
      "service:a",
      "service:u",
      "service:b",
      "field:token",
      "default",
    ]);
    expect(Object.keys(answer.json.state.entries).toSorted()).toEqual(["newkind:x", "service:d"]);
    expect(await stored()).not.toContain("sk-leak");
    expect(await stored()).not.toContain("sk-url");
  });

  test("so large at most: an entry beyond it is not taken, the rest of the change is", async () => {
    const big = "x".repeat(270 * 1024);
    const pack = (name: string) => ({
      name,
      at: time,
      value: { files: { "pack.json": big } },
    });
    expect((await change({ entries: [pack("installed:a")] })).status).toBe(200);
    const over = await change({
      entries: [pack("installed:b"), { name: "field:autoTitle", at: time, value: false }],
    });
    expect(over.status).toBe(200);
    expect(over.json.tooLarge).toEqual(["installed:b"]);
    expect(Object.keys((await read()).entries).toSorted()).toEqual([
      "field:autoTitle",
      "installed:a",
    ]);
    expect(AI_SYNC_BYTES).toBe(512 * 1024);
    // Taking one away always goes, and makes room.
    await change({
      entries: [{ name: "installed:a", at: time + 1, deleted: true }],
    });
    expect((await change({ entries: [pack("installed:b")] })).json.tooLarge).toEqual([]);
    // One entry larger than an entry can be is refused on its own.
    const huge = await change({
      entries: [
        {
          name: "installed:c",
          at: time,
          value: { files: { a: "y".repeat(310 * 1024) } },
        },
      ],
    });
    expect(huge.json.refused).toEqual(["installed:c"]);
  });

  test("keys go whatever the entries come to: a key taken away is gone, a new one is there", async () => {
    // Review CM5, F3: entries too large held back the keys of the same change.
    await change({
      keys: [{ service: "s1", at: time - 100, key: "LEAKED-KEY" }],
    });
    await change({
      keys: [{ service: "s2", at: time - 100, key: "OLD-KEY" }],
    });
    const big = (n: string) => ({
      name: `field:${n}`,
      at: time,
      value: "x".repeat(200_000),
    });
    const answer = await change({
      entries: [big("a"), big("b"), big("c")],
      keys: [
        { service: "s1", at: time, deleted: true },
        { service: "s2", at: time, key: "NEW-KEY" },
      ],
    });
    expect(answer.status).toBe(200);
    expect(answer.json.tooLarge).toEqual(["field:c"]);
    const { keys } = await read();
    expect(keys.s1).toEqual({ at: time, deleted: true });
    expect(keys.s2).toEqual({
      at: time,
      secret: { key: "NEW-KEY" },
      fieldsAt: { key: time },
      key: "NEW-KEY",
    });
    expect(await stored()).not.toContain("LEAKED-KEY");
  });

  test("a key that does not open any more is none: what a device gives again takes its place", async () => {
    // Review CM5, F1: sealed with a master key that is gone.
    const at = time - 1000;
    const lost = createSealer([{ version: 9, key: randomBytes(32) }]);
    await t.db.insert(userAiKeys).values({
      userId: w.userId,
      service: "s1",
      at: new Date(at),
      sealed: lost.seal("old-key", "ai-key", keyContext(w.userId, "s1")),
    });
    expect((await read()).keys).toEqual({});
    // Named, so that people are told to give it again; nothing of it opened.
    expect((await read()).unreadable).toEqual(["s1"]);
    // The browser gives it again, with the time it had.
    expect(
      (
        await change({
          keys: [{ service: "s1", at, key: "KEY-FROM-BROWSER" }],
        })
      ).status,
    ).toBe(200);
    expect((await read()).keys).toEqual({
      s1: {
        at,
        secret: { key: "KEY-FROM-BROWSER" },
        fieldsAt: { key: at },
        key: "KEY-FROM-BROWSER",
      },
    });
    expect((await read()).unreadable).toBeUndefined();
  });

  test("a device away a long time does not bring back what was taken away", async () => {
    // Review CM5, F2 and F2b.
    await change({
      entries: [{ name: "service:s1", at: time - 1000, value: service("s1") }],
      keys: [{ service: "s1", at: time - 1000, key: "k1" }],
    });
    time += 1000;
    await change({
      entries: [{ name: "service:s1", at: time, deleted: true }],
      keys: [{ service: "s1", at: time, deleted: true }],
    });
    time += 31 * DAY;
    const old = time - 31 * DAY - 1000;
    for (let i = 0; i < 2; i += 1)
      await change({
        entries: [{ name: "service:s1", at: old, value: service("s1") }],
        keys: [{ service: "s1", at: old, key: "k1" }],
      });
    const state = await read();
    expect(state.entries["service:s1"]).toMatchObject({ deleted: true });
    expect(state.keys.s1).toMatchObject({ deleted: true });
    expect(await stored()).not.toContain('"k1"');
    // Changed since: it goes.
    await change({
      entries: [{ name: "service:s1", at: time, value: service("s1") }],
      keys: [{ service: "s1", at: time, key: "k2" }],
    });
    expect((await read()).keys.s1?.key).toBe("k2");
  });

  test("what nobody took away goes, however old: the first sign-in, turned on again, a device away", async () => {
    // Review CM5, W1: marks of other names taken away long ago change nothing of these.
    await change({
      entries: [{ name: "service:gone", at: time - 40 * DAY, deleted: true }],
    });
    await change({
      keys: [{ service: "gone", at: time - 40 * DAY, deleted: true }],
    });
    await change({
      entries: [{ name: "service:x", at: time, value: service("x") }],
    });
    const answer = await change({
      entries: [
        // What the first sign-in puts in, under what the account has.
        { name: "service:s1", at: 1, value: service("s1") },
        // Unchanged for 35 days, given again as people turn it on again, or by a device away.
        { name: "service:s2", at: time - 35 * DAY, value: service("s2") },
      ],
      keys: [
        { service: "s1", at: 1, key: "K1" },
        { service: "s2", at: time - 35 * DAY, key: "K2" },
      ],
    });
    expect(answer.json.refused).toEqual([]);
    expect(answer.json.tooLarge).toEqual([]);
    const state = await read();
    expect(Object.keys(state.entries).toSorted()).toEqual([
      "service:gone",
      "service:s1",
      "service:s2",
      "service:x",
    ]);
    expect(state.keys.s1?.key).toBe("K1");
    expect(state.keys.s2?.key).toBe("K2");
  });

  test("so many marks of what was taken away, the oldest go beyond them", async () => {
    const marks = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        name: `pack:m${from + i}`,
        at: base - 10_000 + from + i,
        deleted: true,
      }));
    const base = time;
    // Ten minutes apart, as a person could give no more at once.
    const later = () => (time += 11 * 60_000);
    for (let from = 0; from < DELETED_KEPT + 5; from += 400) {
      await change({
        entries: marks(from, Math.min(400, DELETED_KEPT + 5 - from)),
      });
      later();
    }
    const { entries } = await read();
    expect(Object.keys(entries)).toHaveLength(DELETED_KEPT);
    // The five oldest went.
    for (let i = 0; i < 5; i += 1) expect(entries[`pack:m${i}`]).toBeUndefined();
    expect(entries[`pack:m5`]).toBeDefined();
    // Keys alike.
    const keyMarks = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        service: `k${from + i}`,
        at: base - 10_000 + from + i,
        deleted: true,
      }));
    for (let from = 0; from < DELETED_KEPT + 3; from += 100) {
      await change({
        keys: keyMarks(from, Math.min(100, DELETED_KEPT + 3 - from)),
      });
      if (from % 500 === 400) later();
    }
    const { keys } = await read();
    expect(Object.keys(keys)).toHaveLength(DELETED_KEPT);
    expect(keys.k0).toBeUndefined();
    expect(keys.k3).toBeDefined();
  });

  test("of the person signed in only: another account's are not given, nor changed", async () => {
    await change({
      entries: [{ name: "service:a", at: time, value: service("a") }],
      keys: [{ service: "a", at: time, key: KEY }],
    });
    const someone = await world(t.db);
    const q = await platform(someone, { now: () => time });
    // Their own, which are none.
    const theirs = await read(q);
    expect(theirs.account).toBe(someone.userId);
    expect(theirs.entries).toEqual({});
    expect(theirs.keys).toEqual({});
    // Changes that say they are of the first account, from a session of the second: none kept.
    const refused = await change(
      { entries: [{ name: "service:z", at: time, value: service("z") }] },
      q,
      w.userId,
    );
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "otherAccount" });
    expect(Object.keys((await read()).entries)).toEqual(["service:a"]);
    expect((await read()).keys.a.key).toBe(KEY);
    // Signed out: nothing.
    expect((await p.send("GET", "/api/me/ai-settings", { signedIn: false })).status).toBe(401);
  });

  test("what is secret of a service is sealed whole: key, address, headers, and its models'", async () => {
    const secret = {
      key: KEY,
      baseUrl: "https://gateway.example/v1",
      headers: { "api-key": "THIS-IS-A-HEADER-SECRET" },
      models: {
        m: {
          baseUrl: "https://gateway.example/claude",
          headers: { "x-m": "1" },
        },
      },
    };
    const given = await change({
      format: 3,
      keys: [{ service: "s1", at: time, secret }],
    });
    expect(given.status).toBe(200);
    expect(given.json.state.keys.s1).toEqual({ at: time, secret, key: KEY });
    const text = await stored();
    for (const part of [KEY, "gateway.example", "THIS-IS-A-HEADER-SECRET", "x-m"])
      expect(text, part).not.toContain(part);
    const [row] = await t.db.select().from(userAiKeys).where(eq(userAiKeys.userId, w.userId));
    expect(row?.format).toBe(2);
    expect((await read()).keys.s1.secret).toEqual(secret);
    // What is not one is not taken, nor anything else of the changes.
    const wrong = await change({
      format: 3,
      keys: [{ service: "s1", at: time + 1, secret: { headers: { a: 1 } } }],
    });
    expect(wrong.status).toBe(400);
    expect((await read()).keys.s1.secret).toEqual(secret);
  });

  test("turned off for all devices before 0.3.72: what a device gives now is all there is", async () => {
    await t.db.insert(userAiSettings).values({ userId: w.userId, enabled: false });
    const given = await change({
      entries: [{ name: "service:b", at: time, value: service("b") }],
    });
    expect(given.status).toBe(200);
    expect(Object.keys(given.json.state.entries)).toEqual(["service:b"]);
  });

  test("a newer editor's format is not written over", async () => {
    await change({ entries: [{ name: "field:a", at: time, value: 1 }] });
    await t.db.update(userAiSettings).set({ format: 2 }).where(eq(userAiSettings.userId, w.userId));
    const refused = await change({
      entries: [{ name: "field:a", at: time + 1, value: 2 }],
    });
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "newer" });
    expect((await read()).format).toBe(2);
    expect((await read()).entries["field:a"].value).toBe(1);
  });

  test("entries of models go with format 2, after which an editor of format 1 gives nothing", async () => {
    const model = { id: "m", added: "hand", contextWindow: 64000 };
    const given = await change({
      format: 2,
      entries: [
        { name: "service:a", at: time, value: service("a") },
        { name: "model:a/m", at: time, value: model },
      ],
    });
    expect(given.status).toBe(200);
    expect(given.json.state.format).toBe(2);
    expect((await read()).entries["model:a/m"].value).toEqual(model);
    const old = await change({
      format: 1,
      entries: [{ name: "field:a", at: time + 1, value: 1 }],
    });
    expect(old.status).toBe(409);
    expect(old.json).toEqual({ error: "newer" });
    // A format beyond what this platform knows is taken as the one it knows.
    expect((await change({ format: 9, entries: [] })).json.state.format).toBe(3);
  });

  test("what is secret of a service is merged part by part: two devices, a key and an address", async () => {
    await change({
      format: 3,
      keys: [
        {
          service: "s1",
          at: time - 100,
          secret: { key: "sk-old", baseUrl: "https://old.example" },
          fieldsAt: { key: time - 100, baseUrl: time - 100 },
        },
      ],
    });
    // The address changed later on one device; the key earlier on another, which goes last.
    await change({
      format: 3,
      keys: [
        {
          service: "s1",
          at: time - 10,
          secret: { key: "sk-old", baseUrl: "https://new.example" },
          fieldsAt: { key: time - 100, baseUrl: time - 10 },
        },
      ],
    });
    await change({
      format: 3,
      keys: [
        {
          service: "s1",
          at: time - 50,
          secret: { key: "sk-new", baseUrl: "https://old.example" },
          fieldsAt: { key: time - 50, baseUrl: time - 100 },
        },
      ],
    });
    expect((await read()).keys.s1.secret).toEqual({
      key: "sk-new",
      baseUrl: "https://new.example",
    });
    // The key alone, as editors of before give it: only the key changes.
    await change({
      format: 3,
      keys: [{ service: "s1", at: time, key: "sk-older-editor" }],
    });
    expect((await read()).keys.s1.secret).toEqual({
      key: "sk-older-editor",
      baseUrl: "https://new.example",
    });
  });

  test("a service or a model with its address or headers in the clear is not taken", async () => {
    const answer = await change({
      format: 3,
      entries: [
        {
          name: "service:a",
          at: time,
          value: { ...service("a"), headers: { a: "b" } },
        },
        {
          name: "model:a/m",
          at: time,
          value: { id: "m", baseUrl: "https://x.example" },
        },
        { name: "service:b", at: time, value: service("b") },
      ],
    });
    expect(answer.json.refused).toEqual(["service:a", "model:a/m"]);
    // Pages of before 0.3.72 read whether it is on: always, now.
    expect((await read()).enabled).toBe(true);
    expect(
      (await p.request("GET", `/api/me/ai-settings?since=${answer.json.state.revision}`)).json
        .enabled,
    ).toBe(true);
  });

  test("goes with the person", async () => {
    await change({
      entries: [{ name: "service:a", at: time, value: service("a") }],
      keys: [{ service: "a", at: time, key: KEY }],
    });
    await t.db.delete(users).where(eq(users.id, w.userId));
    expect(await stored()).toBe("");
  });

  test("only from pages of this site, and limited", async () => {
    expect(
      (
        await p.send("POST", "/api/me/ai-settings", {
          payload: JSON.stringify({ account: w.userId, format: 1 }),
          headers: { "content-type": "application/json" },
          fromHere: false,
        })
      ).status,
    ).toBe(403);
    expect((await change({ entries: "no" })).status).toBe(400);
    let last = 0;
    for (let i = 0; i < 400 && last !== 429; i += 1)
      last = (await p.request("GET", "/api/me/ai-settings")).status;
    expect(last).toBe(429);
  });
});
