import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  bezierProgress,
  type RenderJoin,
  type RenderLayer,
  type RenderPlan,
} from "@animaquill/core";
import { importClips } from "./project-files.ts";
import { content, expect, findCompositor, test } from "./support.ts";

/**
 * What transitions look like, as the compositor draws them from a plan it gets straight from here:
 * the same picture as the preview and an export of the same moment, against what the project
 * format says each one is. Pixels of plain colors, so that every one of them can be worked out.
 */

const WIDTH = 640;
const HEIGHT = 360;

type Color = readonly [number, number, number];

const RED: Color = [255, 0, 0];
const GREEN: Color = [0, 255, 0];
const BLUE: Color = [0, 0, 255];
const BLACK: Color = [0, 0, 0];
const WHITE: Color = [255, 255, 255];

const color = (
  id: string,
  start: number,
  end: number,
  hex: string,
  more: Partial<RenderLayer> = {},
): RenderLayer => ({
  id,
  start,
  end,
  offset: 0,
  source: { kind: "color", color: hex },
  fit: "contain",
  channels: {},
  ...more,
});

const still = (value: number) => ({ kind: "still", value }) as const;

/** A box in the middle, half as wide and high as the picture. */
const half = { channels: { "transform.scale": still(0.5) } } as const;

/** A plan of a track or two, where joins have their layers show past their clips, as plans have. */
function planOf(layers: readonly RenderLayer[], joins: readonly RenderJoin[] = []): RenderPlan {
  const shown = layers.map((layer) => {
    const before = joins.find(({ to }) => to === layer.id);
    const after = joins.find(({ from }) => from === layer.id);
    if (!before && !after) return layer;
    const shows = { from: before?.start ?? layer.start, to: after?.end ?? layer.end };
    return { ...layer, shows };
  });
  return {
    width: WIDTH,
    height: HEIGHT,
    stage: { width: 1920, height: 1080 },
    camera: {},
    scenes: { format: "f", language: "zh-CN", fps: { num: 30, den: 1 } },
    background: "#000000",
    layers: shown,
    joins: [...joins],
  };
}

const join = (
  from: string,
  to: string,
  start: number,
  end: number,
  type: string,
  more: Partial<RenderJoin> = {},
  values: Record<string, unknown> = {},
): RenderJoin => ({
  id: `${from}-${to}`,
  track: "t",
  from,
  to,
  how: { kind: "built-in", type, values },
  start,
  end,
  duration: end - start,
  ...more,
});

const compositorListens = (page: Page) =>
  expect
    .poll(async () => {
      const frame = await findCompositor(page);
      return frame?.evaluate(() => document.querySelector("canvas") !== null);
    })
    .toBe(true);

/** Tells the compositor what to draw and when, as the editor does, and waits for it to say so. */
async function show(page: Page, plan: RenderPlan, seconds: number): Promise<void> {
  await compositorListens(page);
  await content(page, "preview")
    .locator("iframe")
    .evaluate(
      (element: HTMLIFrameElement, message) => {
        element.contentWindow?.postMessage({ type: "plan", plan: message.plan }, "*");
        element.contentWindow?.postMessage(
          { type: "seek", seconds: message.seconds, jump: true },
          "*",
        );
      },
      { plan, seconds },
    );
}

async function pixel(page: Page, x: number, y: number): Promise<readonly number[]> {
  const frame = await findCompositor(page);
  const read = frame?.evaluate(
    ([left = 0, top = 0, width = 0]) => {
      const canvas = document.querySelector("canvas");
      if (canvas?.width !== width) return [];
      return [...(canvas.getContext("2d")?.getImageData(left, top, 1, 1).data ?? [])].slice(0, 3);
    },
    [x, y, WIDTH],
  );
  return (await read?.catch(() => [])) ?? [];
}

const distance = (found: readonly number[], wanted: readonly number[]) =>
  found.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.max(...wanted.map((part, index) => Math.abs(part - (found[index] ?? -999))));

