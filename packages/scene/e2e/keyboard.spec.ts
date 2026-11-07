import { test, type Page } from "@playwright/test";
import { expect, expectAllWell, expectGone, openLab, pageScene } from "./support.ts";

// A trace waits for every frame after every step, so with a frame that stands still it would hold the
// test up along with it, and what is measured here is what the keyboard does in the meantime.
test.use({ trace: "off" });

test.beforeEach(({ page }) => openLab(page));

test.describe("the keyboard", () => {
  /** Something to type into, in the editor, and a count of what it got and how often it left. */
  async function typeHere(page: Page) {
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "mine";
      input.style.cssText = "position:fixed;left:0;top:820px;z-index:9";
      document.body.append(input);
      input.focus();
      Object.assign(window, { keys: [], lost: 0 });
      const seen = window as unknown as { keys: string[]; lost: number };
      addEventListener("keydown", ({ key }) => seen.keys.push(key));
      addEventListener("blur", () => (seen.lost += 1));
    });
  }

  const lost = (page: Page) => page.evaluate(() => (window as unknown as { lost: number }).lost);

  /** How many of a run of keys reach the editor. */
  async function type(page: Page, count: number) {
    await page.evaluate(() => Object.assign(window, { keys: [] }));
    for (let key = 0; key < count; key += 1) {
      await page.keyboard.press("b");
      await page.waitForTimeout(10);
    }
    await page.waitForTimeout(100);
    return page.evaluate(() => (window as unknown as { keys: string[] }).keys.length);
  }

  /** Takes the focus without anybody calling `focus`, which is what the runtime can do something about. */
  const THIEF = `<!doctype html><dialog id="trap"><input autofocus></dialog><script>
    const trap = document.getElementById("trap");
    const steal = () => {
      trap.close();
      trap.showModal();
    };
    window.steal = steal;
    window.stealLater = (ms) => {
      const code = "onmessage = ({ data }) => setTimeout(() => postMessage(0), data)";
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const timer = new Worker(url);
      timer.onmessage = steal;
      timer.postMessage(ms);
    };
    window.stealAgain = () => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        steal();
        port2.postMessage(0);
      };
      port2.postMessage(0);
    };
  </script>`;

  test("code that means no harm does not get it at all", async ({ page }) => {
    await typeHere(page);
    const scene = await pageScene(
      page,
      `<!doctype html><input id="a"><script>
        window.steal = () => { document.getElementById("a").focus(); window.focus(); };
      </script>`,
    );
    await (
      await scene.frame()
    ).evaluate(() => (window as unknown as { steal: () => void }).steal());
    expect(await type(page, 5)).toBe(5);
    expect(await lost(page)).toBe(0);
    expect((await scene.problems()).map(({ code }) => code)).toEqual(["focus"]);
    expect((await scene.info()).failures).toEqual([]);
  });

  // In a browser that cannot capture, what is in a canvas is not on screen and cannot take the focus.
  test(
    "taking it once gets it back, and the scene goes on",
    { tag: "@layout" },
    async ({ page }) => {
      await typeHere(page);
      const scene = await pageScene(page, THIEF);
      await (
        await scene.frame()
      ).evaluate(() => (window as unknown as { steal: () => void }).steal());
      await page.waitForTimeout(100);
      expect(await lost(page)).toBe(1);
      expect(await type(page, 5)).toBe(5);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("mine");
      expect((await scene.info()).failures).toEqual([]);
    },
  );

  test(
    "getting it back works with nothing in the editor to go back to",
    { tag: "@layout" },
    async ({ page }) => {
      await typeHere(page);
      await page.evaluate(() => document.getElementById("mine")?.remove());
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const scene = await pageScene(page, THIEF);
      await page.evaluate(() => window.focus());
      await (
        await scene.frame()
      ).evaluate(() => (window as unknown as { steal: () => void }).steal());
      await page.waitForTimeout(100);
      expect(await lost(page)).toBeGreaterThan(0);
      expect(await type(page, 5)).toBe(5);
    },
  );

  test(
    "taking it again and again costs the scene its frame",
    { tag: "@layout" },
    async ({ page }) => {
      const next = await pageScene(page, `<!doctype html><p>next door</p>`);
      await typeHere(page);
      const scene = await pageScene(page, THIEF);
      void (await scene.frame())
        .evaluate(() => (window as unknown as { stealAgain: () => void }).stealAgain())
        .catch(() => {});
      const started = Date.now();
      await expectGone(scene, "focus");
      expect(Date.now() - started).toBeLessThan(2000);
      // Only asking before taking it back finds out who it was each time. Otherwise this goes on
      // and on, and the compositor catches one in every so many.
      const times = await lost(page);
      expect(times).toBeGreaterThan(3);
      expect(times).toBeLessThan(20);
      await page.waitForTimeout(100);
      expect(await type(page, 10)).toBe(10);
      await expectAllWell(page, next);
    },
  );

  test(
    "a compositor that stands still does not hold it up",
    { tag: "@layout" },
    async ({ page }) => {
      await typeHere(page);
      const scene = await pageScene(page, THIEF);
      await (
        await scene.frame()
      ).evaluate(() => (window as unknown as { stealLater: (ms: number) => void }).stealLater(300));
      const started = Date.now();
      const standing = page.evaluate(() => window.lab.call("block", 3000));
      await page.waitForTimeout(700);
      expect(await lost(page)).toBe(1);
      expect(await type(page, 5)).toBe(5);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("mine");
      expect(Date.now() - started).toBeLessThan(2500);
      await standing;
      // Coming back, the frame gets the focus once more, which has to be taken back as well.
      await page.waitForTimeout(200);
      expect(await type(page, 3)).toBe(3);
    },
  );

  test("a scene that takes it now and then is left alone", { tag: "@layout" }, async ({ page }) => {
    test.setTimeout(30000);
    await typeHere(page);
    const scene = await pageScene(page, THIEF);
    const frame = await scene.frame();
    // Below the rate at which it counts as doing this on purpose, and well above a single one.
    for (let time = 0; time < 3; time += 1) {
      await frame.evaluate(() => (window as unknown as { steal: () => void }).steal());
      await page.waitForTimeout(100);
    }
    expect(await lost(page)).toBe(3);
    expect((await scene.info()).failures).toEqual([]);
    expect(await type(page, 5)).toBe(5);
  });

  test("nobody gets into a scene with the keyboard or the mouse", async ({ page }) => {
    await typeHere(page);
    const scene = await pageScene(
      page,
      `<!doctype html><input id="a" style="position:fixed;left:0;top:0;width:400px;height:200px">
      <a id="b" href="#b">link</a><script>
        window.got = [];
        for (const name of ["keydown", "mousedown", "click", "focusin"]) {
          addEventListener(name, ({ type }) => got.push(type));
        }
      </script>`,
    );
    for (let key = 0; key < 6; key += 1) await page.keyboard.press("Tab");
    await page.keyboard.press("b");
    await page.mouse.click(100, 100);
    await page.keyboard.press("b");
    const got = await (
      await scene.frame()
    ).evaluate(() => (window as unknown as { got: string[] }).got);
    expect(got).toEqual([]);
  });
});
