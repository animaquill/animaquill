import { COVER_BYTES, coverEtag, type CoverPut } from "@animaquill/host";
import { memoryCoverStore } from "@animaquill/host/browser";
import { describe, expect, it, vi } from "vitest";
import { COVER_QUALITIES, CoverUploads, encodeCover } from "../export/cover.ts";
import { MOST_PICTURE_BYTES, chooseCover, restoreAutoCover } from "./cover-choice.ts";

const image = () => ({ width: 4000, height: 3000, close: vi.fn() }) as unknown as ImageBitmap;
const target = { key: "folder-1", project: undefined, durationMs: 9000 };

/** Real time, which the tests do not take over. */
const realTimeout = globalThis.setTimeout;

/** Lets what is on its way finish: hashing takes more than a tick, on another thread. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise((resolve) => realTimeout(resolve, 5));
    for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("a cover people choose", () => {
  it("is made small enough for the platform, at the best quality that is", async () => {
    const covers = memoryCoverStore();
    const asked: number[] = [];
    // A detailed picture: only the lower qualities are small enough.
    const encode = (decoded: ImageBitmap) =>
      encodeCover(async (type, quality) => {
        expect(decoded.width).toBe(4000);
        asked.push(quality);
        return new Blob([new Uint8Array(quality > 0.5 ? COVER_BYTES * 2 : COVER_BYTES - 1)], {
          type,
        });
      });
    const decoded = image();
    const outcome = await chooseCover(target, new Blob(["x"], { type: "image/png" }), {
      covers,
      decode: async () => decoded,
      encode,
    });
    expect(outcome).toBe("chosen");
    expect(asked).toEqual(COVER_QUALITIES.filter((quality) => quality >= 0.45));
    expect(decoded.close).toHaveBeenCalled();
    const kept = (await covers.read(["folder-1"])).get("folder-1");
    expect(kept?.chosen).toBe(true);
    expect(kept?.picture.size).toBeLessThanOrEqual(COVER_BYTES);
    expect(kept?.durationMs).toBe(9000);
  });

  it("says what is wrong with a file that is none, too large, unreadable or too detailed", async () => {
    const covers = memoryCoverStore();
    const decode = vi.fn(async () => image());
    expect(
      await chooseCover(target, new Blob(["x"], { type: "text/plain" }), { covers, decode }),
    ).toBe("notPicture");
    const huge = { size: MOST_PICTURE_BYTES + 1, type: "image/png" } as Blob;
    expect(await chooseCover(target, huge, { covers, decode })).toBe("tooLarge");
    expect(decode).not.toHaveBeenCalled();
    expect(
      await chooseCover(target, new Blob(["x"], { type: "image/png" }), {
        covers,
        decode: () => Promise.reject(new Error("broken")),
      }),
    ).toBe("unreadable");
    expect(
      await chooseCover(target, new Blob(["x"], { type: "image/png" }), {
        covers,
        decode,
        encode: async () => undefined,
      }),
    ).toBe("notSmall");
    expect((await covers.read(["folder-1"])).size).toBe(0);
  });

  it("goes to the platform at once, and back to the editor's from there first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const covers = memoryCoverStore();
      const made = new Blob(["made"], { type: "image/webp" });
      await covers.put("folder-1", {
        picture: made,
        at: 1,
        etag: await coverEtag(made),
        sent: "x",
      });
      const puts: { text: string; chosen: boolean | undefined }[] = [];
      const cloud = {
        put: vi.fn(
          async (
            _project: string,
            picture: Blob,
            _durationMs?: number,
            options?: { chosen?: boolean },
          ): Promise<CoverPut> => {
            puts.push({ text: await picture.text(), chosen: options?.chosen });
            return { kind: "kept", etag: await coverEtag(picture), at: 2 };
          },
        ),
        remove: vi.fn(async (): Promise<"removed" | "missing" | "busy"> => "removed"),
        duration: vi.fn(async () => "kept" as const),
      };
      const uploads = new CoverUploads({ covers, cloud });
      const options = {
        covers,
        uploads,
        cloud,
        decode: async () => image(),
        encode: async () => new Blob(["mine"], { type: "image/jpeg" }),
      };
      const onPlatform = { ...target, project: "p_1" };
      expect(await chooseCover(onPlatform, new Blob(["x"], { type: "image/png" }), options)).toBe(
        "chosen",
      );
      vi.advanceTimersByTime(0);
      await settle();
      expect(puts).toEqual([{ text: "mine", chosen: true }]);
      expect(await restoreAutoCover(onPlatform, options)).toBe(true);
      expect(cloud.remove).toHaveBeenCalledWith("p_1");
      const back = (await covers.read(["folder-1"])).get("folder-1");
      expect(back?.chosen).toBeUndefined();
      expect(await back?.picture.text()).toBe("made");
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(puts.at(-1)).toEqual({ text: "made", chosen: false });
      // Where the platform does not take it away now, nothing changes here either.
      await chooseCover(onPlatform, new Blob(["x"], { type: "image/png" }), options);
      cloud.remove.mockImplementation(async () => "busy");
      expect(await restoreAutoCover(onPlatform, options)).toBe(false);
      expect((await covers.read(["folder-1"])).get("folder-1")?.chosen).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
