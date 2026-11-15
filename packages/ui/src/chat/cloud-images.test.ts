import {
  ChatImagesMissing,
  MemoryCloudLinks,
  memoryChatImages,
  memoryChats,
  type AccountAccess,
  type ChatImageRef,
  type ChatSyncAccess,
  type SavedChat,
} from "@animaquill/host";
import { describe, expect, test } from "vitest";
import { CloudChats, HELD_RETRY_MS, IMAGES_PER_CHAT } from "./cloud-chats.ts";

/**
 * The pictures of conversations of projects of the platform (cloud-chats.ts, and me/chat-images.ts
 * of AnimaQuill Cloud): each goes to the account before the conversation that has it; those that
 * cannot go stay here and say why (`held`); the account's come here as they are read.
 */

const PLATFORM = "https://app.example";

const account: AccountAccess = {
  subscribe: () => () => {},
  getSnapshot: () => ({ status: "signedIn", id: "u1", name: "u1", appInstalled: true }),
  refresh: async () => {},
  takeOutcome: () => undefined,
  signIn: () => {},
  installApp: () => {},
  signOut: async () => {},
};

/** The platform: conversations, and pictures within `room` bytes, as the API checks them. */
function platformOf(room = Infinity) {
  const chats = new Map<string, { revision: number; chat: SavedChat }>();
  const pictures = new Map<string, Blob>();
  const puts: string[] = [];
  const state = { room, down: false };
  const used = () => [...pictures.values()].reduce((sum, blob) => sum + blob.size, 0);
  const access: ChatSyncAccess = {
    list: async () => ({ chats: [], epoch: 0 }),
    load: async (project, id) => chats.get(`${project}/${id}`),
    save: async (project, chat, base) => {
      const there = chats.get(`${project}/${chat.id}`);
      const missing: string[] = [];
      for (const entry of chat.entries as { images?: ChatImageRef[] }[])
        for (const image of entry.images ?? [])
          if (image.held === undefined && !pictures.has(image.image))
            missing.push(image.image.slice("sha256:".length));
      if (missing.length > 0) throw new ChatImagesMissing(missing);
      const revision = (there?.revision ?? 0) + 1;
      const { synced: _synced, syncedAt: _syncedAt, ...rest } = chat;
      chats.set(`${project}/${chat.id}`, { revision, chat: structuredClone(rest) });
      expect(base).toBe(there?.revision ?? null);
      return revision;
    },
    remove: async (project, id) => void chats.delete(`${project}/${id}`),
    putImage: async (ref, blob) => {
      if (state.down) throw new Error("unreachable");
      puts.push(ref.image);
      if (pictures.has(ref.image)) return "stored";
      if (used() + blob.size > state.room) return "full";
      pictures.set(ref.image, blob);
      return "stored";
    },
    getImage: async (ref) => pictures.get(ref.image),
  };
  return { chats, pictures, puts, state, access };
}

async function deviceOf(platform: ReturnType<typeof platformOf>, now = () => 0) {
  const links = new MemoryCloudLinks();
  await links.put({
    key: "local-1",
    platform: PLATFORM,
    project: "p1",
    seq: 0,
    pushed: 0,
    linkedAt: 0,
    owner: "u1",
  });
  const local = memoryChats();
  const images = memoryChatImages();
  const chats = new CloudChats({
    local,
    remote: platform.access,
    account,
    links,
    platform: PLATFORM,
    images,
    now,
  });
  return { local, images, chats };
}

const picture = async (
  device: Awaited<ReturnType<typeof deviceOf>>,
  bytes: number,
  seed: number,
) => {
  const data = new Uint8Array(bytes).fill(seed);
  data[0] = seed >> 8;
  return device.images.save(new Blob([data], { type: "image/jpeg" }), { width: 4, height: 3 });
};

const chatWith = (id: string, images: readonly ChatImageRef[], updatedAt = 1): SavedChat => ({
  id,
  project: "local-1",
  title: id,
  updatedAt,
  entries: [
    {
      role: "user",
      text: "看这张",
      images: images.map((image) => ({ ...image, note: "[image]" })),
      at: 1,
      task: "t1",
    },
  ],
});

const sentImages = (platform: ReturnType<typeof platformOf>, id: string) =>
  (platform.chats.get(`p1/${id}`)!.chat.entries[0] as { images: ChatImageRef[] }).images;

