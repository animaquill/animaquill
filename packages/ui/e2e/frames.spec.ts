import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { chooseFolder, expect, tab, test } from "./scene-support.ts";

const FORMAT = { id: "small", name: "小屏", width: 640, height: 360, fps: "30" };
const clipFile = readFileSync(new URL("./fixtures/clip.mp4", import.meta.url));

function projectWithVideo(start: string, offset: string | undefined): string {
  const project = createProject({ name: "视频项目", format: FORMAT });
  const written = writeProject(project);
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(written.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "2" }));
  (timeline.tracks[0] as { clips: unknown[] }).clips = [
    {
      id: "film",
      start,
      duration: "1.5",
      ...(offset && { offset }),
      source: { kind: "video", media: { asset: "clip" } },
    },
  ];
  written.set(path, JSON.stringify(timeline));
  written.set(
    "assets.json",
    JSON.stringify({
      assets: { clip: { name: "片子", kind: "video", path: "assets/clip.mp4", storage: "git" } },
    }),
  );
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-frames-")), "项目");
  for (const [name, text] of [...written, ["assets/clip.mp4", clipFile] as const]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const installSavePicker = (page: Page) =>
  page.context().addInitScript(() => {
    const pick = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle("chosen-video", { create: true });
    };
    Object.assign(window, { showSaveFilePicker: pick });
  });

const savedFile = (page: Page) =>
  page
    .evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("chosen-video");
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      let text = "";
      for (let at = 0; at < bytes.length; at += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      }
      return btoa(text);
    })
    .then((base64) => Buffer.from(base64, "base64"));

async function exportProject(page: Page, folder: string): Promise<Buffer> {
  await chooseFolder(page, folder);
  await expect(tab(page, "preview")).toBeVisible();
  await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "导出视频…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "导出", exact: true }).click();
  const answer = page.getByRole("dialog").getByRole("button", { name: "留在这个页面" });
  if (await answer.isVisible({ timeout: 3000 }).catch(() => false)) await answer.click();
  await expect(page.getByRole("status").getByText("已导出“")).toBeVisible({ timeout: 60_000 });
  return savedFile(page);
}

async function packetsOf(file: Buffer) {
  const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video");
  const config = await track.getDecoderConfig();
  if (!config) throw new Error("No config");
  const packets = [];
  for await (const packet of new EncodedPacketSink(track).packets()) {
    packets.push({
      data: Buffer.from(packet.data).toString("base64"),
      key: packet.type === "key",
      timestamp: Math.round(packet.timestamp * 1e6),
    });
  }
  return {
    codec: config.codec,
    description: config.description
      ? Buffer.from(config.description as Uint8Array).toString("base64")
      : undefined,
    packets,
  };
}

/** Every frame of a file, small, as RGB numbers. */
const framesIn = (page: Page, file: Awaited<ReturnType<typeof packetsOf>>) =>
  page.evaluate(async ({ codec, description, packets }) => {
    const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const out: number[][] = [];
    const pending: Promise<void>[] = [];
    const decoder = new VideoDecoder({
      output: (frame) => {
        const canvas = new OffscreenCanvas(64, 36);
        canvas.getContext("2d")?.drawImage(frame, 0, 0, 64, 36);
        frame.close();
        const small = new VideoFrame(canvas, { timestamp: 0 });
        const pixels = new Uint8Array(small.allocationSize({ format: "RGBA" }));
        const index = out.length;
        out.push([]);
        pending.push(
          small.copyTo(pixels, { format: "RGBA" }).then(() => {
            small.close();
            out[index] = [...pixels].filter((_, at) => at % 4 !== 3);
          }),
        );
      },
      error: (error) => {
        throw error;
      },
    });
    decoder.configure({
      codec,
      codedWidth: 640,
      codedHeight: 360,
      ...(description && { description: bytes(description) }),
    });
    for (const { data, key, timestamp } of packets) {
      decoder.decode(
        new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: bytes(data) }),
      );
    }
    await decoder.flush();
    await Promise.all(pending);
    return out;
  }, file);

/** The picture of the preview, small, as RGB numbers, read the way the export reads it. */
async function previewPixels(page: Page): Promise<number[]> {
  const element = await page.locator('[data-panel="preview"] iframe').elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) return [];
  return frame.evaluate(async () => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const small = new OffscreenCanvas(64, 36);
    small.getContext("2d")?.drawImage(canvas, 0, 0, 64, 36);
    const read = new VideoFrame(small, { timestamp: 0 });
    const pixels = new Uint8Array(read.allocationSize({ format: "RGBA" }));
    await read.copyTo(pixels, { format: "RGBA" });
    read.close();
    return [...pixels].filter((_, at) => at % 4 !== 3);
  });
}

const mse = (a: readonly number[], b: readonly number[]) => {
  let sum = 0;
  for (let at = 0; at < a.length; at += 1) sum += ((a[at] ?? 0) - (b[at] ?? 0)) ** 2;
  return sum / a.length;
};

test.use({ withProject: false });

const keep = (name: string, frames: number[][]) =>
  writeFileSync(join(tmpdir(), `frames-${name}.json`), JSON.stringify(frames));
