import { test } from "@playwright/test";
import { expect, openLab, pageScene, type TestScene } from "./support.ts";

test.beforeEach(({ page }) => openLab(page));

const FPS = 60;
const moment = (frame: number) => (frame * 1000) / FPS;
const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

// What moves here moves with `translate`. Reading a transform back takes a box, and in a browser that
// cannot capture what is in a canvas has none, so this way the same tests run on both stages. That
// reading a `transform` works just the same has a test of its own, at the end.
const STYLE = `<style>
  .b { position: absolute; left: 0; width: 40px; height: 16px; background: #fff }
  @keyframes mv { to { translate: 1000px } }
  #linear { top: 0; animation: mv 2000ms linear 500ms both }
  #none { top: 20px; animation: mv 1000ms linear 0ms none }
  #alternate { top: 40px; animation: mv 1000ms linear infinite alternate }
  #steps { top: 60px; animation: mv 2000ms steps(4, end) both }
  #pseudo::before { content: ""; display: block; width: 1px; height: 1px; animation: mv 2000ms linear both }
  #svg { position: absolute; left: 0; top: 240px }
</style>`;

const boxes = (...ids: string[]) => ids.map((id) => `<div class="b" id="${id}"></div>`).join("");

const PURE_SCENE = `<!doctype html>${STYLE}<body>
  ${boxes("linear", "none", "alternate", "steps", "pseudo", "waapi", "fast", "scripted")}
  <svg id="svg" width="1100" height="20"><rect id="smil" width="40" height="16" fill="#fff">
    <animate attributeName="x" from="0" to="1000" dur="2s" fill="freeze"/></rect></svg>
  <script>
    const move = [{ translate: "0px" }, { translate: "1000px" }];
    document.getElementById("waapi").animate(move, { duration: 2000, fill: "both" });
    const fast = document.getElementById("fast").animate(move, { duration: 2000, fill: "both" });
    fast.playbackRate = 2;
    const scripted = document.getElementById("scripted");
    aq.frame((seconds) => (scripted.style.translate = seconds * 100 + "px"));
  </script>`;

/** Runs in the scene. Each value is the place of something, and the same goes for the rest. */
function readPure() {
  const place = (element: Element, pseudo?: string) => {
    const value = getComputedStyle(element, pseudo).translate;
    return value === "none" ? 0 : Number.parseFloat(value);
  };
  const by = (id: string) => document.getElementById(id) as HTMLElement;
  return {
    linear: place(by("linear")),
    none: place(by("none")),
    alternate: place(by("alternate")),
    steps: place(by("steps")),
    pseudo: place(by("pseudo"), "::before"),
    waapi: place(by("waapi")),
    fast: place(by("fast")),
    scripted: place(by("scripted")),
    smil: (by("smil") as unknown as SVGRectElement).x.animVal.value,
  };
}

const PURE_EXPECTED: Record<string, (time: number) => number> = {
  linear: (t) => 1000 * clamp((t - 500) / 2000),
  none: (t) => (t < 1000 ? t : 0),
  alternate: (t) => {
    const progress = (t % 1000) / 1000;
    return 1000 * (Math.floor(t / 1000) % 2 ? 1 - progress : progress);
  },
  steps: (t) => 1000 * Math.min(Math.floor((4 * t) / 2000) / 4, 1),
  pseudo: (t) => 1000 * clamp(t / 2000),
  waapi: (t) => 1000 * clamp(t / 2000),
  fast: (t) => 1000 * clamp(t / 1000),
  scripted: (t) => t / 10,
  smil: (t) => 1000 * clamp(t / 2000),
};

async function expectPlaces(
  scene: TestScene,
  frames: readonly number[],
  read: () => Record<string, number>,
  expected: Record<string, (time: number) => number>,
) {
  const worst: Record<string, number> = {};
  for (const frame of frames) {
    await scene.seek(frame);
    const places = await scene.read(read);
    for (const [name, value] of Object.entries(places)) {
      const want = expected[name]?.(moment(frame));
      if (want === undefined) throw new Error(`Nothing expected for ${name}`);
      worst[name] = Math.max(worst[name] ?? 0, Math.abs(value - want));
    }
  }
  for (const [name, error] of Object.entries(worst)) {
    expect(error, `${name} at most 0.001 off`).toBeLessThanOrEqual(0.001);
  }
  expect(Object.keys(worst).toSorted()).toEqual(Object.keys(expected).toSorted());
}

/** Frames in an order that jumps around, the same each time. */
function shuffled(count: number, last: number): number[] {
  let seed = 12345;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: count }, () => Math.floor(random() * last));
}

const forward = Array.from({ length: 200 }, (_, frame) => frame + 1);