/** Mixed with premultiplied colors that are all opaque: `a · (1 − p) + b · p`. */
const mix = (a: Color, b: Color, p: number): Color =>
  a.map((part, index) => part * (1 - p) + (b[index] as number) * p) as unknown as Color;

/**
 * Shows a moment of a plan and waits until it has these colors at these places, within two levels
 * of 255 unless said otherwise. Says how far each one is from what it should be.
 */
async function differences(
  page: Page,
  plan: RenderPlan,
  seconds: number,
  wanted: readonly (readonly [x: number, y: number, color: Color])[],
  within = 2,
): Promise<readonly number[]> {
  await show(page, plan, seconds);
  let found: readonly number[] = [];
  let read: readonly (readonly number[])[] = [];
  try {
    await expect
      .poll(async () => {
        read = await Promise.all(wanted.map(([x, y]) => pixel(page, x, y)));
        found = read.map((value, index) =>
          distance(value, (wanted[index] as [number, number, Color])[2]),
        );
        return found.every((difference) => difference <= within);
      })
      .toBe(true);
  } catch {
    throw new Error(
      `At ${seconds}, wanted ${JSON.stringify(wanted)}, found ${JSON.stringify(read)}`,
    );
  }
  return found;
}

const MIDDLE = [WIDTH / 2, HEIGHT / 2] as const;
const CORNER = [10, 10] as const;

test.describe("a dissolve", () => {
  test("keeps what both sides have in one place as it is, all the way through", async ({
    page,
  }) => {
    // Blue below, and on the track above two red boxes in the middle, one after the other.
    const plan = planOf(
      [
        color("below", 0, 4, "#0000ff"),
        color("a", 0, 2, "#ff0000", half),
        color("b", 2, 4, "#ff0000", half),
      ],
      [join("a", "b", 1.5, 2.5, "fade")],
    );
    for (const seconds of [1.5, 1.75, 2, 2.25]) {
      // The box stays red, and nothing of the blue below comes through it in the middle.
      await differences(page, plan, seconds, [
        [...MIDDLE, RED],
        [...CORNER, BLUE],
      ]);
    }
  });

  test("is the two sides mixed by how far it got, along its speed curve", async ({ page }) => {
    const layers = [color("a", 0, 2, "#ff0000"), color("b", 2, 4, "#00ff00")];
    const plain = planOf(layers, [join("a", "b", 1, 3, "fade")]);
    await differences(page, plain, 1.5, [[...MIDDLE, mix(RED, GREEN, 0.25)]]);
    await differences(page, plain, 2, [[...MIDDLE, mix(RED, GREEN, 0.5)]]);
    // Halfway through an ease in, which has done about a third of its work by then.
    const easing = planOf(layers, [join("a", "b", 1, 3, "fade", { curve: [0.42, 0, 1, 1] })]);
    const done = bezierProgress(0.42, 0, 1, 1, 0.5);
    expect(done).toBeGreaterThan(0.3);
    expect(done).toBeLessThan(0.33);
    await differences(page, easing, 2, [[...MIDDLE, mix(RED, GREEN, done)]]);
  });

  test("with nothing but black under it is the same drawn straight onto the picture", async ({
    page,
  }) => {
    // Something see-through in a box, and a box of another size, which leaves the corners out.
    const SEE_THROUGH = 192 / 255;
    const layers = [
      color("a", 0, 2, "#ff8000c0", half),
      color("b", 2, 4, "#2060ff", { channels: { "transform.scale": still(0.75) } }),
    ];
    const dissolve = join("a", "b", 1, 3, "fade");
    const straight = planOf(layers, [dissolve]);
    // With a black layer under it, its sum goes onto the picture as one picture of its own.
    const over = planOf([color("below", 0, 4, "#000000"), ...layers], [dissolve]);
    const white = planOf([color("white", 0, 4, "#ffffff")]);
    const keep = async () =>
      (await findCompositor(page))?.evaluate(() => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height);
        Object.assign(window, { kept: data?.data });
      });
    const furthest = async () =>
      (await findCompositor(page))?.evaluate(() => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height);
        const kept = (window as unknown as { kept?: Uint8ClampedArray }).kept;
        if (!data || kept?.length !== data.data.length) return Number.POSITIVE_INFINITY;
        let most = 0;
        for (let at = 0; at < kept.length; at += 1) {
          most = Math.max(most, Math.abs((kept[at] ?? 0) - (data.data[at] ?? 0)));
        }
        return most;
      });
    for (const seconds of [1.137, 2, 2.811]) {
      const progress = (seconds - 1) / 2;
      const middle = mix([255 * SEE_THROUGH, 128 * SEE_THROUGH, 0], [32, 96, 255], progress);
      const wanted: [number, number, Color][] = [
        [...MIDDLE, middle],
        [...CORNER, BLACK],
      ];
      await differences(page, straight, seconds, wanted);
      await keep();
      // Something else in between, so that what comes next is a frame of its own.
      await differences(page, white, seconds, [[...MIDDLE, WHITE]]);
      await differences(page, over, seconds, wanted);
      expect(await furthest(), `at ${seconds}`).toBeLessThanOrEqual(1);
    }
  });

  test("of a side with nothing in it is the fade that the quick way draws", async ({ page }) => {
    // A fade in, which the compositor draws by opacity, and the same through the code of a join.
    const quick = planOf([
      color("below", 0, 4, "#0000ff"),
      color("b", 1, 3, "#ff8000", {
        enter: { how: { kind: "built-in", type: "fade" }, start: 1, end: 2, duration: 1 },
      }),
    ]);
    const empty = { channels: { opacity: still(0) } };
    const coded = planOf(
      [
        color("below", 0, 4, "#0000ff"),
        color("a", 0, 1, "#ffffff", empty),
        color("b", 1, 3, "#ff8000"),
      ],
      [join("a", "b", 1, 2, "fade")],
    );
    for (const seconds of [1.2, 1.5, 1.9]) {
      const wanted = mix(BLUE, [255, 128, 0], seconds - 1);
      const [byOpacity] = await differences(page, quick, seconds, [[...MIDDLE, wanted]]);
      const [byCode] = await differences(page, coded, seconds, [[...MIDDLE, wanted]]);
      expect(Math.abs((byOpacity ?? 0) - (byCode ?? 0))).toBeLessThanOrEqual(2);
    }
  });
});

