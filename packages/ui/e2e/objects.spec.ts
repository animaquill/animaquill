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
    background: #f00 }</style><div id="logo"></div><span id="名字">不能用</span>`;
  await importFolder(page, projectFolder({ a: { "index.html": logo } }, [{}]));
  await clickFirstClip(page);
  await tab(page, "properties").click();
  // Inside of what holds all elements, which a flat list says by name.
  const element = content(page, "properties").getByRole("region", { name: "元素 › logo" });
  await expect(element).toBeVisible();
  await expect(content(page, "properties").getByRole("region", { name: /名字/ })).toHaveCount(0);
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
