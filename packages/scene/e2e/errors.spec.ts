import { test } from "@playwright/test";
import { expect, openLab, openScene, pageScene, type TestScene } from "./support.ts";

test.beforeEach(({ page }) => openLab(page));

const errors = async (scene: TestScene) =>
  (await scene.problems())
    .filter(({ kind }) => kind === "error" || kind === "rejection")
    .map(({ kind, message, file, line, column }) => ({ kind, message, file, line, column }));

const PAGE = "scenes/test/index.html";

test.describe("says where the project went wrong", () => {
  test("in a classic script", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><script src="a.js"></script>`, {
      files: {
        "scenes/test/a.js": `\n\nfunction boom() {\n  throw new Error("classic");\n}\nboom();\n`,
      },
    });
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "Error: classic", file: "scenes/test/a.js", line: 4, column: 9 },
    ]);
    const [problem] = await scene.problems();
    expect(problem?.stack).toContain("scenes/test/a.js:4:9");
    expect(problem?.stack).toContain("scenes/test/a.js:6:1");
    expect(problem?.stack).not.toContain("blob:");
  });

  test("in a module", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script type="module" src="a.js"></script>`,
      {
        files: {
          "scenes/test/a.js": `import { b } from "./b.js";\nb();\n`,
          "scenes/test/b.js": `export function b() {\n  throw new TypeError("in b");\n}\n`,
        },
      },
    );
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "TypeError: in b", file: "scenes/test/b.js", line: 2, column: 9 },
    ]);
  });

  test("on the first line of a module that was changed in front", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script type="module" src="a.js"></script>`,
      {
        files: { "scenes/test/a.js": `const a = import.meta.url; throw new Error("first");` },
      },
    );
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "Error: first", file: "scenes/test/a.js", line: 1, column: 34 },
    ]);
  });

  test("in the head of the page", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html>\n<html>\n<head>\n<script>\n  const a = 1;\n  throw new Error("in head");\n</script>\n</head>`,
    );
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "Error: in head", file: PAGE, line: 6, column: 9 },
    ]);
  });

  test("in the body of the page", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html>\n<body>\n\n<p>a</p>\n  <script>throw new Error("in body");</script>\n<p id="after">b</p>`,
    );
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "Error: in body", file: PAGE, line: 5, column: 17 },
    ]);
    expect(await scene.read(() => document.getElementById("after")?.textContent)).toBe("b");
  });

  test("in a module in the page", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html>\n<script type="module">\n\n  throw new Error("inline module");\n</script>`,
    );
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "Error: inline module", file: PAGE, line: 4, column: 9 },
    ]);
  });

  test("with a syntax error", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script src="a.js"></script><script type="module" src="b.js"></script>`,
      {
        files: {
          "scenes/test/a.js": `\nlet = = 1;\n`,
          "scenes/test/b.js": `\n\nexport const a = ;\n`,
        },
      },
    );
    const seen = await errors(scene);
    expect(seen.map(({ file, line }) => [file, line]).toSorted()).toEqual([
      ["scenes/test/a.js", 2],
      ["scenes/test/b.js", 3],
    ]);
  });

  test("with an import that does not exist", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script type="module" src="a.js"></script>`,
      {
        files: {
          "scenes/test/a.js": `import { nothing } from "./b.js";\nimport "./gone.js";`,
          "scenes/test/b.js": `export const b = 1;`,
        },
      },
    );
    const problems = await scene.problems();
    expect(problems.find(({ code }) => code === "missing-file")).toMatchObject({
      file: "scenes/test/a.js",
      line: 2,
      target: "./gone.js",
    });
  });

  test("when a frame callback throws", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>\nrequestAnimationFrame(() => {\n  throw new Error("in a frame");\n});\n</script>`,
    );
    await scene.seek(3);
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "Error: in a frame", file: PAGE, line: 3, column: 9 },
    ]);
    const [problem] = await scene.problems();
    expect(problem?.frame).toBe(0);
    expect(problem?.stack).not.toContain("blob:");
  });

  test("when a timer throws, with the frame it happened on", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><script src="a.js"></script>`, {
      files: {
        "scenes/test/a.js": `setTimeout(() => {\n  throw new RangeError("late");\n}, 1000);`,
      },
    });
    await scene.seek(120);
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "RangeError: late", file: "scenes/test/a.js", line: 2, column: 9 },
    ]);
    expect((await scene.problems())[0]?.frame).toBeGreaterThanOrEqual(59);
  });

  test("when aq.frame code throws", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>aq.frame(() => {\n  throw new Error("each frame");\n});</script>`,
    );
    await scene.seek(3);
    await scene.seek(4);
    expect(await errors(scene)).toEqual([
      { kind: "error", message: "Error: each frame", file: PAGE, line: 2, column: 9 },
    ]);
  });

  test("when a promise is rejected", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><script src="a.js"></script>`, {
      files: {
        "scenes/test/a.js": `\nPromise.reject(new Error("no one listens"));\nPromise.reject("just a string");`,
      },
    });
    await expect.poll(async () => (await errors(scene)).length).toBe(2);
    expect(await errors(scene)).toEqual([
      {
        kind: "rejection",
        message: "Error: no one listens",
        file: "scenes/test/a.js",
        line: 2,
        column: 16,
      },
      {
        kind: "rejection",
        message: "just a string",
        file: undefined,
        line: undefined,
        column: undefined,
      },
    ]);
  });

  test("when a worker fails", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><script>new Worker("w.js")</script>`, {
      files: { "scenes/test/w.js": `\n\nthrow new Error("in a worker");` },
    });
    await expect.poll(async () => (await errors(scene)).length).toBe(1);
    expect(await errors(scene)).toEqual([
      {
        kind: "error",
        message: "Uncaught Error: in a worker",
        file: "scenes/test/w.js",
        line: 3,
        column: 7,
      },
    ]);
  });

  test("when a module in a worker fails", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>new Worker("w.js", { type: "module" })</script>`,
      { files: { "scenes/test/w.js": `\n\nthrow new Error("in a module worker");` } },
    );
    await expect.poll(async () => (await errors(scene)).length).toBe(1);
    expect((await errors(scene))[0]).toMatchObject({
      file: "scenes/test/w.js",
      line: 3,
      column: 7,
    });
  });

  test("when a resource cannot be read", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><img id="a" src="broken.png">`, {
      files: { "scenes/test/broken.png": "this is not a picture" },
    });
    const resources = (await scene.problems()).filter(({ kind }) => kind === "resource");
    expect(resources).toHaveLength(1);
  });

  test("and the project's own onerror still runs", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.seen = [];
        addEventListener("error", ({ message }) => seen.push(message));
        setTimeout(() => { throw new Error("from a timer"); }, 0);
      </script>`,
    );
    await scene.seek(1);
    expect(await scene.read(() => (window as unknown as { seen: string[] }).seen)).toEqual([
      "Uncaught Error: from a timer",
    ]);
  });
});

