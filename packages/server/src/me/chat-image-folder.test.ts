import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { ORIGIN, platform, type Platform } from "../test/platform-support.ts";
import { userChatImageRefs, userChatImages } from "../schema.ts";
import { changeableLimits } from "../test/limits-support.ts";
import { SyncHub } from "../sync/hub.ts";
import { ChatImages, UNREFERENCED_KEEP_MS, imageKey } from "./chat-images.ts";
import { folderImageStore } from "./chat-image-store.ts";

/**
 * The pictures of conversations in a folder of the server's own, as the backend of `npx animaquill`
 * keeps them in its data folder (me/chat-image-store.ts): put and read through the server, by their
 * person only, each whole or not at all, and taken away as from the object storage.
 */

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "aq-chat-images-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const USER = "00000000-0000-4000-8000-000000000001";
const picture = (size = 2000) => {
  const bytes = randomBytes(size);
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
};

describe("a folder of pictures", () => {
  test("keeps each whole, only its user's, and lists and takes away by key", async () => {
    const dir = folder();
    const store = folderImageStore({ folder: dir, origin: ORIGIN, minFreeBytes: 0 });
    const image = picture();
    const key = imageKey(USER, image.hash);
    expect(await store.read(key, 10_000)).toBeUndefined();
    await store.write!(key, image.bytes);
    const path = join(dir, "chat-images", "u", USER, image.hash);
    expect(readFileSync(path)).toEqual(image.bytes);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "chat-images")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "chat-images", "u", USER)).mode & 0o777).toBe(0o700);
    }
    // Nothing half-written is left beside it.
    expect(readdirSync(join(dir, "chat-images", ".writing"))).toEqual([]);
    expect(await store.read(key, 10_000)).toEqual(image.bytes);
    expect((await store.read(key, 10))?.length).toBe(0);
    expect((await store.list(`chat-images/u/${USER}/`)).keys).toEqual([key]);
    expect((await store.list("chat-images/u/")).keys).toEqual([key]);
    await store.remove(key);
    expect(existsSync(path)).toBe(false);
    await store.remove(key);
  });

  test("names nothing outside of it", async () => {
    const store = folderImageStore({ folder: folder(), origin: ORIGIN, minFreeBytes: 0 });
    for (const key of [
      `chat-images/u/${USER}/../../../etc`,
      "../outside",
      `chat-images/u/${USER}/${"a".repeat(63)}`,
    ]) {
      await expect(store.read(key, 10)).rejects.toThrow(RangeError);
      await expect(store.write!(key, Buffer.from("x"))).rejects.toThrow(RangeError);
    }
    await expect(store.list("chat-images/../")).rejects.toThrow(RangeError);
  });

  test("pages put and read at the server, with what every change says", async () => {
    const store = folderImageStore({ folder: folder(), origin: ORIGIN, minFreeBytes: 0 });
    const key = imageKey(USER, picture().hash);
    const put = await store.putAddress(key, { bytes: 5, hash: "" }, 600);
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(`${ORIGIN}/api/me/chat-images/${key.split("/").at(-1)}/content`);
    expect(put.headers).toEqual({ "x-animaquill": "1" });
    expect(await store.readAddress(key, 300)).toBe(put.url);
  });

  test("takes nothing new where the disk is too full", async () => {
    const store = folderImageStore({
      folder: folder(),
      origin: ORIGIN,
      minFreeBytes: 1,
      disk: async () => ({ free: 0, floor: 1, enough: false }),
    });
    expect(await store.canPut()).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE)("pictures of conversations in a folder, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  let hub: SyncHub;
  let time: number;
  let dir: string;
  let images: ChatImages;
  const limits = changeableLimits();
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.delete(userChatImageRefs);
    await t.db.delete(userChatImages);
    dir = folder();
    w = await world(t.db);
    hub = new SyncHub({ db: t.db, log: quiet });
    time = 1_800_000_000_000;
    limits.set({ "chat.images": 500 * 1024 ** 2 });
    images = new ChatImages({
      db: t.db,
      storage: folderImageStore({ folder: dir, origin: ORIGIN, minFreeBytes: 0 }),
      limits,
      now: () => time,
      log: quiet,
    });
    p = await platform(w, { hub, now: () => time, chatImages: images });
  });
  afterEach(() => hub.stop());

  const begin = (image: { bytes: Buffer; hash: string }, q = p) =>
    q.send("POST", "/api/me/chat-images", {
      payload: JSON.stringify({ hash: image.hash, bytes: image.bytes.length, type: "image/png" }),
      headers: { "content-type": "application/json" },
    });
  const putBytes = (url: string, bytes: Buffer, q = p, type = "image/png") =>
    q.send("PUT", new URL(url).pathname, { payload: bytes, headers: { "content-type": type } });
  const fileOf = (userId: string, hash: string) => join(dir, "chat-images", "u", userId, hash);

  test("goes up through the server, is checked, and is read by its person only", async () => {
    const image = picture();
    const begun = await begin(image);
    expect(begun.status).toBe(200);
    const { url, headers } = begun.json.upload;
    expect(headers).toEqual({ "x-animaquill": "1" });
    expect((await putBytes(url, image.bytes)).status).toBe(204);
    expect(readFileSync(fileOf(w.userId, image.hash))).toEqual(image.bytes);
    expect((await p.send("POST", `/api/me/chat-images/${image.hash}/done`)).json).toEqual({
      state: "ready",
    });
    const read = await p.send("GET", `/api/me/chat-images/${image.hash}`);
    expect(read.json.url).toBe(url);
    const got = await p.sendRaw("GET", new URL(url).pathname);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["cache-control"]).toContain("no-store");
    expect(got.body).toEqual(image.bytes);
    // Somebody else gets nothing of it, neither to read nor to put.
    const other = await platform(await world(t.db), { hub, now: () => time, chatImages: images });
    expect((await other.send("GET", new URL(url).pathname)).status).toBe(404);
    expect((await putBytes(url, image.bytes, other)).status).toBe(404);
  });

  test("takes only what was begun, as large as it said, and what its name says", async () => {
    const image = picture();
    const { url } = (await begin(image)).json.upload;
    // Other bytes of the same size, fewer bytes, a picture never begun.
    expect((await putBytes(url, randomBytes(image.bytes.length))).status).toBe(422);
    expect((await putBytes(url, image.bytes.subarray(1))).status).toBe(422);
    expect(existsSync(fileOf(w.userId, image.hash))).toBe(false);
    const never = picture();
    expect((await putBytes(url.replace(image.hash, never.hash), never.bytes)).status).toBe(404);
    expect(existsSync(fileOf(w.userId, never.hash))).toBe(false);
    // Not as a type a picture may be, nor without the header of a page of the editor.
    expect((await putBytes(url, image.bytes, p, "text/html")).status).toBe(415);
    expect(
      (
        await p.send("PUT", new URL(url).pathname, {
          payload: image.bytes,
          headers: { "content-type": "image/png", "x-animaquill": "" },
        })
      ).status,
    ).toBe(403);
    // Nothing is there yet to be done with.
    expect((await p.send("POST", `/api/me/chat-images/${image.hash}/done`)).status).toBe(409);
  });

  test("what nothing refers to goes from the folder with its row, and what has no row", async () => {
    const image = picture();
    const { url } = (await begin(image)).json.upload;
    await putBytes(url, image.bytes);
    await p.send("POST", `/api/me/chat-images/${image.hash}/done`);
    // Something of the person's that the server has no row for, as after a crash.
    const stray = picture();
    await folderImageStore({ folder: dir, origin: ORIGIN, minFreeBytes: 0 }).write!(
      imageKey(w.userId, stray.hash),
      stray.bytes,
    );
    time += UNREFERENCED_KEEP_MS + 1;
    const done = await images.cleanUp();
    expect(done).toEqual({ expired: 1, leftOver: 1 });
    expect(existsSync(fileOf(w.userId, image.hash))).toBe(false);
    expect(existsSync(fileOf(w.userId, stray.hash))).toBe(false);
  });

  test("a picture kept whose file is gone goes up again, and only as what its name says", async () => {
    const image = picture();
    const { url } = (await begin(image)).json.upload;
    await putBytes(url, image.bytes);
    await p.send("POST", `/api/me/chat-images/${image.hash}/done`);
    expect((await begin(image)).json).toEqual({ have: true });
    rmSync(fileOf(w.userId, image.hash));
    expect((await p.sendRaw("GET", new URL(url).pathname)).status).toBe(404);
    // Asked again: an address to put it at, not "have".
    const again = await begin(image);
    expect(again.json.upload.url).toBe(url);
    expect((await putBytes(url, randomBytes(image.bytes.length))).status).toBe(422);
    expect(existsSync(fileOf(w.userId, image.hash))).toBe(false);
    expect((await putBytes(url, image.bytes)).status).toBe(204);
    expect((await p.send("POST", `/api/me/chat-images/${image.hash}/done`)).json).toEqual({
      state: "ready",
    });
    expect((await p.sendRaw("GET", new URL(url).pathname)).body).toEqual(image.bytes);
  });

  test("the hourly round goes past what is no picture, and takes away what a crash left half written", async () => {
    const image = picture();
    const { url } = (await begin(image)).json.upload;
    await putBytes(url, image.bytes);
    await p.send("POST", `/api/me/chat-images/${image.hash}/done`);
    writeFileSync(join(dir, "chat-images", "u", ".DS_Store"), "x");
    writeFileSync(join(dir, "chat-images", "u", w.userId, ".DS_Store"), "x");
    const writing = join(dir, "chat-images", ".writing");
    writeFileSync(join(writing, "old.tmp"), "half");
    writeFileSync(join(writing, "new.tmp"), "half");
    const hourAgo = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(join(writing, "old.tmp"), hourAgo, hourAgo);
    time += UNREFERENCED_KEEP_MS + 1;
    expect(await images.cleanUp()).toEqual({ expired: 1, leftOver: 0 });
    expect(existsSync(fileOf(w.userId, image.hash))).toBe(false);
    expect(readdirSync(writing)).toEqual(["new.tmp"]);
    expect(existsSync(join(dir, "chat-images", "u", w.userId, ".DS_Store"))).toBe(true);
  });
});