test.describe("built-in transitions", () => {
  const layers = [color("a", 0, 2, "#ff0000"), color("b", 2, 4, "#00ff00")];
  const LEFT = 100;
  const RIGHT = WIDTH - 100;
  const TOP = 60;
  const BOTTOM = HEIGHT - 60;

  test("dip to a color that covers everything in the middle, black or white", async ({ page }) => {
    for (const [variant, plain] of [
      ["black", BLACK],
      ["white", WHITE],
    ] as const) {
      const values = { color: variant === "black" ? "#000000" : "#ffffff" };
      const plan = planOf(
        [
          color("below", 0, 4, "#0000ff"),
          color("a", 0, 2, "#ff0000", half),
          color("b", 2, 4, "#00ff00", half),
        ],
        [join("a", "b", 1, 3, "dip", { how: { kind: "built-in", type: "dip", variant, values } })],
      );
      await differences(page, plan, 1, [[...MIDDLE, RED]]);
      await differences(page, plan, 1.5, [[...MIDDLE, mix(RED, plain, 0.5)]]);
      // All of the picture is the color in the middle, also where nothing was on either side.
      await differences(page, plan, 2, [
        [...MIDDLE, plain],
        [...CORNER, plain],
      ]);
      await differences(page, plan, 2.5, [[...MIDDLE, mix(plain, GREEN, 0.5)]]);
    }
  });

  test("wipe across the way they say, with a soft edge", async ({ page }) => {
    const wipe = (variant: string, direction: readonly number[]) =>
      planOf(layers, [
        join("a", "b", 1, 3, "wipe", {
          how: { kind: "built-in", type: "wipe", variant, values: { softness: 0.02, direction } },
        }),
      ]);
    const cases = [
      ["left", [-1, 0], [RIGHT, HEIGHT / 2], [LEFT, HEIGHT / 2]],
      ["right", [1, 0], [LEFT, HEIGHT / 2], [RIGHT, HEIGHT / 2]],
      ["up", [0, -1], [WIDTH / 2, BOTTOM], [WIDTH / 2, TOP]],
      ["down", [0, 1], [WIDTH / 2, TOP], [WIDTH / 2, BOTTOM]],
    ] as const;
    for (const [variant, direction, passed, ahead] of cases) {
      const plan = wipe(variant, direction);
      // Nothing of the side after at the start, half of the picture in the middle, all at the end.
      await differences(page, plan, 1, [
        [...passed, RED],
        [...ahead, RED],
      ]);
      await differences(page, plan, 2, [
        [...passed, GREEN],
        [...ahead, RED],
      ]);
      await differences(page, plan, 2.999, [
        [...passed, GREEN],
        [...ahead, GREEN],
      ]);
    }
    // The edge is soft over 2% of the short side, which is 7.2 pixels here, and in the middle of it
    // at the middle of the wipe: half way across the picture and the edge.
    const plan = wipe("right", [1, 0]);
    const edge = (WIDTH + 7.2) / 2;
    const x = Math.floor(edge - 3.6);
    const shown = (edge - (x + 0.5)) / 7.2;
    await differences(page, plan, 2, [[x, HEIGHT / 2, mix(RED, GREEN, shown)]], 4);
  });

  test("wipe the same as across the whole picture, only working on the band of the edge", async ({
    page,
  }) => {
    /** A row or a column of the picture across the edge, as the compositor drew it. */
    const line = async (across: boolean) => {
      const frame = await findCompositor(page);
      return frame?.evaluate((horizontal) => {
        const canvas = document.querySelector("canvas");
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return [];
        const data = horizontal
          ? context.getImageData(0, canvas.height / 2, canvas.width, 1).data
          : context.getImageData(canvas.width / 2, 0, 1, canvas.height).data;
        return [...data];
      }, across);
    };
    /** The same row or column of the wipe this one replaced, which drew on the whole picture. */
    const before = (progress: number, direction: readonly number[]) =>
      page.evaluate(
        ({ width, height, progress: p, direction: [x = 0, y = 0] }) => {
          const fill = (paint: string) => {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
            context.fillStyle = paint;
            context.fillRect(0, 0, width, height);
            return canvas;
          };
          const [from, to] = [fill("#ff0000"), fill("#00ff00")];
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
          const after = new OffscreenCanvas(width, height);
          const cut = after.getContext("2d") as OffscreenCanvasRenderingContext2D;
          const across = Math.abs(x) >= Math.abs(y);
          const length = across ? width : height;
          const soft = Math.max(0.02 * Math.min(width, height), 0.5);
          const edge = p * (length + soft);
          const forwards = across ? x > 0 : y > 0;
          const along = (away: number) => (forwards ? away : length - away);
          const full = along(edge - soft);
          const none = along(edge);
          const keep = (target: OffscreenCanvasRenderingContext2D, operation: string) => {
            const gradient = across
              ? target.createLinearGradient(full, 0, none, 0)
              : target.createLinearGradient(0, full, 0, none);
            gradient.addColorStop(0, "#000000ff");
            gradient.addColorStop(1, "#00000000");
            target.globalCompositeOperation = operation as GlobalCompositeOperation;
            target.fillStyle = gradient;
            target.fillRect(0, 0, width, height);
          };
          context.drawImage(from, 0, 0);
          keep(context, "destination-out");
          cut.drawImage(to, 0, 0);
          keep(cut, "destination-in");
          context.globalCompositeOperation = "lighter";
          context.drawImage(after, 0, 0);
          // Onto the black behind everything, as the compositor puts it.
          const shown = new OffscreenCanvas(width, height);
          const picture = shown.getContext("2d") as OffscreenCanvasRenderingContext2D;
          picture.fillStyle = "#000000";
          picture.fillRect(0, 0, width, height);
          picture.drawImage(canvas, 0, 0);
          const data = across
            ? picture.getImageData(0, height / 2, width, 1).data
            : picture.getImageData(width / 2, 0, 1, height).data;
          return [...data];
        },
        { width: WIDTH, height: HEIGHT, progress, direction },
      );
    for (const [variant, direction] of [
      ["right", [1, 0]],
      ["left", [-1, 0]],
      ["up", [0, -1]],
    ] as const) {
      for (const progress of [0.137, 0.5, 0.811]) {
        const plan = planOf(
          [color("a", 0, 2, "#ff0000"), color("b", 2, 4, "#00ff00")],
          [
            join("a", "b", 1, 3, "wipe", {
              how: {
                kind: "built-in",
                type: "wipe",
                variant,
                values: { softness: 0.02, direction: [...direction] },
              },
            }),
          ],
        );
        const seconds = 1 + 2 * progress;
        const wanted = await before(progress, direction);
        await show(page, plan, seconds);
        let worst = Number.POSITIVE_INFINITY;
        await expect
          .poll(async () => {
            const found = (await line(direction[0] !== 0)) ?? [];
            worst =
              found.length === wanted.length
                ? Math.max(...found.map((value, at) => Math.abs(value - (wanted[at] ?? 0))))
                : Number.POSITIVE_INFINITY;
            return worst;
          }, `${variant} at ${progress}`)
          .toBeLessThanOrEqual(1);
      }
    }
  });

  test("push the side before out with the side after, and overshoot where the curve does", async ({
    page,
  }) => {
    const push = (variant: string, direction: readonly number[], more: Partial<RenderJoin> = {}) =>
      planOf(
        [color("a", 0, 2, "#ff0000", half), color("b", 2, 4, "#00ff00", half)],
        [
          join("a", "b", 1, 3, "push", {
            how: { kind: "built-in", type: "push", variant, values: { direction } },
            overshoot: true,
            ...more,
          }),
        ],
      );
    // Halfway, the box before is half the picture further on, the one after half of it short.
    await differences(page, push("right", [1, 0]), 2, [
      [WIDTH * 0.8, HEIGHT / 2, RED],
      [WIDTH * 0.1, HEIGHT / 2, GREEN],
      [...MIDDLE, BLACK],
    ]);
    await differences(page, push("up", [0, -1]), 2, [
      [WIDTH / 2, HEIGHT * 0.15, RED],
      [WIDTH / 2, HEIGHT * 0.9, GREEN],
      [...MIDDLE, BLACK],
    ]);
    // A curve that goes past the end takes the box after further than the middle, and then back.
    const curve = [0.3, 2, 0.6, 1.4] as const;
    const bouncing = push("right", [1, 0], { curve });
    const seconds = 2.6;
    const progress = bezierProgress(...curve, (seconds - 1) / 2);
    expect(progress).toBeGreaterThan(1.05);
    // Just inside the right edge of the box after, which is past where it ends up.
    const right = WIDTH * 0.75 + (progress - 1) * WIDTH - 3;
    expect(right).toBeGreaterThan(WIDTH * 0.75 + 10);
    await differences(page, bouncing, seconds, [[Math.floor(right), HEIGHT / 2, GREEN]]);
    await differences(page, bouncing, 2.999, [[...MIDDLE, GREEN]]);
  });
});

