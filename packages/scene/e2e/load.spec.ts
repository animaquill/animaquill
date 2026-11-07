import { test } from "@playwright/test";
import { binary, expect, fixture, openLab, openScene, pageScene } from "./support.ts";

test.beforeEach(({ page }) => openLab(page));

const sample = (page: Parameters<typeof openScene>[0]) =>
  openScene(page, {
    entry: "scenes/sample/index.html",
    files: { ...fixture("sample", "scenes/sample/"), ...fixture("code", "code/") },
    assets: { logo: binary("sample/images/logo.png"), font: binary("sample/fonts/tiny.ttf") },
  });

test("runs a scene with everything a scene can have", async ({ page }) => {
  const scene = await sample(page);
  expect((await scene.info()).state).toBe("ready");
  const probe = await scene.read(() => (window as unknown as { probe: object }).probe);
  expect(probe).toMatchObject({
    classic: true,
    inlineHeadScript: true,
    bodyInHead: "null",
    moduleImport: true,
    inlineModule: true,
    sharedCode: "from the code folder",
    moduleCycle: true,
    dynamicImport: "loaded later",
    computedImport: "loaded later",
    importMetaUrl: "aq:/scenes/sample/data.json",
    importMetaResolve: "aq:/scenes/sample/data.json",
    jsonModule: 42,
    fetchRelative: 42,
    fetchFromUrl: 42,
    fetchFromLocation: 42,
    fetchMissing: 404,
    xhr: 42,
    jsImage: 64,
    setAttributeImage: 64,
    assetImage: 64,
    assetFont: "loaded",
    projectFontFace: "loaded",
    classicWorker: "classic worker number",
    moduleWorker: "module 2 loaded later 42",
    fetchBlobUrl: "blob text",
    fetchDataUrl: "hello",
    eval: 2,
    newFunction: 3,
    wasm: true,
    moduleDone: true,
  });
});

