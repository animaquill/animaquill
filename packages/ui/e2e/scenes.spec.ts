import type { Frame, Page } from "@playwright/test";
import {
  canCapture,
  chooseFolder,
  clickFirstClip,
  colorAt,
  compositor,
  content,
  distance,
  expect,
  goTo,
  importFolder,
  openAnyway,
  openScene,
  previewButton,
  projectFolder,
  sceneFrames,
  tab,
  test,
  type Color,
} from "./scene-support.ts";

const clips = (page: Page) => content(page, "timeline").getByRole("option");
const items = (page: Page) => content(page, "assets").getByRole("listitem");
const field = (page: Page, name: string) =>
  content(page, "properties").getByRole("spinbutton", { name, exact: true });

/**
 * A white square on black that goes from left to right over ten seconds: at second n it is at
 * 192·n world units, so where it is says which moment the picture is of.
 */
const SLIDE = `<!doctype html><style>
  body { background: #000 }
  #square { position: absolute; left: 0; top: 490px; width: 100px; height: 100px; background: #fff;
    animation: slide 10s linear both }
  @keyframes slide { to { transform: translateX(1920px) } }
</style><div id="square"></div>`;

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** Whether the square is at this many seconds. Its middle is 50 to the right of where it starts. */
const squareIsAt = async (page: Page, seconds: number) => {
  const x = Math.round(seconds * 192 + 50);
  return distance(await colorAt(page, x, 540), WHITE) < 8;
};

