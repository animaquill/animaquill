/**
 * The editor on this computer, as `npx animaquill` serves it: every site on a name of its own under
 * `localhost`, each with the headers it has when deployed. What is checked here is what the server
 * and the sites change. How each feature works is for the tests of the editor, which run on its
 * development page: see packages/ui/e2e.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Download, Frame, Page } from "@playwright/test";
import { dialog, drop, footer } from "../../ui/e2e/folder-support.ts";
import {
  canCapture,
  importFolder,
  distance,
  colorAt,
  projectFolder,
  sceneFrames,
} from "../../ui/e2e/scene-support.ts";
import { content, expect, findCompositor, resourcesIn, tab, test } from "../../ui/e2e/support.ts";

const RED = fileURLToPath(new URL("../../ui/e2e/fixtures/red.webm", import.meta.url));

test.use({ devPage: false, folders: true, withProject: false });

/** The sites of this server, from the editor's address, as the page works them out itself. */
const sitesOf = (page: Page) => {
  const { port } = new URL(page.url());
  return {
    editor: `http://animaquill.localhost:${port}`,
    compositor: `http://animaquill-sandbox.localhost:${port}`,
    scene: (index: number) => `http://animaquill-scene-${index}.localhost:${port}`,
  };
};

/** A new project in an empty folder on the disk, dropped in the way people do. */
async function newProjectOnDisk(page: Page): Promise<string> {
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-local-")), "片子");
  mkdirSync(disk);
  await drop(page, disk);
  await dialog(page).getByRole("button", { name: "在这里新建项目" }).click();
  await dialog(page).getByRole("textbox").fill("片子");
  await dialog(page).getByRole("button", { name: "创建" }).click();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
  return disk;
}

/** The colour in the middle of the preview. */
async function middle(page: Page): Promise<readonly number[]> {
  const frame = await findCompositor(page);
  if (!frame) return [];
  return frame
    .evaluate(() => {
      const canvas = document.querySelector("canvas");
      const data = canvas
        ?.getContext("2d")
        ?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return data ? [...data] : [];
    })
    .catch(() => []);
}

const isRed = ([red = 0, green = 255, blue = 255]: readonly number[]) =>
  red > 200 && green < 60 && blue < 60;

const bytesOf = async (download: Download) => {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** The colour in the middle of a picture, read the way the page reads pictures. */
const middleOf = (page: Page, png: Buffer) =>
  page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1);
    return { width: bitmap.width, height: bitmap.height, color: [...data] };
  }, png.toString("base64"));