test("a scene that fails goes on working, and so does everything around it", async ({ page }) => {
  const other = await pageScene(page, `<!doctype html><p>fine</p>`);
  const scene = await pageScene(
    page,
    `<!doctype html><style>
      @keyframes mv { to { translate: 1000px } }
      #a { animation: mv 1000ms linear both }
    </style><div id="a"></div><script>
      throw new Error("at load");
    </script><script>
      requestAnimationFrame(function again() {
        requestAnimationFrame(again);
        throw new Error("every frame");
      });
      setInterval(() => { throw new Error("every timer"); }, 10);
    </script>`,
  );
  expect(await scene.seek(30)).toBe(true);
  const x = await scene.read(
    () => getComputedStyle(document.getElementById("a") as Element).translate,
  );
  expect(x).toBe("500px");
  expect((await scene.info()).state).toBe("ready");
  expect(await other.seek(5)).toBe(true);
  expect(await page.evaluate(() => window.lab.call("alive"))).toBe(true);
});

test("one problem is one report, however often it happens", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      requestAnimationFrame(function again() {
        requestAnimationFrame(again);
        throw new Error("every frame");
      });
    </script>`,
  );
  await scene.seek(120);
  expect(await errors(scene)).toHaveLength(1);
});

test.describe("a scene that hangs", () => {
  const LIMITS = { hello: 2500, loading: 2500, running: 2500 };

  test("while loading is noticed, tried again, and then left alone", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await openScene(page, {
      entry: "index.html",
      files: { "index.html": `<!doctype html><script>for (;;);</script>` },
      watchdog: LIMITS,
    });
    const info = await scene.info();
    expect(info.state).toBe("stopped");
    expect(info.failures).toEqual([
      { reason: "silent", phase: "loading", frame: 0, retrying: true },
      { reason: "silent", phase: "loading", frame: 0, retrying: true },
      { reason: "silent", phase: "loading", frame: 0, retrying: false },
    ]);
    expect(info.frames).toBe(0);
    expect(await page.evaluate(() => window.lab.call("alive"))).toBe(true);
  });

  test("on a later frame is noticed the same way", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>setTimeout(() => { for (;;); }, 1000);</script>`,
      { watchdog: LIMITS },
    );
    expect(await scene.seek(30)).toBe(true);
    expect(await scene.seek(120)).toBe(false);
    const info = await scene.info();
    expect(info.state).toBe("stopped");
    expect(info.failures).toHaveLength(3);
    expect(info.failures[0]).toMatchObject({
      reason: "silent",
      phase: "seeking",
      frame: 30,
      target: 120,
      retrying: true,
    });
  });

  test("gets a new frame on another origin, which takes over where it was", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>window.hang = () => { for (;;); };</script>`,
      { watchdog: LIMITS },
    );
    await scene.seek(30);
    const before = await scene.info();
    const frame = await scene.frame();
    void frame.evaluate(() => (window as unknown as { hang: () => void }).hang()).catch(() => {});
    await expect.poll(async () => (await scene.info()).failures.length, { timeout: 10000 }).toBe(1);
    await expect.poll(() => scene.read(() => performance.now()), { timeout: 10000 }).toBe(500);
    const after = await scene.info();
    expect(after.origin).not.toBe(before.origin);
    expect(after.state).toBe("ready");
    expect(after.frames).toBe(1);
    expect(after.failures[0]).toMatchObject({ phase: "running", frame: 30, retrying: true });
    expect(await scene.seek(60)).toBe(true);
  });

  test("does not take the scene next to it along", async ({ page }) => {
    test.setTimeout(30000);
    const other = await pageScene(page, `<!doctype html><p>fine</p>`);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
      window.hang = () => { for (;;); };
    </script>`,
      { watchdog: LIMITS },
    );
    void scene.read(() => (window as unknown as { hang: () => void }).hang()).catch(() => {});
    await page.waitForTimeout(300);
    for (let round = 0; round < 5; round += 1) {
      expect(await other.seek(round * 10 + 1)).toBe(true);
      await page.waitForTimeout(100);
    }
    expect(await page.evaluate(() => window.lab.call("alive"))).toBe(true);
  });
});