test.describe("a scene from the start", () => {
  test.use({ withProject: false });

  test.describe("that can be captured", () => {
    test.skip(!canCapture, "needs a browser that can capture");

    test("shows the moment of the playhead", async ({ page }) => {
      await openScene(page, SLIDE);
      await expect.poll(() => squareIsAt(page, 0)).toBe(true);
      await goTo(page, "0:05/00");
      await expect.poll(() => squareIsAt(page, 5)).toBe(true);
      expect(await squareIsAt(page, 0)).toBe(false);
    });

    test("goes backwards just like forwards", async ({ page }) => {
      await openScene(page, SLIDE);
      await goTo(page, "0:08/00");
      await expect.poll(() => squareIsAt(page, 8)).toBe(true);
      await goTo(page, "0:03/00");
      await expect.poll(() => squareIsAt(page, 3)).toBe(true);
      await goTo(page, "0:06/00");
      await expect.poll(() => squareIsAt(page, 6)).toBe(true);
    });

    test("follows the playhead while it is dragged", async ({ page }) => {
      await openScene(page, SLIDE);
      await expect.poll(() => squareIsAt(page, 0)).toBe(true);
      const box = await content(page, "timeline").locator("canvas").first().boundingBox();
      if (!box) throw new Error("no timeline");
      await page.mouse.move(box.x + 300, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 400, box.y + 10, { steps: 10 });
      await page.mouse.move(box.x + 200, box.y + 10, { steps: 10 });
      await page.mouse.up();
      const time = await page
        .getByRole("contentinfo")
        .getByRole("button", { name: "当前时间和总时长" })
        .innerText();
      const [minutes = "0", rest = ""] = time.split("|")[0]?.trim().split(":") ?? [];
      const [seconds = "0", frames = "0"] = rest.split("/");
      const moment = Number(minutes) * 60 + Number(seconds) + Number(frames) / 30;
      await expect.poll(() => squareIsAt(page, moment)).toBe(true);
    });

    test("plays by itself, and stops where the playhead stops", async ({ page }) => {
      await openScene(page, SLIDE);
      await expect.poll(() => squareIsAt(page, 0)).toBe(true);
      await previewButton(page, "播放").click();
      await expect.poll(() => squareIsAt(page, 0)).toBe(false);
      await page.waitForTimeout(1000);
      await previewButton(page, "暂停").click();
      const time = page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" });
      const [, rest = ""] = (await time.innerText()).split("|")[0]?.trim().split(":") ?? [];
      const [seconds = "0", frames = "0"] = rest.split("/");
      const moment = Number(seconds) + Number(frames) / 30;
      expect(moment).toBeGreaterThan(0.5);
      await expect.poll(() => squareIsAt(page, moment)).toBe(true);
    });

    test("goes on playing for longer than a seek may take", async ({ page }) => {
      test.setTimeout(30000);
      await openScene(page, SLIDE, { duration: "25" });
      await expect.poll(() => squareIsAt(page, 0)).toBe(true);
      const [frame] = sceneFrames(page);
      await previewButton(page, "播放").click();
      await page.waitForTimeout(12000);
      expect(sceneFrames(page)).toEqual([frame]);
      await expect(content(page, "preview").getByText("没有响应")).toHaveCount(0);
      await previewButton(page, "暂停").click();
    });

    test("a jump back while playing goes back", async ({ page }) => {
      await openScene(page, SLIDE);
      await goTo(page, "0:06/00");
      await expect.poll(() => squareIsAt(page, 6)).toBe(true);
      await previewButton(page, "播放").click();
      await page.waitForTimeout(300);
      await goTo(page, "0:02/00");
      await expect
        .poll(async () => (await squareIsAt(page, 2)) || (await squareIsAt(page, 2.2)))
        .toBe(true);
      await previewButton(page, "暂停").click();
    });

    test("comes from another moment after a cut, on the clock of the clip", async ({ page }) => {
      await openScene(page, SLIDE, { offset: "4", duration: "5" });
      await expect.poll(() => squareIsAt(page, 4)).toBe(true);
      await goTo(page, "0:01/00");
      await expect.poll(() => squareIsAt(page, 5)).toBe(true);
    });

    test("is ready when its clip comes up while playing", async ({ page }) => {
      const later = { start: "1", duration: "5" };
      await importFolder(page, projectFolder({ a: { "index.html": SLIDE } }, [later]));
      await expect.poll(() => sceneFrames(page).length).toBe(1);
      await expect.poll(() => colorAt(page, 960, 100)).toEqual([0, 0, 0, 255]);
      await previewButton(page, "播放").click();
      await expect.poll(() => squareIsAt(page, 0.2), { timeout: 2000 }).toBe(true);
      await previewButton(page, "暂停").click();
    });

    test("goes back through code that ran, and ends up in the same place", async ({ page }) => {
      const stateful = `<!doctype html><style>
        body { background: #000 }
        #square { position: absolute; left: 0; top: 490px; width: 100px; height: 100px; background: #fff }
      </style><div id="square"></div><script>
        let x = 0;
        requestAnimationFrame(function step() {
          x += 6.4;
          document.getElementById("square").style.left = x + "px";
          requestAnimationFrame(step);
        });
      </script>`;
      await openScene(page, stateful);
      await goTo(page, "0:06/00");
      await expect.poll(() => squareIsAt(page, 6), { timeout: 10000 }).toBe(true);
      await goTo(page, "0:02/00");
      await expect.poll(() => squareIsAt(page, 2), { timeout: 10000 }).toBe(true);
    });

    test("a new state of a scene takes over with no gap, on an origin of its own", async ({
      page,
    }) => {
      const green = `<!doctype html><style>body { background: #0f0 }</style>`;
      await importFolder(page, projectFolder({ a: { "index.html": green } }, [{ id: "c" }]));
      await expect
        .poll(async () => distance(await colorAt(page, 960, 540), [0, 255, 0]))
        .toBeLessThan(8);
      const [before] = sceneFrames(page);
      const origin = new URL(before?.url() ?? "").origin;
      await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('[data-panel="preview"] iframe');
        const blue = "<!doctype html><style>body { background: #00f }</style>";
        const layer = {
          id: "c",
          start: 0,
          end: 10,
          offset: 0,
          fit: "fixed",
          fades: { in: 0, out: 0 },
          channels: {},
          source: {
            kind: "scene",
            scene: "a",
            entry: "scenes/a/index.html",
            runtime: 1,
            revision: "new",
            assets: [],
            seed: 1,
          },
        };
        const plan = {
          width: 1920,
          height: 1080,
          stage: { width: 1920, height: 1080 },
          camera: {},
          background: "#000000",
          scenes: { format: "landscape", language: "zh-CN", fps: { num: 30, den: 1 } },
          layers: [layer],
        };
        const say = (message: unknown) => frame?.contentWindow?.postMessage(message, "*");
        const files = new Map([["scenes/a/index.html", new Blob([blue])]]);
        say({ type: "plan", plan });
        say({ type: "scene-files", scene: "a", revision: "new", files, assets: new Map() });
      });
      const seen = new Set<string>();
      await expect
        .poll(async () => {
          const parts = await colorAt(page, 960, 540);
          seen.add(
            parts
              .slice(0, 3)
              .map((part) => (part > 128 ? "x" : "-"))
              .join(""),
          );
          return parts[2] > 200;
        })
        .toBe(true);
      expect(seen.has("---")).toBe(false);
      await expect.poll(() => sceneFrames(page).length).toBe(1);
      expect(new URL(sceneFrames(page)[0]?.url() ?? "").origin).not.toBe(origin);
    });

    test("does not start over while somebody drags the size of its box", async ({ page }) => {
      await openScene(page, SLIDE);
      await expect.poll(() => squareIsAt(page, 0)).toBe(true);
      await tab(page, "timeline").click();
      await clickFirstClip(page);
      await tab(page, "properties").click();
      const [frame] = sceneFrames(page);
      const box = await field(page, "大小 宽").boundingBox();
      if (!box) throw new Error("no field");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 12 });
      expect(sceneFrames(page)).toEqual([frame]);
      await page.mouse.up();
      expect(sceneFrames(page)).toEqual([frame]);
      // Saving is when the box has its new size, which takes a new layout.
      await page.keyboard.press("Control+s");
      await expect.poll(() => sceneFrames(page)[0] !== frame, { timeout: 8000 }).toBe(true);
    });

    test("behind another tab it has nothing to say", async ({ page }) => {
      await openScene(page, SLIDE);
      await expect.poll(() => squareIsAt(page, 0)).toBe(true);
      await page.getByRole("button", { name: "视图" }).click();
      await page.getByRole("menuitem", { name: "代码" }).click();
      await goTo(page, "0:03/00");
      await page.waitForTimeout(1500);
      await expect(page.getByText("浏览器没有绘制这一帧")).toHaveCount(0);
      // Coming back shows where the playhead went in the meantime, without it having to move.
      await tab(page, "preview").click();
      await expect.poll(() => squareIsAt(page, 3)).toBe(true);
    });

    test("keeps a pixel of its frame on the screen, or the browser would stop it", async ({
      page,
    }) => {
      await openScene(page, SLIDE);
      await expect.poll(() => squareIsAt(page, 0)).toBe(true);
      const shown = await compositor(page).evaluate(() =>
        [...document.querySelectorAll("iframe")].map((frame) => {
          const { left, top, width, height } = frame.getBoundingClientRect();
          return { left, top, width, height, right: innerWidth, bottom: innerHeight };
        }),
      );
      expect(shown).toHaveLength(1);
      const [{ left, top, width, height, right, bottom }] = shown as [(typeof shown)[number]];
      expect([width, height]).toEqual([1920, 1080]);
      expect(left).toBeLessThanOrEqual(right - 1);
      expect(top).toBeLessThanOrEqual(bottom - 1);
      // Only a corner of it: the rest would be in front of the picture.
      expect(left).toBeGreaterThan(right - 20);
      expect(top).toBeGreaterThan(bottom - 20);
    });

    test("goes away after its clip, and the picture goes with it", async ({ page }) => {
      await openScene(page, SLIDE, { duration: "2" });
      await expect.poll(() => squareIsAt(page, 0)).toBe(true);
      await goTo(page, "0:10/00");
      await expect.poll(() => squareIsAt(page, 0)).toBe(false);
      await expect.poll(() => sceneFrames(page).length, { timeout: 6000 }).toBe(0);
    });

    test("shows what is behind it through what it leaves open", async ({ page }) => {
      const hole = `<!doctype html><style>
        html, body { background: transparent }
        #half { position: absolute; left: 0; top: 0; width: 960px; height: 1080px; background: #0f0 }
      </style><div id="half"></div>`;
      await openScene(page, hole);
      await expect
        .poll(async () => distance(await colorAt(page, 480, 540), [0, 255, 0]))
        .toBeLessThan(8);
      expect(distance(await colorAt(page, 1440, 540), BLACK)).toBeLessThan(8);
    });

    test("shows sharp text at the size of the picture", async ({ page }) => {
      const text = `<!doctype html><style>body { background: #fff; color: #000; font: 200px sans-serif }</style>
        <div>AnimaQuill</div>`;
      await openScene(page, text);
      await expect
        .poll(async () =>
          compositor(page).evaluate(() => {
            const canvas = document.querySelector("canvas");
            const row = canvas?.getContext("2d")?.getImageData(0, 120, 1000, 1).data ?? [];
            let edges = 0;
            for (let x = 4; x < row.length; x += 4) {
              if (Math.abs((row[x] as number) - (row[x - 4] as number)) > 100) edges += 1;
            }
            return edges;
          }),
        )
        .toBeGreaterThan(5);
    });

    test("runs modules, styles and data of the project, from the folder it came in", async ({
      page,
    }) => {
      const scene = {
        "index.html": `<!doctype html><link rel="stylesheet" href="css/style.css">
          <div id="box"></div><script type="module" src="main.js"></script>`,
        "css/style.css": `body { background: #000 } #box { position: absolute; inset: 0 }`,
        "main.js": `import { color } from "./lib/color.js";
          document.getElementById("box").style.background = color;`,
        "lib/color.js": `export const color = "#00f";`,
      };
      await importFolder(page, projectFolder({ a: scene }, [{}]));
      await expect
        .poll(async () => distance(await colorAt(page, 960, 540), [0, 0, 255]))
        .toBeLessThan(8);
    });
  });

  test.describe("that moves like any other clip", () => {
    test.skip(!canCapture, "needs a browser that can capture");

    /** Red on the left half, green on the right. Where the middle goes shows what the clip did. */
    const HALVES = `<!doctype html><style>
      body { background: linear-gradient(to right, #f00 50%, #0f0 50%) }
    </style>`;

    const isNear = async (page: Page, x: number, y: number, color: readonly number[]) =>
      distance(await colorAt(page, x, y), color) < 12;

    test("moves", async ({ page }) => {
      await openScene(page, HALVES, { properties: { "transform.x": 300 } });
      await expect.poll(() => isNear(page, 500, 540, [255, 0, 0])).toBe(true);
      expect(await isNear(page, 100, 540, BLACK)).toBe(true);
      expect(await isNear(page, 1200, 540, [255, 0, 0])).toBe(true);
      expect(await isNear(page, 1400, 540, [0, 255, 0])).toBe(true);
    });

    test("scales around its middle", async ({ page }) => {
      await openScene(page, HALVES, { properties: { "transform.scale": 0.5 } });
      await expect.poll(() => isNear(page, 700, 540, [255, 0, 0])).toBe(true);
      expect(await isNear(page, 400, 540, BLACK)).toBe(true);
      expect(await isNear(page, 1200, 540, [0, 255, 0])).toBe(true);
      expect(await isNear(page, 1500, 540, BLACK)).toBe(true);
    });

    test("turns", async ({ page }) => {
      await openScene(page, HALVES, { properties: { "transform.rotation": 180 } });
      await expect.poll(() => isNear(page, 400, 540, [0, 255, 0])).toBe(true);
      expect(await isNear(page, 1500, 540, [255, 0, 0])).toBe(true);
    });

    test("fades", async ({ page }) => {
      await openScene(page, HALVES, { properties: { opacity: 0.5 } });
      await expect.poll(() => isNear(page, 400, 540, [128, 0, 0])).toBe(true);
    });

    test("gets a box of another size, and is laid out for that", async ({ page }) => {
      const circle = `<!doctype html><style>
        body { background: #00f }
        #mark { position: absolute; left: 0; top: 0; width: 100vw; height: 50vh; background: #ff0 }
      </style><div id="mark"></div>`;
      const properties = { "transform.width": 400, "transform.height": 400 };
      await openScene(page, circle, { properties });
      await expect.poll(() => isNear(page, 960, 440, [255, 255, 0])).toBe(true);
      expect(await isNear(page, 960, 640, [0, 0, 255])).toBe(true);
      expect(await isNear(page, 1100, 540, [0, 0, 255])).toBe(true);
      expect(await isNear(page, 1200, 540, BLACK)).toBe(true);
    });

    test("fills the stage in a format with fewer pixels, which is the same world", async ({
      page,
    }) => {
      const format = { id: "small", name: "小", width: 960, height: 540, fps: "30" };
      await importFolder(page, projectFolder({ a: { "index.html": HALVES } }, [{}], format));
      await expect.poll(() => isNear(page, 20, 270, [255, 0, 0])).toBe(true);
      expect(await isNear(page, 460, 270, [255, 0, 0])).toBe(true);
      expect(await isNear(page, 500, 270, [0, 255, 0])).toBe(true);
      expect(await isNear(page, 940, 270, [0, 255, 0])).toBe(true);
    });

    test("stretches its picture to a box that is only being tried", async ({ page }) => {
      await openScene(page, HALVES);
      await expect.poll(() => isNear(page, 100, 540, [255, 0, 0])).toBe(true);
      await tab(page, "timeline").click();
      await clickFirstClip(page);
      await tab(page, "properties").click();
      await field(page, "大小 宽").click();
      await field(page, "大小 宽").fill("960");
      await field(page, "大小 宽").press("Enter");
      await expect.poll(() => isNear(page, 100, 540, BLACK)).toBe(true);
      expect(await isNear(page, 600, 540, [255, 0, 0])).toBe(true);
      expect(await isNear(page, 1300, 540, [0, 255, 0])).toBe(true);
      expect(await isNear(page, 1800, 540, BLACK)).toBe(true);
    });

    test("follows keys, at the moment of the playhead", async ({ page }) => {
      const keys = [
        { time: "0", value: 0 },
        { time: "2", value: 600 },
      ];
      await openScene(page, HALVES, { properties: { "transform.x": { keys } } });
      await expect.poll(() => isNear(page, 1300, 540, [0, 255, 0])).toBe(true);
      await goTo(page, "0:02/00");
      await expect.poll(() => isNear(page, 300, 540, BLACK)).toBe(true);
      await goTo(page, "0:01/00");
      await expect.poll(() => isNear(page, 100, 540, BLACK)).toBe(true);
      expect(await isNear(page, 400, 540, [255, 0, 0])).toBe(true);
    });

    test("changes with the controls of the properties panel, and undo takes it back", async ({
      page,
    }) => {
      await openScene(page, HALVES);
      await expect.poll(() => isNear(page, 100, 540, [255, 0, 0])).toBe(true);
      await tab(page, "timeline").click();
      await clickFirstClip(page);
      await tab(page, "properties").click();
      await field(page, "位置 X").click();
      await field(page, "位置 X").fill("500");
      await field(page, "位置 X").press("Enter");
      await expect.poll(() => isNear(page, 100, 540, BLACK)).toBe(true);
      await page.keyboard.press("Control+z");
      await expect.poll(() => isNear(page, 100, 540, [255, 0, 0])).toBe(true);
    });
  });
});

