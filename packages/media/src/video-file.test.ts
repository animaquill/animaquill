import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { containerOf, VideoFileWriter, type ByteSink } from "./video-file.ts";

/** A file in memory, which keeps every write, to see how it was written. */
class MemoryFile implements ByteSink {
  bytes = new Uint8Array(0);
  readonly writes: { readonly position: number; readonly size: number }[] = [];

  async write(data: Uint8Array<ArrayBuffer>, position: number): Promise<void> {
    this.writes.push({ position, size: data.byteLength });
    const end = Math.max(this.bytes.byteLength, position + data.byteLength);
    const grown = new Uint8Array(end);
    grown.set(this.bytes);
    grown.set(data, position);
    this.bytes = grown;
  }
}

const VP9 = { codec: "vp09.00.10.08", codedWidth: 64, codedHeight: 36 };
/** A frame is whatever the encoder said. Nothing here decodes it. */
const frame = (index: number, size = 1000) => ({
  data: new Uint8Array(size).fill(index + 1),
  key: index % 30 === 0,
  timestamp: index / 30,
  duration: 1 / 30,
});

async function readBack(bytes: Uint8Array) {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const packets = [];
  if (track)
    for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
  return { track, packets, duration: await input.computeDuration() };
}

describe("a video file", () => {
  it("is MP4 for H.264 and WebM for the others", () => {
    expect(containerOf("avc")).toBe("mp4");
    expect(containerOf("vp9")).toBe("webm");
    expect(containerOf("av1")).toBe("webm");
  });

  it("has every frame, in order, with its time", async () => {
    const file = new MemoryFile();
    const writer = await VideoFileWriter.start(file, { codec: "vp9", frameRate: 30 });
    for (let index = 0; index < 60; index += 1) await writer.add(frame(index), VP9);
    await writer.finish();
    const { track, packets, duration } = await readBack(file.bytes);
    expect(track?.codec).toBe("vp9");
    expect(packets).toHaveLength(60);
    expect(packets.map(({ type }) => type).filter((type) => type === "key")).toHaveLength(2);
    expect(packets[59]?.data[0]).toBe(60);
    expect(duration).toBeCloseTo(2, 3);
  });

  it("gets written while frames come, in pieces of limited size", async () => {
    const file = new MemoryFile();
    const writer = await VideoFileWriter.start(file, { codec: "vp9", frameRate: 30 });
    // 12 MB in all, which should not wait in memory for the end.
    for (let index = 0; index < 120; index += 1) await writer.add(frame(index, 100_000), VP9);
    expect(file.bytes.byteLength).toBeGreaterThan(8_000_000);
    await writer.finish();
    expect(Math.max(...file.writes.map(({ size }) => size))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect((await readBack(file.bytes)).packets).toHaveLength(120);
  });

  it("writes nothing more once it is cancelled", async () => {
    const file = new MemoryFile();
    const writer = await VideoFileWriter.start(file, { codec: "vp9", frameRate: 30 });
    await writer.add(frame(0), VP9);
    await writer.cancel();
    const writes = file.writes.length;
    await expect(writer.add(frame(1), VP9)).rejects.toThrow();
    expect(file.writes).toHaveLength(writes);
  });

  it("stops when the file does not take what it gets", async () => {
    const failing: ByteSink = { write: () => Promise.reject(new Error("disk full")) };
    const writer = await VideoFileWriter.start(failing, { codec: "vp9", frameRate: 30 });
    const adding = (async () => {
      for (let index = 0; index < 60; index += 1) await writer.add(frame(index, 100_000), VP9);
      await writer.finish();
    })();
    await expect(adding).rejects.toThrow("disk full");
  });
});