describe("pictures of conversations of the platform", () => {
  test("go before the conversation, each once; the conversation only names them", async () => {
    const platform = platformOf();
    const device = await deviceOf(platform);
    const one = await picture(device, 100, 1);
    await device.chats.save(chatWith("c1", [one, one]));
    await device.chats.save(chatWith("c2", [one], 2));
    expect([...platform.pictures.keys()]).toEqual([one.image]);
    // Known to be there: not put again.
    expect(platform.puts).toEqual([one.image]);
    expect(sentImages(platform, "c1").every((image) => image.held === undefined)).toBe(true);
    expect(JSON.stringify(platform.chats.get("p1/c1"))).not.toContain("blob:");
  });

  test("no room: the picture stays here, the conversation goes and says so, and it is tried again later", async () => {
    let time = 0;
    const platform = platformOf(150);
    const device = await deviceOf(platform, () => time);
    const one = await picture(device, 100, 1);
    const two = await picture(device, 100, 2);
    await device.chats.save(chatWith("c1", [one, two]));
    expect(sentImages(platform, "c1").map((image) => image.held)).toEqual([undefined, "full"]);
    expect(device.chats.heldOf(two.image)).toBe("full");
    // Not every turn asks again.
    platform.state.room = Infinity;
    await device.chats.save(chatWith("c1", [one, two], 2));
    expect(sentImages(platform, "c1")[1]?.held).toBe("full");
    time += HELD_RETRY_MS;
    await device.chats.save(chatWith("c1", [one, two], 3));
    expect(sentImages(platform, "c1")[1]?.held).toBeUndefined();
    expect(device.chats.heldOf(two.image)).toBeUndefined();
    expect(platform.pictures.has(two.image)).toBe(true);
  });

  test("the platform could not be reached for a picture: the conversation goes all the same", async () => {
    const platform = platformOf();
    const device = await deviceOf(platform);
    const one = await picture(device, 100, 1);
    platform.state.down = true;
    await device.chats.save(chatWith("c1", [one]));
    expect(sentImages(platform, "c1")[0]?.held).toBe("unavailable");
  });

  test("more than a conversation may have there: the later ones stay here", async () => {
    const platform = platformOf();
    const device = await deviceOf(platform);
    const all = [];
    for (let i = 0; i <= IMAGES_PER_CHAT; i += 1) all.push(await picture(device, 10, i + 1));
    await device.chats.save(chatWith("c1", all));
    const sent = sentImages(platform, "c1");
    expect(sent.filter((image) => image.held === undefined)).toHaveLength(IMAGES_PER_CHAT);
    expect(sent.at(-1)?.held).toBe("many");
  });

  test("the account lost one since: put again, and written once more", async () => {
    const platform = platformOf();
    const device = await deviceOf(platform);
    const one = await picture(device, 100, 1);
    await device.chats.save(chatWith("c1", [one]));
    // The hourly round took it, as nothing referred to it for a day.
    platform.pictures.clear();
    await device.chats.save(chatWith("c2", [one], 2));
    expect(platform.pictures.has(one.image)).toBe(true);
    expect(sentImages(platform, "c2")[0]?.held).toBeUndefined();
  });

  test("another device: reads the account's pictures as they are shown, keeps what it says of those that stayed elsewhere", async () => {
    const platform = platformOf(150);
    const first = await deviceOf(platform);
    const one = await picture(first, 100, 1);
    const two = await picture(first, 100, 2);
    await first.chats.save(chatWith("c1", [one, two]));
    const second = await deviceOf(platform);
    const pictures = second.chats.pictures(second.images);
    expect(await second.images.read(one.image)).toBeUndefined();
    const read = await pictures.read(one.image);
    expect(read?.size).toBe(100);
    // Kept here from then on.
    expect(await second.images.read(one.image)).toBeDefined();
    expect(await pictures.read(two.image)).toBeUndefined();
    // Going on with the conversation there: the one it does not have still says it stayed.
    const theirs = await second.chats.load("local-1", "c1");
    await second.chats.save({ ...theirs!, title: "接着聊", updatedAt: 5 });
    expect(sentImages(platform, "c1").map((image) => image.held)).toEqual([undefined, "full"]);
  });
});