test.describe("transitions that run into each other", () => {
  test("of a clip too short for its two joins go one after the other", async ({ page }) => {
    // Half a second of green between red and blue, with a second long dissolve on each cut.
    const plan = planOf(
      [color("a", 0, 1, "#ff0000"), color("b", 1, 1.5, "#00ff00"), color("c", 1.5, 3, "#0000ff")],
      [join("a", "b", 0.5, 1.5, "fade"), join("b", "c", 1, 2, "fade")],
    );
    // Three quarters of the first and a quarter of the second, of what the first made.
    const first = mix(RED, GREEN, 0.75);
    await differences(page, plan, 1.25, [[...MIDDLE, mix(first, BLUE, 0.25)]], 3);
  });

  test("at the edges of a clip come in first and go out after, with a fade going last", async ({
    page,
  }) => {
    const dip = {
      how: {
        kind: "built-in" as const,
        type: "dip",
        variant: "black",
        values: { color: "#000000" },
      },
      start: 0,
      end: 1,
      duration: 1,
    };
    const fade = {
      how: { kind: "built-in" as const, type: "fade" },
      start: 0.5,
      end: 2,
      duration: 1.5,
    };
    const plan = planOf([
      color("below", 0, 2, "#0000ff"),
      color("x", 0, 2, "#ff0000", { enter: dip, exit: fade }),
    ]);
    // From black at three quarters of the way, faded out by a sixth after that: what the dip made
    // fades, black and all, and the blue below shows through as much.
    const shown = 5 / 6;
    const wanted: Color = [255 * 0.75 * shown, 0, 255 * (1 - shown)];
    await differences(page, plan, 0.75, [[...MIDDLE, wanted]], 3);
  });
});

