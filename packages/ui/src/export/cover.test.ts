import { ProjectStore } from "@animaquill/core";
import { COVER_BYTES, coverEtag, type CoverAccess, type CoverPut } from "@animaquill/host";
import { memoryCoverStore } from "@animaquill/host/browser";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COVER_QUALITIES,
  COVER_TIMING,
  CoverMaker,
  CoverUploads,
  coverShotOf,
  coverSize,
  encodeCover,
  versionOf,
  type CoverShot,
} from "./cover.ts";

/** Real time, which the tests do not take over. */
const realTimeout = globalThis.setTimeout;

/** Lets what is on its way finish: hashing takes more than a tick, on another thread. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise((resolve) => realTimeout(resolve, 5));
    for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
  }
}

let clock = 0;

beforeEach(() => {
  clock = 1_000_000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Time goes on, and what it set off finishes. */
async function wait(ms: number): Promise<void> {
  clock += ms;
  vi.advanceTimersByTime(ms);
  await settle();
  // What that set off at once, as sending what was made.
  vi.advanceTimersByTime(0);
  await settle();
}

function sessionOf(store: ProjectStore | undefined, key = "folder-1") {
  const listeners = new Set<() => void>();
  const session = {
    store,
    key: store ? key : undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(next: ProjectStore | undefined) {
      session.store = next;
      session.key = next ? key : undefined;
      for (const listener of listeners) listener();
    },
  };
  return session;
}

const projectOf = (name = "片头") => ProjectStore.create(createProject({ name }));

const rename = (store: ProjectStore, name: string) =>
  store.execute({ type: "project.rename", params: { name } });

function makerWith(
  store: ProjectStore,
  more: {
    busy?: () => boolean;
    project?: string;
    cloud?: Pick<CoverAccess, "put">;
    picture?: string;
  } = {},
) {
  const covers = memoryCoverStore();
  const session = sessionOf(store);
  const shots: CoverShot[] = [];
  const looks = { picture: more.picture ?? "frame" };
  const picture = vi.fn(async (shot: CoverShot) => {
    shots.push(shot);
    return { width: 1920, height: 1080, close: () => {} } as unknown as ImageBitmap;
  });
  const uploads = more.cloud && new CoverUploads({ covers, cloud: more.cloud, now: () => clock });
  const maker = new CoverMaker({
    session,
    covers,
    picture,
    encode: async () => new Blob([looks.picture], { type: "image/webp" }),
    isBusy: more.busy ?? (() => false),
    ...(more.project !== undefined && { sendTo: () => more.project }),
    ...(uploads && { uploads }),
    now: () => clock,
  });
  return { maker, covers, session, picture, shots, looks };
}

describe("the moment a cover shows", () => {
  it("is a second into the main timeline, or the middle of a shorter one", () => {
    const store = projectOf();
    const shot = coverShotOf(store.getState(), "folder-1");
    expect(shot?.timeline).toBe("main");
    expect(shot?.seconds).toBe(shot!.durationMs >= 1000 ? 1 : shot!.durationMs / 2000);
  });

  it("is small: its longer side 480 pixels, whatever the shape", () => {
    expect(coverSize(3840, 2160)).toEqual({ width: 480, height: 270 });
    expect(coverSize(1080, 1920)).toEqual({ width: 270, height: 480 });
    expect(coverSize(1080, 1080)).toEqual({ width: 480, height: 480 });
    expect(coverSize(320, 180)).toEqual({ width: 320, height: 180 });
  });
});

describe("encoding a cover", () => {
  it("lowers the quality until it is small enough", async () => {
    const asked: number[] = [];
    const cover = await encodeCover(async (type, quality) => {
      asked.push(quality);
      return new Blob([new Uint8Array(quality > 0.5 ? COVER_BYTES + 1 : 1000)], { type });
    });
    expect(asked).toEqual([0.75, 0.6, 0.45]);
    expect(cover?.size).toBe(1000);
    expect(cover?.type).toBe("image/webp");
  });

  it("is a JPEG where the browser makes no WebP", async () => {
    const cover = await encodeCover(
      async (type) => new Blob(["x"], { type: type === "image/webp" ? "image/png" : type }),
    );
    expect(cover?.type).toBe("image/jpeg");
  });

  it("is none where nothing is small enough", async () => {
    const asked: string[] = [];
    const cover = await encodeCover(async (type, quality) => {
      asked.push(`${type}@${quality}`);
      return new Blob([new Uint8Array(COVER_BYTES + 1)], { type });
    });
    expect(cover).toBeUndefined();
    expect(asked).toHaveLength(COVER_QUALITIES.length * 2);
  });
});