test.describe("the size of a box that is being tried", () => {
  test.use({ withProject: false });

  const WIDTH = "大小 宽";
  const trial = (page: Page) => page.getByRole("group", { name: "试改", exact: true });
  const widthOf = (frame: Frame | undefined) => frame?.evaluate(() => innerWidth).catch(() => 0);

  /** The scene that runs, and the clip of it ready for its properties to be changed. */
  async function open(page: Page): Promise<Frame> {
    await page.goto(canCapture ? "/" : "/?sceneStage=plain");
    await openScene(page, SLIDE);
    await expect.poll(() => widthOf(sceneFrames(page)[0])).toBe(1920);
    await select(page);
    return sceneFrames(page)[0] as Frame;
  }

  async function select(page: Page): Promise<void> {
    await tab(page, "timeline").click();
    const box = await content(page, "timeline").getByRole("option", { name: /场景/ }).boundingBox();
    if (!box) throw new Error("No clip");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await tab(page, "properties").click();
    await expect(field(page, WIDTH)).toBeVisible();
  }

  async function tryWidth(page: Page, width: string): Promise<void> {
    await field(page, WIDTH).click();
    await field(page, WIDTH).fill(width);
    await field(page, WIDTH).press("Enter");
    await expect(trial(page).getByRole("status")).toHaveText("试改 1 处");
  }

  /** What makes a new plan, with what is being tried on top of it. */
  async function addClip(page: Page, clipsAfter: number): Promise<void> {
    await tab(page, "timeline").click();
    await content(page, "timeline").getByRole("button", { name: "纯色片段" }).click();
    await expect(clips(page)).toHaveCount(clipsAfter);
  }

  /** Long enough for a new frame to have shown up, if there would be one. */
  const expectSameFrame = async (page: Page, frame: Frame) => {
    await page.waitForTimeout(800);
    expect(sceneFrames(page)).toEqual([frame]);
    expect(await widthOf(frame)).toBe(1920);
  };

  test("starts nothing over, also not when the project changes meanwhile", async ({ page }) => {
    const frame = await open(page);
    await tryWidth(page, "800");
    await expectSameFrame(page, frame);
    await addClip(page, 2);
    await expectSameFrame(page, frame);
    await select(page);
    await tryWidth(page, "600");
    await addClip(page, 3);
    await expectSameFrame(page, frame);
  });

  test("starts nothing over when people compare, or give up on it", async ({ page }) => {
    const frame = await open(page);
    await tryWidth(page, "800");
    await addClip(page, 2);
    await trial(page).getByRole("button", { name: "对比", exact: true }).click();
    await expectSameFrame(page, frame);
    await trial(page).getByRole("button", { name: "对比", exact: true }).click();
    await trial(page).getByRole("button", { name: "放弃", exact: true }).click();
    await expect(trial(page)).toHaveCount(0);
    await expectSameFrame(page, frame);
  });

  test("takes a new layout once, when it is saved", async ({ page }) => {
    const frame = await open(page);
    await tryWidth(page, "800");
    await tryWidth(page, "700");
    await page.keyboard.press("Control+s");
    await expect(trial(page)).toHaveCount(0);
    await expect.poll(() => widthOf(sceneFrames(page).at(-1)), { timeout: 8000 }).toBe(700);
    await expect.poll(() => sceneFrames(page).length).toBe(1);
    const saved = sceneFrames(page)[0];
    expect(saved).not.toBe(frame);
    await page.waitForTimeout(800);
    expect(sceneFrames(page)).toEqual([saved]);
  });

  test("comes back after a reload without a layout of its own", async ({ page }) => {
    await open(page);
    await tryWidth(page, "800");
    await page.reload();
    await expect(trial(page).getByRole("status")).toHaveText("试改 1 处");
    await expect.poll(() => widthOf(sceneFrames(page)[0])).toBe(1920);
  });
});