test.describe("what only depends on the time", () => {
  // Hundreds of frames, each one there and back through three layers.
  test.describe.configure({ timeout: 120000 });

  test("goes to any frame going forward", async ({ page }) => {
    const scene = await pageScene(page, PURE_SCENE);
    await expectPlaces(scene, forward, readPure, PURE_EXPECTED);
  });

  test("goes to any frame going back", async ({ page }) => {
    const scene = await pageScene(page, PURE_SCENE);
    await expectPlaces(scene, forward.toReversed(), readPure, PURE_EXPECTED);
  });

  test("goes to any frame in any order, without starting over", async ({ page }) => {
    const scene = await pageScene(page, PURE_SCENE);
    const { origin } = await scene.info();
    await expectPlaces(scene, shuffled(200, 210), readPure, PURE_EXPECTED);
    expect((await scene.info()).origin).toBe(origin);
    expect(await scene.problems()).toEqual([]);
  });

  test("jumps straight to a frame on the first move", async ({ page }) => {
    const scene = await pageScene(page, PURE_SCENE);
    await expectPlaces(scene, [90], readPure, PURE_EXPECTED);
  });

  test("gives the same picture every time", async ({ page }) => {
    const scene = await pageScene(page, PURE_SCENE);
    const seen = new Map<number, string>();
    for (const frame of [...shuffled(30, 200), ...shuffled(30, 200)]) {
      await scene.seek(frame);
      const places = JSON.stringify(await scene.read(readPure));
      expect(seen.get(frame) ?? places).toBe(places);
      seen.set(frame, places);
    }
  });

  test("keeps an animation that has ended, to come back to it", async ({ page }) => {
    const scene = await pageScene(page, PURE_SCENE);
    await scene.seek(120);
    expect((await scene.read(readPure)).none).toBe(0);
    await scene.seek(30);
    expect((await scene.read(readPure)).none).toBeCloseTo(500, 3);
  });
});

const STATEFUL_SCENE = `<!doctype html>${STYLE}<body>
  ${boxes("time", "perf", "date", "state", "interval", "late", "transition", "ended", "lucky")}
  <style>
    #transition { transition: translate 1000ms linear }
    #transition.go { translate: 1000px }
  </style>
  <script>
    const $ = (id) => document.getElementById(id);
    // A style only keeps six digits, and the test wants to know what the code worked out.
    window.written = {};
    const set = (id, x) => {
      written[id] = x;
      $(id).style.transform = "translateX(" + x + "px)";
    };
    const move = [{ translate: "0px" }, { translate: "1000px" }];
    const start = Date.now();
    const lucky = Math.random() * 100;
    const loop = (time) => {
      set("time", time / 10);
      set("perf", performance.now() / 10);
      set("date", (Date.now() - start) / 10);
      set("lucky", lucky);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    let x = 0;
    let speed = 0;
    let last = 0;
    const fall = (time) => {
      const step = (time - last) / 1000;
      last = time;
      speed += 200 * step;
      x += speed * step;
      set("state", x);
      requestAnimationFrame(fall);
    };
    requestAnimationFrame(fall);
    let ticks = 0;
    setInterval(() => set("interval", (ticks += 1) * 10), 100);
    setTimeout(() => $("late").animate(move, { duration: 1000, fill: "both" }), 1000);
    setTimeout(() => $("transition").classList.add("go"), 1000);
  </script>`;

function readStateful() {
  const { written } = window as unknown as { written: Record<string, number> };
  const place = (id: string) => {
    const value = getComputedStyle(document.getElementById(id) as Element).translate;
    return value === "none" ? 0 : Number.parseFloat(value);
  };
  return {
    time: written.time ?? 0,
    perf: written.perf ?? 0,
    date: written.date ?? 0,
    state: written.state ?? 0,
    interval: written.interval ?? 0,
    late: place("late"),
    transition: place("transition"),
  };
}

/** The same sum the loop does, so that it has the same rounding. */
function fallen(time: number) {
  let x = 0;
  let speed = 0;
  let last = 0;
  for (let frame = 0; moment(frame) <= time + 1e-6; frame += 1) {
    const step = (moment(frame) - last) / 1000;
    last = moment(frame);
    speed += 200 * step;
    x += speed * step;
  }
  return x;
}

const STATEFUL_EXPECTED: Record<string, (time: number) => number> = {
  time: (t) => t / 10,
  perf: (t) => t / 10,
  date: (t) => t / 10,
  state: fallen,
  interval: (t) => Math.floor(t / 100 + 1e-9) * 10,
  late: (t) => (t < 1000 ? 0 : 1000 * clamp((t - 1000) / 1000)),
  transition: (t) => (t < 1000 ? 0 : 1000 * clamp((t - 1000) / 1000)),
};

