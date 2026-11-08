import type { Locator, Page } from "@playwright/test";
import { typeInto } from "./property-helpers.ts";
import {
  clickFirstClip,
  content,
  expect,
  goTo,
  importFolder,
  needsPlainStage,
  openForScenes,
  projectFolder,
  sceneFrames,
  tab,
  test,
  type SceneClip,
} from "./scene-support.ts";

/**
 * What a scene registers and what its clip holds for it: keys on code objects, elements and
 * parameters, worked out inside the scene. A browser that cannot capture runs scenes as normal
 * pages, so what the scene does with its values is read from its page, which works either way.
 */

test.use({ withProject: false });
needsPlainStage();

const panel = (page: Page) => content(page, "keyframes");
const row = (page: Page, name: string) => panel(page).getByRole("treeitem", { name, exact: true });
const value = (page: Page, name: string) =>
  panel(page).getByRole("spinbutton", { name, exact: true });
const open = (page: Page, name: string) =>
  panel(page)
    .getByRole("button", { name: `展开 ${name}`, exact: true })
    .click();
const addKey = (lane: Locator) => lane.getByRole("button", { name: "添加关键帧" }).click();

async function animate(page: Page) {
  await page.getByRole("button", { name: "动画", exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

/** What the page of the scene says about what it got, which it writes on its body. */
const said = (page: Page, key: string) =>
  sceneFrames(page)
    .at(-1)
    ?.evaluate((name) => document.body.dataset[name], key)
    .catch(() => undefined);

/** A box that a code object moves, and that says where. */
const arm = (id = "arm") => `<!doctype html>
<style>body { margin: 0; background: #000 } .box { position: absolute; width: 100px;
  height: 100px; background: #fff }</style>
<div class="box"></div>
<script>
  const arm = aq.object("${id}", {
    name: "手臂",
    properties: { x: { type: "number", unit: "world", default: 0 } },
  });
  const box = document.querySelector(".box");
  aq.frame((seconds) => {
    const { x } = arm.at(seconds);
    box.style.translate = x + "px 0px";
    document.body.dataset.x = String(x);
  });
</script>`;

function openArm(page: Page, clip: SceneClip = {}, html = arm()) {
  return importFolder(page, projectFolder({ a: { "index.html": html } }, [clip]));
}

test("a code object takes keys in the keyframe editor, and the scene moves with them", async ({
  page,
}) => {
  await openForScenes(page);
  await openArm(page);
  await animate(page);
  await open(page, "场景");
  await expect(row(page, "手臂")).toBeVisible();
  await open(page, "手臂");
  await addKey(row(page, "x"));
  await goTo(page, "0:02/00");
  await typeInto(value(page, "x"), "200");
  await goTo(page, "0:01/00");
  await expect.poll(() => said(page, "x")).toBe("100");

  await page.keyboard.press("Control+z");
  await expect.poll(() => said(page, "x")).toBe("0");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => said(page, "x")).toBe("100");
});

test("an element with an id is there to change in the properties tab", async ({ page }) => {
  await openForScenes(page);
  const logo = `<!doctype html><style>body { margin: 0 } #logo { width: 50px; height: 50px;
    background: #f00 }</style><div id="logo"></div><span id="名字">不能用</span>
    <div id="${"long".repeat(17)}">一段 ID 最长 64 个字符</div>`;
  await importFolder(page, projectFolder({ a: { "index.html": logo } }, [{}]));
  await clickFirstClip(page);
  await tab(page, "properties").click();
  // Inside of what holds all elements, which a flat list says by name.
  const element = content(page, "properties").getByRole("region", { name: "元素 › logo" });
  await expect(element).toBeVisible();
  await expect(
    content(page, "properties").getByRole("region", { name: /名字|longlong/ }),
  ).toHaveCount(0);
  await typeInto(element.getByRole("spinbutton", { name: "不透明度", exact: true }), "25");
  const opacity = () =>
    sceneFrames(page)
      .at(-1)
      ?.evaluate(() => getComputedStyle(document.getElementById("logo") as Element).opacity)
      .catch(() => undefined);
  await expect.poll(opacity).toBe("0.25");
});

test("a parameter of the scene takes keys, and code reads them at its moment", async ({ page }) => {
  await openForScenes(page);
  const reads = `<!doctype html><script>
    aq.frame((seconds) => { document.body.dataset.size = String(aq.param("size", seconds)); });
  </script>`;
  const params = [{ id: "size", name: "字号", type: "number" as const, default: 64 }];
  await importFolder(
    page,
    projectFolder({ a: { "index.html": reads } }, [{}], undefined, { a: { params } }),
  );
  await animate(page);
  await open(page, "场景");
  await open(page, "参数");
  await expect.poll(() => said(page, "size")).toBe("64");
  await addKey(row(page, "字号"));
  await goTo(page, "0:02/00");
  await typeInto(value(page, "字号"), "100");
  await goTo(page, "0:01/00");
  await expect.poll(() => said(page, "size")).toBe("82");
});

test("keys of a renamed object stay, and go back to work where people connect them", async ({
  page,
  devPage,
}) => {
  test.skip(!devPage, "renames the object in the code through window.aqExecute");
  await openForScenes(page);
  const keys = {
    keys: [
      { time: "0", value: 0 },
      { time: "2", value: 200 },
    ],
  };
  await openArm(page, { properties: { "object.arm.x": keys } });
  await goTo(page, "0:01/00");
  await expect.poll(() => said(page, "x")).toBe("100");

  // The code renames the object, and its keys lose it.
  await page.evaluate((text) => {
    const { aqExecute } = window as unknown as { aqExecute: (call: unknown) => unknown };
    aqExecute({ type: "file.write", params: { path: "scenes/a/index.html", text } });
  }, arm("arm2"));
  await expect.poll(() => said(page, "x")).toBe("0");
  await tab(page, "problems").click();
  await expect(content(page, "problems")).toContainText("object.arm.x 没有对象认领");
  await animate(page);
  await open(page, "场景");
  await expect(row(page, "未连接")).toBeVisible();
  await open(page, "未连接");
  await row(page, "object.arm.x").click({ button: "right" });
  await page.getByRole("menuitem", { name: "连接到…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox")).toHaveValue("object.arm2.x");
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect.poll(() => said(page, "x")).toBe("100");
  await expect(row(page, "未连接")).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await expect.poll(() => said(page, "x")).toBe("0");
  await expect(row(page, "未连接")).toBeVisible();
});

/** Runs something in the page of the scene that shows. */
const inScene = <T>(page: Page, run: () => T) =>
  sceneFrames(page)
    .at(-1)
    ?.evaluate(run)
    .catch(() => undefined);

const elementRegion = (page: Page, id: string) =>
  content(page, "properties").getByRole("region", { name: `元素 › ${id}`, exact: true });

async function resetAll(region: Locator): Promise<void> {
  const resets = region.locator('button[aria-label="恢复默认"]:not([aria-disabled])');
  while ((await resets.count()) > 0) await resets.first().click();
}

test("an element shows the value of the frame whatever transitions it has, and gets its own back", async ({
  page,
}) => {
  await openForScenes(page);
  const logo = `<!doctype html><style>body { margin: 0 } #logo { width: 50px; height: 50px;
    background: #f00; transition: opacity 2s, translate 2s, color 2s }</style>
    <div id="logo" style="opacity: 0.5"></div>`;
  await importFolder(page, projectFolder({ a: { "index.html": logo } }, [{}]));
  const look = () =>
    inScene(page, () => {
      const element = document.getElementById("logo") as HTMLElement;
      const { opacity, translate } = getComputedStyle(element);
      return { opacity, translate, inline: element.style.cssText };
    });
  await expect.poll(look).toEqual({ opacity: "0.5", translate: "none", inline: "opacity: 0.5;" });
  await clickFirstClip(page);
  await tab(page, "properties").click();
  const element = elementRegion(page, "logo");
  await typeInto(element.getByRole("spinbutton", { name: "不透明度", exact: true }), "25");
  await typeInto(element.getByRole("spinbutton", { name: "位置 X", exact: true }), "30");
  // Right away, and not somewhere on the way there over two seconds.
  await expect.poll(look, { timeout: 1000 }).toMatchObject({ opacity: "0.25", translate: "30px" });
  await goTo(page, "0:02/00");
  await expect.poll(look, { timeout: 1000 }).toMatchObject({ opacity: "0.25", translate: "30px" });

  await resetAll(element);
  await expect
    .poll(look, { timeout: 1000 })
    .toEqual({ opacity: "0.5", translate: "none", inline: "opacity: 0.5;" });
});

test("an element of SVG with a transform of its own moves and turns around where it shows", async ({
  page,
}) => {
  await openForScenes(page);
  const svg = `<!doctype html><style>body { margin: 0 }</style>
    <svg width="400" height="400"><rect id="r" x="200" y="0" width="40" height="20" fill="red"
    transform="rotate(45)"/></svg>`;
  await importFolder(page, projectFolder({ a: { "index.html": svg } }, [{}]));
  // Where its middle shows, what it has of its own, and what it got.
  const middle = () =>
    inScene(page, () => {
      const rect = document.getElementById("r") as Element;
      const box = rect.getBoundingClientRect();
      const { transformBox, transformOrigin, transform, rotate } = getComputedStyle(rect);
      return {
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2),
        own: `${transformBox} ${transformOrigin} ${transform}`,
        rotate,
        style: rect.getAttribute("style") ?? "",
      };
    });
  await expect.poll(middle).not.toBeUndefined();
  const before = await middle();
  if (!before) throw new Error("no rect");
  expect(before).toMatchObject({ rotate: "none", style: "" });
  await clickFirstClip(page);
  await tab(page, "properties").click();
  const element = elementRegion(page, "r");
  await typeInto(element.getByRole("spinbutton", { name: "位置 X", exact: true }), "10");
  const moved = { x: before.x + 10, y: before.y, own: before.own };
  await expect.poll(middle).toMatchObject({ ...moved, rotate: "none" });
  // Its own transform stays what it is, and turning keeps its middle where it is.
  await typeInto(element.getByRole("spinbutton", { name: "旋转", exact: true }), "90");
  await expect.poll(middle).toMatchObject({ ...moved, rotate: "90deg" });

  await resetAll(element);
  await expect.poll(middle).toEqual(before);
});

test("an element turns around its middle, on top of a move of its own", async ({ page }) => {
  await openForScenes(page);
  const bar = `<!doctype html><style>body { margin: 0 } #bar { position: absolute; left: 100px;
    top: 100px; width: 60px; height: 20px; background: #f00; translate: -50% -50% }</style>
    <div id="bar"></div>`;
  const properties = { "element.bar.rotation": 90 };
  await importFolder(page, projectFolder({ a: { "index.html": bar } }, [{ properties }]));
  const box = () =>
    inScene(page, () => {
      const { x, y, width, height } = (
        document.getElementById("bar") as Element
      ).getBoundingClientRect();
      return [x + width / 2, y + height / 2, width, height].map(Math.round);
    });
  await expect.poll(box).toEqual([100, 100, 20, 60]);
});

test("what code registers counts for the parameters it went by, and for nothing else", async ({
  page,
}) => {
  await openForScenes(page);
  const bars = `<!doctype html><script>
    const count = aq.param("count");
    const bars = [];
    for (let i = 0; i < count; i += 1) bars.push(aq.object("bar" + i, { properties: { x: 0 } }));
    aq.frame((s) => { document.body.dataset.x = bars.map((bar) => bar.at(s).x).join(","); });
  </script>`;
  const params = [{ id: "count", name: "数量", type: "number" as const, default: 1 }];
  const keys = {
    keys: [
      { time: "0", value: 0 },
      { time: "2", value: 200 },
    ],
  };
  const clips = [
    { id: "one", start: "0", duration: "10", properties: { "param.count": 1 } },
    {
      id: "two",
      start: "10",
      duration: "10",
      properties: { "param.count": 2, "object.bar1.x": keys },
    },
  ];
  await importFolder(
    page,
    projectFolder({ a: { "index.html": bars } }, clips, undefined, { a: { params } }),
  );
  await expect.poll(() => said(page, "x")).toBe("0");
  await tab(page, "problems").click();
  const problems = content(page, "problems");
  // The scene of the first clip has one bar, which says nothing about the second clip.
  await page.waitForTimeout(1500);
  await expect(problems).not.toContainText("没有对象认领");
  await goTo(page, "0:11/00");
  await expect.poll(() => said(page, "x")).toBe("0,100");
  await goTo(page, "0:01/00");
  await expect.poll(() => said(page, "x")).toBe("0");
  await page.waitForTimeout(1500);
  await expect(problems).not.toContainText("没有对象认领");
});

test("code that stops in its frame is not known to have registered all of it", async ({
  page,
  problems: thrown,
}) => {
  await openForScenes(page);
  const html = `<!doctype html><script>
    aq.frame((s) => {
      if (s >= 0) missing();
      const arm = aq.object("arm", { properties: { x: 0 } });
      document.body.dataset.x = String(arm.at(s).x);
    });
  </script>`;
  const keys = {
    keys: [
      { time: "0", value: 0 },
      { time: "2", value: 200 },
    ],
  };
  await importFolder(
    page,
    projectFolder({ a: { "index.html": html } }, [{ properties: { "object.arm.x": keys } }]),
  );
  await tab(page, "problems").click();
  const problems = content(page, "problems");
  await expect(problems).toContainText("missing is not defined");
  await page.waitForTimeout(1500);
  await expect(problems).not.toContainText("没有对象认领");
  // What the scene threw, which the page heard of as well.
  expect(thrown).toContain("missing is not defined");
  thrown.splice(0);
});

test("a big registration gets to the editor whole", async ({ page }) => {
  await openForScenes(page);
  const html = `<!doctype html><script>
    const bones = [];
    for (let i = 0; i < 1600; i += 1) {
      bones.push(aq.object("rig.bone" + i, { name: "骨骼 " + i, properties: {
        x: { type: "number", unit: "world", default: 0, group: "position" },
        y: { type: "number", unit: "world", default: 0, group: "position" },
        rotation: { type: "angle", default: 0 }, scale: 1 } }));
    }
    aq.frame((s) => { document.body.dataset.last = String(bones[1599].at(s).rotation); });
  </script>`;
  const keys = {
    keys: [
      { time: "0", value: 0 },
      { time: "2", value: 200 },
    ],
  };
  const clip = { properties: { "object.rig.bone1599.rotation": keys, "object.rig.bone1600.x": 1 } };
  await importFolder(page, projectFolder({ a: { "index.html": html } }, [clip]));
  await goTo(page, "0:01/00");
  await expect.poll(() => said(page, "last")).toBe("100");
  await tab(page, "problems").click();
  // All of it came, so what is not there is known not to be.
  await expect(content(page, "problems")).toContainText("object.rig.bone1600.x 没有对象认领");
  await expect(content(page, "problems")).not.toContainText("object.rig.bone1599");
});

test("a registration that keeps changing does not take the scene away", async ({ page }) => {
  test.setTimeout(120_000);
  await openForScenes(page);
  // Big, and different in every frame, which is what a registration should never be.
  const html = `<!doctype html><script>
    let frames = 0;
    aq.frame((s) => {
      for (let i = 0; i < 1600; i += 1) {
        aq.object("rig.bone" + i, { name: "骨骼 " + i, properties: {
          x: { type: "number", default: Math.round(s * 30) + i, group: "position" },
          y: { type: "number", default: 0, group: "position" } } });
      }
      frames += 1;
      document.body.dataset.frames = String(frames);
    });
  </script>`;
  await importFolder(page, projectFolder({ a: { "index.html": html } }, [{ duration: "20" }]));
  await expect.poll(() => said(page, "frames"), { timeout: 30_000 }).toBeTruthy();
  await page.keyboard.press("Space");
  await page.waitForTimeout(8000);
  await page.keyboard.press("Space");
  await tab(page, "problems").click();
  const problems = content(page, "problems");
  await expect(problems).toContainText("的描述一直在变");
  await expect(problems).not.toContainText("发的消息太多");
  const frames = Number(await said(page, "frames"));
  await goTo(page, "0:15/00");
  await expect.poll(async () => Number(await said(page, "frames"))).toBeGreaterThan(frames);
});

/** A ball that a code object moves, by a position that is one vector, and that says where. */
const ball = `<!doctype html>
<style>body { margin: 0; background: #000 } .ball { position: absolute; width: 60px;
  height: 60px; border-radius: 50%; background: #fff }</style>
<div class="ball"></div>
<script>
  const ball = aq.object("ball", {
    name: "球",
    properties: { pos: { type: "vec2", name: "中心", unit: "world", default: [0, 0] } },
  });
  const element = document.querySelector(".ball");
  aq.frame((seconds) => {
    const [x, y] = ball.at(seconds).pos;
    element.style.translate = x + "px " + y + "px";
    document.body.dataset.pos = x + "," + y;
  });
</script>`;

test("a vector opens up into its parts, each with its curve, which share their keys", async ({
  page,
}) => {
  // Room for the rows of both parts, made taller, under what the clip has.
  await page.setViewportSize({ width: 1440, height: 1600 });
  await openForScenes(page);
  const keys = {
    keys: [
      { time: "1", value: [0, 100] },
      { time: "3", value: [200, 50] },
    ],
  };
  await openArm(page, { properties: { "object.ball.pos": keys } }, ball);
  await animate(page);
  await open(page, "场景");
  await open(page, "球");
  // Closed, the row of the vector has a field for each part.
  const fields = row(page, "中心").getByRole("spinbutton");
  await expect(fields).toHaveCount(2);
  await open(page, "中心");
  // Open, each part has its own row with a field, and the row of the vector only says what it is.
  await expect(fields).toHaveCount(0);
  await expect(row(page, "中心")).toContainText("0, 100");
  await panel(page).getByRole("button", { name: "收起 中心", exact: true }).click();
  await expect(fields).toHaveCount(2);
  await open(page, "中心");
  const keyOf = (name: string) =>
    panel(page).getByRole("option", { name: new RegExp(`^${name}，`) });
  const partValue = (name: string) => row(page, name).getByRole("spinbutton");
  await expect(keyOf("中心 X")).toHaveCount(2);
  await expect(keyOf("中心 Y")).toHaveCount(2);
  for (const name of ["中心 X", "中心 Y"]) {
    await panel(page)
      .getByRole("button", { name: `加高 ${name} 这一行`, exact: true })
      .click();
  }
  const middleOf = async (key: Locator) => {
    const box = await key.boundingBox();
    if (!box) throw new Error("not on screen");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const heights = async (name: string) =>
    Promise.all((await keyOf(name).all()).map(async (key) => (await middleOf(key)).y));
  // X goes up from 0 to 200, and Y goes down from 100 to 50.
  await expect
    .poll(async () => {
      const [a = 0, b = 0] = await heights("中心 X");
      return a - b;
    })
    .toBeGreaterThan(40);
  await expect
    .poll(async () => {
      const [a = 0, b = 0] = await heights("中心 Y");
      return b - a;
    })
    .toBeGreaterThan(40);

  await goTo(page, "0:03/00");
  await expect(partValue("中心 X")).toHaveValue("200");
  await expect(partValue("中心 Y")).toHaveValue("50");
  await expect.poll(() => said(page, "pos")).toBe("200,50");

  // Up and down in the row of Y is Y alone.
  const drag = async (key: Locator, x: number, y: number) => {
    const from = await middleOf(key);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + x / 2, from.y + y / 2, { steps: 4 });
    await page.mouse.move(from.x + x, from.y + y, { steps: 4 });
    await page.mouse.up();
  };
  await drag(keyOf("中心 Y").nth(1), 0, -40);
  await expect.poll(async () => Number(await partValue("中心 Y").inputValue())).toBeGreaterThan(50);
  await expect(partValue("中心 X")).toHaveValue("200");
  await expect.poll(() => said(page, "pos")).toMatch(/^200,/);
  await expect.poll(() => said(page, "pos")).not.toBe("200,50");
  await page.keyboard.press("Control+z");
  await expect(partValue("中心 Y")).toHaveValue("50");
  await expect.poll(() => said(page, "pos")).toBe("200,50");

  // Along the time it is the key of the vector, in all of its rows.
  const timeOf = async (key: Locator) => (await key.getAttribute("aria-label"))?.split("，").at(-1);
  const before = await timeOf(keyOf("中心 X").nth(1));
  await drag(keyOf("中心 X").nth(1), 60, 0);
  await expect.poll(() => timeOf(keyOf("中心 X").nth(1))).not.toBe(before);
  const after = await timeOf(keyOf("中心 X").nth(1));
  await expect.poll(() => timeOf(keyOf("中心 Y").nth(1))).toBe(after);
  await expect.poll(() => timeOf(keyOf("中心").nth(1))).toBe(after);
  // Both numbers went along: at 3 seconds now the ball is on its way.
  await expect.poll(() => said(page, "pos")).not.toBe("200,50");
  await page.keyboard.press("Control+z");
  await expect.poll(() => timeOf(keyOf("中心 Y").nth(1))).toBe(before);
  await expect.poll(() => said(page, "pos")).toBe("200,50");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => timeOf(keyOf("中心 Y").nth(1))).toBe(after);
});
