/**
 * How long the proxy of a 4K video at 60 frames takes, made the way the editor makes it: in its
 * worker, from a project folder at 1080p and 30 frames, as the projects of people are. Only when
 * asked for, AQ_PERF_4K=1, or AQ_PERF_4K=30 for 30 seconds of video: encoding the video for it takes
 * a while. The numbers are what this is for, and depend on the machine: a graphics card decodes much
 * faster than a processor.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { PROXY_FOLDER, proxyName } from "../src/proxy/spec.ts";
import { encodeIn, openProject, projectWith } from "./proxy-support.ts";
import { expect, needsDevPage, test } from "./support.ts";

test.use({
  folders: true,
  withProject: false,
  quality: "auto",
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});
test.setTimeout(1_800_000);

const UHD60 = { width: 3840, height: 2160, fps: 60 };
const HD30 = { id: "hd", name: "横屏", width: 1920, height: 1080, fps: "30" };
/** How long the video is: 10 seconds, or what AQ_PERF_4K says, such as AQ_PERF_4K=30. */
const asked = Number(process.env["AQ_PERF_4K"]);
const SECONDS = asked > 1 ? asked : 10;

test("the proxy of 4K at 60 frames, in a project of 1080p at 30", async ({ page, devPage }) => {
  test.skip(!process.env["AQ_PERF_4K"], "4K only when asked for: AQ_PERF_4K=1");
  test.skip(!devPage, needsDevPage("window.aqProxies"));
  const encodeStart = Date.now();
  // Fine detail that moves, at the bitrate of people's video: 381 MB for 153 s is 20 Mbit/s.
  const video = await encodeIn(page, UHD60, SECONDS * UHD60.fps, {
    codec: "avc1.640033",
    bitrate: 20_000_000,
    look: "detail",
  });
  const encodeSeconds = (Date.now() - encodeStart) / 1000;
  const { disk, hash } = projectWith(video, { seconds: SECONDS, format: HD30, shape: UHD60 });
  const opened = Date.now();
  await openProject(page, disk);
  // Watched in the page, a tenth of a second at a time: when it started, and when it was ready.
  const timing = await page.evaluate(async (wanted) => {
    const { aqProxies } = window as unknown as {
      aqProxies: () => { states: Record<string, { kind: string }> } | undefined;
    };
    const started = performance.now();
    let making: number | undefined;
    for (;;) {
      const state = aqProxies()?.states[wanted]?.kind;
      if (state === "making") making ??= performance.now();
      if (state === "ready" || state === "failed" || performance.now() - started > 1_500_000) {
        const now = performance.now();
        return {
          state,
          beforeMs: (making ?? now) - started,
          makingMs: making === undefined ? undefined : now - making,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, hash);
  const totalSeconds = (Date.now() - opened) / 1000;
  // Where the time went, as a report has it.
  const made = await page.evaluate(
    (wanted) =>
      (
        window as unknown as { aqProxies: () => { made: Record<string, unknown> } | undefined }
      ).aqProxies()?.made[wanted],
    hash,
  );
  expect(timing.state).toBe("ready");
  const proxy = join(
    disk,
    PROXY_FOLDER,
    proxyName(hash, { width: 960, height: 540, fps: { num: 30, den: 1 } }),
  );
  const input = new Input({ source: new BufferSource(readFileSync(proxy)), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  let frames = 0;
  for await (const _ of new EncodedPacketSink(track as never).packets()) frames += 1;
  const makingSeconds = (timing.makingMs ?? 0) / 1000;
  // Decoding the video and nothing else, for how much of the time that is on this machine.
  const source = new Input({ source: new BufferSource(video), formats: ALL_FORMATS });
  const sourceTrack = await source.getPrimaryVideoTrack();
  const config = await sourceTrack?.getDecoderConfig();
  const packets: { data: string; key: boolean; timestamp: number }[] = [];
  for await (const packet of new EncodedPacketSink(sourceTrack as never).packets()) {
    packets.push({
      data: Buffer.from(packet.data).toString("base64"),
      key: packet.type === "key",
      timestamp: Math.round(packet.timestamp * 1e6),
    });
  }
  // A second at a time, from its key frame, which keeps the page from filling up.
  await page.evaluate(
    ({ codec, codedWidth, codedHeight, head }) => {
      const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const counted = { frames: 0, ms: 0 };
      const decoder = new VideoDecoder({
        output: (frame) => {
          counted.frames += 1;
          frame.close();
        },
        error: (error) => console.warn(error),
      });
      decoder.configure({ codec, codedWidth, codedHeight, description: bytes(head) });
      const decode = async (chunks: { data: string; key: boolean; timestamp: number }[]) => {
        const all = chunks.map(
          ({ data, key, timestamp }) =>
            new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: bytes(data) }),
        );
        const started = performance.now();
        for (const chunk of all) {
          decoder.decode(chunk);
          while (decoder.decodeQueueSize > 8) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
        await decoder.flush();
        counted.ms += performance.now() - started;
        return counted;
      };
      Object.assign(window, { aqDecode: decode });
    },
    {
      codec: config?.codec ?? "",
      codedWidth: config?.codedWidth ?? 0,
      codedHeight: config?.codedHeight ?? 0,
      head: Buffer.from(config?.description as Uint8Array).toString("base64"),
    },
  );
  let decodeOnly = { frames: 0, ms: 0 };
  for (let from = 0; from < packets.length; from += UHD60.fps) {
    decodeOnly = await page.evaluate(
      (chunks) =>
        (
          window as unknown as {
            aqDecode: (all: typeof chunks) => Promise<{ frames: number; ms: number }>;
          }
        ).aqDecode(chunks),
      packets.slice(from, from + UHD60.fps),
    );
  }
  const facts = {
    video: `${SECONDS} s of 3840x2160 at 60, ${(video.length / 1024 ** 2).toFixed(1)} MB, made in ${encodeSeconds.toFixed(1)} s`,
    proxy: `${track?.displayWidth}x${track?.displayHeight}, ${frames} frames, ${(statSync(proxy).size / 1024 ** 2).toFixed(1)} MB`,
    beforeMaking: `${(timing.beforeMs / 1000).toFixed(1)} s (hash and look at the video)`,
    making: `${makingSeconds.toFixed(1)} s`,
    decoded: `${((SECONDS * UHD60.fps) / makingSeconds).toFixed(1)} frames of the video a second`,
    decodingAlone: `${((decodeOnly.frames * 1000) / decodeOnly.ms).toFixed(1)} frames a second, in the page, nothing else`,
    bitrate: `${((video.length * 8) / SECONDS / 1e6).toFixed(0)} Mbit/s (people's video: 20)`,
    speed: `${(SECONDS / makingSeconds).toFixed(2)}x as fast as it plays`,
    for153Seconds: `about ${((153 / SECONDS) * makingSeconds).toFixed(0)} s for the 153 s of people's video`,
    fromOpening: `${totalSeconds.toFixed(1)} s`,
    spent: made,
    cores: await page.evaluate(() => navigator.hardwareConcurrency),
  };
  console.log(`proxy of 4K60: ${JSON.stringify(facts, null, 2)}`);
  expect(track?.displayWidth).toBe(960);
});