test.describe("code that keeps state", () => {
  test.describe.configure({ timeout: 120000 });

  test("is right going forward", async ({ page }) => {
    const scene = await pageScene(page, STATEFUL_SCENE);
    await expectPlaces(scene, forward, readStateful, STATEFUL_EXPECTED);
  });

  test("is right after jumping forward, on every frame in between", async ({ page }) => {
    const scene = await pageScene(page, STATEFUL_SCENE);
    await expectPlaces(scene, [120, 180, 200], readStateful, STATEFUL_EXPECTED);
  });

  test("starts over to go back, and is right there", async ({ page }) => {
    const scene = await pageScene(page, STATEFUL_SCENE);
    await scene.seek(150);
    const before = (await scene.info()).origin;
    await expectPlaces(scene, [100], readStateful, STATEFUL_EXPECTED);
    const after = await scene.info();
    expect(after.origin).not.toBe(before);
    expect(after.frames).toBe(1);
  });

  test("is right in any order", async ({ page }) => {
    const scene = await pageScene(page, STATEFUL_SCENE);
    await expectPlaces(scene, shuffled(12, 200), readStateful, STATEFUL_EXPECTED);
    expect(await scene.problems()).toEqual([]);
  });

  test("gives the same picture every time, random numbers and all", async ({ page }) => {
    const scene = await pageScene(page, STATEFUL_SCENE);
    const look = () =>
      scene.read(() => {
        const element = (id: string) => document.getElementById(id) as HTMLElement;
        return ["state", "interval", "lucky"].map((id) => element(id).style.transform).join();
      });
    await scene.seek(100);
    const first = await look();
    await scene.seek(50);
    await scene.seek(100);
    expect(await look()).toBe(first);
    await scene.seek(10);
    await scene.seek(70);
    await scene.seek(100);
    expect(await look()).toBe(first);
  });

  test("gives other random numbers with another seed", async ({ page }) => {
    const lucky = async (seed: number) => {
      const scene = await pageScene(page, STATEFUL_SCENE, { seed });
      await scene.seek(5);
      return scene.read(() => (document.getElementById("lucky") as HTMLElement).style.transform);
    };
    expect(await lucky(1)).toBe(await lucky(1));
    expect(await lucky(1)).not.toBe(await lucky(2));
  });

  test("keeps the old frame in front until the new one has got there", async ({ page }) => {
    const scene = await pageScene(page, STATEFUL_SCENE);
    await scene.seek(600);
    const old = (await scene.info()).origin;
    const going = scene.seek(590);
    const seen: { origin: string; top: boolean; visible: boolean }[][] = [];
    await expect
      .poll(
        async () => {
          const frames = (await page.evaluate(() =>
            window.lab.call("atPoint"),
          )) as (typeof seen)[0];
          if (frames.length === 2) seen.push(frames);
          return frames.length === 1 && seen.some((look) => look.every(({ visible }) => visible));
        },
        { intervals: [2] },
      )
      .toBe(true);
    // While there were two, and both were showing, it was always the old one on top.
    for (const look of seen) {
      expect(look.find(({ top }) => top)?.origin).toBe(old);
    }
    expect(await going).toBe(true);
    expect((await scene.info()).frames).toBe(1);
  });

  test("goes to the last frame it was asked for, while it is starting over", async ({ page }) => {
    const scene = await pageScene(page, STATEFUL_SCENE);
    await scene.seek(150);
    const asked = [scene.seek(100), scene.seek(20), scene.seek(90), scene.seek(30)];
    expect(await Promise.all(asked)).toEqual([true, true, true, true]);
    expect(await scene.read(() => performance.now())).toBe(moment(30));
    expect((await scene.info()).frames).toBe(1);
  });

  test("goes back without starting over as long as no code ran since", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><body><div id="a"></div><script>
        setTimeout(() => document.body.classList.add("done"), 1000);
      </script>`,
    );
    await scene.seek(120);
    const { origin } = await scene.info();
    await scene.seek(70);
    expect((await scene.info()).origin).toBe(origin);
    expect(await scene.read(() => document.body.className)).toBe("done");
    await scene.seek(30);
    expect((await scene.info()).origin).not.toBe(origin);
    expect(await scene.read(() => document.body.className)).toBe("");
  });
});

test("code on a frame sees animations as they are on that frame", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><style>
      @keyframes mv { to { translate: 1000px } }
      #a { animation: mv 1000ms linear both }
    </style><div id="a"></div><script>
      window.seen = [];
      const a = document.getElementById("a");
      const loop = (time) => {
        const value = getComputedStyle(a).translate;
        const x = value === "none" ? 0 : parseFloat(value);
        seen.push([time, x]);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    </script>`,
  );
  await scene.seek(30);
  const seen = await scene.read(() => (window as unknown as { seen: number[][] }).seen);
  expect(seen).toHaveLength(31);
  for (const [time = 0, x = 0] of seen) expect(Math.abs(x - time)).toBeLessThan(0.01);
});

test("does not let time pass before the project is there", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      window.atLoad = performance.now();
      requestAnimationFrame(() => (window.first = performance.now()));
    </script>`,
    { seekAtOnce: 30 },
  );
  await expect.poll(() => scene.read(() => performance.now())).toBe(500);
  expect(await scene.read(() => (window as unknown as { atLoad: number }).atLoad)).toBe(0);
  expect(await scene.read(() => (window as unknown as { first: number }).first)).toBe(0);
});

test("runs promises at the moment of what they waited for", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      window.log = [];
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      (async () => {
        await sleep(100);
        log.push(performance.now());
        await sleep(100);
        await Promise.resolve();
        log.push(performance.now());
        for (let round = 0; round < 3; round += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          log.push(performance.now());
        }
      })();
    </script>`,
  );
  await scene.seek(60);
  const log = await scene.read(() => (window as unknown as { log: number[] }).log);
  expect(log.slice(0, 2)).toEqual([100, 200]);
  expect(log.slice(2).map((time) => Math.round((time * 60) / 1000))).toEqual([12, 13, 14]);
});

test("lets what a timer started finish before the next timer runs", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      window.log = [];
      setTimeout(() => {
        log.push("first");
        Promise.resolve()
          .then(() => {})
          .then(() => {})
          .then(() => {})
          .then(() => log.push("promise of the first"));
      }, 100);
      setTimeout(() => log.push("second"), 100);
    </script>`,
  );
  await scene.seek(6);
  expect(await scene.read(() => (window as unknown as { log: string[] }).log)).toEqual([
    "first",
    "promise of the first",
    "second",
  ]);
});

test("waits for what takes real time before moving on", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      setTimeout(async () => {
        const data = await (await fetch("./data.json")).json();
        window.gotAt = performance.now();
        window.value = data.value;
      }, 100);
    </script>`,
    { files: { "scenes/test/data.json": `{ "value": 42 }` } },
  );
  await scene.seek(600);
  expect(await scene.read(() => (window as unknown as { gotAt: number }).gotAt)).toBe(100);
});