test.describe("a join past the ends of its clips", () => {
  const redBlue = readFileSync(new URL("./fixtures/red-blue.webm", import.meta.url));

  async function sendVideo(page: Page): Promise<void> {
    await compositorListens(page);
    await content(page, "preview")
      .locator("iframe")
      .evaluate(
        (element: HTMLIFrameElement, bytes) => {
          const file = new Blob([new Uint8Array(bytes)], { type: "video/webm" });
          element.contentWindow?.postMessage({ type: "file", id: "red-blue", file }, "*");
        },
        [...redBlue],
      );
  }

  const video = (id: string, start: number, end: number, offset: number): RenderLayer => ({
    id,
    start,
    end,
    offset,
    source: { kind: "video", file: "red-blue" },
    fit: "cover",
    channels: {},
  });

  test("shows the first frame of a file before it starts, and its last one after it ends", async ({
    page,
  }) => {
    await sendVideo(page);
    /** The color of the video on its own, at a place in its file. */
    const alone = async (at: number, near: Color) => {
      const plan = planOf([video("v", 0, 10, at)]);
      await differences(page, plan, 0, [[...MIDDLE, near]], 80);
      return (await pixel(page, ...MIDDLE)) as unknown as Color;
    };
    const first = await alone(0, RED);
    const last = await alone(1.9, BLUE);
    // Green, and then the video from its first frame, with a dissolve of two seconds in the middle.
    const before = planOf(
      [color("a", 0, 2, "#00ff00"), video("b", 2, 4, 0)],
      [join("a", "b", 1, 3, "fade")],
    );
    // A quarter of the way, the video is half a second before its start, which is its first frame.
    await differences(page, before, 1.5, [[...MIDDLE, mix(GREEN, first, 0.25)]], 3);
    // The file has two seconds, and what is past them is the last frame.
    const after = planOf(
      [video("a", 0, 0.5, 1.5), color("b", 0.5, 2, "#00ff00")],
      [join("a", "b", 0, 1.5, "fade", { duration: 1.5 })],
    );
    await differences(page, after, 1.2, [[...MIDDLE, mix(last, GREEN, 0.8)]], 3);
  });
});