test("takes new curves without tripping over them", async ({ page }) => {
  const scene = await pageScene(page, `<!doctype html><p>a</p>`);
  expect(await scene.seek(600)).toBe(true);
  await scene.call("channels", "layer-1", { "param.size": { keys: [] } });
  expect(await scene.seek(3)).toBe(true);
  expect(await scene.problems()).toEqual([]);
});

test.describe("what a scene claims is not taken at its word", () => {
  const LIMITS = { hello: 2500, loading: 2500, running: 2500 };

  test("saying it got somewhere does not make up for hanging", async ({ page }) => {
    test.setTimeout(40000);
    const scene = await openScene(page, {
      entry: "index.html",
      files: {
        // What a script sends only leaves when it ends, so the hanging has to come a task later.
        "index.html": `<!doctype html><script>
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = () => { for (;;); };
          parent.postMessage({ type: "seeked", request: 0, frame: 0, stateful: false }, "*");
          port2.postMessage(0);
        </script>`,
      },
      watchdog: LIMITS,
    });
    const info = await scene.info();
    expect(info.state).toBe("stopped");
    expect(info.failures.map(({ retrying }) => retrying)).toEqual([true, true, false]);
  });

  test("an answer right before it hangs does not either", async ({ page }) => {
    test.setTimeout(40000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        // Does what it was asked, for real, every time, and goes down right after that.
        addEventListener("load", () => {
          const send = parent.postMessage.bind(parent);
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = () => { for (;;); };
          document.open();
          addEventListener("message", ({ data }) => {
            if (data?.type !== "seek") return;
            send({ type: "seeked", request: data.request, frame: data.frame }, "*");
            port2.postMessage(0);
          });
        });
      </script>`,
      { watchdog: LIMITS },
    );
    expect(await scene.seek(5)).toBe(true);
    await expect.poll(async () => (await scene.info()).state, { timeout: 30000 }).toBe("stopped");
    const { failures } = await scene.info();
    expect(failures.map(({ retrying }) => retrying)).toEqual([true, true, false]);
  });

  test("asking for a new frame without reason ends the seek and the scene", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        addEventListener("message", ({ data }) => {}, true);
        // What the runtime would say to an ordinary seek, had it any reason to.
        const say = (request, frame) =>
          parent.postMessage({ type: "needs-replay", request, frame }, "*");
        for (let request = 1; request < 50; request += 1) say(request, 5);
        requestAnimationFrame(function again() {
          for (let request = 1; request < 50; request += 1) say(request, 5);
          requestAnimationFrame(again);
        });
      </script>`,
    );
    const started = Date.now();
    const seen: string[] = [];
    page.on("frameattached", () => seen.push("attached"));
    const reached = await scene.seek(5);
    await page.waitForTimeout(500);
    expect(Date.now() - started).toBeLessThan(8000);
    const info = await scene.info();
    expect(seen).toEqual([]);
    expect(reached).toBe(false);
    expect(info.state).toBe("stopped");
    expect(info.failures).toEqual([
      { reason: "replay", phase: "running", frame: 0, retrying: false },
    ]);
  });

  test("a new frame that asks for another one goes the same way", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        // Every seek gets the answer that it would take a new frame, starting with the second.
        let seeks = 0;
        const realSend = parent.postMessage.bind(parent);
        addEventListener("load", () => {
          document.open();
          addEventListener("message", ({ data }) => {
            if (data?.type === "ping") realSend({ type: "pong", nonce: data.nonce }, "*");
            if (data?.type !== "seek") return;
            seeks += 1;
            if (seeks === 1) realSend({ type: "seeked", request: data.request, frame: data.frame }, "*");
            else realSend({ type: "needs-replay", request: data.request, frame: data.frame }, "*");
          });
        });
      </script>`,
    );
    expect(await scene.seek(10)).toBe(true);
    const seen: string[] = [];
    page.on("frameattached", () => seen.push("attached"));
    // The second seek gets a new frame, which behaves on its first seek, so this ends there.
    expect(await scene.seek(20)).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test("starting over again and again has a limit too", async ({ page }) => {
    test.setTimeout(40000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        // Goes along with the first seek of a new frame, and wants another one for the next.
        addEventListener("load", () => {
          const send = parent.postMessage.bind(parent);
          let seeks = 0;
          document.open();
          addEventListener("message", ({ data }) => {
            if (data?.type === "ping") send({ type: "pong", nonce: data.nonce }, "*");
            if (data?.type !== "seek") return;
            seeks += 1;
            const type = seeks === 1 ? "seeked" : "needs-replay";
            send({ type, request: data.request, frame: data.frame }, "*");
          });
        });
      </script>`,
      { watchdog: { replayBurst: 2, replaysPerSecond: 0.5 } },
    );
    await scene.seek(1);
    const started = Date.now();
    // The first two come right away, and each of the others takes two seconds to come up.
    for (const frame of [2, 3, 4, 5]) expect(await scene.seek(frame)).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(3000);
  });

  test("a frame number that was not asked for is not an answer", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        addEventListener("load", () => {
          const send = parent.postMessage.bind(parent);
          document.open();
          addEventListener("message", ({ data }) => {
            if (data?.type === "ping") send({ type: "pong", nonce: data.nonce }, "*");
            if (data?.type === "seek") send({ type: "seeked", request: data.request, frame: 999 }, "*");
          });
        });
      </script>`,
      { watchdog: { seekStallMs: 2500 } },
    );
    expect(await scene.seek(5)).toBe(false);
    expect((await scene.info()).failures.at(-1)).toMatchObject({ reason: "stuck", target: 5 });
  });

  test("a scene that has no answers for anything is told from one that works", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => {
          for (const request of [1, 2, 3, 999]) {
            parent.postMessage({ type: "seeked", request, frame: 1, stateful: false }, "*");
            parent.postMessage({ type: "needs-replay", request, frame: 1 }, "*");
          }
        };
      </script>`,
    );
    const { origin } = await scene.info();
    await scene.read(() => (window as unknown as { attack: () => void }).attack());
    await page.waitForTimeout(100);
    expect(await scene.seek(30)).toBe(true);
    const info = await scene.info();
    expect(info.frames).toBe(1);
    expect(info.origin).toBe(origin);
  });

  test("a playing position only counts while it plays", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = () => parent.postMessage({ type: "position", frame: 5000 }, "*");
      </script>`,
    );
    await scene.seek(10);
    await scene.read(() => (window as unknown as { attack: () => void }).attack());
    await page.waitForTimeout(100);
    expect((await scene.info()).positions).toEqual([]);
  });
});

test.describe("a seek that does not get there", () => {
  /** Keeps answering pings like a scene that is fine, and never goes anywhere. */
  const ZOMBIE = `<!doctype html><script>
    addEventListener("load", () => {
      const send = parent.postMessage.bind(parent);
      document.open();
      addEventListener("message", ({ data }) => {
        if (data?.type === "ping") send({ type: "pong", nonce: data.nonce }, "*");
      });
    });
  </script>`;

  test("has a result, and says what it was doing", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(page, ZOMBIE, { watchdog: { seekStallMs: 2500 } });
    const started = Date.now();
    expect(await scene.seek(30)).toBe(false);
    expect(Date.now() - started).toBeLessThan(15000);
    const info = await scene.info();
    expect(info.state).toBe("stopped");
    expect(info.failures).toEqual([
      { reason: "stuck", phase: "seeking", frame: 0, target: 30, retrying: true },
      { reason: "stuck", phase: "seeking", frame: 0, target: 30, retrying: true },
      { reason: "stuck", phase: "seeking", frame: 0, target: 30, retrying: false },
    ]);
  });

  test("a long way is fine as long as it gets further", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        // About 20 ms of real work on each frame, for many more frames than the limit allows.
        const { port1, port2 } = new MessageChannel();
        (function loop() {
          const until = new Worker(URL.createObjectURL(new Blob([""])));
          until.terminate();
          for (let spin = 0; spin < 3000000; spin += 1);
          requestAnimationFrame(loop);
        })();
      </script>`,
      { watchdog: { seekStallMs: 2500 } },
    );
    expect(await scene.seek(400)).toBe(true);
    expect((await scene.info()).failures).toEqual([]);
  });

  test("talking does not make a load any shorter", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await openScene(page, {
      entry: "index.html",
      files: {
        // A worker keeps real time. A timer in here would wait for a clock that stands still.
        "index.html": `<!doctype html><script type="module">
          const code = "setInterval(() => postMessage(0), 100)";
          const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
          new Worker(url).onmessage = () => parent.postMessage({ type: "pong", nonce: 1 }, "*");
          await new Promise(() => {});
        </script>`,
      },
      watchdog: { loading: 2500 },
    });
    const info = await scene.info();
    expect(info.failures.map(({ reason, phase }) => [reason, phase])).toEqual([
      ["silent", "loading"],
      ["silent", "loading"],
      ["silent", "loading"],
    ]);
    expect(info.state).toBe("stopped");
  });

  test("gets nowhere after a load that takes too long", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await openScene(page, {
      entry: "index.html",
      files: {
        // Without the limit, this would go on after ten seconds without what it was waiting for.
        "index.html": `<!doctype html><script type="module">await new Promise(() => {});</script>`,
      },
      watchdog: { loading: 2500 },
    });
    const info = await scene.info();
    const silent = { reason: "silent", phase: "loading", frame: 0 };
    expect(info.failures).toEqual([
      { ...silent, retrying: true },
      { ...silent, retrying: true },
      { ...silent, retrying: false },
    ]);
    expect(info.state).toBe("stopped");
  });
});