test.describe("the editor on this computer", () => {
  test("opens on a site of its own, with everything a page needs for folders", async ({ page }) => {
    const response = await page.request.get("/");
    expect(response.headers()["content-security-policy"]).toContain(
      `frame-src ${sitesOf(page).compositor};`,
    );
    expect(await page.evaluate(() => location.hostname)).toBe("animaquill.localhost");
    const can = await page.evaluate(() => ({
      secure: isSecureContext,
      folders: typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker,
      workers: typeof Worker,
      offscreen: typeof OffscreenCanvas,
      encoder: typeof VideoEncoder,
    }));
    expect(can).toEqual({
      secure: true,
      folders: "function",
      workers: "function",
      offscreen: "function",
      encoder: "function",
    });
    await expect(page.getByRole("button", { name: "新建项目" })).toBeVisible();
  });

  test("is where localhost leads", async ({ page }) => {
    const { port } = new URL(page.url());
    await page.goto(`http://localhost:${port}/`);
    expect(page.url()).toBe(`http://animaquill.localhost:${port}/`);
    await expect(page.getByRole("button", { name: "新建项目" })).toBeVisible();
  });

  test("can be installed as an app", async ({ page }) => {
    const manifest = await page.request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBe(true);
    expect((await manifest.json()).name).toBe("AnimaQuill");
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(`${sitesOf(page).editor}/`);
  });

  test("keeps a project in a folder, with its assets, shows it, and exports a frame of it", async ({
    page,
  }) => {
    // That browser takes nothing dropped from a test. Scenes are what it is for, see below.
    test.skip(canCapture, "the browser that can capture takes no folders dropped on it");
    const disk = await newProjectOnDisk(page);
    await tab(page, "assets").click();
    const box = await content(page, "assets").boundingBox();
    if (!box) throw new Error("The assets panel has no box");
    await drop(page, RED, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await expect(resourcesIn(page, "assets")).toHaveCount(1);
    // The asset is in the folder, as a copy of what was dropped.
    await expect
      .poll(() =>
        existsSync(join(disk, "assets"))
          ? readdirSync(join(disk, "assets")).map((name) =>
              readFileSync(join(disk, "assets", name)).equals(readFileSync(RED)),
            )
          : [],
      )
      .toEqual([true]);
    await resourcesIn(page, "assets").first().dblclick();
    await expect.poll(async () => isRed(await middle(page)), { timeout: 15_000 }).toBe(true);
    // The preview is the compositor, on its own site, in a sandbox.
    const compositor = (await findCompositor(page)) as Frame;
    expect(compositor.url()).toBe(`${sitesOf(page).compositor}/compositor.html`);
    expect(await compositor.evaluate(() => self.origin)).toBe("null");

    const download = page.waitForEvent("download");
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "导出当前帧", exact: true }).click();
    const png = await bytesOf(await download);
    const frame = await middleOf(page, png);
    expect({ width: frame.width, height: frame.height }).toEqual({ width: 1920, height: 1080 });
    expect(isRed(frame.color)).toBe(true);
  });

  test.describe("with scenes", () => {
    test.use({ folders: false });

    test("runs scenes on sites of their own, where they get to nothing of the editor", async ({
      page,
      problems,
    }) => {
      await page.evaluate(() => localStorage.setItem("animaquill.secret", "editor"));
      const wantsOut = `<!doctype html><body style="margin: 0; background: rgb(255, 0, 0)"><script type="module">
        const out = {};
        const attempt = async (name, run) => {
          try { out[name] = await run(); } catch (error) { out[name] = "blocked: " + error.name; }
        };
        await attempt("fetch", () => fetch(location.ancestorOrigins[location.ancestorOrigins.length - 1]).then(({ status }) => "reached " + status));
        await attempt("storage", () => localStorage.getItem("animaquill.secret"));
        await attempt("indexedDB", () => indexedDB.open("a").readyState);
        await attempt("parent", () => parent.document.title);
        await attempt("top", () => top.location.href);
        window.answers = out;
      </script>`;
      await importFolder(page, projectFolder({ a: { "index.html": wantsOut } }, [{}]));

      const sites = sitesOf(page);
      const scenes = Array.from({ length: 8 }, (_, index) => `${sites.scene(index)}/scene.html`);
      await expect.poll(() => sceneFrames(page).length).toBe(1);
      const [frame] = sceneFrames(page) as [Frame];
      expect(scenes).toContain(frame.url());
      expect(await frame.evaluate(() => self.origin)).toBe("null");
      await expect
        .poll(() => frame.evaluate(() => (window as unknown as { answers?: object }).answers))
        .toBeDefined();
      const answers = await frame.evaluate(
        () => (window as unknown as { answers: Record<string, string> }).answers,
      );
      for (const [name, answer] of Object.entries(answers)) {
        expect(String(answer), name).toMatch(/^blocked: /);
      }
      // It was the policy of the scene that stopped it, and the editor says so.
      expect(problems.join()).toContain("Content Security Policy");
      await expect(page.getByText(`沙箱挡住了对 ${sites.editor}/ 的访问`)).toBeVisible();
      if (canCapture) {
        await expect
          .poll(async () => distance(await colorAt(page, 100, 100), [255, 0, 0, 255]))
          .toBeLessThan(8);
      }
      problems.splice(0);
    });
  });

  test.describe("with a project kept in the browser", () => {
    test.use({ folders: false, withProject: true });

    test("has nothing to sign in to, and keeps reports here", async ({ page }) => {
      await expect(tab(page, "preview")).toBeVisible();
      await expect(page.getByRole("button", { name: /登录|账号/ })).toHaveCount(0);
      await expect(page.locator("header").getByText(/登录/)).toHaveCount(0);
      await page.getByRole("button", { name: "帮助" }).click();
      await page.getByRole("menuitem", { name: "运行情况" }).click();
      const panel = content(page, "performance");
      await panel.getByRole("button", { name: "开始记录" }).click();
      await panel.getByRole("button", { name: "结束记录" }).click();
      await expect(panel.getByText("这个版本没有接收服务，可以保存成文件。")).toBeVisible();
      await expect(panel.getByRole("button", { name: /发送/ })).toHaveCount(0);
    });

    test("talks to the AI services people set up, and to nothing else outside", async ({
      page,
      problems,
    }) => {
      await page.locator("header").getByRole("button", { name: "视图", exact: true }).click();
      await page.getByRole("menu").getByRole("menuitem", { name: "设置", exact: true }).click();
      const settings = content(page, "settings");
      await settings.getByRole("combobox", { name: "服务类型" }).selectOption("anthropic");
      await settings.getByRole("button", { name: "添加服务" }).click();
      const service = settings.getByTestId("ai-service");
      await service.getByLabel("Key").fill("sk-ant-test-local");
      await service.getByLabel("Key").press("Enter");
      await expect(service.getByLabel("Key")).toHaveAttribute("placeholder", "已保存（不显示）");
      await expect(settings.getByTestId("ai-keys-where")).toContainText("animaquill-keys");
      await tab(page, "chat").click();
      await expect(
        content(page, "chat").getByRole("textbox", { name: /给 AI 发消息/ }),
      ).toBeVisible();

      // The services answer here in their place. What the policy stops never gets this far.
      await page.route(/^https:\/\/api\.anthropic\.com\/|^http:\/\/localhost:11434\//, (route) =>
        route.fulfill({ status: 200, body: "ok", headers: { "Access-Control-Allow-Origin": "*" } }),
      );
      const reach = (url: string) =>
        page.evaluate(
          (address) =>
            fetch(address).then(
              (response) => response.text(),
              (error: Error) => `blocked: ${error.name}`,
            ),
          url,
        );
      expect(await reach("https://api.anthropic.com/v1/models")).toBe("ok");
      expect(await reach("http://localhost:11434/api/tags")).toBe("ok");
      expect(await reach(`${sitesOf(page).compositor}/compositor.html`)).toMatch(/^blocked: /);
      expect(problems.join()).toContain("Content Security Policy");
      problems.splice(0);
    });
  });
});