test("rewrites what the page, the stylesheets and the code refer to", async ({ page }) => {
  const scene = await sample(page);
  const facts = await scene.read(() => {
    const style = (id: string) => getComputedStyle(document.getElementById(id) as HTMLElement);
    const images = ["png", "svg", "srcset"].map(
      (id) => (document.getElementById(id) as HTMLImageElement).naturalWidth,
    );
    const backgrounds = ["css-bg", "in-page", "in-attribute"].map((id) =>
      style(id).backgroundImage.slice(0, 9),
    );
    return {
      images,
      backgrounds,
      fromImport: style("hero").getPropertyValue("--from-import").trim(),
      bodyColor: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(facts.images.every((width) => width > 0)).toBe(true);
  expect(facts.backgrounds).toEqual(['url("blob', 'url("blob', 'url("blob']);
  expect(facts.fromImport).toBe("7");
  expect(facts.bodyColor).toBe("rgb(16, 32, 58)");
});

test("loads what the sandbox would block otherwise, so it blocks nothing here", async ({
  page,
}) => {
  const scene = await sample(page);
  await scene.seek(30);
  const problems = await scene.problems();
  expect(problems.filter(({ kind }) => kind === "blocked" || kind === "error")).toEqual([]);
  expect(problems.map(({ code, target }) => [code, target])).toEqual([
    ["missing-file", "./nothing.json"],
    ["worker-timing", undefined],
  ]);
});

test("the font really is used", { tag: "@layout" }, async ({ page }) => {
  const scene = await sample(page);
  const [title, plain] = await scene.read(() => [
    (document.getElementById("title") as HTMLElement).offsetWidth,
    (document.getElementById("plain") as HTMLElement).offsetWidth,
  ]);
  expect(title).toBeGreaterThan((plain as number) * 1.5);
  const fonts = await scene.read(() =>
    [...document.fonts].map(({ family, status }) => `${family} ${status}`.replaceAll('"', "")),
  );
  expect(fonts).toContain("Tiny Test loaded");
});

test("puts the page in a canvas before anything in its body runs", async ({ page }) => {
  // This is about the order of things, which is the same in a browser that cannot capture.
  const scene = await pageScene(
    page,
    `<!doctype html><html class="a"><head><style>body { color: rgb(1, 2, 3) }</style>
    <script>window.inHead = document.body === null;</script></head>
    <body class="b" data-c="d"><script>
      const body = document.body;
      window.seen = {
        parent: body.parentElement.localName,
        grand: body.parentElement.parentElement.localName,
        queried: document.querySelector("body") === body,
        one: document.querySelectorAll("body").length,
        tag: body.localName,
        attributes: [body.className, body.dataset.c],
        script: document.currentScript.parentElement === body,
        ready: document.readyState,
        color: getComputedStyle(body).color,
      };
      document.body.append(Object.assign(document.createElement("p"), { id: "added" }));
    </script><p id="written">a</p><script>
      window.after = {
        added: document.getElementById("added").parentElement === document.body,
        written: document.getElementById("written").parentElement === document.body,
        order: [...document.body.children].map(({ id, localName }) => id || localName),
      };
    </script></body></html>`,
    { stage: "canvas" },
  );
  const facts = await scene.read(() => {
    const { inHead, seen, after } = window as unknown as Record<string, unknown>;
    return { inHead, seen, after };
  });
  expect(facts).toEqual({
    inHead: true,
    seen: {
      parent: "canvas",
      grand: "html",
      queried: true,
      one: 1,
      tag: "body",
      attributes: ["b", "d"],
      script: true,
      ready: "loading",
      color: "rgb(1, 2, 3)",
    },
    after: { added: true, written: true, order: ["script", "added", "written", "script"] },
  });
  expect(await scene.read(() => document.getElementById("aq-stage")?.getAttribute("content"))).toBe(
    "drawable",
  );
});

test("does not show the stage to a page that asked for a normal one", async ({ page }) => {
  const scene = await pageScene(page, `<!doctype html><body>`, { stage: "plain" });
  expect(await scene.read(() => document.body.parentElement?.localName)).toBe("html");
  expect(await scene.read(() => document.getElementById("aq-stage"))).toBeNull();
});

test("a page without a body tag gets a canvas just the same", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<title>a</title><p id="b">c</p><script>window.parentOfBody = document.body.parentElement.localName</script>`,
    { stage: "canvas" },
  );
  expect(await scene.read(() => (window as unknown as { parentOfBody: string }).parentOfBody)).toBe(
    "canvas",
  );
});

test("sizes the canvas in pixels of the output, and the page in those of the view", async ({
  page,
}) => {
  const scene = await pageScene(page, `<!doctype html><body>`, { stage: "canvas" });
  const size = await scene.read(() => {
    const canvas = document.getElementById("aq-stage") as HTMLCanvasElement;
    return [canvas.width, canvas.height, innerWidth, innerHeight];
  });
  expect(size).toEqual([1280, 720, 1280, 720]);
});

test("the background of the page reaches the body, which is what gets captured", async ({
  page,
}) => {
  const background = (css: string) =>
    pageScene(page, `<!doctype html><style>${css}</style><body>`, { stage: "canvas" }).then(
      (scene) => scene.read(() => getComputedStyle(document.body).backgroundColor),
    );
  expect(await background("html { background: rgb(1, 2, 3) }")).toBe("rgb(1, 2, 3)");
  expect(await background("html { background: red } body { background: rgb(4, 5, 6) }")).toBe(
    "rgb(4, 5, 6)",
  );
  expect(await background("")).toBe("rgba(0, 0, 0, 0)");
});

test("does not start in a browser that cannot capture, unless told to", async ({ page }) => {
  const scene = await pageScene(page, `<!doctype html><p>a</p>`, { stage: undefined });
  const { capture, state, frames } = await scene.info();
  expect(state).toBe(capture ? "ready" : "unsupported");
  if (!capture) expect(frames).toBe(0);
});

test("tells the page who it is for", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><html lang="xx"><head><script>
      window.seen = { lang: document.documentElement.lang, format: document.documentElement.dataset.format };
    </script></head><body></body></html>`,
  );
  const facts = await scene.read(() => {
    const { aq, seen } = window as unknown as {
      aq: { view: object; runtime: number };
      seen: object;
    };
    const root = getComputedStyle(document.documentElement);
    return {
      seen,
      view: aq.view,
      runtime: aq.runtime,
      width: root.getPropertyValue("--aq-width"),
      height: root.getPropertyValue("--aq-height"),
      ratio: root.getPropertyValue("--aq-pixel-ratio"),
    };
  });
  expect(facts).toEqual({
    seen: { lang: "en", format: "landscape" },
    view: { width: 1280, height: 720, pixelRatio: 1, format: "landscape", language: "en" },
    runtime: 1,
    width: "1280px",
    height: "720px",
    ratio: "1",
  });
});

test("gets to the end of a page with the usual events in the usual order", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      window.log = [document.readyState];
      document.addEventListener("DOMContentLoaded", () => log.push("DOMContentLoaded"));
      addEventListener("load", () => log.push("load " + document.readyState));
    </script><body onload="log.push('body onload')"><script>log.push("body script")</script>`,
  );
  expect(await scene.read(() => (window as unknown as { log: string[] }).log)).toEqual([
    "loading",
    "body script",
    "DOMContentLoaded",
    "load complete",
    "body onload",
  ]);
});

test(
  "waits for the frame to have a size before running anything",
  { tag: "@layout" },
  async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><style>#a{height:100vh}</style><body><div id="a"></div>
    <script>window.size = [innerWidth, innerHeight, document.getElementById("a").offsetHeight]</script>`,
      { startHidden: true },
    );
    expect(await scene.read(() => (window as unknown as { size: number[] }).size)).toEqual([
      1280, 720, 720,
    ]);
  },
);

