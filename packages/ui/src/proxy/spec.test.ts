import { isSafePath } from "@animaquill/host";
import { describe, expect, it } from "vitest";
import {
  PROXY_FOLDER,
  RECIPE,
  digestOf,
  isMadeHere,
  partOf,
  proxyEncoders,
  proxyName,
  proxyOf,
  proxySpecFor,
  rateOf,
} from "./spec.ts";

const HD30 = { width: 1920, height: 1080, fps: { num: 30, den: 1 } };
const HASH = "sha256-n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg";

describe("the proxy of a video", () => {
  it("is half the project for 4K at 60, at the rate of the project", () => {
    expect(proxySpecFor({ width: 3840, height: 2160, fps: 59.94 }, HD30)).toEqual({
      width: 960,
      height: 540,
      fps: { num: 30, den: 1 },
    });
  });

  it("stands upright for a video that does, with as many pixels", () => {
    expect(proxySpecFor({ width: 2160, height: 3840, fps: 60 }, HD30)).toMatchObject({
      width: 540,
      height: 960,
    });
  });

  it("is never larger than 720p, also for a project that is 4K", () => {
    const uhd = { width: 3840, height: 2160, fps: { num: 24, den: 1 } };
    expect(proxySpecFor({ width: 7680, height: 4320, fps: 24 }, uhd)).toMatchObject({
      width: 1280,
      height: 720,
    });
    // As large as the project and as fast: what the preview draws anyway.
    expect(proxySpecFor({ width: 3840, height: 2160, fps: 24 }, uhd)).toBeUndefined();
  });

  it("is there for a video that is only faster, at its own size if that is small enough", () => {
    expect(proxySpecFor({ width: 640, height: 360, fps: 60 }, HD30)).toMatchObject({
      width: 640,
      height: 360,
    });
    expect(proxySpecFor({ width: 1920, height: 1080, fps: 60 }, HD30)).toMatchObject({
      width: 960,
      height: 540,
    });
  });

  it("is not there for what the preview decodes as fast as it draws", () => {
    expect(proxySpecFor({ width: 1920, height: 1080, fps: 30 }, HD30)).toBeUndefined();
    expect(proxySpecFor({ width: 1280, height: 720, fps: 29.97 }, HD30)).toBeUndefined();
    expect(proxySpecFor({ width: 1080, height: 1920, fps: 30 }, HD30)).toBeUndefined();
    // Without a known rate, by its size alone.
    expect(proxySpecFor({ width: 1920, height: 1080 }, HD30)).toBeUndefined();
    expect(proxySpecFor({ width: 0, height: 0, fps: 60 }, HD30)).toBeUndefined();
    const ntsc = { ...HD30, fps: rateOf("30000/1001") };
    expect(proxySpecFor({ width: 1920, height: 1080, fps: 30 }, ntsc)).toBeUndefined();
  });

  it("has sides that are even, as H.264 wants, and keeps the shape", () => {
    const spec = proxySpecFor({ width: 4096, height: 2160, fps: 25 }, HD30);
    expect(spec).toEqual({ width: 960, height: 506, fps: { num: 30, den: 1 } });
    expect(Math.abs((spec?.width ?? 0) / (spec?.height ?? 1) - 4096 / 2160)).toBeLessThan(0.01);
  });

  it("is named by the file and by what it is like, and the name is fine on every system", () => {
    const spec = proxySpecFor({ width: 3840, height: 2160, fps: 60 }, HD30);
    if (!spec) throw new Error("No proxy");
    const name = proxyName(HASH, spec);
    expect(name).toBe("9f86d081884c7d659a2feaa0-960x540-30-v1.mp4");
    const ntsc = proxyName(HASH, { ...spec, fps: rateOf("30000/1001") });
    expect(ntsc).toBe("9f86d081884c7d659a2feaa0-960x540-30000_1001-v1.mp4");
    expect(proxyName("sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", spec)).not.toBe(name);
    for (const each of [name, ntsc, partOf(ntsc)]) {
      expect(isSafePath(`${PROXY_FOLDER}/${each}`)).toBe(true);
    }
  });

  it("says by its name which file it is of and how it was made", () => {
    const spec = { width: 960, height: 540, fps: rateOf("30000/1001") };
    const name = proxyName(HASH, spec);
    expect(proxyOf(name)).toEqual({ digest: digestOf(HASH), recipe: RECIPE });
    expect(proxyOf(name.replace("-v1.mp4", "-v0.mp4"))).toEqual({
      digest: digestOf(HASH),
      recipe: "v0",
    });
    for (const other of [partOf(name), `${name}.crswap`, "笔记.txt", "a.mp4"]) {
      expect(proxyOf(other)).toBeUndefined();
    }
  });

  it("is known by its name, with what writing it leaves, and nothing else is", () => {
    const name = "9f86d081884c7d659a2feaa0-960x540-30000_1001-v1.mp4";
    for (const ours of [name, partOf(name), `${name}.crswap`, `${partOf(name)}.1.crswap`]) {
      expect(isMadeHere(ours)).toBe(true);
    }
    for (const theirs of ["笔记.txt", "a.mp4", `${name}.txt`, `x${name}`, ".gitignore"]) {
      expect(isMadeHere(theirs)).toBe(false);
    }
  });

  it("is encoded with H.264 on the graphics card first, at a level that holds it", () => {
    const encoders = proxyEncoders({ width: 1280, height: 720, fps: { num: 30, den: 1 } });
    expect(encoders.map(({ hardwareAcceleration }) => hardwareAcceleration)).toEqual([
      "prefer-hardware",
      "prefer-software",
    ]);
    expect(encoders[0]).toMatchObject({ codec: "avc1.64001F", width: 1280, height: 720 });
    expect(encoders[0]?.bitrate).toBeGreaterThan(1_000_000);
    expect(encoders[0]?.bitrate).toBeLessThan(5_000_000);
  });
});