const kept = (name: string) =>
  JSON.parse(readFileSync(join(tmpdir(), `frames-${name}.json`), "utf8")) as number[][];

test.describe.serial("a video clip", () => {
  for (const [name, start, offset] of [
    ["reference", "0", undefined],
    ["moved", "1/30", undefined],
    ["trimmed", "1/30", "7/30"],
  ] as const) {
    test(`exported ${name}`, async ({ page }) => {
      test.setTimeout(120_000);
      await installSavePicker(page);
      await page.reload();
      const file = await exportProject(page, projectWithVideo(start, offset));
      keep(name, await framesIn(page, await packetsOf(file)));
    });
  }

  test("shows the right frame of its own in the preview, too", async ({ page }) => {
    const reference = kept("reference");
    await installSavePicker(page);
    await page.reload();
    await chooseFolder(page, projectWithVideo("1/30", "7/30"));
    await expect(tab(page, "preview")).toBeVisible();
    const wrong: string[] = [];
    for (const index of [1, 2, 5, 12, 20, 33]) {
      await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
      await page
        .getByRole("textbox", { name: "当前时间" })
        .fill(`0:00/${String(index).padStart(2, "0")}`);
      await page.keyboard.press("Enter");
      const expected = index - 1 + 7;
      let best = -1;
      await expect
        .poll(async () => {
          const shown = await previewPixels(page);
          let bestScore = Infinity;
          for (let source = Math.max(expected - 3, 0); source <= expected + 3; source += 1) {
            const score = mse(shown, reference[source] ?? []);
            if (score < bestScore) {
              bestScore = score;
              best = source;
            }
          }
          return best;
        })
        .toBe(expected)
        .catch(() => wrong.push(`${index}:${expected}->${best}`));
    }
    console.log("preview:", wrong.length, "frames show another source frame:", wrong.join(" "));
    expect(wrong).toEqual([]);
  });

  test("that does not start at 0 shows each of its frames once", () => {
    const reference = kept("reference");
    const steps = reference.slice(1, 45).map((frame, index) => mse(frame, reference[index] ?? []));
    console.log(
      "difference between neighbouring source frames, smallest:",
      Math.min(...steps).toFixed(1),
      "largest:",
      Math.max(...steps).toFixed(1),
    );
    const report = (name: string, shift: number) => {
      const frames = kept(name);
      const wrong: string[] = [];
      for (let index = 1; index < 45; index += 1) {
        const expected = index - 1 + shift;
        if (expected > 44) continue;
        let best = -1;
        let bestScore = Infinity;
        for (
          let source = Math.max(expected - 3, 0);
          source <= Math.min(expected + 3, 44);
          source += 1
        ) {
          const score = mse(frames[index] ?? [], reference[source] ?? []);
          if (score < bestScore) {
            bestScore = score;
            best = source;
          }
        }
        if (best !== expected) wrong.push(`${index}:${expected}->${best}`);
      }
      console.log(`${name}: ${wrong.length} frames show another source frame:`, wrong.join(" "));
      return wrong;
    };
    const a = report("moved", 0);
    const b = report("trimmed", 7);
    expect([...a, ...b]).toEqual([]);
  });
});

test("a clip that is drawn while it gets ready leaves no decoder behind", async ({ page }) => {
  // In the compositor of the preview: decoders that are not closed, with files that are slow to
  // read, as on a busy computer. Then getting the clip ready and drawing it wait for the same file to
  // open, and ask for a read of it at once.
  await page.context().addInitScript(() => {
    if (!location.href.includes("compositor")) return;
    const live = new Set<VideoDecoder>();
    const Decoder = VideoDecoder;
    const close = Decoder.prototype.close;
    Decoder.prototype.close = function (this: VideoDecoder) {
      live.delete(this);
      close.call(this);
    };
    globalThis.VideoDecoder = class extends Decoder {
      constructor(init: VideoDecoderInit) {
        super(init);
        live.add(this);
      }
    };
    const slowly = () => new Promise((resolve) => setTimeout(resolve, 150));
    const arrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      await slowly();
      return arrayBuffer.call(this);
    };
    const stream = Blob.prototype.stream;
    Blob.prototype.stream = function (this: Blob) {
      const reader = stream.call(this).getReader();
      return new ReadableStream({
        async pull(controller) {
          await slowly();
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
      });
    };
    Object.assign(globalThis, { liveDecoders: () => live.size });
  });
  await installSavePicker(page);
  await page.reload();
  await chooseFolder(page, projectWithVideo("1/30", "7/30"));
  await expect(tab(page, "preview")).toBeVisible();
  // Onto the clip while it opens, and then past it, where nothing reads it any more.
  for (const time of ["0:00/05", "0:01/27"]) {
    await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
    await page.getByRole("textbox", { name: "当前时间" }).fill(time);
    await page.keyboard.press("Enter");
  }
  const element = await page.locator('[data-panel="preview"] iframe').elementHandle();
  const frame = await element?.contentFrame();
  await expect
    .poll(() =>
      frame?.evaluate(() => (globalThis as unknown as { liveDecoders(): number }).liveDecoders()),
    )
    .toBe(0);
});