test("waits for modules, even with top-level await", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script type="module">
      const { value } = await (await fetch("./data.json")).json();
      await new Promise((resolve) => queueMicrotask(resolve));
      document.body.dataset.value = value;
    </script>`,
    { files: { "scenes/test/data.json": `{ "value": 42 }` } },
  );
  expect(await scene.read(() => document.body.dataset.value)).toBe("42");
});

test("does not wait for ever for a module that waits for time to pass", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script type="module">
      await new Promise((resolve) => setTimeout(resolve, 500));
      document.body.dataset.done = "yes";
    </script>`,
  );
  expect(await scene.read(() => document.body.dataset.done)).toBeUndefined();
  await scene.seek(29);
  expect(await scene.read(() => document.body.dataset.done)).toBeUndefined();
  await scene.seek(30);
  expect(await scene.read(() => document.body.dataset.done)).toBe("yes");
});

test("a page does not need to be complete", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<title>a</title><p id="b">c</p><script>window.ran = 1</script>`,
  );
  expect(await scene.read(() => (window as unknown as { ran: number }).ran)).toBe(1);
  expect(await scene.read(() => document.getElementById("b")?.parentElement?.localName)).toBe(
    "body",
  );
});

test("starts from a module as well as from a page", async ({ page }) => {
  const scene = await openScene(page, {
    entry: "scenes/test/main.mjs",
    files: {
      "scenes/test/main.mjs": `import { a } from "./a.js"; document.body.dataset.a = a;`,
      "scenes/test/a.js": `export const a = "works";`,
    },
  });
  expect(await scene.read(() => document.body.dataset.a)).toBe("works");
});

test("gives a page with broken references a chance, and says what is wrong", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><body>
<img src="https://example.com/a.png">
<img src="gone.png">
<img src="../../../above.png">
<style>a{background:url(http://example.com/b.png)}</style>
<script>window.ran = true</script>`,
  );
  expect(await scene.read(() => (window as unknown as { ran: boolean }).ran)).toBe(true);
  const problems = (await scene.problems()).filter(({ kind }) => kind === "loader");
  expect(problems.map(({ code, file, line, target }) => [code, file, line, target])).toEqual([
    ["external-url", "scenes/test/index.html", 2, "https://example.com/a.png"],
    ["missing-file", "scenes/test/index.html", 3, "gone.png"],
    ["above-root", "scenes/test/index.html", 4, "../../../above.png"],
    ["external-url", "scenes/test/index.html", 5, "http://example.com/b.png"],
  ]);
});