test("waits for everything else that takes real time too", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      window.log = {};
      const note = (name) => () => (log[name] = performance.now());
      setTimeout(() => import("./later.js").then(note("import")), 100);
      setTimeout(async () => {
        await import("./" + "later.js");
        note("computed import")();
      }, 200);
      setTimeout(() => {
        const image = new Image();
        image.onload = note("image");
        image.src = URL.createObjectURL(new Blob([
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        ], { type: "image/svg+xml" }));
      }, 300);
      setTimeout(async () => {
        const blob = new Blob(["a"]);
        await blob.text();
        note("blob")();
      }, 400);
    </script>`,
    { files: { "scenes/test/later.js": `export {};` } },
  );
  await scene.seek(6000);
  expect(await scene.read(() => (window as unknown as { log: object }).log)).toEqual({
    import: 100,
    "computed import": 200,
    image: 300,
    blob: 400,
  });
});

test.describe("everything that tells the time", () => {
  const READ = `window.read = async () => {
    const instant = typeof Temporal === "undefined" ? null : Temporal.Now.instant().epochMilliseconds;
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    return {
      performance: performance.now(),
      origin: performance.timeOrigin,
      date: Date.now(),
      newDate: new Date().getTime(),
      dateCall: Date(),
      instant,
      plainTime: typeof Temporal === "undefined" ? null : Temporal.Now.plainDateTimeISO("UTC").toString(),
      timeline: document.timeline.currentTime,
      formatted: new Intl.DateTimeFormat("en", { timeZone: "UTC", dateStyle: "short", timeStyle: "medium" }).format(),
      parts: new Intl.DateTimeFormat("en", { timeZone: "UTC", second: "numeric" }).formatToParts().length,
      event: new Event("x").timeStamp,
      random: Math.random(),
      bytes: random[0],
      uuid: crypto.randomUUID(),
    };
  }`;

  test("stands still between frames and reads the same in all of them", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><script>${READ}</script>`);
    await scene.seek(90);
    const read = () =>
      scene.read(() =>
        (window as unknown as { read: () => Promise<Record<string, unknown>> }).read(),
      );
    const first = await read();
    await page.waitForTimeout(50);
    const second = await read();
    expect(second.performance).toBe(1500);
    expect(second.date).toBe(first.date);
    expect(second.newDate).toBe(first.date);
    expect(second.timeline).toBe(1500);
    expect(second.event).toBe(1500);
    expect(second.origin).toBe((second.date as number) - 1500);
    expect(second.dateCall).toBe(new Date(second.date as number).toString());
    expect(second.formatted).toBe(first.formatted);
    if (second.instant !== null) expect(second.instant).toBe(second.date);
    expect(second.plainTime).toBe(first.plainTime);
    // Random numbers go on from one call to the next.
    expect(second.random).not.toBe(first.random);
    expect(second.uuid).not.toBe(first.uuid);
  });

  test("gives the same on every run", async ({ page }) => {
    const read = async () => {
      const scene = await pageScene(page, `<!doctype html><script>${READ}</script>`);
      await scene.seek(90);
      return scene.read(() =>
        (window as unknown as { read: () => Promise<Record<string, unknown>> }).read(),
      );
    };
    expect(await read()).toEqual(await read());
  });

  test("has a date, and keeps it for the project too", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.facts = {
          iso: new Date().toISOString(),
          instance: new Date() instanceof Date,
          subclass: new (class extends Date {})(5).getTime(),
          parsed: Date.parse("2020-01-01T00:00:00Z"),
          utc: Date.UTC(2020, 0, 1),
          fixed: new Date(2020, 0, 1).getFullYear(),
        };
      </script>`,
    );
    expect(await scene.read(() => (window as unknown as { facts: object }).facts)).toEqual({
      iso: "2026-01-01T00:00:00.000Z",
      instance: true,
      subclass: 5,
      parsed: Date.UTC(2020, 0, 1),
      utc: Date.UTC(2020, 0, 1),
      fixed: 2020,
    });
  });

  test("timers in disguise run on the scene's clock", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.log = {};
        const note = (name) => () => (log[name] = performance.now());
        AbortSignal.timeout(100).addEventListener("abort", note("abort"));
        requestIdleCallback(note("idle"));
        const cancelled = requestIdleCallback(note("cancelled"));
        cancelIdleCallback(cancelled);
        scheduler.postTask(note("task"), { delay: 200 });
        setTimeout("window.log.text = performance.now()", 300);
      </script>`,
    );
    await scene.seek(5);
    expect(await scene.read(() => (window as unknown as { log: object }).log)).toEqual({ idle: 0 });
    await scene.seek(30);
    await expect
      .poll(() => scene.read(() => (window as unknown as { log: object }).log))
      .toEqual({ idle: 0, abort: 100, task: 200, text: 300 });
  });
});