test.describe("joins on the timeline", () => {
  test.use({ withProject: false });
  const clipsAt = (page: Page) => content(page, "timeline").getByRole("option");

  /** Where the first clip ends and the second starts, at the height of the clips or of their top. */
  async function cut(page: Page, atTop = false): Promise<{ x: number; y: number }> {
    const box = await clipsAt(page).first().boundingBox();
    if (!box) throw new Error("No clip");
    return { x: box.x + box.width, y: atTop ? box.y + 8 : box.y + box.height / 2 + 8 };
  }

  async function middleOfPicture(page: Page): Promise<readonly number[]> {
    const frame = await findCompositor(page);
    const read = frame?.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return [];
      const data = canvas.getContext("2d")?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1);
      return data ? [...data.data].slice(0, 3) : [];
    });
    return (await read?.catch(() => [])) ?? [];
  }

  async function goTo(page: Page, time: string): Promise<void> {
    await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
    await page.getByRole("textbox", { name: "当前时间" }).fill(time);
    await page.keyboard.press("Enter");
  }

  test("go on a cut from its menu, show in the picture, change, go, and come back", async ({
    page,
  }) => {
    await importClips(page, 4, [
      {
        id: "a",
        name: "红",
        start: "0",
        duration: "2",
        source: { kind: "color", color: "#ff0000" },
      },
      {
        id: "b",
        name: "绿",
        start: "2",
        duration: "2",
        source: { kind: "color", color: "#00ff00" },
      },
    ]);
    const properties = content(page, "properties");
    const seam = await cut(page);
    await page.mouse.click(seam.x - 2, seam.y, { button: "right" });
    await page.getByRole("menuitem", { name: "添加衔接转场" }).click();
    await expect(properties.getByText("红 → 绿")).toBeVisible();
    await expect(properties.getByLabel("叠化")).toBeVisible();
    // At the cut, half way through a dissolve of half a second around it.
    await goTo(page, "0:02/00");
    await expect.poll(() => middleOfPicture(page)).toEqual([128, 128, 0]);

    // What it is changes from the menu of its block, where it is from the buttons.
    const block = await cut(page, true);
    await page.mouse.click(block.x, block.y, { button: "right" });
    await page.getByRole("menuitemradio", { name: "向左推移" }).click();
    await expect(properties.getByLabel("向左推移")).toBeVisible();
    await properties.getByRole("button", { name: "从剪切点开始" }).click();
    await expect(properties.getByRole("button", { name: "从剪切点开始" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // From the cut on, so at the cut nothing of the clip after has come in yet.
    await expect.poll(() => middleOfPicture(page)).toEqual([255, 0, 0]);

    // A click on its block selects it, and Delete there takes it away.
    await page.mouse.click(block.x + 4, block.y);
    await page.keyboard.press("Delete");
    await expect(properties.getByText("红 → 绿")).toHaveCount(0);
    await expect.poll(() => middleOfPicture(page)).toEqual([0, 255, 0]);
    await page.keyboard.press("Control+z");
    // Inside the block: from the cut on, it starts right at the cut, which a pixel can miss.
    await page.mouse.click(block.x + 4, block.y);
    await expect(properties.getByLabel("向左推移")).toBeVisible();
  });

  test("go when the clips are taken apart, which people hear, and undo brings them back", async ({
    page,
  }) => {
    await importClips(page, 6, [
      {
        id: "a",
        name: "红",
        start: "0",
        duration: "2",
        source: { kind: "color", color: "#ff0000" },
      },
      {
        id: "b",
        name: "绿",
        start: "2",
        duration: "2",
        source: { kind: "color", color: "#00ff00" },
      },
    ]);
    const seam = await cut(page);
    await page.mouse.click(seam.x - 2, seam.y, { button: "right" });
    await page.getByRole("menuitem", { name: "添加衔接转场" }).click();
    const second = await clipsAt(page).nth(1).boundingBox();
    if (!second) throw new Error("No clip");
    const from = { x: second.x + second.width / 2, y: second.y + second.height - 6 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y, { steps: 4 });
    await page.mouse.move(from.x + 80, from.y, { steps: 4 });
    await page.mouse.up();
    await expect(
      page.getByText("1 个衔接转场两边的片段分开了，衔接转场已删除。撤销可以恢复。"),
    ).toBeVisible();
    await page.keyboard.press("Control+z");
    const block = await cut(page, true);
    await page.mouse.click(block.x, block.y);
    await expect(content(page, "properties").getByText("红 → 绿")).toBeVisible();
  });
});
