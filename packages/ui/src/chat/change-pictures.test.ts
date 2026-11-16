import { describe, expect, it, vi } from "vitest";
import type { PicturesRequest } from "../look/looks.ts";
import { ChangePictures } from "./change-pictures.ts";

const request = { timeline: "main", seconds: 1, side: 320 } as unknown as PicturesRequest;

describe("pictures of a change", () => {
  it("are rendered once for each key, and let go of once too many came after them", async () => {
    const side = () => ({ ok: true as const, image: new Blob(["b"]), width: 320, height: 180 });
    const pictures = vi.fn(async () => ({ before: side(), after: side() }));
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const kept = new ChangePictures({ pictures });
    const first = await kept.get("one", () => request);
    expect(first.before).toMatchObject({ ok: true, width: 320 });
    await kept.get("one", () => request);
    expect(pictures).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 24; index++) await kept.get(`other ${index}`, () => request);
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith(first.before.ok ? first.before.url : "");
    await kept.get("one", () => request);
    expect(pictures).toHaveBeenCalledTimes(26);
    kept.clear();
  });

  it("say why there are none", async () => {
    const failure = { reason: "compositor" } as const;
    const side = { ok: false as const, failure };
    const kept = new ChangePictures({ pictures: async () => ({ before: side, after: side }) });
    expect(await kept.get("one", () => request)).toEqual({ before: side, after: side });
  });
});