test.describe("animations under the control of code", () => {
  const SCENE = (code: string) => `<!doctype html><div id="a"></div><script>
    const a = document.getElementById("a");
    const move = [{ translate: "0px" }, { translate: "1000px" }];
    const animation = a.animate(move, { duration: 1000, fill: "both" });
    window.log = [];
    ${code}
  </script>`;

  const x = (scene: TestScene) =>
    scene.read(() => {
      const value = getComputedStyle(document.getElementById("a") as Element).translate;
      return value === "none" ? 0 : Number.parseFloat(value);
    });

  const log = (scene: TestScene) => scene.read(() => (window as unknown as { log: unknown[] }).log);

  test("await finished works, and at the right moment", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`(async () => {
        await animation.finished;
        log.push(performance.now());
      })();`),
    );
    await scene.seek(59);
    expect(await log(scene)).toEqual([]);
    await scene.seek(120);
    expect(await log(scene)).toEqual([1000]);
  });

  test("the finish event comes at the right moment on any way there", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`animation.onfinish = () => log.push("handler " + performance.now());
        animation.addEventListener("finish", ({ currentTime }) => log.push("event " + currentTime));`),
    );
    await scene.seek(300);
    expect(await log(scene)).toEqual(["handler 1000", "event 1000"]);
  });

  test("going back through a finish starts over", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`animation.finished.then(() => document.body.classList.add("over"));`),
    );
    await scene.seek(120);
    await expect.poll(() => scene.read(() => document.body.className)).toBe("over");
    await scene.seek(30);
    expect(await scene.read(() => document.body.className)).toBe("");
    expect(await x(scene)).toBeCloseTo(500, 3);
  });

  test("a paused animation stays where it was", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`setTimeout(() => animation.pause(), 250);
        setTimeout(() => log.push(animation.playState, animation.currentTime), 300);`),
    );
    await scene.seek(60);
    expect(await x(scene)).toBeCloseTo(250, 3);
    expect(await log(scene)).toEqual(["paused", 250]);
  });

  test("play takes up where pause left off", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`setTimeout(() => animation.pause(), 250);
        setTimeout(() => animation.play(), 500);`),
    );
    await scene.seek(45);
    expect(await x(scene)).toBeCloseTo(500, 3);
  });

  test("code can drive an animation by hand", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`animation.pause();
        aq.frame((seconds) => (animation.currentTime = seconds * 100));`),
    );
    await scene.seek(120);
    expect(await x(scene)).toBeCloseTo(200, 3);
    await scene.seek(60);
    expect(await x(scene)).toBeCloseTo(100, 3);
  });

  test("playbackRate counts from when it was set", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`setTimeout(() => (animation.playbackRate = 0.5), 500);`),
    );
    await scene.seek(60);
    expect(await x(scene)).toBeCloseTo(750, 3);
  });

  test("updatePlaybackRate does the same", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`setTimeout(() => animation.updatePlaybackRate(2), 250);`),
    );
    await scene.seek(30);
    expect(await x(scene)).toBeCloseTo(750, 3);
  });

  test("reverse turns around where it is", async ({ page }) => {
    const scene = await pageScene(page, SCENE(`setTimeout(() => animation.reverse(), 500);`));
    await scene.seek(45);
    expect(await x(scene)).toBeCloseTo(250, 3);
  });

  test("setting the time moves it from there on", async ({ page }) => {
    const scene = await pageScene(page, SCENE(`animation.currentTime = 500;`));
    await scene.seek(15);
    expect(await x(scene)).toBeCloseTo(750, 3);
  });

  test("cancel leaves nothing behind, and tells whoever waited", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`animation.finished.catch((error) => log.push(error.name));
        setTimeout(() => animation.cancel(), 100);`),
    );
    await scene.seek(30);
    expect(await x(scene)).toBe(0);
    expect(await log(scene)).toEqual(["AbortError"]);
    expect(await scene.problems()).toEqual([]);
  });

  test("finish jumps to the end and tells at once", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`animation.finished.then(() => log.push(performance.now(), animation.playState));
        setTimeout(() => animation.finish(), 100);`),
    );
    await scene.seek(30);
    expect(await x(scene)).toBe(1000);
    expect(await log(scene)).toEqual([100, "finished"]);
  });

  test("an animation made by hand follows the clock too", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`animation.cancel();
        const effect = new KeyframeEffect(a, move, { duration: 1000, fill: "both" });
        new Animation(effect, document.timeline).play();`),
    );
    await scene.seek(30);
    expect(await x(scene)).toBeCloseTo(500, 3);
  });

  test("an animation nobody started stays where code puts it", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`animation.cancel();
        const effect = new KeyframeEffect(a, move, { duration: 1000, fill: "both" });
        window.still = new Animation(effect, document.timeline);
        still.currentTime = 250;`),
    );
    await scene.seek(30);
    expect(await x(scene)).toBeCloseTo(250, 3);
    expect(
      await scene.read(() => (window as unknown as { still: Animation }).still.playState),
    ).toBe("paused");
  });

  test("taking the start time away holds an animation where it is", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`setTimeout(() => (animation.startTime = null), 250);`),
    );
    await scene.seek(30);
    expect(await x(scene)).toBeCloseTo(250, 3);
  });

  test("what a finish starts is on the clock from that moment", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`animation.onfinish = () => {
        a.animate(move, { duration: 1000, fill: "both", composite: "replace" });
      };`),
    );
    await scene.seek(90);
    expect(await x(scene)).toBeCloseTo(500, 3);
  });

  test("says what state it is in", async ({ page }) => {
    const scene = await pageScene(
      page,
      SCENE(`const say = () => log.push([animation.playState, animation.pending, animation.currentTime]);
        setTimeout(say, 500);
        setTimeout(say, 1500);`),
    );
    await scene.seek(120);
    expect(await log(scene)).toEqual([
      ["running", false, 500],
      ["finished", false, 1000],
    ]);
  });

  test("nonsense in a start time does not stop anything", async ({ page }) => {
    const scene = await pageScene(page, SCENE(`animation.startTime = "soon";`));
    expect(await scene.seek(30)).toBe(true);
    expect(await scene.seek(40)).toBe(true);
    expect((await scene.info()).state).toBe("ready");
  });

  test("a class that goes away ends its animation for good", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><style>
        @keyframes mv { to { translate: 1000px } }
        .moving { animation: mv 1000ms linear both }
      </style><div id="a" class="moving"></div><script>
        setTimeout(() => document.getElementById("a").classList.remove("moving"), 250);
      </script>`,
    );
    await scene.seek(30);
    expect(await x(scene)).toBe(0);
  });

  test("CSS that starts out paused stays paused", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><style>
        @keyframes mv { to { translate: 1000px } }
        #a { animation: mv 1000ms linear both paused }
      </style><div id="a"></div>`,
    );
    await scene.seek(30);
    expect(await x(scene)).toBe(0);
  });

  test("code that waits for the end of a CSS animation gets its event on time", async ({
    page,
  }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><style>
        @keyframes mv { to { translate: 1000px } }
        #a { animation: mv 1000ms linear both }
      </style><div id="a"></div><script>
        window.log = [];
        const a = document.getElementById("a");
        a.addEventListener("animationstart", () => log.push("start " + performance.now()));
        a.addEventListener("animationend", () => log.push("end " + performance.now()));
      </script>`,
    );
    await scene.seek(120);
    expect(await log(scene)).toEqual(["start 0", "end 1000"]);
  });

  test("an event is not lost on code that only comes along later", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><style>
        @keyframes mv { to { translate: 1000px } }
        #a { animation: mv 1000ms linear both }
      </style><div id="a"></div><script type="module">
        // Long enough for several frames of the screen, if there are any.
        const { port1, port2 } = new MessageChannel();
        await new Promise((resolve) => {
          let left = 30000;
          port1.onmessage = () => ((left -= 1) > 0 ? port2.postMessage(0) : resolve());
          port2.postMessage(0);
        });
        window.log = [];
        document.getElementById("a").addEventListener("animationstart", () => {
          log.push("start " + performance.now());
        });
      </script>`,
    );
    await scene.seek(5);
    expect(await log(scene)).toEqual(["start 0"]);
  });

  test("an element that went away does not hold on to its animation", async ({ page }) => {
    const scene = await pageScene(page, SCENE(`setTimeout(() => a.remove(), 100);`));
    expect(await scene.seek(30)).toBe(true);
    expect(await scene.problems()).toEqual([]);
  });
});

