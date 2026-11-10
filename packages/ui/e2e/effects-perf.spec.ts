import type { Page } from "@playwright/test";
import { compileChannel, type RenderLayer, type RenderPlan } from "@animaquill/core";
import { content, expect, findCompositor, test } from "./support.ts";

/**
 * What effects cost the compositor at 1080p and 4K: a full-picture clip with each effect on its
 * own, and with all of them one after the other, against the same clip without. Each is a whole
 * picture drawn and finished, as an export has them, so what the graphics card does counts too.
 * Without a graphics card, as on a server, the canvas draws in software, which is far slower.
 * The numbers are what this is for, so it only fails when pictures do not come at all.
 */

const SIZES = { "1080p": [1920, 1080], "4K": [3840, 2160] } as const;
const FPS = 60;
const SECONDS = 3;

test.setTimeout(600_000);

const still = (value: unknown) => ({ kind: "still", value }) as const;

const EFFECTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  brightness: { brightness: 0.3 },
  contrast: { contrast: 0.3 },
  saturation: { saturation: 0.5 },
  temperature: { temperature: 0.5 },
  blur: { radius: 20 },
  crop: { left: 0.1, right: 0.1 },
};

/** Other values of an effect, measured on their own: the blur repeats the edge at first. */
const VARIANTS: Readonly<Record<string, readonly [string, Readonly<Record<string, unknown>>]>> = {
  "blur, transparent edge": ["blur", { radius: 20, edge: "transparent" }],
};

function planOf(
  [width, height]: readonly [number, number],
  types: readonly string[],
  values: Readonly<Record<string, Readonly<Record<string, unknown>>>> = EFFECTS,
): RenderPlan {
  // It moves, so that every frame is another picture and gets drawn.
  const moving = {
    keys: [
      { time: "0", value: -20 },
      { time: String(SECONDS + 2), value: 20 },
    ],
  };
  const channels: Record<string, unknown> = { "transform.x": compileChannel(moving, "number") };
  for (const type of types) {
    for (const [name, value] of Object.entries(values[type] ?? {})) {
      channels[`effect.${type}.${name}`] = still(value);
    }
  }
  const layer: RenderLayer = {
    id: "c",
    start: 0,
    end: SECONDS + 2,
    offset: 0,
    source: { kind: "color", color: "#3070c0" },
    fit: "contain",
    channels: channels as RenderLayer["channels"],
    ...(types.length > 0 && { effects: types.map((type) => ({ id: type, type })) }),
  };
  return {
    width,
    height,
    stage: { width: 1920, height: 1080 },
    camera: {},
    scenes: { format: "f", language: "zh-CN", fps: { num: FPS, den: 1 } },
    background: "#000000",
    layers: [layer],
    joins: [],
  };
}

const tell = (page: Page, message: unknown) =>
  content(page, "preview")
    .locator("iframe")
    .evaluate(
      (element: HTMLIFrameElement, sent) => element.contentWindow?.postMessage(sent, "*"),
      message,
    );

/**
 * How long the compositor takes for a whole picture of a moment of a plan, one after another: the
 * same drawing as the preview and an export, waiting for everything, see `paintStill`. Each picture
 * also gets copied out, which the picture without effects says how long that takes.
 */
async function stills(page: Page, plan: RenderPlan, count: number): Promise<readonly number[]> {
  await tell(page, { type: "plan", plan });
  await expect.poll(async () => (await findCompositor(page)) !== undefined).toBe(true);
  return content(page, "preview")
    .locator("iframe")
    .evaluate(
      async (element: HTMLIFrameElement, { total }) => {
        const times: number[] = [];
        for (let index = -2; index < total; index += 1) {
          const request = 900_000 + Math.floor(Math.random() * 99_999);
          const began = performance.now();
          await new Promise<void>((resolve) => {
            const listen = (event: MessageEvent) => {
              const data = event.data as { type?: string; request?: number; image?: ImageBitmap };
              if (data?.type !== "still" || data.request !== request) return;
              removeEventListener("message", listen);
              data.image?.close();
              resolve();
            };
            addEventListener("message", listen);
            element.contentWindow?.postMessage(
              { type: "still", request, seconds: 1 + (index + 2) / 60 },
              "*",
            );
          });
          // The first two get things ready, which a playing preview does once.
          if (index >= 0) times.push(performance.now() - began);
        }
        return times;
      },
      { total: count },
    );
}

const quantile = (values: readonly number[], share: number) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length * share)] ?? Number.NaN;
const round = (value: number) => Math.round(value * 10) / 10;

for (const [name, size] of Object.entries(SIZES)) {
  test(`effects at ${name}, against none`, async ({ page }) => {
    test.skip(name === "4K" && !process.env["AQ_PERF_4K"], "4K only when asked for: AQ_PERF_4K=1");
    const lines = [`${name}`];
    const cases: readonly (readonly [string, readonly string[], typeof EFFECTS?])[] = [
      ["none", []],
      ...Object.keys(EFFECTS).map((type) => [type, [type]] as const),
      ...Object.entries(VARIANTS).map(
        ([label, [type, values]]) => [label, [type], { [type]: values }] as const,
      ),
      ["all six", Object.keys(EFFECTS)],
    ];
    for (const [label, types, values] of cases) {
      const times = await stills(page, planOf(size, types, values), 12);
      const median = quantile(times, 0.5);
      const found = { median: round(median), p90: round(quantile(times, 0.9)) };
      lines.push(`${label} ${JSON.stringify(found)}`);
    }
    console.log(lines.join("\n"));
    expect(lines).toHaveLength(cases.length + 1);
  });
}
