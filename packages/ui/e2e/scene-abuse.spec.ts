import type { Frame, Page } from "@playwright/test";
import {
  clickFirstClip,
  compositor,
  content,
  expect,
  findCompositor,
  importFolder,
  needsPlainStage,
  openForScenes,
  projectFolder,
  sceneFrames,
  test,
} from "./scene-support.ts";

// A trace waits for every frame after every step, so with a frame that stands still it would hold
// the test up along with it. What runs here does not care for traces anyway.
test.use({ withProject: false, trace: "off" });
needsPlainStage();

/**
 * A scene written to do harm, in the real editor with the real compositor. In a browser that cannot
 * capture scenes run as normal pages, which is all this needs: what they can do is the same.
 */
async function start(page: Page): Promise<void> {
  await openForScenes(page);
}

/** Until a scene ran, there is nothing to ask it. */
const ran = (page: Page, name: string) =>
  expect.poll(() => sceneFrames(page)[0]?.evaluate((global) => global in window, name)).toBe(true);

const FINE = `<!doctype html><script>window.alive = true</script>`;

/** The frame of the scene that did nothing wrong, as soon as it runs. */
async function innocent(page: Page): Promise<Frame | undefined> {
  for (const frame of sceneFrames(page)) {
    const isIt = await frame.evaluate(() => "alive" in window).catch(() => false);
    if (isIt) return frame;
  }
  return undefined;
}

/** The attacker, and next to it a scene that did nothing wrong. */
async function openNextToVictim(page: Page, html: string): Promise<Frame> {
  await start(page);
  const folder = projectFolder({ bad: { "index.html": html }, good: { "index.html": FINE } }, [
    { scene: "bad" },
    { scene: "good", above: true },
  ]);
  await importFolder(page, folder);
  await expect.poll(() => innocent(page)).toBeDefined();
  return (await innocent(page)) as Frame;
}

const expectAlive = async (frame: Frame) =>
  expect(await frame.evaluate(() => (window as unknown as { alive: boolean }).alive)).toBe(true);

async function openOne(page: Page, html: string): Promise<void> {
  await start(page);
  await importFolder(page, projectFolder({ bad: { "index.html": html } }, [{}]));
  await expect.poll(() => sceneFrames(page).length).toBe(1);
}

/** The editor still does what people tell it to, with the keyboard and the mouse. */
async function expectEditorWorks(page: Page): Promise<void> {
  const clips = content(page, "timeline").getByRole("option");
  const count = await clips.count();
  await content(page, "timeline").getByRole("button", { name: "纯色片段" }).click();
  await expect(clips).toHaveCount(count + 1);
  await page.keyboard.press("Control+z");
  await expect(clips).toHaveCount(count);
}

/** The compositor is there, and it did not go through anything strange. */
const expectCompositorWorks = async (page: Page) => {
  const frame = await compositor(page);
  const seen = await frame.evaluate(() => document.querySelector("canvas") !== null);
  expect(seen).toBe(true);
};

/** Keeps count of what got read of messages from anybody but a child of this page. */
const countForeignReads = (page: Page) =>
  // It only takes effect with the next page, which `start` goes to.
  page.addInitScript(() => {
    if (window !== window.top) return;
    const read = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get;
    const state = { reads: 0 };
    Object.assign(window, { foreign: state });
    Object.defineProperty(MessageEvent.prototype, "data", {
      get(this: MessageEvent) {
        const frames = [...document.querySelectorAll("iframe")];
        const isChild = frames.some((frame) => frame.contentWindow === this.source);
        // A web socket has messages too, and they come from nowhere.
        if (this.target === window && !isChild) state.reads += 1;
        return read?.call(this);
      },
    });
  });

const foreignReads = (page: Page) =>
  page.evaluate(() => (window as unknown as { foreign: { reads: number } }).foreign.reads);

const notice = (page: Page, text: string) => content(page, "preview").getByText(text);