test("only looks for animations when the document changed", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><style>
      @keyframes mv { to { translate: 1000px } }
      .moving { animation: mv 1000ms linear both }
    </style><div id="a"></div><script>
      window.calls = 0;
      const real = Document.prototype.getAnimations;
      Document.prototype.getAnimations = function counted() {
        window.calls += 1;
        return real.call(this);
      };
      aq.frame((seconds) => {
        if (seconds === 1) document.getElementById("a").classList.add("moving");
      });
    </script>`,
  );
  const calls = () => scene.read(() => (window as unknown as { calls: number }).calls);
  const before = await calls();
  for (const frame of [5, 10, 20, 30]) await scene.seek(frame);
  expect(await calls()).toBe(before);
  await scene.seek(60);
  await scene.seek(61);
  await scene.seek(62);
  expect(await calls()).toBe(before + 1);
  const moved = await scene.read(
    () => getComputedStyle(document.getElementById("a") as Element).translate,
  );
  expect(moved).not.toBe("none");
});

test("sees animations in a shadow tree and from stylesheets changed by code", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><div id="host"></div><div id="b"></div><script>
      const root = document.getElementById("host").attachShadow({ mode: "open" });
      root.innerHTML = '<style>@keyframes s { to { opacity: 0 } } .on { animation: s 1s linear both }</style><div id="in"></div>';
      window.shadow = root;
      document.head.append(document.createElement("style"));
      setTimeout(() => root.getElementById("in").classList.add("on"), 100);
      setTimeout(() => {
        const sheet = document.styleSheets[document.styleSheets.length - 1];
        sheet.insertRule("@keyframes t { to { opacity: 0 } }");
        sheet.insertRule("#b { animation: t 1s linear both }", 1);
      }, 200);
    </script>`,
  );
  await scene.seek(42);
  const [inside, outside] = await scene.read(() => {
    const { shadow } = window as unknown as { shadow: ShadowRoot };
    return [
      Number(getComputedStyle(shadow.getElementById("in") as Element).opacity),
      Number(getComputedStyle(document.getElementById("b") as Element).opacity),
    ];
  });
  expect(inside).toBeCloseTo(1 - 0.6, 3);
  expect(outside).toBeCloseTo(1 - 0.5, 3);
});

