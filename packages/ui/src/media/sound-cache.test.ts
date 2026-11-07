import { describe, expect, it, vi } from "vitest";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { cleanSoundCache } from "./sound-cache.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const RULES = { maxAgeMs: 7 * DAY, maxBytes: 1000 };

const bytes = (count: number) => new Blob([new Uint8Array(count)]);

async function setup() {
  const projects = new MemoryLibrary();
  const media = projects.media("p");
  /** Puts a file in as if it were last used so many days ago. */
  const put = async (name: string, size: number, daysAgo: number) => {
    projects.now = () => NOW - daysAgo * DAY;
    await media.put(name, bytes(size));
  };
  const names = async () =>
    [...projects.files.keys()].map((key) => key.replace(/^p\//, "")).toSorted();
  return { projects, media, put, names };
}

describe("cleaning up sounds", () => {
  it("takes what nobody needs once it was not used for a while", async () => {
    const { media, put, names } = await setup();
    await put("sound-1:old", 10, 8);
    await put("peaks-1:sound-1:old", 1, 8);
    await put("sound-1:recent", 10, 1);
    const removed = await cleanSoundCache(media, () => false, NOW, RULES);
    expect(removed.toSorted()).toEqual(["peaks-1:sound-1:old", "sound-1:old"]);
    expect(await names()).toEqual(["sound-1:recent"]);
  });

  it("keeps what the project plays, and its waveform, however old", async () => {
    const { media, put, names } = await setup();
    await put("sound-1:kept", 10, 300);
    await put("peaks-1:sound-1:kept", 1, 300);
    await cleanSoundCache(media, (name) => name === "sound-1:kept", NOW, RULES);
    expect(await names()).toEqual(["peaks-1:sound-1:kept", "sound-1:kept"]);
  });

  it("takes the least recently used first when there is too much, until it fits", async () => {
    const { media, put, names } = await setup();
    await put("sound-1:a", 400, 3);
    await put("sound-1:b", 400, 2);
    await put("sound-1:c", 400, 1);
    await cleanSoundCache(media, () => false, NOW, RULES);
    expect(await names()).toEqual(["sound-1:b", "sound-1:c"]);
  });

  it("counts what is needed towards the limit, without ever taking it", async () => {
    const { media, put, names } = await setup();
    await put("sound-1:needed", 2000, 1);
    await put("sound-1:spare", 10, 0);
    await cleanSoundCache(media, (name) => name === "sound-1:needed", NOW, RULES);
    expect(await names()).toEqual(["sound-1:needed"]);
  });

  it("never takes what people brought in, however old and large", async () => {
    const { media, put, names } = await setup();
    await put("sha256-abc=", 5000, 300);
    await put("peaks-1:sha256-abc=", 10, 300);
    await put("sound-1:spare", 10, 300);
    const remove = vi.spyOn(media, "removeMade");
    await cleanSoundCache(media, () => false, NOW, RULES);
    expect(await names()).toEqual(["peaks-1:sha256-abc=", "sha256-abc="]);
    expect(remove.mock.calls.map(([name]) => name)).toEqual(["sound-1:spare"]);
  });

  it("never takes what an asset is called, even when that looks like a sound", async () => {
    const { media, put, names } = await setup();
    await put("sound-1:asset", 5000, 300);
    await cleanSoundCache(media, (name) => name === "sound-1:asset", NOW, RULES);
    expect(await names()).toEqual(["sound-1:asset"]);
  });

  it("goes on when one cannot be removed, and leaves that for next time", async () => {
    const { projects, media, put, names } = await setup();
    await put("sound-1:stuck", 10, 30);
    await put("sound-1:loose", 10, 30);
    projects.failingToRemove.add("sound-1:stuck");
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    const removed = await cleanSoundCache(media, () => false, NOW, RULES);
    expect(removed).toEqual(["sound-1:loose"]);
    expect(await names()).toEqual(["sound-1:stuck"]);
  });

  it("does not trust the listing to have only made files", async () => {
    const { media } = await setup();
    const remove = vi.fn(async () => {});
    const lying = {
      ...media,
      listMade: async () => [{ name: "sha256-abc=", size: 5000, usedAt: 0 }],
      removeMade: remove,
    };
    await cleanSoundCache(lying, () => false, NOW, RULES);
    expect(remove).not.toHaveBeenCalled();
  });
});