test.describe("code in a project that comes in", () => {
  test.use({ withProject: false });

  test("is announced before any of it runs, and only then", async ({ page }) => {
    await page.goto(canCapture ? "/" : "/?sceneStage=plain");
    await chooseFolder(page, projectFolder({ a: { "index.html": SLIDE } }, [{}]));
    const notice = page.getByRole("dialog");
    await expect(notice.getByRole("heading", { name: "这个项目含有脚本" })).toBeVisible();
    await expect(notice.getByText("“场景项目”里有场景或声音的代码")).toBeVisible();
    expect(sceneFrames(page)).toHaveLength(0);
    await expect(tab(page, "preview")).toHaveCount(0);

    await openAnyway(page);
    await expect(tab(page, "preview")).toBeVisible();
    await expect.poll(() => sceneFrames(page).length).toBe(1);
    await expect(notice).toHaveCount(0);

    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await expect.poll(() => sceneFrames(page).length).toBe(1);
    await expect(notice).toHaveCount(0);
  });
});

test.describe("a new scene", () => {
  const newScene = (page: Page) =>
    content(page, "timeline").getByRole("button", { name: "新建场景" }).click();

  test("goes on the timeline with its name, in one step", async ({ page }) => {
    await newScene(page);
    await expect(clips(page)).toHaveCount(1);
    expect(await clips(page).first().getAttribute("aria-label")).toContain("场景 1");
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(0);
    await tab(page, "assets").click();
    await expect(items(page)).toHaveCount(0);
    await page.keyboard.press("Control+Shift+z");
    await expect(items(page)).toHaveCount(1);
  });

  test("shows in the list, and a second clip of it can go on the timeline", async ({ page }) => {
    await newScene(page);
    await tab(page, "assets").click();
    await expect(items(page).filter({ hasText: "场景 1" })).toHaveCount(1);
    await items(page).first().dblclick();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(2);
  });

  test("counts on from the ones that are there", async ({ page }) => {
    await newScene(page);
    await newScene(page);
    await tab(page, "assets").click();
    await expect(items(page).filter({ hasText: "场景 2" })).toHaveCount(1);
  });

  test("can come from the list too", async ({ page }) => {
    await tab(page, "assets").click();
    await content(page, "assets").getByRole("button", { name: "新建场景" }).click();
    await expect(items(page)).toHaveCount(1);
  });

  test("cannot go while a clip uses it, and says so", async ({ page }) => {
    await newScene(page);
    await tab(page, "assets").click();
    await items(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除场景" }).click();
    await expect(page.getByText("还有片段或版本在用这个场景")).toBeVisible();
    await expect(items(page)).toHaveCount(1);
  });

  test("offers the properties of what is on the picture, and nothing to fit", async ({ page }) => {
    await newScene(page);
    await tab(page, "properties").click();
    await expect(field(page, "位置 X")).toBeVisible();
    await expect(content(page, "properties").getByText("适配")).toHaveCount(0);
  });

  test("stays after a reload", async ({ page }) => {
    await newScene(page);
    await expect(page.getByText("已保存")).toBeVisible();
    await page.reload();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(1);
    await tab(page, "assets").click();
    await expect(items(page)).toHaveCount(1);
  });

  test.describe("in a browser that can capture", () => {
    test.skip(!canCapture, "needs a browser that can capture");

    /** The picture is not the same as a moment ago. */
    const fingerprint = (page: Page) =>
      compositor(page).evaluate(() => {
        const canvas = document.querySelector("canvas");
        const { data } = canvas?.getContext("2d")?.getImageData(0, 0, 1920, 1080) ?? { data: [] };
        let sum = 0;
        for (let index = 0; index < data.length; index += 4099) sum += data[index] as number;
        return sum;
      });

    test("moves on the picture, and the keyboard stays with the editor", async ({ page }) => {
      await newScene(page);
      const dark: Color = [0, 0, 0, 255];
      await expect
        .poll(async () => distance(await colorAt(page, 100, 100), dark))
        .toBeGreaterThan(8);
      const first = await fingerprint(page);
      await page.keyboard.press("Space");
      await expect.poll(() => fingerprint(page)).not.toBe(first);
      await page.keyboard.press("Space");
      await page.keyboard.press("Control+z");
      await expect(clips(page)).toHaveCount(0);
    });
  });
});

test.describe("a browser that cannot capture", () => {
  test.skip(canCapture, "this one can");

  const placeholder = async (page: Page) => distance(await colorAt(page, 960, 540), [0, 0, 0]) > 8;

  test("shows a placeholder and says why", async ({ page }) => {
    await content(page, "timeline").getByRole("button", { name: "新建场景" }).click();
    await expect(content(page, "preview").getByText("这个浏览器不能捕获场景")).toBeVisible();
    await expect.poll(() => placeholder(page)).toBe(true);
    await expect.poll(() => sceneFrames(page).length).toBe(0);
  });

  test("everything else goes on working", async ({ page }) => {
    await content(page, "timeline").getByRole("button", { name: "新建场景" }).click();
    await expect(content(page, "preview").getByText("这个浏览器不能捕获场景")).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(0);
    await expect(content(page, "preview").getByText("这个浏览器不能捕获场景")).toHaveCount(0);
    await expect.poll(() => placeholder(page)).toBe(false);
  });
});

test.describe("a scene from a folder", () => {
  test.use({ withProject: false });

  test("is in the list, and goes on the timeline", async ({ page }) => {
    const folder = projectFolder({ a: { "index.html": "<p>a</p>" } }, []);
    await importFolder(page, folder);
    await tab(page, "assets").click();
    await expect(items(page).filter({ hasText: "场景 a" })).toHaveCount(1);
    await items(page).first().dblclick();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(1);
  });
});
