import { describe, expect, it } from "vitest";
import { bitrateFor, chooseEncoding, codecString, inSoftware } from "./codecs.ts";

const HD = { width: 1920, height: 1080, fps: 30 };

describe("the bitrate of an export", () => {
  it("is what the export demo had for the sizes it had", () => {
    expect(bitrateFor(HD, "standard")).toBe(12_000_000);
    expect(bitrateFor({ ...HD, fps: 60 }, "standard")).toBe(16_000_000);
    expect(bitrateFor({ width: 3840, height: 2160, fps: 30 }, "standard")).toBe(45_000_000);
    expect(bitrateFor({ width: 3840, height: 2160, fps: 60 }, "standard")).toBe(60_000_000);
  });

  it("has a smaller and a larger step around that", () => {
    expect(bitrateFor(HD, "small")).toBe(7_200_000);
    expect(bitrateFor(HD, "high")).toBe(19_200_000);
  });

  it("goes with the size of anything in between, and never gets silly", () => {
    const vertical = bitrateFor({ width: 1080, height: 1920, fps: 30 }, "standard");
    expect(vertical).toBe(12_000_000);
    expect(bitrateFor({ width: 16, height: 16, fps: 1 }, "small")).toBe(500_000);
  });
});

describe("the codec of an export", () => {
  it("claims the H.264 level the video needs, as the demo did", () => {
    expect(codecString("avc", HD, 12e6)).toBe("avc1.640028");
    expect(codecString("avc", { ...HD, fps: 60 }, 16e6)).toBe("avc1.64002A");
    expect(codecString("avc", { width: 3840, height: 2160, fps: 30 }, 45e6)).toBe("avc1.640033");
    expect(codecString("avc", { width: 3840, height: 2160, fps: 60 }, 60e6)).toBe("avc1.640034");
  });

  it("takes a higher level for more bits than a level allows", () => {
    expect(codecString("avc", HD, 30e6)).toBe("avc1.640029");
  });

  it("has levels for VP9 and AV1 as well", () => {
    expect(codecString("vp9", HD, 12e6)).toBe("vp09.00.40.08");
    expect(codecString("vp9", { width: 3840, height: 2160, fps: 60 }, 60e6)).toBe("vp09.00.51.08");
    expect(codecString("av1", HD, 12e6)).toBe("av01.0.08M.08");
    expect(codecString("av1", { width: 3840, height: 2160, fps: 30 }, 45e6)).toBe("av01.0.12M.08");
  });

  it("is H.264 where it can be", async () => {
    const encoding = await chooseEncoding(HD, "standard", async () => true);
    expect(encoding?.codec).toBe("avc");
    expect(encoding?.acceleration).toBe("hardware");
    expect(encoding?.config).toMatchObject({
      codec: "avc1.640028",
      width: 1920,
      height: 1080,
      bitrate: 12_000_000,
      framerate: 30,
      avc: { format: "avc" },
    });
  });

  it("tries the graphics card first, and then the processor", async () => {
    const asked: string[] = [];
    const encoding = await chooseEncoding(HD, "standard", async (config) => {
      asked.push(`${config.codec} ${config.hardwareAcceleration}`);
      return config.hardwareAcceleration === "prefer-software";
    });
    expect(asked).toEqual(["avc1.640028 prefer-hardware", "avc1.640028 prefer-software"]);
    expect(encoding).toMatchObject({
      codec: "avc",
      acceleration: "software",
      config: { hardwareAcceleration: "prefer-software" },
    });
  });

  it("goes over to the processor for a codec before it gives up on that codec", () => {
    const hardware = {
      codec: "avc" as const,
      acceleration: "hardware" as const,
      config: { codec: "a", width: 2, height: 2, hardwareAcceleration: "prefer-hardware" as const },
    };
    expect(inSoftware(hardware)).toMatchObject({
      acceleration: "software",
      config: { codec: "a", hardwareAcceleration: "prefer-software" },
    });
  });

  it("falls back to VP9, then AV1, then nothing", async () => {
    const only = (prefix: string) => async (config: VideoEncoderConfig) =>
      config.codec.startsWith(prefix);
    expect((await chooseEncoding(HD, "standard", only("vp09")))?.codec).toBe("vp9");
    expect((await chooseEncoding(HD, "standard", only("av01")))?.codec).toBe("av1");
    expect(await chooseEncoding(HD, "standard", async () => false)).toBeUndefined();
  });
});