describe("making the cover of the open project", () => {
  it("waits until people leave the project alone, and then makes one with its length", async () => {
    const store = projectOf();
    const { covers, picture } = makerWith(store);
    await settle();
    await wait(COVER_TIMING.idleMs - 1000);
    expect(picture).not.toHaveBeenCalled();
    // A change starts the wait over.
    rename(store, "片头 2");
    await wait(COVER_TIMING.idleMs - 1000);
    expect(picture).not.toHaveBeenCalled();
    await wait(1000);
    expect(picture).toHaveBeenCalledTimes(1);
    const kept = (await covers.read(["folder-1"])).get("folder-1");
    expect(kept?.etag).toBe(await coverEtag(new Blob(["frame"])));
    expect(kept?.durationMs).toBe(coverShotOf(store.getState(), "folder-1")?.durationMs);
    expect(kept?.made).toBe(await versionOf(store));
    expect(kept?.at).toBe(clock);
  });

  it("makes one every five minutes at most, however often the project changes", async () => {
    const store = projectOf();
    const { picture } = makerWith(store);
    await settle();
    await wait(COVER_TIMING.idleMs);
    expect(picture).toHaveBeenCalledTimes(1);
    for (let turn = 0; turn < 4; turn++) {
      rename(store, `片头 ${turn}`);
      await wait(COVER_TIMING.idleMs);
    }
    expect(picture).toHaveBeenCalledTimes(1);
    await wait(COVER_TIMING.everyMs - 4 * COVER_TIMING.idleMs);
    expect(picture).toHaveBeenCalledTimes(2);
    // Nothing changed since: nothing to make.
    await wait(COVER_TIMING.everyMs * 2);
    expect(picture).toHaveBeenCalledTimes(2);
  });

  it("does not make one while people play, export or look elsewhere", async () => {
    const store = projectOf();
    let isBusy = true;
    const { picture } = makerWith(store, { busy: () => isBusy });
    await settle();
    await wait(COVER_TIMING.idleMs + 3 * COVER_TIMING.retryMs);
    expect(picture).not.toHaveBeenCalled();
    isBusy = false;
    await wait(COVER_TIMING.retryMs);
    expect(picture).toHaveBeenCalledTimes(1);
  });

  it("makes none again for a project that is as its cover shows it", async () => {
    const store = projectOf();
    const first = makerWith(store);
    await settle();
    await wait(COVER_TIMING.idleMs);
    expect(first.picture).toHaveBeenCalledTimes(1);
    first.maker.close();
    // Opened again later, in another window of the browser.
    const covers = first.covers;
    const session = sessionOf(store);
    const picture = vi.fn();
    const maker = new CoverMaker({
      session,
      covers,
      picture,
      isBusy: () => false,
      now: () => clock,
    });
    await settle();
    await wait(COVER_TIMING.everyMs * 2);
    expect(picture).not.toHaveBeenCalled();
    maker.close();
  });

  it("makes one as people leave a project that changed, and none for one that did not", async () => {
    const store = projectOf();
    const { maker, session, picture } = makerWith(store);
    await settle();
    await wait(COVER_TIMING.idleMs);
    expect(picture).toHaveBeenCalledTimes(1);
    maker.leaving();
    await settle();
    expect(picture).toHaveBeenCalledTimes(1);
    rename(store, "片头 2");
    // Within five minutes of the last one, and at once.
    maker.leaving();
    session.open(undefined);
    await settle();
    expect(picture).toHaveBeenCalledTimes(2);
  });

  it("gives way to an export that begins while it draws, and draws again later", async () => {
    const store = projectOf();
    const covers = memoryCoverStore();
    const signals: AbortSignal[] = [];
    // A picture that takes a while, as one of a large project.
    const picture = vi.fn(
      (_shot: CoverShot, signal: AbortSignal) =>
        new Promise<ImageBitmap>((resolve) => {
          signals.push(signal);
          setTimeout(
            () => resolve({ width: 1920, height: 1080, close: () => {} } as unknown as ImageBitmap),
            5000,
          );
        }),
    );
    const maker = new CoverMaker({
      session: sessionOf(store),
      covers,
      picture,
      encode: async () => new Blob(["frame"], { type: "image/webp" }),
      isBusy: () => false,
      now: () => clock,
    });
    await settle();
    await wait(COVER_TIMING.idleMs);
    expect(picture).toHaveBeenCalledTimes(1);
    // The export starts: the picture stops at once, and nothing is kept of it.
    maker.yieldNow();
    expect(signals[0]?.aborted).toBe(true);
    await wait(5000);
    expect((await covers.read(["folder-1"])).size).toBe(0);
    // Made again once people leave it alone, not five minutes later.
    await wait(COVER_TIMING.idleMs);
    expect(picture).toHaveBeenCalledTimes(2);
    await wait(5000);
    expect((await covers.read(["folder-1"])).size).toBe(1);
    maker.close();
  });

  it("changes nothing of the project", async () => {
    const store = projectOf();
    const changes = vi.fn();
    store.subscribe(changes);
    const revision = store.revision;
    const { maker } = makerWith(store);
    await settle();
    await wait(COVER_TIMING.idleMs);
    maker.leaving();
    await settle();
    expect(changes).not.toHaveBeenCalled();
    expect(store.revision).toBe(revision);
  });

  it("is quiet when the picture cannot be had", async () => {
    const store = projectOf();
    const covers = memoryCoverStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const maker = new CoverMaker({
      session: sessionOf(store),
      covers,
      picture: () => Promise.reject(new Error("no compositor")),
      isBusy: () => false,
      now: () => clock,
    });
    await settle();
    await wait(COVER_TIMING.idleMs);
    expect((await covers.read(["folder-1"])).size).toBe(0);
    maker.close();
    warn.mockRestore();
  });
});

