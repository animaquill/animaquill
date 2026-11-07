import { test } from "@playwright/test";
import { OUTSIDE, SCENES } from "./hosts.ts";
import {
  expect,
  expectAllWell,
  expectGone,
  openLab,
  openScene,
  pageScene,
  type TestScene,
} from "./support.ts";

test.beforeEach(({ page }) => openLab(page));

/** Keeps sending, a burst at a time, and goes back to the event loop in between, so it stays alive. */
const FLOOD = (target: string, message: string, burst: number) => `<!doctype html><script>
  window.attack = () => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      for (let i = 0; i < ${burst}; i += 1) ${target}.postMessage(${message}, "*");
      port2.postMessage(0);
    };
    port2.postMessage(0);
  };
</script>`;

const attack = (scene: TestScene) =>
  scene
    .read(() => (window as unknown as { attack: () => void }).attack())
    .catch(() => {
      // The frame may be gone before the answer is.
    });

const BIG = `{ type: "pong", nonce: 1, pad: "x".repeat(64 * 1024 * 1024) }`;

test.describe("a scene that talks too much to the compositor", () => {
  test("is taken out at once, and the neighbour does not pay for it", async ({ page }) => {
    const victim = await pageScene(page, `<!doctype html><p>next door</p>`);
    const scene = await pageScene(page, FLOOD("parent", `{ type: "pong", nonce: 1 }`, 2000));
    await scene.seek(5);
    await attack(scene);
    await expectGone(scene, "flood");
    await expectAllWell(page, victim);
  });

  test("gets nowhere by starting right away", async ({ page }) => {
    const victim = await pageScene(page, `<!doctype html><p>next door</p>`);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        requestAnimationFrame(() => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = () => {
            for (let i = 0; i < 2000; i += 1) parent.postMessage({ type: "pong", nonce: 1 }, "*");
            port2.postMessage(0);
          };
          port2.postMessage(0);
        });
      </script>`,
    );
    await scene.seek(5);
    await expectGone(scene, "flood");
    await expectAllWell(page, victim);
  });

  test("does not get one more message read than it was allowed", async ({ page }) => {
    const scene = await pageScene(page, FLOOD("parent", `{ type: "pong", nonce: 1 }`, 200), {
      messageRules: { burstMessages: 60, messagesPerSecond: 1 },
    });
    await attack(scene);
    await expectGone(scene, "flood");
    await page.waitForTimeout(100);
    const { received, read } = (await page.evaluate(() => window.lab.call("reads"))) as {
      received: number;
      read: number;
    };
    expect(read).toBeLessThanOrEqual(60);
    expect(received).toBeGreaterThan(read);
  });

  test("gets nowhere with nonsense, which still has to be looked at", async ({ page }) => {
    const scene = await pageScene(page, FLOOD("parent", "0", 2000));
    await attack(scene);
    await expectGone(scene, "flood");
  });

  test("gets nowhere from a frame of its own", async ({ page }) => {
    const victim = await pageScene(page, `<!doctype html><p>next door</p>`);
    const scene = await pageScene(
      page,
      `<!doctype html><iframe id="inner" srcdoc="<script>
        const { port1, port2 } = new MessageChannel();
        window.go = () => {
          port1.onmessage = () => {
            for (let i = 0; i < 2000; i += 1) parent.parent.postMessage(0, '*');
            port2.postMessage(0);
          };
          port2.postMessage(0);
        };
        addEventListener('message', () => window.go());
      </script>"></iframe><script>
        window.attack = () => document.getElementById("inner").contentWindow.postMessage(0, "*");
      </script>`,
    );
    await attack(scene);
    await expectGone(scene, "flood");
    // What a page in the scene writes counts, and it never means anything, so nothing gets to read it.
    const { strangers } = (await page.evaluate(() => window.lab.call("reads"))) as {
      strangers: number;
    };
    expect(strangers).toBe(0);
    await expectAllWell(page, victim);
  });

  test("while spinning is found out as well", async ({ page }) => {
    const victim = await pageScene(page, `<!doctype html><p>next door</p>`);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => { for (;;) parent.postMessage({ type: "pong", nonce: 1 }, "*"); };
      </script>`,
    );
    await scene.seek(5);
    await attack(scene);
    // A thread that never rests does not get all of that out, so it may be caught either way.
    await expect.poll(async () => (await scene.info()).failures.length, { timeout: 10000 }).toBe(1);
    expect(["flood", "silent"]).toContain((await scene.info()).failures[0]?.reason);
    await expectAllWell(page, victim);
  });

  test("does not make up for hanging with answers to nothing", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        addEventListener("load", () => {
          const send = parent.postMessage.bind(parent);
          document.open();
          // Says something every time, and it is never what was asked.
          addEventListener("message", ({ data }) => {
            if (data?.type === "ping") send({ type: "pong", nonce: data.nonce + 1 }, "*");
          });
        });
      </script>`,
      { watchdog: { running: 2500 } },
    );
    await expect.poll(async () => (await scene.info()).failures.length, { timeout: 10000 }).toBe(1);
    expect((await scene.info()).failures[0]).toMatchObject({ reason: "silent", retrying: true });
  });

  test("is left alone below the limit", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => {
          for (let i = 0; i < 500; i += 1) parent.postMessage({ type: "pong", nonce: 1 }, "*");
        };
      </script>`,
    );
    await attack(scene);
    await page.waitForTimeout(300);
    expect((await scene.info()).failures).toEqual([]);
    expect(await scene.seek(5)).toBe(true);
  });

  test("cannot bury the problems list", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => {
          for (let i = 0; i < 1000; i += 1) {
            const problem = { kind: "error", frame: 0, message: "number " + i };
            parent.postMessage({ type: "problem", problem }, "*");
          }
        };
      </script>`,
    );
    await attack(scene);
    await page.waitForTimeout(500);
    const { problems, failures } = await scene.info();
    expect(failures).toEqual([]);
    expect(problems.length).toBeLessThanOrEqual(201);
    expect(problems.at(-1)?.code).toBe("too-many-problems");
  });
});

test.describe("a message that is too big", () => {
  test("for the compositor takes the scene out on the first one", async ({ page }) => {
    const crashes: string[] = [];
    page.on("crash", () => crashes.push("crash"));
    const victim = await pageScene(page, `<!doctype html><p>next door</p>`);
    const scene = await pageScene(page, FLOOD("parent", BIG, 1));
    await scene.seek(5);
    await attack(scene);
    await expectGone(scene, "oversized");
    await expectAllWell(page, victim);
    expect(crashes).toEqual([]);
  });

  test("for the editor never gets read, and the scene goes all the same", async ({ page }) => {
    test.setTimeout(60000);
    const crashes: string[] = [];
    page.on("crash", () => crashes.push("crash"));
    const victim = await pageScene(page, `<!doctype html><p>next door</p>`);
    const scene = await pageScene(page, FLOOD("top", BIG, 1));
    await scene.seek(5);
    await attack(scene);
    // Nothing tells how big a message is without reading it, so these count like any others, and
    // each one takes hundreds of milliseconds to get here.
    await expectGone(scene, "flood", 40000);
    expect(await page.evaluate(() => window.lab.foreign())).toBeGreaterThan(9);
    expect(await page.evaluate(() => window.lab.foreignReads())).toBe(0);
    await expectAllWell(page, victim);
    expect(crashes).toEqual([]);
  });
});

test.describe("a scene that writes to the editor", () => {
  test("is taken out as well, because nothing in a scene has to", async ({ page }) => {
    const victim = await pageScene(page, `<!doctype html><p>next door</p>`);
    const scene = await pageScene(page, FLOOD("top", "0", 2000));
    await attack(scene);
    await expectGone(scene, "flood");
    await expectAllWell(page, victim);
  });

  test("from a frame of its own too", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><iframe id="inner" srcdoc="<script>
        addEventListener('message', () => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = () => {
            for (let i = 0; i < 2000; i += 1) top.postMessage(0, '*');
            port2.postMessage(0);
          };
          port2.postMessage(0);
        });
      </script>"></iframe><script>
        window.attack = () => document.getElementById("inner").contentWindow.postMessage(0, "*");
      </script>`,
    );
    await attack(scene);
    await expectGone(scene, "flood");
  });

  test("gets away with a few, which could be a library that means well", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => { for (let i = 0; i < 5; i += 1) top.postMessage("ready", "*"); };
      </script>`,
    );
    await attack(scene);
    await page.waitForTimeout(200);
    expect((await scene.info()).failures).toEqual([]);
  });
});

test.describe("a browser that does not say who is around a page", () => {
  test.beforeEach(({ page }) =>
    page.route("**/scene.html", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replaceAll("location.ancestorOrigins", "undefined");
      await route.fulfill({ response, body });
    }),
  );

  test("counts as one that cannot capture, and that is known at once", async ({ page }) => {
    const started = Date.now();
    const scene = await pageScene(page, `<!doctype html><p>a</p>`, { stage: undefined });
    const { capture, state, frames } = await scene.info();
    expect([capture, state, frames]).toEqual([false, "unsupported", 0]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("runs nothing, even when told to", async ({ page }) => {
    const scene = await openScene(page, {
      entry: "index.html",
      files: { "index.html": `<!doctype html><p>a</p>` },
      watchdog: { loading: 2500 },
    });
    expect((await scene.info()).failures[0]).toMatchObject({ reason: "silent", phase: "loading" });
  });
});

test("a page elsewhere gets nothing out of the scene page", async ({ page }) => {
  await page.goto(`${OUTSIDE}/third-party`);
  const said = await page.evaluate(async (origin) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = `${origin}/scene.html`;
    document.body.append(frame);
    const seen: unknown[] = [];
    addEventListener("message", ({ data, source }) => {
      if (source === frame.contentWindow) seen.push(data);
    });
    await new Promise((resolve) => frame.addEventListener("load", resolve));
    const code = new Blob([`parent.postMessage("ran", "*")`], { type: "text/javascript" });
    frame.contentWindow?.postMessage({ type: "boot", code }, "*");
    await new Promise((resolve) => setTimeout(resolve, 500));
    return seen;
  }, SCENES[0]);
  expect(said).toEqual([]);
});
