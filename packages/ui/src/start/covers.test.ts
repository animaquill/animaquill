import type { ProjectCover } from "@animaquill/host";
import { memoryCoverStore } from "@animaquill/host/browser";
import { describe, expect, it, vi } from "vitest";
import type { ProjectCard } from "./cards.ts";
import { StartCovers, type PictureUrls } from "./covers.ts";

const card = (id: string, more: Partial<ProjectCard> = {}): ProjectCard => ({
  id,
  kind: "local",
  name: id,
  key: id,
  project: undefined,
  marksKey: id,
  openedAt: 1,
  updatedAt: 1,
  starred: false,
  group: undefined,
  owner: undefined,
  durationMs: undefined,
  cover: undefined,
  source: { kind: "browser", summary: { id, name: id, updatedAt: 1 }, known: true },
  ...more,
});

/** One of the platform that this browser never opened. */
const remote = (project: string, etag: string, at = 10, durationMs = 6000) =>
  card(`cloud:${project}`, {
    kind: "cloudRemote",
    key: undefined,
    project,
    cover: { etag, at },
    durationMs,
  });

const picture = (text: string) => new Blob([text], { type: "image/webp" });
const cover = (etag: string, at: number, durationMs?: number): ProjectCover => ({
  picture: picture(etag),
  at,
  etag,
  ...(durationMs !== undefined && { durationMs }),
});