describe("sending covers to the platform", () => {
  const platform = () => {
    const sent: string[] = [];
    let answer: CoverPut | undefined;
    const cloud = {
      put: vi.fn(async (_project: string, picture: Blob): Promise<CoverPut> => {
        sent.push(await picture.text());
        return answer ?? { kind: "kept", etag: await coverEtag(picture), at: clock };
      }),
    };
    return { cloud, sent, answerWith: (next: CoverPut | undefined) => (answer = next) };
  };

  it("sends what was made, and not the same picture again", async () => {
    const store = projectOf();
    const { cloud, sent } = platform();
    const { maker, covers, looks } = makerWith(store, { project: "p_1", cloud });
    await settle();
    await wait(COVER_TIMING.idleMs);
    expect(sent).toEqual(["frame"]);
    expect((await covers.read(["folder-1"])).get("folder-1")?.sent).toBe(
      await coverEtag(new Blob(["frame"])),
    );
    // The project changed and looks the same: kept, not sent again.
    rename(store, "片头 2");
    maker.leaving();
    await settle();
    await wait(COVER_TIMING.everyMs);
    expect(sent).toEqual(["frame"]);
    // Now it looks otherwise.
    looks.picture = "frame 2";
    rename(store, "片头 3");
    maker.leaving();
    await settle();
    await wait(60_000);
    expect(sent).toEqual(["frame", "frame 2"]);
  });

  it("sends a project once a minute at most, and again when the platform says when", async () => {
    const covers = memoryCoverStore();
    const { cloud, sent, answerWith } = platform();
    const uploads = new CoverUploads({ covers, cloud, now: () => clock });
    const keep = async (text: string) => {
      const picture = new Blob([text], { type: "image/webp" });
      await covers.put("folder-1", { picture, at: clock, etag: await coverEtag(picture) });
    };
    await keep("a");
    uploads.offer("folder-1", "p_1");
    await wait(0);
    expect(sent).toEqual(["a"]);
    await keep("b");
    uploads.offer("folder-1", "p_1");
    await wait(30_000);
    expect(sent).toEqual(["a"]);
    // Offered again while it waits: once.
    uploads.offer("folder-1", "p_1");
    await wait(30_000);
    expect(sent).toEqual(["a", "b"]);
    await keep("c");
    answerWith({ kind: "busy", retryAfterMs: 90_000 });
    uploads.offer("folder-1", "p_1");
    await wait(60_000);
    expect(sent).toEqual(["a", "b", "c"]);
    answerWith(undefined);
    await wait(60_000);
    expect(sent).toEqual(["a", "b", "c"]);
    await wait(30_000);
    expect(sent).toEqual(["a", "b", "c", "c"]);
    // Taken now: nothing more goes.
    uploads.offer("folder-1", "p_1");
    await wait(120_000);
    expect(sent).toEqual(["a", "b", "c", "c"]);
  });

  it("gives up quietly where the platform cannot be reached", async () => {
    const covers = memoryCoverStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cloud = { put: vi.fn(() => Promise.reject(new Error("offline"))) };
    const uploads = new CoverUploads({ covers, cloud, now: () => clock });
    const picture = new Blob(["a"], { type: "image/webp" });
    await covers.put("folder-1", { picture, at: clock, etag: await coverEtag(picture) });
    uploads.offer("folder-1", "p_1");
    await wait(0);
    expect(cloud.put).toHaveBeenCalledTimes(1);
    expect((await covers.read(["folder-1"])).get("folder-1")?.sent).toBeUndefined();
    warn.mockRestore();
  });

  it("sends nothing for a project that is not one of the platform, and nothing fails", async () => {
    const store = projectOf();
    const { covers, picture } = makerWith(store);
    await settle();
    await wait(COVER_TIMING.idleMs);
    expect(picture).toHaveBeenCalledTimes(1);
    expect((await covers.read(["folder-1"])).get("folder-1")?.sent).toBeUndefined();
  });
});