test("leaves scroll timelines alone, which have nothing to do with time", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><div id="a"></div><script>
      const timeline = new ScrollTimeline({ source: document.documentElement });
      window.scrolled = document.getElementById("a").animate(
        { opacity: [0, 1] },
        { timeline, duration: 1000 },
      );
    </script>`,
  );
  await scene.seek(30);
  const facts = await scene.read(() => {
    const { scrolled } = window as unknown as { scrolled: Animation };
    return { state: scrolled.playState, timeline: scrolled.timeline instanceof ScrollTimeline };
  });
  expect(facts).toEqual({ state: "running", timeline: true });
});

test.describe("playing", () => {
  const SCENE = `<!doctype html><script>
    window.frames = [];
    const loop = (time) => {
      frames.push(time);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  </script>`;

  test("follows the time base by itself, frame by frame", async ({ page }) => {
    const scene = await pageScene(page, SCENE);
    await scene.seek(0);
    await scene.call("play", 0);
    await expect.poll(async () => (await scene.info()).positions.length).toBeGreaterThan(5);
    await scene.call("pause");
    await page.waitForTimeout(100);
    const seen = await scene.read(() => (window as unknown as { frames: number[] }).frames);
    const { positions } = await scene.info();
    const last = positions.at(-1) as number;
    // Stateful code never skips a frame, however the screen is doing.
    expect(seen.length).toBeGreaterThanOrEqual(last + 1);
    expect(seen.map((time) => Math.round((time * FPS) / 1000))).toEqual(
      seen.map((_, frame) => frame),
    );
    await page.waitForTimeout(100);
    expect(
      (await scene.read(() => (window as unknown as { frames: number[] }).frames)).length,
    ).toBe(seen.length);
  });

  test("goes at the speed it was told to", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><p>a</p>`);
    await scene.seek(0);
    const started = Date.now();
    await scene.call("play", 600, 2);
    await page.waitForTimeout(500);
    await scene.call("pause");
    const elapsed = Date.now() - started;
    const { positions } = await scene.info();
    const last = positions.at(-1) as number;
    // Two seconds of frames in each second, give or take what this machine is doing.
    expect(last).toBeGreaterThan(600 + elapsed * 0.06);
    expect(last).toBeLessThanOrEqual(600 + elapsed * 0.12 + 1);
  });

  test("a seek ends playing", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><p>a</p>`);
    await scene.seek(0);
    await scene.call("play", 0);
    await page.waitForTimeout(100);
    await scene.seek(5);
    const { positions } = await scene.info();
    await page.waitForTimeout(100);
    expect((await scene.info()).positions.length).toBe(positions.length);
  });
});

test.describe("the same picture, whatever way it got there", () => {
  test("random numbers in aq.frame are the same on the same frame", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><div id="a"></div><script>
        aq.frame(() => {
          const bytes = crypto.getRandomValues(new Uint8Array(2));
          document.getElementById("a").dataset.v = [Math.random(), ...bytes, crypto.randomUUID()].join();
        });
      </script>`,
    );
    const look = () => scene.read(() => (document.getElementById("a") as HTMLElement).dataset.v);
    await scene.seek(10);
    const first = await look();
    await scene.seek(10);
    expect(await look()).toBe(first);
    await scene.seek(20);
    const other = await look();
    expect(other).not.toBe(first);
    await scene.seek(10);
    expect(await look()).toBe(first);
    await scene.seek(20);
    expect(await look()).toBe(other);
  });

  test("random numbers elsewhere do not depend on how often aq.frame ran", async ({ page }) => {
    const html = `<!doctype html><script>
      aq.frame(() => Math.random());
      setTimeout(() => (window.value = Math.random()), 100);
    </script>`;
    const once = await pageScene(page, html);
    await once.seek(60);
    const often = await pageScene(page, html);
    for (let frame = 1; frame <= 60; frame += 1) await often.seek(frame);
    const value = (scene: TestScene) =>
      scene.read(() => (window as unknown as { value: number }).value);
    expect(await value(often)).toBe(await value(once));
  });

  test("a shadow tree written in the page follows the clock", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><div id="host"><template shadowrootmode="open"><style>
        @keyframes s { to { opacity: 0 } } #in { animation: s 2s linear both }
      </style><div id="in"></div></template></div>`,
    );
    const read = () =>
      scene.read(() => {
        const root = (document.getElementById("host") as HTMLElement).shadowRoot as ShadowRoot;
        return Number(getComputedStyle(root.getElementById("in") as Element).opacity);
      });
    await scene.seek(30);
    expect(await read()).toBeCloseTo(0.75, 3);
    await page.waitForTimeout(300);
    await scene.seek(30);
    expect(await read()).toBeCloseTo(0.75, 3);
    await scene.seek(60);
    expect(await read()).toBeCloseTo(0.5, 3);
  });

  test("so does one that code adds later", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><div id="box"></div><script>
        setTimeout(() => {
          document.getElementById("box").setHTMLUnsafe(\`<div id="host"><template shadowrootmode="open"><style>
            @keyframes s { to { opacity: 0 } } #in { animation: s 2s linear both }
          </style><div id="in"></div></template></div>\`);
        }, 100);
      </script>`,
    );
    await scene.seek(66);
    const opacity = await scene.read(() => {
      const root = (document.getElementById("host") as HTMLElement).shadowRoot as ShadowRoot;
      return Number(getComputedStyle(root.getElementById("in") as Element).opacity);
    });
    expect(opacity).toBeCloseTo(0.5, 3);
  });

  for (const [name, adopt] of [
    ["assigned", `document.adoptedStyleSheets = [sheet];`],
    ["pushed", `document.adoptedStyleSheets.push(sheet);`],
  ] as const) {
    test(`an adopted stylesheet that was ${name} follows the clock`, async ({ page }) => {
      const scene = await pageScene(
        page,
        `<!doctype html><div id="a"></div><script>
          const sheet = new CSSStyleSheet();
          sheet.replaceSync("@keyframes s { to { opacity: 0 } } #a { animation: s 2s linear both }");
          setTimeout(() => { ${adopt} }, 100);
        </script>`,
      );
      const read = () =>
        scene.read(() => Number(getComputedStyle(document.getElementById("a") as Element).opacity));
      await scene.seek(36);
      expect(await read()).toBeCloseTo(0.75, 3);
      await page.waitForTimeout(300);
      await scene.seek(36);
      expect(await read()).toBeCloseTo(0.75, 3);
    });
  }

  test("a short animation does not slip through while the page loads", async ({ page }) => {
    const started = Date.now();
    const scene = await pageScene(
      page,
      `<!doctype html><style>
        @keyframes mv { from { translate: 0px } to { translate: 1000px } }
        #both { animation: mv 100ms linear both }
        #none { animation: mv 100ms linear }
      </style><div id="both"></div><div id="none"></div>
      <script>window.width = document.getElementById("both").offsetWidth;</script>
      <script type="module">
        // Nothing in here tells real time any more, so this goes by turns of the event loop.
        const { port1, port2 } = new MessageChannel();
        await new Promise((resolve) => {
          let left = 100000;
          port1.onmessage = () => ((left -= 1) > 0 ? port2.postMessage(0) : resolve());
          port2.postMessage(0);
        });
      </script>`,
    );
    // The animations would have been over by now, or this does not show anything.
    expect(Date.now() - started).toBeGreaterThan(200);
    const read = () =>
      scene.read(() =>
        ["both", "none"].map(
          (id) => getComputedStyle(document.getElementById(id) as Element).translate,
        ),
      );
    await scene.seek(3);
    expect(await read()).toEqual(["500px", "500px"]);
    await scene.seek(0);
    expect((await read()).map((value) => Number.parseFloat(value) || 0)).toEqual([0, 0]);
  });

  test("a transform reads back like anything else", { tag: "@layout" }, async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><style>
        @keyframes tr { to { transform: translateX(1000px) } }
        #a { animation: tr 1000ms linear both }
      </style><div id="a"></div>`,
    );
    const read = () =>
      scene.read(() => getComputedStyle(document.getElementById("a") as Element).transform);
    await scene.seek(30);
    expect(await read()).toBe("matrix(1, 0, 0, 1, 500, 0)");
    await scene.seek(15);
    expect(await read()).toBe("matrix(1, 0, 0, 1, 250, 0)");
  });
});

test.describe("what still tells real time", () => {
  test("marks and measures are on the clock", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><p>a</p>`);
    await scene.seek(30);
    const facts = await scene.read(() => {
      performance.mark("start");
      const given = performance.mark("given", { startTime: 7 });
      const measured = performance.measure("all", "given");
      const fromOptions = performance.measure("options", { start: 100 });
      return {
        mark: performance.getEntriesByName("start")[0]?.startTime,
        given: given.startTime,
        measured: [measured.startTime, measured.duration],
        fromOptions: [fromOptions.startTime, fromOptions.duration],
        types: [...new Set(performance.getEntries().map(({ entryType }) => entryType))].toSorted(),
        navigation: performance.getEntriesByType("navigation").length,
        resources: performance.getEntriesByType("resource").length,
      };
    });
    expect(facts).toEqual({
      mark: 500,
      given: 7,
      measured: [7, 493],
      fromOptions: [100, 400],
      types: ["mark", "measure"],
      navigation: 0,
      resources: 0,
    });
  });

  test("the old ways of asking are the same on every run", async ({ page }) => {
    const read = async () => {
      const scene = await pageScene(page, `<!doctype html><p>a</p>`);
      await scene.seek(30);
      return scene.read(() => ({
        timing: performance.timing.navigationStart,
        loaded: performance.timing.loadEventEnd,
        lastModified: document.lastModified,
      }));
    };
    const first = await read();
    await page.waitForTimeout(1100);
    expect(await read()).toEqual(first);
    expect(first.timing).toBe(Date.UTC(2026, 0, 1));
    expect(first.lastModified).toBe("01/01/2026 00:00:00");
  });
});

test("a module that waits for time costs a walk one limit, not one on every frame", async ({
  page,
}) => {
  test.setTimeout(60000);
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      (function loop() { requestAnimationFrame(loop); })();
      setTimeout(() => import("./lazy.js"), 0);
    </script>`,
    {
      files: {
        "scenes/test/lazy.js": `await new Promise((resolve) => setTimeout(resolve, 100)); window.done = performance.now();`,
      },
    },
  );
  const started = Date.now();
  expect(await scene.seek(12)).toBe(true);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(await scene.read(() => (window as unknown as { done?: number }).done)).toBe(100);
  expect((await scene.problems()).map(({ code }) => code)).toEqual(["slow-work"]);
});