/** Addresses that say which picture they are of. */
function urls(): PictureUrls & { readonly live: Set<string> } {
  const live = new Set<string>();
  let count = 0;
  return {
    live,
    create: (blob) => {
      const url = `blob:${++count}:${(blob as Blob & { label?: string }).size}`;
      live.add(url);
      return url;
    },
    revoke: (url) => void live.delete(url),
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

describe("the covers of the start page", () => {
  it("shows what this browser keeps, with its length", async () => {
    const covers = memoryCoverStore();
    await covers.put("folder-1", cover("a", 5, 42_000));
    const start = new StartCovers({ covers, urls: urls() });
    start.show([card("folder-1"), card("folder-2")]);
    await settle();
    expect(start.getSnapshot().get("folder-1")).toEqual({
      url: expect.stringMatching(/^blob:/),
      durationMs: 42_000,
      chosen: false,
    });
    expect(start.getSnapshot().get("folder-2")).toEqual({
      url: undefined,
      durationMs: undefined,
      chosen: false,
    });
  });

  it("fetches one of the platform once for each etag, and keeps it for the next time", async () => {
    const covers = memoryCoverStore();
    const cloud = { get: vi.fn(async (project: string) => picture(project)) };
    const first = new StartCovers({ covers, cloud, urls: urls() });
    first.show([remote("p_1", "e1")]);
    await settle();
    first.show([remote("p_1", "e1")]);
    await settle();
    expect(cloud.get).toHaveBeenCalledTimes(1);
    expect(first.getSnapshot().get("cloud:p_1")?.url).toMatch(/^blob:/);
    expect(first.getSnapshot().get("cloud:p_1")?.durationMs).toBe(6000);
    expect((await covers.read(["cloud:p_1"])).get("cloud:p_1")?.etag).toBe("e1");
    // Another page of the browser: the etag did not change, nothing is fetched.
    const later = new StartCovers({ covers, cloud, urls: urls() });
    later.show([remote("p_1", "e1")]);
    await settle();
    expect(cloud.get).toHaveBeenCalledTimes(1);
    expect(later.getSnapshot().get("cloud:p_1")?.url).toMatch(/^blob:/);
    // A new one on the platform is fetched.
    later.show([remote("p_1", "e2", 20)]);
    await settle();
    expect(cloud.get).toHaveBeenCalledTimes(2);
  });

  it("takes the platform's only where it is another one, and newer", async () => {
    const covers = memoryCoverStore();
    await covers.put("here", cover("mine", 50));
    const cloud = { get: vi.fn(async () => picture("theirs")) };
    const start = new StartCovers({ covers, cloud, urls: urls() });
    const linked = (etag: string, at: number) =>
      card("here", { kind: "cloudHere", project: "p_1", cover: { etag, at }, durationMs: 1000 });
    // What this browser sent itself, and an older one.
    start.show([linked("mine", 60)]);
    await settle();
    start.show([linked("older", 40)]);
    await settle();
    expect(cloud.get).not.toHaveBeenCalled();
    // Made on another computer since.
    start.show([linked("theirs", 70)]);
    await settle();
    expect(cloud.get).toHaveBeenCalledTimes(1);
    expect(start.getSnapshot().get("here")?.durationMs).toBe(1000);
  });

  it("fetches a few at a time, in the order of the cards", async () => {
    const asked: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cloud = {
      get: vi.fn(async (project: string) => {
        asked.push(project);
        await gate;
        return picture(project);
      }),
    };
    const start = new StartCovers({ cloud, urls: urls(), parallel: 2 });
    start.show([remote("p_1", "a"), remote("p_2", "b"), remote("p_3", "c")]);
    await settle();
    expect(asked).toEqual(["p_1", "p_2"]);
    release();
    await settle();
    expect(asked).toEqual(["p_1", "p_2", "p_3"]);
  });

  it("fetches only for the cards people can see, and the others once they come into view", async () => {
    const cloud = { get: vi.fn(async (project: string) => picture(project)) };
    const start = new StartCovers({ cloud, urls: urls() });
    const many = Array.from({ length: 200 }, (_, index) => remote(`p_${index}`, `e${index}`));
    start.show(many, { onlySeen: true });
    start.seen("cloud:p_0", true);
    start.seen("cloud:p_1", true);
    await settle();
    expect(cloud.get.mock.calls.map(([project]) => project)).toEqual(["p_0", "p_1"]);
    // Scrolled further down.
    start.seen("cloud:p_150", true);
    await settle();
    expect(cloud.get).toHaveBeenCalledTimes(3);
    expect(cloud.get).toHaveBeenLastCalledWith("p_150");
  });

  it("asks once for one the platform has not, and lets go of addresses no card shows", async () => {
    const addresses = urls();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cloud = { get: vi.fn(async () => undefined) };
    const start = new StartCovers({ cloud, urls: addresses });
    start.show([remote("p_1", "a")]);
    await settle();
    start.show([remote("p_1", "a")]);
    await settle();
    expect(cloud.get).toHaveBeenCalledTimes(1);
    expect(start.getSnapshot().get("cloud:p_1")).toEqual({
      url: undefined,
      durationMs: 6000,
      chosen: false,
    });
    const covers = memoryCoverStore();
    await covers.put("folder-1", cover("a", 1));
    const kept = new StartCovers({ covers, urls: addresses });
    kept.show([card("folder-1")]);
    await settle();
    expect(addresses.live.size).toBe(1);
    kept.show([]);
    expect(addresses.live.size).toBe(0);
    warn.mockRestore();
  });

  it("follows a cover made in a window, as people leave a project", async () => {
    const covers = memoryCoverStore();
    const start = new StartCovers({ covers, urls: urls() });
    start.show([card("folder-1")]);
    await settle();
    expect(start.getSnapshot().get("folder-1")?.url).toBeUndefined();
    await covers.put("folder-1", cover("a", 1, 3000));
    await settle();
    expect(start.getSnapshot().get("folder-1")).toMatchObject({ durationMs: 3000 });
    expect(start.getSnapshot().get("folder-1")?.url).toMatch(/^blob:/);
  });

  it("puts one people chose before what the editor made, on whichever computer", async () => {
    const covers = memoryCoverStore();
    const cloud = { get: vi.fn(async () => picture("chosen elsewhere")) };
    // The editor made one here later than people chose one on another computer.
    await covers.put("here", cover("made", 90));
    const start = new StartCovers({ covers, cloud, urls: urls() });
    const linked = (listed: ProjectCard["cover"]) =>
      card("here", { kind: "cloudHere", project: "p_1", cover: listed });
    start.show([linked({ etag: "theirs", at: 50, chosen: true })]);
    await settle();
    expect(cloud.get).toHaveBeenCalledTimes(1);
    expect(start.getSnapshot().get("here")?.chosen).toBe(true);
    // One chosen here that the platform did not get yet comes before what it has.
    await covers.put("here", { ...cover("mine", 10), chosen: true });
    await settle();
    start.show([linked({ etag: "made", at: 95 })]);
    await settle();
    expect(start.getSnapshot().get("here")?.chosen).toBe(true);
    expect(cloud.get).toHaveBeenCalledTimes(1);
  });

  it("goes back to the editor's where people did so on another computer", async () => {
    const covers = memoryCoverStore();
    await covers.put("here", {
      ...cover("mine", 10),
      chosen: true,
      sent: "mine",
      sentAt: 100,
      auto: { picture: picture("made"), at: 5, etag: "made" },
    });
    const start = new StartCovers({ covers, urls: urls() });
    const linked = (listed: ProjectCard["cover"]) =>
      card("here", { kind: "cloudHere", project: "p_1", cover: listed });
    // The platform still has it.
    start.show([linked({ etag: "mine", at: 10, chosen: true })]);
    await settle();
    expect(start.getSnapshot().get("here")?.chosen).toBe(true);
    // A list from before the platform took it says nothing of that.
    start.show([linked({ etag: "old", at: 1 })], { listedAt: 90 });
    await settle();
    expect(start.getSnapshot().get("here")?.chosen).toBe(true);
    // Taken away there, as a later list says.
    start.show([linked(null)], { listedAt: 200 });
    await settle();
    expect(start.getSnapshot().get("here")?.chosen).toBe(false);
    const kept = (await covers.read(["here"])).get("here");
    expect(kept).toMatchObject({ etag: "made" });
    expect(kept?.chosen).toBeUndefined();
  });

  it("goes back to the editor's on a computer that only fetched the one people chose", async () => {
    const covers = memoryCoverStore();
    const cloud = { get: vi.fn(async (project: string) => picture(project)) };
    const start = new StartCovers({ covers, cloud, urls: urls() });
    start.show([{ ...remote("p_1", "chosen"), cover: { etag: "chosen", at: 10, chosen: true } }]);
    await settle();
    expect(start.getSnapshot().get("cloud:p_1")?.chosen).toBe(true);
    // People went back to the editor's elsewhere: that one comes.
    start.show([remote("p_1", "made", 20)], { listedAt: Date.now() + 1000 });
    await settle();
    expect(cloud.get).toHaveBeenCalledTimes(2);
    expect(start.getSnapshot().get("cloud:p_1")?.chosen).toBe(false);
    expect((await covers.read(["cloud:p_1"])).get("cloud:p_1")?.etag).toBe("made");
  });

  it("works without a platform and without a place to keep covers", async () => {
    const start = new StartCovers({ urls: urls() });
    start.show([card("folder-1"), remote("p_1", "a")]);
    await settle();
    expect(start.getSnapshot().get("cloud:p_1")).toEqual({
      url: undefined,
      durationMs: 6000,
      chosen: false,
    });
  });
});
