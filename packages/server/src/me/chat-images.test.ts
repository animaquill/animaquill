import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newProject, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { TEST_S3, testStorageConfig } from "../test/objects.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { LibraryStorage } from "../library/storage.ts";
import { userChatImageRefs, userChatImages, users } from "../schema.ts";
import { changeSetting } from "../settings.ts";
import { SyncHub } from "../sync/hub.ts";
import { CHATS_PER_PROJECT } from "./chats.ts";
import {
  CHAT_IMAGES_PREFIX,
  CHAT_IMAGES_SETTING,
  ChatImages,
  IMAGES_PER_CHAT,
  imageKey,
  UNREFERENCED_KEEP_MS,
} from "./chat-images.ts";

/**
 * The pictures of conversations on the platform (me/chat-images.ts): straight into a real object
 * storage and checked once there, read by their person only, within the room people have, and taken
 * away with what refers to them. Needs AQ_TEST_DATABASE and AQ_TEST_S3, see vitest.config.ts.
 */

describe.skipIf(!TEST_DATABASE || !TEST_S3)(
  "pictures of conversations, on a database and a storage",
  () => {
    let t: TestDatabase;
    let w: World;
    let p: Platform;
    let hub: SyncHub;
    let time: number;
    let storage: LibraryStorage;
    let images: ChatImages;
    /** What was left to settle once the addresses to put pictures expired, see `later`. */
    let later: { userId: string; hash?: string }[];
    const imagesWith = (checksum: "sha256" | "none") =>
      new ChatImages({
        db: t.db,
        storage,
        mode: () => "on",
        checksum,
        minFreeBytes: 0,
        now: () => time,
        log: quiet,
        later: async (job) => void later.push(job),
      });
    beforeAll(async () => {
      t = await createTestDatabase();
    });
    afterAll(async () => {
      await t?.drop();
    });
    beforeEach(async () => {
      // The round goes over everyone's: each test starts with nobody's.
      await t.db.delete(userChatImageRefs);
      await t.db.delete(userChatImages);
      storage = new LibraryStorage(testStorageConfig());
      await storage.internal.createBucket();
      w = await world(t.db);
      hub = new SyncHub({ db: t.db, log: quiet });
      time = 1_800_000_000_000;
      later = [];
      images = imagesWith("sha256");
      p = await platform(w, { hub, now: () => time, chatImages: images });
    });
    afterEach(() => hub.stop());

    const picture = (size = 2000) => {
      const bytes = randomBytes(size);
      return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
    };
    const post = (url: string, body?: unknown, q = p) =>
      q.send(
        "POST",
        url,
        body === undefined
          ? {}
          : {
              payload: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            },
      );
    /** Puts a picture as the editor does: begin, up to the storage, done. */
    const upload = async (image: { bytes: Buffer; hash: string }, q = p, sent = image.bytes) => {
      const begun = await post(
        "/api/me/chat-images",
        { hash: image.hash, bytes: image.bytes.length, type: "image/jpeg" },
        q,
      );
      if (begun.status !== 200 || begun.json.have) return { begun };
      const { url, headers } = begun.json.upload;
      const put = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "content-type": "image/jpeg" },
        body: sent,
      });
      const done = await post(`/api/me/chat-images/${image.hash}/done`, undefined, q);
      return { begun, put, done };
    };
    const chat = (id: string, hashes: readonly string[], held: readonly string[] = []) => ({
      id,
      title: id,
      updatedAt: time,
      entries: [
        {
          role: "user",
          text: "看这张",
          images: [
            ...hashes.map((hash) => ({
              image: `sha256:${hash}`,
              type: "image/jpeg",
            })),
            ...held.map((hash) => ({
              image: `sha256:${hash}`,
              type: "image/jpeg",
              held: "full",
            })),
          ],
        },
      ],
    });
    const putChat = (project: string, body: { base: number | null; chat: { id: string } }, q = p) =>
      q.send("PUT", `/api/me/chats/${project}/${body.chat.id}`, {
        payload: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
    const objectsOf = async (userId: string) =>
      (
        await storage.internal.listObjects({
          prefix: `${CHAT_IMAGES_PREFIX}${userId}/`,
        })
      ).objects.map((object) => object.key);

    test("goes up, is checked, is referred to, and read back by its person", async () => {
      const image = picture();
      const { begun, put, done } = await upload(image);
      expect(begun.status).toBe(200);
      expect(put?.status).toBe(200);
      expect(done?.json).toEqual({ state: "ready" });
      // The address says how long it works.
      expect(new URL(begun.json.upload.url).searchParams.get("X-Amz-Expires")).toBe("600");
      const project = await newProject(w);
      expect(
        (
          await putChat(project.id, {
            base: null,
            chat: chat("c1", [image.hash]),
          })
        ).status,
      ).toBe(200);
      expect(await t.db.select().from(userChatImageRefs)).toEqual([
        {
          userId: w.userId,
          projectId: project.id,
          chatId: "c1",
          hash: image.hash,
        },
      ]);
      const read = await p.send("GET", `/api/me/chat-images/${image.hash}`);
      expect(read.status).toBe(200);
      expect(read.json.type).toBe("image/jpeg");
      expect(new URL(read.json.url).searchParams.get("X-Amz-Expires")).toBe("300");
      const got = Buffer.from(await (await fetch(read.json.url)).arrayBuffer());
      expect(got.equals(image.bytes)).toBe(true);
      // Room taken, by conversation.
      const usage = await p.send("GET", "/api/me/chat-images");
      expect(usage.json).toMatchObject({
        used: image.bytes.length,
        limit: 500 * 1024 ** 2,
        chats: [
          {
            project: project.id,
            chat: "c1",
            title: "c1",
            images: 1,
            bytes: image.bytes.length,
          },
        ],
      });
    });

    test("what is not what was said goes at once", async () => {
      // Without the checksum signed in, the storage takes anything of the size: the platform checks.
      images = imagesWith("none");
      p = await platform(w, { hub, now: () => time, chatImages: images });
      const image = picture();
      const other = randomBytes(image.bytes.length);
      const { put, done } = await upload(image, p, other);
      expect(put?.status).toBe(200);
      expect(done?.status).toBe(422);
      expect(done?.json).toEqual({ error: "mismatch" });
      expect(await objectsOf(w.userId)).toEqual([]);
      expect(await t.db.select().from(userChatImages)).toEqual([]);
      // With it signed in, the storage itself refuses.
      images = imagesWith("sha256");
      p = await platform(w, { hub, now: () => time, chatImages: images });
      const refused = await upload(image, p, other);
      expect(refused.put?.status).toBeGreaterThanOrEqual(400);
      expect(refused.done?.json).toEqual({ error: "notUploaded" });
      // Larger than it said: the signed length refuses it.
      const longer = await upload(image, p, Buffer.concat([image.bytes, Buffer.from("x")]));
      expect(longer.put?.ok ?? false).toBe(false);
    });

    test("the room of a person, one picture and a conversation at most", async () => {
      await changeSetting(t.db, CHAT_IMAGES_SETTING, { perUserMb: 1 }, { adminId: null });
      const first = picture(600 * 1024);
      expect((await upload(first)).done?.json).toEqual({ state: "ready" });
      const second = picture(600 * 1024);
      const full = await upload(second);
      expect(full.begun.status).toBe(413);
      expect(full.begun.json).toEqual({
        error: "full",
        used: 600 * 1024,
        limit: 1024 ** 2,
      });
      expect(await objectsOf(w.userId)).toEqual([imageKey(w.userId, first.hash)]);
      // Larger than 2 MB: never.
      const large = await post("/api/me/chat-images", {
        hash: second.hash,
        bytes: 2 * 1024 ** 2 + 1,
        type: "image/jpeg",
      });
      expect(large.status).toBe(413);
      expect(large.json).toEqual({ error: "tooLarge" });
      expect(
        (
          await post("/api/me/chat-images", {
            hash: second.hash,
            bytes: 10,
            type: "text/html",
          })
        ).status,
      ).toBe(400);
      // A conversation names what the platform does not have: it is told which; one that stayed on
      // its device (`held`) it may name.
      const project = await newProject(w);
      const missing = await putChat(project.id, {
        base: null,
        chat: chat("c1", [first.hash, second.hash]),
      });
      expect(missing.status).toBe(409);
      expect(missing.json).toEqual({
        error: "missingImages",
        images: [second.hash],
      });
      const held = await putChat(project.id, {
        base: null,
        chat: chat("c1", [first.hash], [second.hash]),
      });
      expect(held.status).toBe(200);
      // More than 100 in one conversation.
      const many = Array.from({ length: IMAGES_PER_CHAT + 1 }, () => picture(10).hash);
      const tooMany = await putChat(project.id, {
        base: 1,
        chat: chat("c1", many),
      });
      expect(tooMany.status).toBe(413);
      expect(tooMany.json).toEqual({ error: "tooManyImages" });
    });

    test("another's picture cannot be read, nor its address had", async () => {
      const image = picture();
      await upload(image);
      const someone = await world(t.db);
      const q = await platform(someone, {
        hub,
        now: () => time,
        chatImages: images,
      });
      expect((await q.send("GET", `/api/me/chat-images/${image.hash}`)).status).toBe(404);
      // Nor is it theirs to refer to, or to finish.
      const project = await newProject(someone);
      const theirs = await putChat(project.id, { base: null, chat: chat("c1", [image.hash]) }, q);
      expect(theirs.json).toEqual({
        error: "missingImages",
        images: [image.hash],
      });
      expect((await post(`/api/me/chat-images/${image.hash}/done`, undefined, q)).status).toBe(404);
      // Theirs of the same bytes is theirs, under their prefix.
      expect((await upload(image, q)).done?.json).toEqual({ state: "ready" });
      expect(await objectsOf(someone.userId)).toEqual([imageKey(someone.userId, image.hash)]);
      // Signed out: nothing.
      expect(
        (
          await p.send("GET", `/api/me/chat-images/${image.hash}`, {
            signedIn: false,
          })
        ).status,
      ).toBe(401);
    });

    test("the same picture is kept once", async () => {
      const image = picture();
      await upload(image);
      const again = await upload(image);
      expect(again.begun.json).toEqual({ have: true });
      const project = await newProject(w);
      await putChat(project.id, { base: null, chat: chat("c1", [image.hash]) });
      await putChat(project.id, {
        base: null,
        chat: chat("c2", [image.hash, image.hash]),
      });
      expect(await objectsOf(w.userId)).toHaveLength(1);
      expect(await t.db.select().from(userChatImages)).toHaveLength(1);
      expect(await t.db.select().from(userChatImageRefs)).toHaveLength(2);
    });

    test("a conversation taken away: its pictures go 24 hours later, not before", async () => {
      const kept = picture();
      const gone = picture();
      await upload(kept);
      await upload(gone);
      const project = await newProject(w);
      await putChat(project.id, { base: null, chat: chat("c1", [kept.hash]) });
      await putChat(project.id, { base: null, chat: chat("c2", [gone.hash]) });
      time += 2 * UNREFERENCED_KEEP_MS;
      // Referred to: stays however old.
      expect(await images.cleanUp()).toEqual({ expired: 0, leftOver: 0 });
      expect((await p.send("DELETE", `/api/me/chats/${project.id}/c2`)).status).toBe(204);
      time += UNREFERENCED_KEEP_MS - 60_000;
      expect(await images.cleanUp()).toEqual({ expired: 0, leftOver: 0 });
      expect(await objectsOf(w.userId)).toHaveLength(2);
      time += 120_000;
      expect(await images.cleanUp()).toEqual({ expired: 1, leftOver: 0 });
      expect(await objectsOf(w.userId)).toEqual([imageKey(w.userId, kept.hash)]);
      expect((await p.send("GET", `/api/me/chat-images/${gone.hash}`)).status).toBe(404);
      // One that never finished going up goes too.
      const never = picture();
      await post("/api/me/chat-images", {
        hash: never.hash,
        bytes: never.bytes.length,
        type: "image/jpeg",
      });
      time += UNREFERENCED_KEEP_MS + 60_000;
      expect((await images.cleanUp()).expired).toBe(1);
      // Taken out of a conversation that is written again: the same.
      await putChat(project.id, { base: 1, chat: chat("c1", []) });
      time += UNREFERENCED_KEEP_MS + 60_000;
      expect((await images.cleanUp()).expired).toBe(1);
      expect(await objectsOf(w.userId)).toEqual([]);
      expect(await t.db.select().from(userChatImages)).toEqual([]);
    });

    test("a conversation pushed out of the 50 of a project: its pictures go with the round", async () => {
      const image = picture();
      await upload(image);
      const project = await newProject(w);
      await putChat(project.id, { base: null, chat: chat("c0", [image.hash]) });
      for (let i = 1; i <= CHATS_PER_PROJECT; i += 1) {
        time += 1000;
        expect((await putChat(project.id, { base: null, chat: chat(`c${i}`, []) })).status).toBe(
          200,
        );
      }
      expect(await t.db.select().from(userChatImageRefs)).toEqual([]);
      time += UNREFERENCED_KEEP_MS + 60_000;
      expect((await images.cleanUp()).expired).toBe(1);
      expect(await objectsOf(w.userId)).toEqual([]);
    });

    test("the project taken away: its conversations' pictures go with the round", async () => {
      const image = picture();
      await upload(image);
      const project = await newProject(w);
      await putChat(project.id, { base: null, chat: chat("c1", [image.hash]) });
      expect((await p.send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
      expect(await t.db.select().from(userChatImageRefs)).toEqual([]);
      time += UNREFERENCED_KEEP_MS + 60_000;
      expect((await images.cleanUp()).expired).toBe(1);
      expect(await objectsOf(w.userId)).toEqual([]);
    });

    test("what the storage has with no row goes with the round, as of an account that is gone", async () => {
      const image = picture();
      await upload(image);
      // Left behind, as by a turning off while the storage could not be reached.
      await storage.internal.putObject(imageKey(w.userId, picture().hash), "left");
      expect((await images.cleanUp()).leftOver).toBe(1);
      expect(await objectsOf(w.userId)).toEqual([imageKey(w.userId, image.hash)]);
      // The account goes: its rows with it, its objects with the round.
      await t.db.delete(users).where(eq(users.id, w.userId));
      expect((await images.cleanUp()).leftOver).toBe(1);
      expect(await objectsOf(w.userId)).toEqual([]);
    });

    test("asked again for one begun before: its size is what counts now, within the room", async () => {
      // Review S-C2, 1: begun at 1 byte each, then said to be 1.5 MB, took no room at all.
      await changeSetting(t.db, CHAT_IMAGES_SETTING, { perUserMb: 1 }, { adminId: null });
      const hashes = [picture(), picture(), picture()].map((each) => each.hash);
      for (const hash of hashes)
        expect(
          (
            await post("/api/me/chat-images", {
              hash,
              bytes: 1,
              type: "image/jpeg",
            })
          ).status,
        ).toBe(200);
      for (const hash of hashes) {
        const again = await post("/api/me/chat-images", {
          hash,
          bytes: 1536 * 1024,
          type: "image/jpeg",
        });
        expect(again.status).toBe(413);
        expect(again.json).toEqual({
          error: "full",
          used: 2,
          limit: 1024 ** 2,
        });
      }
      // Within the room: taken, and that is what done checks.
      const fits = picture(600 * 1024);
      await post("/api/me/chat-images", {
        hash: fits.hash,
        bytes: 1,
        type: "image/jpeg",
      });
      expect((await upload(fits)).done?.json).toEqual({ state: "ready" });
      const [row] = await t.db
        .select()
        .from(userChatImages)
        .where(eq(userChatImages.hash, fits.hash));
      expect(row?.bytes).toBe(600 * 1024);
    });

    test("one taken away while an address to put it still works: it goes again once that expired", async () => {
      // Review S-C2, 2: without the checksum signed in, the address puts anything of its size.
      images = imagesWith("none");
      p = await platform(w, { hub, now: () => time, chatImages: images });
      const image = picture();
      const begun = await post("/api/me/chat-images", {
        hash: image.hash,
        bytes: image.bytes.length,
        type: "image/jpeg",
      });
      const { url } = begun.json.upload;
      const junk = randomBytes(image.bytes.length);
      await fetch(url, { method: "PUT", body: junk });
      expect((await post(`/api/me/chat-images/${image.hash}/done`)).status).toBe(422);
      expect(await objectsOf(w.userId)).toEqual([]);
      expect(later).toEqual([{ userId: w.userId, hash: image.hash }]);
      // Put again at the same address: nothing on the platform says it is there.
      expect((await fetch(url, { method: "PUT", body: junk })).status).toBe(200);
      expect(await objectsOf(w.userId)).toHaveLength(1);
      expect(await images.settle(w.userId, image.hash)).toBe(1);
      expect(await objectsOf(w.userId)).toEqual([]);
      // Put again properly meanwhile: it stays.
      expect((await upload(image)).done?.json).toEqual({ state: "ready" });
      expect(await images.settle(w.userId, image.hash)).toBe(0);
      expect(await objectsOf(w.userId)).toHaveLength(1);
    });

    test("what the room takes is all the platform keeps, until the round takes it away", async () => {
      // Review S-C2, 3.
      const image = picture();
      await upload(image);
      const project = await newProject(w);
      await putChat(project.id, { base: null, chat: chat("c1", [image.hash]) });
      time += 3 * UNREFERENCED_KEEP_MS;
      expect((await p.send("DELETE", `/api/me/chats/${project.id}/c1`)).status).toBe(204);
      expect((await p.send("GET", "/api/me/chat-images")).json.used).toBe(image.bytes.length);
      time += UNREFERENCED_KEEP_MS + 60_000;
      await images.cleanUp();
      expect((await p.send("GET", "/api/me/chat-images")).json.used).toBe(0);
    });

    test("begun again late: the round does not take it while it goes up", async () => {
      // Review S-C2, 4.
      const image = picture();
      const start = () =>
        post("/api/me/chat-images", {
          hash: image.hash,
          bytes: image.bytes.length,
          type: "image/jpeg",
        });
      await start();
      time += UNREFERENCED_KEEP_MS - 3_600_000;
      const again = await start();
      time += 2 * 3_600_000;
      expect((await images.cleanUp()).expired).toBe(0);
      const { url, headers } = again.json.upload;
      expect((await fetch(url, { method: "PUT", headers, body: image.bytes })).status).toBe(200);
      expect((await post(`/api/me/chat-images/${image.hash}/done`)).json).toEqual({
        state: "ready",
      });
    });

    test("saying a picture stayed on its device does not refer to more than 100", async () => {
      // Review S-C2, 5: one said to have stayed, which the platform has, was referred to all the same.
      const all = Array.from({ length: IMAGES_PER_CHAT + 1 }, () => picture(10));
      for (const each of all) await upload(each);
      const project = await newProject(w);
      const hashes = all.map((each) => each.hash);
      const fine = await putChat(project.id, {
        base: null,
        chat: chat("c1", hashes.slice(0, IMAGES_PER_CHAT), hashes.slice(IMAGES_PER_CHAT)),
      });
      expect(fine.status).toBe(200);
      expect(await t.db.select().from(userChatImageRefs)).toHaveLength(IMAGES_PER_CHAT);
      const tooMany = await putChat(project.id, {
        base: 1,
        chat: chat("c1", hashes),
      });
      expect(tooMany.json).toEqual({ error: "tooManyImages" });
    });
  },
);