/** Keeps what the preview says, however short it says it. */
const rememberNotices = (page: Page) =>
  page.evaluate(() => {
    const seen = new Set<string>();
    Object.assign(window, { noticesSeen: seen });
    new MutationObserver(() => {
      const shown = document.querySelectorAll('[data-panel="preview"] [role="status"]');
      for (const item of shown) seen.add(item.textContent ?? "");
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

const noticesSeen = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { noticesSeen: Set<string> }).noticesSeen]);

/** Writes to a page for as long as it is there, in a way that leaves room for answering. */
const flood = (target: string, message: string) => `<!doctype html><script>
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => {
    for (let i = 0; i < 2000; i += 1) ${target}.postMessage(${message}, "*");
    port2.postMessage(0);
  };
  port2.postMessage(0);
</script>`;

/** One large message after the other. */
const bigMessages = (target: string) => `<!doctype html><script>
  const pad = "x".repeat(64 * 1024 * 1024);
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => {
    ${target}.postMessage({ type: "pong", nonce: 1, pad }, "*");
    port2.postMessage(0);
  };
  port2.postMessage(0);
</script>`;

/** A chain of frames inside the scene, the deepest of which runs `leaf` as soon as it is there. */
const nested = (depth: number, leaf: string) => `<!doctype html><script>
  const BOOT = "<script>addEventListener('message', (e) => eval(e.data))<" + "/script>";
  function leaf() { ${leaf} }
  function step(left) {
    if (left === 0) return leaf();
    const frame = document.createElement("iframe");
    frame.srcdoc = BOOT;
    frame.onload = () => frame.contentWindow.postMessage(
      "const BOOT = " + JSON.stringify(BOOT) + ";" + leaf.toString() + ";" + step.toString() +
      "; step(" + (left - 1) + ");", "*");
    document.documentElement.append(frame);
  }
  addEventListener("load", () => step(${depth}));
</script>`;

test.describe("frames far down inside a scene", () => {
  test("writing to the editor take the scene along, however deep they are", async ({
    page,
    problems,
  }) => {
    test.setTimeout(60000);
    await countForeignReads(page);
    const leaf = `setInterval(() => { for (let i = 0; i < 400; i += 1) top.postMessage(0, "*"); }, 4);`;
    await start(page);
    await importFolder(page, projectFolder({ bad: { "index.html": nested(12, leaf) } }, [{}]));
    await expect(notice(page, "发的消息太多")).toBeVisible({ timeout: 30000 });
    await expect.poll(() => sceneFrames(page).length).toBe(0);
    await expectEditorWorks(page);
    expect(await foreignReads(page)).toBe(0);
    problems.splice(0);
  });
});

test.describe("a compositor that never comes up", () => {
  test.setTimeout(90000);

  test("says that a new page is what helps, and that does", async ({ page, problems }) => {
    await page.route("**/compositor.html", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><p>nothing here</p>" }),
    );
    await start(page);
    await importFolder(page, projectFolder({ a: { "index.html": FINE } }, [{}]));
    await expect(notice(page, "预览起不来")).toBeVisible({ timeout: 45000 });
    // The frame goes with its element, and the test hears of that a moment after the notice.
    await expect.poll(() => findCompositor(page)).toBeUndefined();
    await expectEditorWorks(page);
    await page.unroute("**/compositor.html");
    await content(page, "preview").getByRole("button", { name: "刷新页面" }).click();
    await expect
      .poll(async () => (await findCompositor(page)) !== undefined, { timeout: 20000 })
      .toBe(true);
    await expect(notice(page, "预览起不来")).toHaveCount(0);
    await expect.poll(() => sceneFrames(page).length, { timeout: 20000 }).toBe(1);
    problems.splice(0);
  });
});

test.describe("scenes that used up every origin", () => {
  test.setTimeout(120000);

  test("leave one way out, which is a new page, and nothing keeps trying", async ({
    page,
    problems,
  }) => {
    const html = flood("parent", `{ type: "pong", nonce: 1 }`);
    await start(page);
    await importFolder(page, projectFolder({ bad: { "index.html": html } }, [{}]));
    const preview = content(page, "preview");
    const retry = preview.getByRole("button", { name: "重试" });
    const newPage = preview.getByRole("button", { name: "刷新页面" });
    await expect
      .poll(
        async () => {
          await retry.click({ timeout: 500 }).catch(() => {});
          return newPage.isVisible();
        },
        { timeout: 90000, intervals: [100] },
      )
      .toBe(true);
    await expect(notice(page, "这次打开不能再运行场景了")).toHaveCount(1);
    await expect(retry).toHaveCount(0);
    expect(sceneFrames(page)).toHaveLength(0);
    await expectEditorWorks(page);
    await newPage.click();
    await expect(notice(page, "这次打开不能再运行场景了")).toHaveCount(0, { timeout: 15000 });
    await expect(notice(page, "发的消息太多")).toBeVisible({ timeout: 20000 });
    problems.splice(0);
  });
});

test.describe("too many messages", () => {
  test("to the compositor take the scene away, and nobody else", async ({ page, problems }) => {
    const victim = await openNextToVictim(page, flood("parent", `{ type: "pong", nonce: 1 }`));
    await expect(notice(page, "发的消息太多")).toBeVisible({ timeout: 20000 });
    await expect.poll(() => sceneFrames(page).length).toBe(1);
    await expectAlive(victim);
    await expectEditorWorks(page);
    await expectCompositorWorks(page);
    problems.splice(0);
  });

  test("to the editor take the scene away, and never get read", async ({ page, problems }) => {
    await countForeignReads(page);
    const victim = await openNextToVictim(page, flood("top", "0"));
    await expect(notice(page, "发的消息太多")).toBeVisible({ timeout: 20000 });
    await expect.poll(() => sceneFrames(page).length).toBe(1);
    await expectAlive(victim);
    await expectEditorWorks(page);
    expect(await foreignReads(page)).toBe(0);
    problems.splice(0);
  });

  test("that come to the editor from a frame inside a scene count for that scene", async ({
    page,
    problems,
  }) => {
    await countForeignReads(page);
    const html = `<!doctype html><script>
      const frame = document.createElement("iframe");
      frame.srcdoc = "<script>for (let i = 0; i < 40; i += 1) top.postMessage(0, '*');<" + "/script>";
      document.documentElement.append(frame);
    </script>`;
    await start(page);
    await importFolder(page, projectFolder({ bad: { "index.html": html } }, [{}]));
    await expect(notice(page, "发的消息太多")).toBeVisible({ timeout: 20000 });
    await expectEditorWorks(page);
    problems.splice(0);
  });
});

test.describe("a page inside a scene", () => {
  /** Keeps count of what the compositor read of messages from anybody but its frames and parent. */
  const countReadsInCompositor = (page: Page) =>
    page.addInitScript(() => {
      if (window === window.top) return;
      const read = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get;
      const state = { reads: 0 };
      Object.assign(window, { strangers: state });
      Object.defineProperty(MessageEvent.prototype, "data", {
        get(this: MessageEvent) {
          const frames = [...document.querySelectorAll("iframe")];
          const known =
            this.source === parent || frames.some((frame) => frame.contentWindow === this.source);
          if (this.target === window && !known) state.reads += 1;
          return read?.call(this);
        },
      });
    });

  test("gets none of its messages read by the compositor", async ({ page, problems }) => {
    await countReadsInCompositor(page);
    const html = `<!doctype html><script>
      const frame = document.createElement("iframe");
      frame.srcdoc = "<script>for (let i = 0; i < 20; i += 1) parent.parent.postMessage({ type: 'pong', nonce: 1 }, '*');<" + "/script>";
      document.documentElement.append(frame);
      window.sent = true;
    </script>`;
    await openOne(page, html);
    await ran(page, "sent");
    await page.waitForTimeout(500);
    const reads = await (
      await compositor(page)
    ).evaluate(() => (window as unknown as { strangers: { reads: number } }).strangers.reads);
    expect(reads).toBe(0);
    problems.splice(0);
  });
});

test.describe("large messages", () => {
  test.setTimeout(90000);

  test("to the editor never get read, and the tab stays", async ({ page, problems }) => {
    const crashes: string[] = [];
    page.on("crash", () => crashes.push("crash"));
    await countForeignReads(page);
    await openOne(page, bigMessages("top"));
    await expect(notice(page, "发的消息太多")).toBeVisible({ timeout: 40000 });
    await expectEditorWorks(page);
    expect(crashes).toEqual([]);
    expect(await foreignReads(page)).toBe(0);
    problems.splice(0);
  });

  test("to the compositor end with the first one", async ({ page, problems }) => {
    const crashes: string[] = [];
    page.on("crash", () => crashes.push("crash"));
    await openOne(page, bigMessages("parent"));
    await expect(notice(page, "发了不该发的数据")).toBeVisible({ timeout: 40000 });
    await expectEditorWorks(page);
    await expectCompositorWorks(page);
    expect(crashes).toEqual([]);
    problems.splice(0);
  });
});

test.describe("a scene that hangs", () => {
  test.setTimeout(90000);

  const hang = (frame: Frame | undefined) =>
    void frame
      ?.evaluate(() => {
        for (;;);
      })
      .catch(() => {});

  /**
   * Whether a scene is running, which the editor shows by showing its frame. A page that loaded is
   * not there yet: one that hangs on the way in gets much longer before it counts as hung.
   */
  const running = (frame: Frame | undefined) =>
    frame
      ?.frameElement()
      .then((element) =>
        element.evaluate((it) => getComputedStyle(it as Element).visibility !== "hidden"),
      )
      .catch(() => false) ?? false;

  test("gets started again, and says so while that goes on", async ({ page, problems }) => {
    const victim = await openNextToVictim(page, `<!doctype html><p>a</p>`);
    await expect.poll(() => sceneFrames(page).length).toBe(2);
    const bad = () => sceneFrames(page).find((frame) => frame !== victim);
    await expect.poll(() => running(bad())).toBe(true);
    await rememberNotices(page);
    const hung = bad();
    hang(hung);
    await expectEditorWorks(page);
    await expect.poll(() => bad() !== hung, { timeout: 15000 }).toBe(true);
    await expect.poll(() => sceneFrames(page).length, { timeout: 10000 }).toBe(2);
    await expect(notice(page, "没有响应，正在重新打开")).toHaveCount(0, { timeout: 10000 });
    expect((await noticesSeen(page)).join()).toContain("没有响应，正在重新打开");
    await expectAlive(victim);
    problems.splice(0);
  });

  test("three times in a row stop it, with a way to try again", async ({ page, problems }) => {
    const victim = await openNextToVictim(page, `<!doctype html><p>a</p>`);
    await expect.poll(() => sceneFrames(page).length).toBe(2);
    const bad = () => sceneFrames(page).find((frame) => frame !== victim);
    for (let round = 0; round < 3; round += 1) {
      await expect.poll(() => running(bad()), { timeout: 15000 }).toBe(true);
      const hung = bad();
      hang(hung);
      if (round < 2) await expect.poll(() => bad() !== hung, { timeout: 15000 }).toBe(true);
    }
    await expect(notice(page, "卡死了")).toBeVisible({ timeout: 30000 });
    // The frame is gone before people hear of it, but its page hangs, and it takes a moment until
    // the browser says so.
    await expect.poll(() => sceneFrames(page)).toEqual([victim]);
    await expectAlive(victim);
    await expectEditorWorks(page);
    await content(page, "preview").getByRole("button", { name: "重试" }).click();
    await expect(notice(page, "卡死了")).toHaveCount(0);
    await expect.poll(() => sceneFrames(page).length).toBe(2);
    problems.splice(0);
  });

  test("on the way in stops by itself, with a way to try again", async ({ page, problems }) => {
    test.setTimeout(120000);
    await start(page);
    const html = `<!doctype html><script>for (;;);</script>`;
    await importFolder(page, projectFolder({ bad: { "index.html": html } }, [{}]));
    await expectEditorWorks(page);
    await expect(notice(page, "卡死了")).toBeVisible({ timeout: 100000 });
    // See above: a frame that hangs takes a moment to be gone for the browser.
    await expect.poll(() => sceneFrames(page).length).toBe(0);
    await content(page, "preview").getByRole("button", { name: "重试" }).click();
    await expect(notice(page, "卡死了")).toHaveCount(0);
    await expect.poll(() => sceneFrames(page).length).toBe(1);
    problems.splice(0);
  });
});

test.describe("a compositor that hangs", () => {
  test.setTimeout(120000);

  const hang = async (page: Page) =>
    void (await compositor(page))
      .evaluate(() => {
        for (;;);
      })
      .catch(() => {});

  test("gets a new frame by itself, and people hear about it", async ({ page, problems }) => {
    await openOne(page, FINE);
    const before = await compositor(page);
    await hang(page);
    await expect(page.getByText("预览没有响应，已经重新启动")).toBeVisible({ timeout: 15000 });
    await expect
      .poll(async () => [undefined, before].includes(await findCompositor(page)))
      .toBe(false);
    await expect.poll(() => sceneFrames(page).length, { timeout: 10000 }).toBe(1);
    await expectEditorWorks(page);
    problems.splice(0);
  });

  test("stops after three times, with a way out", async ({ page, problems }) => {
    await openOne(page, FINE);
    for (let round = 0; round < 3; round += 1) {
      await expect.poll(() => sceneFrames(page).length, { timeout: 15000 }).toBe(1);
      await expect
        .poll(
          async () =>
            (await findCompositor(page))
              ?.evaluate(() => document.querySelector("canvas") !== null)
              .catch(() => false),
          { timeout: 15000 },
        )
        .toBe(true);
      await hang(page);
      if (round < 2) await page.waitForTimeout(9000);
    }
    await expect(notice(page, "预览一直没有响应")).toBeVisible({ timeout: 15000 });
    // The frame goes with its element, and the test hears of that a moment after the notice.
    await expect.poll(() => findCompositor(page)).toBeUndefined();
    expect(sceneFrames(page)).toHaveLength(0);
    await expectEditorWorks(page);
    await content(page, "preview").getByRole("button", { name: "不运行场景，重新启动" }).click();
    await expect(notice(page, "场景没有运行")).toBeVisible();
    await expect(sceneFrames(page)).toHaveLength(0);
    await content(page, "preview").getByRole("button", { name: "重新运行场景" }).click();
    await expect(notice(page, "场景没有运行")).toHaveCount(0);
    await expect.poll(() => sceneFrames(page).length, { timeout: 15000 }).toBe(1);
    problems.splice(0);
  });
});

test.describe("the keyboard", () => {
  test.setTimeout(60000);

  const THIEF = `<!doctype html><dialog id="trap"><input autofocus></dialog><script>
    const trap = document.getElementById("trap");
    window.keys = [];
    addEventListener("keydown", ({ key }) => keys.push(key));
    window.steal = () => {
      trap.close();
      trap.showModal();
    };
  </script>`;

  const steal = (frame: Frame | undefined) =>
    frame?.evaluate(() => (window as unknown as { steal: () => void }).steal());

  test("comes back to the editor after a scene took it", async ({ page, problems }) => {
    await openOne(page, THIEF);
    await ran(page, "steal");
    await steal(sceneFrames(page)[0]);
    await page.waitForTimeout(200);
    const active = await page.evaluate(() => document.activeElement?.tagName);
    expect(active).not.toBe("IFRAME");
    await expectEditorWorks(page);
    const keys = await sceneFrames(page)[0]?.evaluate(
      () => (window as unknown as { keys: string[] }).keys,
    );
    expect(keys).toEqual([]);
    problems.splice(0);
  });

  test("goes back to what had it", async ({ page, problems }) => {
    await openOne(page, THIEF);
    await ran(page, "steal");
    await page.getByRole("button", { name: "命令面板" }).click();
    const input = page.getByRole("combobox");
    await input.fill("时");
    await steal(sceneFrames(page)[0]);
    await page.waitForTimeout(200);
    await page.keyboard.type("间");
    await expect(input).toHaveValue("时间");
    await page.keyboard.press("Escape");
    problems.splice(0);
  });

  test("a scene that goes on taking it is taken away", async ({ page, problems }) => {
    await openOne(page, THIEF);
    await ran(page, "steal");
    const frame = sceneFrames(page)[0] as Frame;
    for (let round = 0; round < 6 && !frame.isDetached(); round += 1) {
      await steal(frame)?.catch(() => {});
      await page.waitForTimeout(150);
    }
    await expect(notice(page, "反复抢键盘焦点")).toBeVisible({ timeout: 5000 });
    await expect(sceneFrames(page)).toHaveLength(0);
    await expectEditorWorks(page);
    problems.splice(0);
  });

  test("a scene can do its worst from a loop of its own", async ({ page, problems }) => {
    const html = THIEF.replace(
      "</script>",
      `window.addEventListener("load", () => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = () => { steal(); port2.postMessage(0); };
        port2.postMessage(0);
      });</script>`,
    );
    await start(page);
    await importFolder(page, projectFolder({ bad: { "index.html": html } }, [{}]));
    await expect(notice(page, "反复抢键盘焦点")).toBeVisible({ timeout: 15000 });
    await expectEditorWorks(page);
    problems.splice(0);
  });

  test("a scene that means no harm does not get it, and goes on", async ({ page, problems }) => {
    const html = `<!doctype html><input id="a" autofocus><script>
      document.getElementById("a").focus();
      window.focus();
    </script>`;
    await openOne(page, html);
    await expectEditorWorks(page);
    await expect(notice(page, "抢键盘焦点")).toHaveCount(0);
    problems.splice(0);
  });

  test("is not forwarded from a scene, so that it cannot press anything", async ({
    page,
    problems,
  }) => {
    const html = `<!doctype html><script>
      window.press = () => {
        const fake = { type: "keydown", key: "Delete", code: "Delete" };
        parent.postMessage(fake, "*");
        top.postMessage(fake, "*");
      };
    </script>`;
    await start(page);
    await importFolder(page, projectFolder({ bad: { "index.html": html } }, [{}]));
    await ran(page, "press");
    const clips = content(page, "timeline").getByRole("option");
    await clickFirstClip(page);
    await sceneFrames(page)[0]?.evaluate(() =>
      (window as unknown as { press: () => void }).press(),
    );
    await page.waitForTimeout(300);
    await expect(clips).toHaveCount(1);
    problems.splice(0);
  });
});

test.describe("a scene that cannot run", () => {
  test("without its entry says so", async ({ page, problems }) => {
    await start(page);
    await importFolder(page, projectFolder({ bad: { "other.html": "<p>a</p>" } }, [{}]));
    await page.getByRole("dialog").getByRole("button").click();
    await expect(notice(page, "入口文件不在")).toBeVisible({ timeout: 15000 });
    await expectEditorWorks(page);
    problems.splice(0);
  });
});

test.describe("what a scene says", () => {
  test("to the compositor changes nothing when it is not what the protocol has", async ({
    page,
    problems,
  }) => {
    const html = `<!doctype html><script>
      const say = (message) => { parent.postMessage(message, "*"); top.postMessage(message, "*"); };
      window.addEventListener("load", () => {
        say({ type: "seeked", request: 1, frame: 0, stateful: false });
        say({ type: "needs-replay", request: 1, frame: 0 });
        say({ type: "plan", plan: {} });
        say({ type: "ready" });
        say({ type: "needs", id: "x" });
        say({ type: "needs-scene", scene: "other", revision: "x" });
        say({ type: "scene-status", layer: "x", status: { state: "stopped" } });
        say({ type: "pong", nonce: 1 });
      });
    </script>`;
    await openOne(page, html);
    await expectEditorWorks(page);
    await page.waitForTimeout(500);
    await expect(sceneFrames(page)).toHaveLength(1);
    problems.splice(0);
  });

  test("cannot go to the frames around it", async ({ page, problems }) => {
    const html = `<!doctype html><script>
      window.attack = () => {
        const out = {};
        const attempt = (name, run) => {
          try { run(); out[name] = "no error"; } catch (error) { out[name] = error.name; }
        };
        const to = "https://example.com/";
        attempt("parent", () => { parent.location.href = to; });
        attempt("top", () => { top.location.href = to; });
        attempt("neighbour", () => { parent.frames[0].location.href = to; });
        return out;
      };
    </script>`;
    const victim = await openNextToVictim(page, html);
    await expect
      .poll(async () => {
        const answers = await Promise.all(
          sceneFrames(page).map((frame) => frame.evaluate(() => "attack" in window)),
        );
        return answers.filter(Boolean).length;
      })
      .toBe(1);
    const url = page.url();
    const shown = await compositor(page);
    const compositorUrl = shown.url();
    for (const frame of sceneFrames(page)) {
      await frame.evaluate(() => (window as unknown as { attack?: () => unknown }).attack?.());
    }
    await page.waitForTimeout(800);
    expect(page.url()).toBe(url);
    expect(shown.url()).toBe(compositorUrl);
    expect(victim.url()).toContain("/scene.html");
    await expectAlive(victim);
    await expectEditorWorks(page);
    problems.splice(0);
  });

  test("leaves the history of the tab as it is", async ({ page, problems }) => {
    const html = `<!doctype html><script>
      window.push = () => { for (let i = 0; i < 30; i += 1) history.pushState({}, "", "?" + i); };
    </script>`;
    await openOne(page, html);
    await ran(page, "push");
    const before = await page.evaluate(() => history.length);
    await sceneFrames(page)[0]?.evaluate(() => (window as unknown as { push: () => void }).push());
    expect(await page.evaluate(() => history.length)).toBe(before);
    problems.splice(0);
  });
});