test.describe("what the compositor does to itself", () => {
  test("a long task there is not the scene's fault", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(page, `<!doctype html><p>fine</p>`);
    await scene.seek(5);
    const { origin } = await scene.info();
    await page.evaluate(() => window.lab.call("block", 6000));
    await page.waitForTimeout(1500);
    const info = await scene.info();
    expect(info.failures).toEqual([]);
    expect(info.origin).toBe(origin);
    expect(await scene.seek(10)).toBe(true);
  });

  test("a hang is still found after one", async ({ page }) => {
    test.setTimeout(30000);
    const scene = await pageScene(
      page,
      `<!doctype html><script>window.hang = () => { for (;;); };</script>`,
      { watchdog: { running: 2500 } },
    );
    await page.evaluate(() => window.lab.call("block", 3000));
    const frame = await scene.frame();
    void frame.evaluate(() => (window as unknown as { hang: () => void }).hang()).catch(() => {});
    await expect.poll(async () => (await scene.info()).failures.length, { timeout: 10000 }).toBe(1);
  });
});

test.describe("closing a scene from what tells about its end", () => {
  test("after a hang leaves no frame behind", async ({ page }) => {
    test.setTimeout(30000);
    const opening = openScene(page, {
      entry: "index.html",
      files: { "index.html": `<!doctype html><script>for (;;);</script>` },
      watchdog: { loading: 2500 },
      closeOnFailure: true,
    });
    await opening;
    await page.waitForTimeout(3500);
    expect(await page.evaluate(() => window.lab.call("frames"))).toBe(0);
  });

  test("after a failure stays closed", async ({ page }) => {
    const scene = await openScene(page, {
      entry: "scenes/test/index.html",
      files: {},
      closeOnFailure: true,
    });
    const info = await scene.info();
    expect(info.state).toBe("closed");
    expect(info.frames).toBe(0);
    expect(info.failures).toHaveLength(1);
  });
});

test("after a hang a scene goes back to where it played to, not to the last seek", async ({
  page,
}) => {
  test.setTimeout(30000);
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      window.hang = () => { for (;;); };
      (function loop() { requestAnimationFrame(loop); })();
    </script>`,
    { watchdog: { running: 2500 } },
  );
  await scene.seek(10);
  await scene.call("play", 10);
  await page.waitForTimeout(600);
  await scene.call("pause");
  await page.waitForTimeout(100);
  const { positions, origin } = await scene.info();
  const last = positions.at(-1) as number;
  expect(last).toBeGreaterThan(15);
  const frame = await scene.frame();
  void frame.evaluate(() => (window as unknown as { hang: () => void }).hang()).catch(() => {});
  await expect.poll(async () => (await scene.info()).origin, { timeout: 10000 }).not.toBe(origin);
  await expect
    .poll(() => scene.read(() => performance.now()), { timeout: 10000 })
    .toBe((last * 1000) / 60);
});