test("says when an asset is not there, and the scene goes on", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script>window.url = aq.asset("gone"); window.again = aq.asset("gone")</script>`,
  );
  expect(await scene.read(() => (window as unknown as { url: string }).url)).toBe("data:,");
  expect(await scene.problems()).toEqual([
    { kind: "api", code: "missing-asset", target: "gone", frame: 0 },
  ]);
});

test("says when something can not be captured", async ({ page }) => {
  const scene = await pageScene(
    page,
    `<!doctype html><dialog id="a"></dialog><script>document.getElementById("a").showModal()</script>`,
  );
  expect(await scene.problems()).toEqual([
    { kind: "api", code: "top-layer", target: "showModal", frame: 0 },
  ]);
});

test("reports a missing entry instead of waiting", async ({ page }) => {
  const scene = await openScene(page, { entry: "scenes/test/index.html", files: {} });
  const info = await scene.info();
  expect(info.state).toBe("stopped");
  expect(info.failures.map(({ reason, message }) => [reason, message])).toEqual([
    ["failed", "missing-entry"],
  ]);
});

test("a page that says nothing is not a problem", async ({ page }) => {
  const scene = await pageScene(page, ``);
  expect((await scene.info()).state).toBe("ready");
  expect(await scene.seek(10)).toBe(true);
  expect(await scene.problems()).toEqual([]);
});

test("a worker gets a message sent right after it started, whatever kind it is", async ({
  page,
}) => {
  const scene = await pageScene(
    page,
    `<!doctype html><script type="module">
      const answer = (worker) => new Promise((resolve) => {
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = ({ message }) => resolve("failed: " + message);
        worker.postMessage("hello");
      });
      window.answers = [
        await answer(new Worker("classic.js")),
        await answer(new Worker("module.js", { type: "module" })),
        await answer(new Worker(new URL("./module.js", import.meta.url), { type: "module" })),
      ];
    </script>`,
    {
      files: {
        "scenes/test/classic.js": `onmessage = ({ data }) => postMessage("classic " + data);`,
        "scenes/test/module.js": `import { name } from "./name.js"; onmessage = ({ data }) => postMessage(name + " " + data);`,
        "scenes/test/name.js": `export const name = "module";`,
      },
    },
  );
  expect(await scene.read(() => (window as unknown as { answers: string[] }).answers)).toEqual([
    "classic hello",
    "module hello",
    "module hello",
  ]);
});

test("the same seed gives a worker the same numbers", async ({ page }) => {
  const html = `<!doctype html><script type="module">
    window.answer = await new Promise((resolve) => {
      new Worker("w.js").onmessage = ({ data }) => resolve(data);
    });
  </script>`;
  const files = {
    "scenes/test/w.js": `postMessage([Math.random(), Date.now(), performance.now() < 1, new Date(5).getTime(), Date().length > 10]);`,
  };
  const read = async () => {
    const scene = await pageScene(page, html, { files });
    return scene.read(() => (window as unknown as { answer: number[] }).answer);
  };
  const first = await read();
  expect(await read()).toEqual(first);
  expect(first[2]).toBe(true);
  expect(first[3]).toBe(5);
  expect(first[4]).toBe(true);
});

test.describe("images that take their time", () => {
  const PNG = { "scenes/test/a.png": binary("sample/images/logo.png") };

  for (const [name, page] of [
    ["far below the fold", `<div style="height:30000px"></div><img loading="lazy" src="a.png">`],
    ["at the top", `<img loading="lazy" src="a.png" width="64" height="64">`],
    ["in something not shown", `<div style="display:none"><img loading="lazy" src="a.png"></div>`],
  ] as const) {
    test(`a lazy image ${name} does not keep the scene from starting`, async ({ page: tab }) => {
      const scene = await pageScene(tab, `<!doctype html><body>${page}</body>`, {
        files: PNG,
        watchdog: { loading: 2500 },
      });
      const info = await scene.info();
      expect(info.failures).toEqual([]);
      expect(info.state).toBe("ready");
      const loaded = await scene.read(() => document.images[0]?.naturalWidth);
      expect(loaded).toBe(64);
    });
  }

  test("a scene with a lazy image opens right away, every time", async ({ page }) => {
    test.setTimeout(60000);
    // In a frame that is still hidden, `decode` can stay unanswered, which comes and goes.
    for (let round = 0; round < 30; round += 1) {
      const started = Date.now();
      const scene = await pageScene(page, `<!doctype html><img loading="lazy" src="a.png">`, {
        files: PNG,
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await scene.problems()).toEqual([]);
      await scene.call("close");
    }
  });

  test("a frame only counts as there once its images are decoded", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><img src="a.png"><img loading="lazy" src="a.png"><script>
        const decode = HTMLImageElement.prototype.decode;
        window.decoded = 0;
        HTMLImageElement.prototype.decode = function counted() {
          return decode.call(this).then(() => {
            window.decoded += 1;
          });
        };
      </script>`,
      { files: PNG },
    );
    const decoded = () => scene.read(() => (window as unknown as { decoded: number }).decoded);
    expect(await decoded()).toBe(0);
    expect(await scene.seek(1)).toBe(true);
    expect(await decoded()).toBe(2);
    expect(await scene.seek(2)).toBe(true);
    expect(await decoded()).toBe(2);
    expect(await scene.problems()).toEqual([]);
  });

  for (const [name, lazy] of [
    ["property", `image.loading = "lazy";`],
    ["attribute", `image.setAttribute("loading", "lazy");`],
  ] as const) {
    test(`a lazy image in a shadow tree loads, by ${name} too`, async ({ page }) => {
      const scene = await pageScene(
        page,
        `<!doctype html><div id="host"></div><script>
          const root = document.getElementById("host").attachShadow({ mode: "open" });
          root.innerHTML = '<div style="height:30000px"></div>';
          const image = document.createElement("img");
          ${lazy}
          image.src = "a.png";
          root.append(image);
          window.image = image;
        </script>`,
        { files: PNG },
      );
      await scene.seek(5);
      // The list of images of a document does not reach in there, so nothing else would do this.
      await expect
        .poll(() =>
          scene.read(() => (window as unknown as { image: HTMLImageElement }).image.naturalWidth),
        )
        .toBe(64);
    });
  }

  test("a lazy image that code adds later does not stop a seek either", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><body><div style="height:30000px"></div><script>
        setTimeout(() => {
          const image = document.createElement("img");
          image.loading = "lazy";
          image.src = "a.png";
          document.body.append(image);
        }, 100);
        setTimeout(() => {
          document.body.insertAdjacentHTML("beforeend", '<img loading="lazy" src="' + aq.asset("logo") + '">');
        }, 200);
      </script></body>`,
      { files: PNG, assets: { logo: binary("sample/images/logo.png") } },
    );
    const started = Date.now();
    expect(await scene.seek(30)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    const sizes = await scene.read(() => [...document.images].map((image) => image.naturalWidth));
    expect(sizes).toEqual([64, 64]);
    expect(await scene.problems()).toEqual([]);
  });

  test("an image that never gets anywhere costs a limit, and says so", async ({ page }) => {
    // Nothing a page can do makes `decode` wait for ever on purpose, except this.
    const scene = await pageScene(
      page,
      `<!doctype html><img id="a"><script>
        HTMLImageElement.prototype.decode = () => new Promise(() => {});
        Object.defineProperty(document.getElementById("a"), "complete", { value: false });
      </script>`,
    );
    expect((await scene.info()).state).toBe("ready");
    expect((await scene.problems()).map(({ code }) => code)).toContain("content-timeout");
  });
});

test.describe("where the browser and the loader see a page differently", () => {
  test("an image in a select still loads", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><select id="s"><img id="a" src="a.png"></select>`,
      { files: { "scenes/test/a.png": binary("sample/images/logo.png") } },
    );
    const parent = await scene.read(() => document.getElementById("a")?.parentElement?.localName);
    const width = await scene.read(
      () => (document.getElementById("a") as HTMLImageElement | null)?.naturalWidth,
    );
    expect([parent, width]).toEqual(["select", 64]);
    expect(await scene.problems()).toEqual([]);
  });

  test("a script in the page with a hash runs, as it would in a page", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script integrity="sha256-AAAA">window.ran = true</script>`,
    );
    expect(await scene.read(() => (window as unknown as { ran?: boolean }).ran)).toBe(true);
  });

  test("an import map works in any case", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script type="ImportMap">{"imports":{"named":"./named.js"}}</script>
      <script type="module">import { v } from "named"; window.named = v;</script>`,
      { files: { "scenes/test/named.js": `export const v = 1;` } },
    );
    expect(await scene.read(() => (window as unknown as { named?: number }).named)).toBe(1);
    expect(await scene.problems()).toEqual([]);
  });

  test("a script that never closes does not run, and takes nothing with it", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><p id="a">a</p><script>window.ran = true`, {
      stage: "canvas",
    });
    const facts = await scene.read(() => ({
      ran: (window as unknown as { ran?: boolean }).ran ?? false,
      lang: document.documentElement.lang,
      inCanvas: document.body.parentElement?.localName,
      paragraph: document.getElementById("a")?.parentElement === document.body,
    }));
    expect(facts).toEqual({ ran: false, lang: "en", inCanvas: "canvas", paragraph: true });
    expect((await scene.problems()).map(({ code }) => code)).toEqual(["unclosed-script"]);
  });

  test("a page that ends inside a title still gets its stage", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><title>never closed`, { stage: "canvas" });
    expect(await scene.read(() => document.body?.parentElement?.localName)).toBe("canvas");
  });

  test("a closed shadow tree follows the clock too", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><div id="host"><template shadowrootmode="closed"><style>
        @keyframes s { to { opacity: 0 } } #in { animation: s 2s linear both }
      </style><div id="in"></div></template></div>`,
    );
    await scene.seek(30);
    const opacity = await scene.read(() => {
      const root = (document.getElementById("host") as HTMLElement).shadowRoot as ShadowRoot;
      return Number(getComputedStyle(root.getElementById("in") as Element).opacity);
    });
    expect(opacity).toBeCloseTo(0.75, 3);
  });
});

test("a file with anything in its name can be read from a worker", async ({ page }) => {
  const names = ["plain.json", "logo@2x.json", "a+b.json", "a,b.json", "a b.json", "a'b.json"];
  const scene = await pageScene(
    page,
    `<!doctype html><script type="module">
      window.answer = await new Promise((resolve) => {
        new Worker("w.js").onmessage = ({ data }) => resolve(data);
      });
    </script>`,
    {
      files: {
        "scenes/test/w.js": `(async () => {
          const names = ${JSON.stringify(names)};
          const read = async (name) => {
            try {
              return await (await fetch(name)).text();
            } catch (error) {
              return "failed: " + error.message;
            }
          };
          postMessage(await Promise.all(names.map(read)));
        })();`,
        ...Object.fromEntries(names.map((name, index) => [`scenes/test/${name}`, String(index)])),
      },
    },
  );
  await expect
    .poll(() => scene.read(() => (window as unknown as { answer?: unknown }).answer))
    .toEqual(names.map((_, index) => String(index)));
});

test.describe("what a worker can tell", () => {
  const WORKER = `
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const start = Date.now();
    const log = [];
    requestAnimationFrame((time) => log.push("frame " + (time | 0)));
    const never = requestAnimationFrame(() => log.push("never"));
    cancelAnimationFrame(never);
    setTimeout(() => log.push("b " + (Date.now() - start | 0)), 200);
    setTimeout(() => log.push("a " + (Date.now() - start | 0)), 100);
    const every = setInterval(() => log.push("i"), 40);
    setTimeout(() => {
      clearInterval(every);
      postMessage({
        date: Date.now() | 0,
        now: performance.now() | 0,
        origin: performance.timeOrigin,
        random: Math.random(),
        bytes: random[0],
        uuid: crypto.randomUUID?.(),
        event: new Event("x").timeStamp | 0,
        measure: performance.measure("all").duration | 0,
        entries: performance.getEntries().map(({ entryType }) => entryType),
        log,
      });
    }, 300);
  `;
  const page = (blob: string) => `<!doctype html><script type="module">
    window.answer = await new Promise((resolve) => {
      new Worker(${blob}).onmessage = ({ data }) => resolve(data);
    });
  </script>`;
  const BLOB = `URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: "text/javascript" }))`;

  for (const [name, html] of [
    ["from a file", page(`"w.js"`)],
    ["that code made", page(BLOB)],
  ] as const) {
    test(`a worker ${name} gets the same numbers and times on every run`, async ({ page: tab }) => {
      const read = async () => {
        const scene = await pageScene(tab, html, { files: { "scenes/test/w.js": WORKER } });
        await expect
          .poll(() => scene.read(() => Boolean((window as unknown as { answer?: object }).answer)))
          .toBe(true);
        return scene.read(() => (window as unknown as { answer: object }).answer);
      };
      const first = await read();
      expect(await read()).toEqual(first);
      expect(first).toMatchObject({
        now: 300,
        origin: Date.UTC(2026, 0, 1),
        event: 300,
        measure: 300,
        entries: ["measure"],
        log: ["frame 16", "i", "i", "a 100", "i", "i", "b 200", "i", "i", "i"],
      });
    });
  }

  for (const [name, inner] of [
    ["from a file", `"w.js"`],
    ["that code made", `URL.createObjectURL(new Blob([code], { type: "text/javascript" }))`],
  ] as const) {
    test(`a worker ${name} that a worker started has the same clock`, async ({ page: tab }) => {
      const OUTER = `
        const code = ${JSON.stringify(WORKER)};
        const inner = new Worker(${inner});
        inner.onmessage = ({ data }) => postMessage(data);
        inner.onerror = (event) => postMessage("failed: " + event.message);
      `;
      const read = async () => {
        const scene = await pageScene(tab, page(`"outer.js"`), {
          files: { "scenes/test/w.js": WORKER, "scenes/test/outer.js": OUTER },
        });
        await expect
          .poll(() => scene.read(() => Boolean((window as unknown as { answer?: object }).answer)))
          .toBe(true);
        return scene.read(() => (window as unknown as { answer: object }).answer);
      };
      const first = await read();
      expect(await read()).toEqual(first);
      expect(first).toMatchObject({ now: 300, origin: Date.UTC(2026, 0, 1), event: 300 });
    });
  }

  test("a worker reads files with the old way of asking too", async ({ page: tab }) => {
    const scene = await pageScene(tab, page(`"w.js"`), {
      files: {
        "scenes/test/w.js": `
          const request = new XMLHttpRequest();
          request.open("GET", "data.json");
          request.onload = () => postMessage(request.responseText);
          request.onerror = () => postMessage("failed");
          request.send();
        `,
        "scenes/test/data.json": `{"a":1}`,
      },
    });
    await expect
      .poll(() => scene.read(() => (window as unknown as { answer?: string }).answer))
      .toBe(`{"a":1}`);
  });

  test("says that nothing of the clock reaches into a worklet", async ({ page: tab }) => {
    const scene = await pageScene(
      tab,
      `<!doctype html><script type="module">
        await CSS.paintWorklet.addModule("paint.js");
        window.loaded = true;
      </script>`,
      { files: { "scenes/test/paint.js": `registerPaint("x", class { paint() {} });` } },
    );
    expect(await scene.read(() => (window as unknown as { loaded?: boolean }).loaded)).toBe(true);
    expect((await scene.problems()).map(({ code }) => code)).toEqual(["worklet"]);
  });

  test("a module worker that code made runs at all", async ({ page: tab }) => {
    const scene = await pageScene(
      tab,
      `<!doctype html><script type="module">
        const code = 'await 0; postMessage(typeof Math.random())';
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        window.answer = await new Promise((resolve) => {
          const worker = new Worker(url, { type: "module" });
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = () => resolve("failed");
        });
      </script>`,
    );
    await expect
      .poll(() => scene.read(() => (window as unknown as { answer?: string }).answer))
      .toBe("number");
  });

  test("says that what a worker sends arrives in real time", async ({ page: tab }) => {
    const scene = await pageScene(tab, `<!doctype html><script>new Worker("w.js")</script>`, {
      files: { "scenes/test/w.js": `` },
    });
    expect((await scene.problems()).map(({ code }) => code)).toEqual(["worker-timing"]);
  });
});

test("does not touch the history of the tab", async ({ page }) => {
  const before = await page.evaluate(() => history.length);
  const scene = await pageScene(
    page,
    `<!doctype html><script>
      window.result = (() => {
        for (let round = 0; round < 30; round += 1) history.pushState({ round }, "", "?" + round);
        history.back();
        history.go(-1);
        return { state: history.state, url: location.search };
      })();
    </script>`,
  );
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => history.length)).toBe(before);
  expect(await scene.read(() => (window as unknown as { result: object }).result)).toEqual({
    state: { round: 29 },
    url: "",
  });
});
