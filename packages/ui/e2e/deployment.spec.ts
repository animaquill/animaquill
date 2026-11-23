import { execFileSync } from "node:child_process";
import { createHmac, randomInt } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { APIRequestContext, Page } from "@playwright/test";
import {
  canCapture,
  chooseFolder,
  colorAt,
  content,
  distance,
  expect,
  importFolder,
  projectFolder,
  sceneFrames,
  tab,
  test,
} from "./scene-support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * What only shows on the real sites. Everything here runs against the files in this repository,
 * through both servers: see scripts/e2e-edge. Host names are the real ones, in a container that has
 * nothing else to reach.
 */
const EDITOR = "https://app.animaquill.com";
const COMPOSITOR = "https://app-sandbox.animaquill.dev";
const SCENES = [0, 1, 2, 3, 4, 5, 6, 7].map(
  (index) => `https://scene-${index}.animaquill.dev`,
);

const scenePolicy =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; " +
  "style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; " +
  "media-src blob: data:; connect-src blob: data:; base-uri 'none'; form-action 'none'; " +
  "sandbox allow-scripts";

/** A project of two seconds with a tone on its track of sound, written to a folder. */
function soundFolder(): string {
  const rate = 48_000;
  const count = 2 * rate;
  const data = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const value = 0.3 * Math.sin((2 * Math.PI * 440 * index) / rate);
    data.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const format = { id: "small", name: "小屏", width: 320, height: 180, fps: "30" };
  const files: Map<string, string | Buffer> = writeProject(
    createProject({ name: "声音项目", format }),
  );
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { kind: string; clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "2" }));
  const track = timeline.tracks.find(({ kind }) => kind === "audio");
  if (!track) throw new Error("No track of sound");
  const source = { kind: "audio", media: { asset: "tone" } };
  track.clips = [{ id: "tone", start: "0", duration: "2", source }];
  files.set(path, JSON.stringify(timeline));
  const tone = { name: "测试音", kind: "audio", path: "assets/tone.wav", storage: "git" };
  files.set("assets.json", JSON.stringify({ assets: { tone } }));
  files.set("assets/tone.wav", Buffer.concat([header, data]));
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-sound-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const headers = async (request: APIRequestContext, url: string) => {
  const response = await request.get(url);
  return {
    status: response.status(),
    headers: response.headers(),
    text: await response.text(),
  };
};

test.describe("the sites", () => {
  test.use({ withProject: false });

  for (const origin of SCENES) {
    test(`${origin} has the page, with the sandbox as its policy`, async ({
      request,
    }) => {
      const {
        status,
        headers: sent,
        text,
      } = await headers(request, `${origin}/scene.html`);
      expect(status).toBe(200);
      expect(sent["content-security-policy"]).toBe(scenePolicy);
      expect(sent["content-type"]).toContain("text/html");
      expect(sent["x-frame-options"]).toBeUndefined();
      // Nothing that directive can say matches a compositor, which has no origin.
      expect(sent["content-security-policy"]).not.toContain("frame-ancestors");
      expect(text).toContain(`data-editors="[&quot;${EDITOR}&quot;]"`);
    });

    test(`${origin} has nothing else`, async ({ request }) => {
      for (const path of [
        "/",
        "/index.html",
        "/compositor.html",
        "/assets/",
        "/scene.html/x",
      ]) {
        expect((await headers(request, `${origin}${path}`)).status, path).toBe(
          404,
        );
      }
    });
  }

  test("the compositor can only show the scenes of this site", async ({
    request,
  }) => {
    const { headers: sent } = await headers(
      request,
      `${COMPOSITOR}/compositor.html`,
    );
    const policy = sent["content-security-policy"] as string;
    expect(policy).toContain(`frame-src ${SCENES.join(" ")};`);
    expect(policy).toContain(`frame-ancestors ${EDITOR}`);
    expect(policy).toContain(`script-src ${COMPOSITOR};`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("unsafe");
  });

  test("the editor shows the compositor and nothing else", async ({
    request,
  }) => {
    const { headers: sent } = await headers(request, `${EDITOR}/`);
    const policy = sent["content-security-policy"] as string;
    expect(policy).toContain(`frame-src ${COMPOSITOR};`);
    expect(policy).toContain("frame-ancestors 'none'");
  });

  test("the editor runs only its own scripts, and styles reach nothing outside", async ({
    request,
  }) => {
    const { headers: sent } = await headers(request, `${EDITOR}/`);
    const policy = sent["content-security-policy"] as string;
    const directive = (name: string) =>
      policy
        .split("; ")
        .find((part) => part.startsWith(`${name} `))
        ?.slice(name.length + 1);
    // WebAssembly may compile, for keeping the pitch at other speeds; scripts still cannot eval.
    expect(directive("script-src")).toBe("'self' 'wasm-unsafe-eval'");
    expect(directive("worker-src")).toBe("'self'");
    expect(directive("manifest-src")).toBe("'self'");
    // Monaco writes styles into the page, so this one is open. It has to go nowhere from there.
    expect(directive("style-src")).toBe("'self' 'unsafe-inline'");
    // Pictures of the READMEs of model packs, from the commit installed; GitHub's pictures of
    // accounts, for the account menu.
    expect(directive("img-src")).toBe(
      "'self' data: blob: https://raw.githubusercontent.com https://avatars.githubusercontent.com",
    );
    expect(directive("font-src")).toBe("'self'");
    // The browser agent talks to the AI services people set up (2026-11-10, user's decision).
    expect(directive("connect-src")).toBe("'self' https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*");
  });

  test("a scene page opened directly has no origin of its own", async ({
    page,
  }) => {
    await page.goto(`${SCENES[0]}/scene.html`);
    expect(await page.title()).toBe("Scene");
    // That is what the header is for.
    expect(await page.evaluate(() => self.origin)).toBe("null");
  });

  test("a scene page answers nobody but the editor of this site", async ({
    page,
  }) => {
    // Another page of this deployment can put the scene page in a frame of its own. It is a real
    // page here, because the browser keeps a page from elsewhere from reaching local sites at all.
    await page.goto(`${COMPOSITOR}/compositor.html`);
    const said = await page.evaluate(async (scene) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      const heard: unknown[] = [];
      addEventListener("message", (event) => {
        if (event.source === frame.contentWindow) heard.push(event.data);
      });
      frame.src = scene;
      document.body.append(frame);
      await new Promise((done) =>
        frame.addEventListener("load", done, { once: true }),
      );
      await new Promise((done) => setTimeout(done, 500));
      return heard;
    }, `${SCENES[0]}/scene.html`);
    // It did load, or saying nothing would mean nothing.
    const scene = page
      .frames()
      .find((frame) => frame.url() === `${SCENES[0]}/scene.html`);
    expect(await scene?.evaluate(() => document.title)).toBe("Scene");
    expect(said).toEqual([]);
  });
});

test.describe("the editor", () => {
  const notes = (page: Page) => {
    const seen: string[] = [];
    page.on("console", (message) => {
      if (/content security policy/i.test(message.text()))
        seen.push(message.text());
    });
    return seen;
  };

  test("runs in its policy", async ({ page, problems }) => {
    await expect(tab(page, "preview")).toBeVisible();
    await content(page, "timeline")
      .getByRole("button", { name: "新建场景" })
      .click();
    await expect.poll(() => page.frames().length).toBeGreaterThan(1);
    expect(problems).toEqual([]);
  });

  test("keeps the pitch at twice the speed: its worklet and WebAssembly run in the policy", async ({
    page,
    problems,
  }) => {
    const keeps: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("keeps no pitch")) keeps.push(message.text());
    });
    await expect(tab(page, "preview")).toBeVisible();
    // A little module that says where the worklet is: the audio thread fetches that itself.
    const worklet = page.waitForResponse(/stretch-worklet/);
    await content(page, "timeline").getByRole("group", { name: "时间轴" }).focus();
    await page.keyboard.press("KeyL");
    await page.keyboard.press("KeyL");
    await expect(content(page, "preview").getByTestId("play-rate")).toHaveText("2×");
    const where = await worklet;
    expect(where.ok()).toBe(true);
    const path = /["'`](\/assets\/stretch-worklet-[^"'`]+\.js)["'`]/.exec(await where.text())?.[1];
    expect(path).toBeDefined();
    const served = await page.request.get(new URL(path ?? "", where.url()).href);
    expect(served.ok()).toBe(true);
    // Its MIT notice goes along with it, through the build and the minifier.
    const code = await served.text();
    expect(code).toContain("registerProcessor");
    expect(code).toContain("Permission is hereby granted");
    // The worklet says it is ready within seconds, or the editor says that it keeps no pitch.
    await page.waitForTimeout(6000);
    await page.keyboard.press("KeyK");
    expect(keeps).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("mixes sound in its policy: the mixer of the audio thread plays, the export mixes in its worker", async ({
    page,
    problems,
  }) => {
    test.setTimeout(120_000);
    // Where the dialog for saving would put the file, because a test cannot operate that dialog.
    await page.context().addInitScript(() => {
      const pick = async () =>
        (await navigator.storage.getDirectory()).getFileHandle("chosen-video", { create: true });
      Object.assign(window, { showSaveFilePicker: pick });
    });
    await page.reload();
    const mixer = page.waitForResponse(/mixer-worklet/);
    const worker = page.waitForResponse(/mix-worker/);
    await chooseFolder(page, soundFolder());
    await expect(tab(page, "preview")).toBeVisible({ timeout: 30_000 });
    const button = (name: string) =>
      content(page, "preview").getByRole("button", { name, exact: true });
    await button("播放").click();
    // A little module that says where the worklet is: the audio thread fetches that itself.
    const where = await mixer;
    expect(where.ok()).toBe(true);
    const path = /["'`](\/assets\/mixer-worklet-[^"'`]+\.js)["'`]/.exec(await where.text())?.[1];
    expect(path).toBeDefined();
    expect((await page.request.get(new URL(path ?? "", where.url()).href)).ok()).toBe(true);
    await page.waitForTimeout(1000);
    await button("暂停").click();
    // Nothing says that this browser plays no sound.
    await expect(page.getByText("这个浏览器放不出预览的声音")).toHaveCount(0);
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "导出视频…", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "导出", exact: true }).click();
    expect((await worker).ok()).toBe(true);
    await expect(page.getByRole("status").getByText("已导出“")).toBeVisible({ timeout: 60_000 });
    expect(problems).toEqual([]);
  });

  test.describe("in a browser that cannot capture", () => {
    test.skip(canCapture, "this one can");

    test("the page of a scene loads, and says that", async ({ page }) => {
      const seen = notes(page);
      await content(page, "timeline")
        .getByRole("button", { name: "新建场景" })
        .click();
      await expect(
        content(page, "preview").getByText("这个浏览器不能捕获场景"),
      ).toBeVisible();
      expect(seen).toEqual([]);
    });
  });

  test.describe("with scenes running", () => {
    test.skip(!canCapture, "needs a browser that can capture");

    test("a new scene shows, through every policy there is", async ({
      page,
    }) => {
      const seen = notes(page);
      await content(page, "timeline")
        .getByRole("button", { name: "新建场景" })
        .click();
      await expect
        .poll(async () => distance(await colorAt(page, 100, 100), [0, 0, 0]))
        .toBeGreaterThan(8);
      expect(seen).toEqual([]);
      const [frame] = sceneFrames(page);
      expect(SCENES.some((origin) => frame?.url().startsWith(origin))).toBe(
        true,
      );
    });

    test.describe("from a project that wants out", () => {
      test.use({ withProject: false });

      test("reaches none of the sites, and the page around it stays closed", async ({
        page,
        problems,
      }) => {
        const blocked = `<!doctype html><script type="module">
          const out = {};
          const attempt = async (name, run) => {
            try { out[name] = await run(); } catch (error) { out[name] = "blocked: " + error.name; }
          };
          await attempt("fetch", () => fetch("${EDITOR}/").then(({ status }) => "reached " + status));
          await attempt("storage", () => localStorage.length);
          await attempt("cookie", () => document.cookie);
          await attempt("indexedDB", () => indexedDB.open("a").readyState);
          await attempt("parent", () => parent.document.title);
          await attempt("top", () => top.location.href);
          window.answers = out;
        </script>`;
        await importFolder(
          page,
          projectFolder({ a: { "index.html": blocked } }, [{}]),
        );
        await expect.poll(() => sceneFrames(page).length).toBe(1);
        const [frame] = sceneFrames(page);
        await expect
          .poll(() =>
            frame?.evaluate(
              () => (window as unknown as { answers?: object }).answers,
            ),
          )
          .toBeDefined();
        const answers = await frame?.evaluate(
          () =>
            (window as unknown as { answers: Record<string, string> }).answers,
        );
        for (const [name, answer] of Object.entries(answers ?? {})) {
          expect(String(answer), name).toMatch(/^blocked: /);
        }
        // It was the policy of the scene that stopped it, and it said so.
        expect(problems.join()).toContain("Content Security Policy");
        problems.splice(0);
      });
    });
  });
});

test.describe("the code editor", () => {
  test.use({ withProject: false });

  const code = (page: Page) => content(page, "code");
  /** Monaco's list of suggestions has no roles that say what is in it. */
  const suggestion = (page: Page, text: RegExp) =>
    code(page)
      .locator(".suggest-widget .monaco-list-row")
      .filter({ hasText: text })
      .first();

  const open = async (page: Page, name: string) => {
    await tab(page, "files").click();
    await content(page, "files")
      .getByRole("treeitem")
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
    await expect(code(page).locator(".view-lines")).toBeVisible();
  };

  test("lays out, colors and completes code, each of them with what the policy allows", async ({
    page,
  }) => {
    const sources = {
      "index.html": "<!doctype html>\n<p>你好</p>\n",
      "main.js": "const first = 1;\nconst second = 2;\n",
      "style.css": "body {\n  color: red;\n}\n",
    };
    await importFolder(page, projectFolder({ a: sources }, [{}]));
    await open(page, "main.js");

    // Lines get their place from a style attribute, and would all be in the same place without it.
    const lines = code(page).locator(".view-line");
    await expect(lines).toHaveCount(3);
    const [first, second] = await lines.evaluateAll((all) =>
      all.map((line) => line.getBoundingClientRect().top),
    );
    expect(second).toBeGreaterThan(first as number);

    // Colors come from a style element that the theme writes. Without it all words look the same.
    const colors = () =>
      code(page)
        .locator(".view-line span span")
        .evaluateAll(
          (spans) =>
            new Set(spans.map((span) => getComputedStyle(span).color)).size,
        );
    await expect.poll(colors).toBeGreaterThan(2);

    // The icons are a font, which loads once some of them show, as they do in the find widget.
    await code(page).locator(".view-lines").click();
    await page.keyboard.press("Control+f");
    await expect(code(page).locator(".find-widget")).toBeVisible();
    const iconsLoaded = () =>
      page.evaluate(() =>
        [...document.fonts].some(
          ({ family, status }) =>
            family.includes("codicon") && status === "loaded",
        ),
      );
    await expect.poll(iconsLoaded).toBe(true);
    await page.keyboard.press("Escape");

    // Each of these takes a worker of its own.
    await code(page).locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("document.getEl");
    await expect(suggestion(page, /getElementById/)).toBeVisible();
    await page.keyboard.press("Escape");
    await open(page, "style.css");
    await code(page).locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("a { backgr");
    await expect(suggestion(page, /background-color/)).toBeVisible();
    await page.keyboard.press("Escape");
    await open(page, "index.html");
    await code(page).locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("<scr");
    await expect(suggestion(page, /script/)).toBeVisible();
  });

  test.describe("with scenes running", () => {
    test.skip(!canCapture, "needs a browser that can capture");

    test("saving changes the picture, through every policy there is", async ({
      page,
    }) => {
      const page1 = "<!doctype html><style>body { background: #f00 }</style>\n";
      await importFolder(
        page,
        projectFolder({ a: { "index.html": page1 } }, [{}]),
      );
      await expect
        .poll(async () => distance(await colorAt(page, 100, 100), [255, 0, 0]))
        .toBeLessThan(8);
      // In the layout for animating, which shows the code next to the preview: in the one for
      // editing, the code takes the place of the preview, which takes the new scene once it shows.
      await page.keyboard.press("Alt+Shift+2");
      await open(page, "index.html");
      await code(page).locator(".view-lines").click();
      await page.keyboard.press("Control+a");
      await page.keyboard.insertText(
        "<!doctype html><style>body { background: #00f }</style>\n",
      );
      await page.keyboard.press("Control+s");
      await expect
        .poll(async () => distance(await colorAt(page, 100, 100), [0, 0, 255]))
        .toBeLessThan(8);
    });
  });
});

test.describe("reports of errors", () => {
  // Reports are sent where there is a backend: the online mode, so somebody signs in first. The
  // offline mode asks nothing of one, and saves them as files.
  test.use({ withProject: false });

  /** Where scripts/e2e-edge runs the report service, see run.sh. */
  const REPORTS = "/tmp/reports/errors";
  const code = readdirSync("/site/assets").filter((name) =>
    name.endsWith(".js"),
  );

  test("the maps of the code stay on the server", async ({ request }) => {
    expect(code.length).toBeGreaterThan(5);
    const main = code.find((name) => /^index-.*\.js$/.test(name));
    // They were made, or not finding them would prove nothing.
    expect(existsSync(`/work/apps/web/maps/assets/${main}.map`)).toBe(true);
    for (const name of code) {
      for (const site of [EDITOR, COMPOSITOR]) {
        for (const path of [
          `/assets/${name}.map`,
          `/assets/${name}.MAP`,
          `/${name}.map`,
        ]) {
          expect(
            (await request.get(`${site}${path}`)).status(),
            `${site}${path}`,
          ).toBe(404);
        }
      }
      const text = readFileSync(`/site/assets/${name}`, "utf8");
      expect(text, name).not.toMatch(/\/\/# sourceMappingURL=\S+\s*$/);
    }
    expect(
      readdirSync("/site", { recursive: true }).filter((name) =>
        String(name).endsWith(".map"),
      ),
    ).toEqual([]);
  });

  test("an error on the site is sent and comes back to its line in the sources", async ({
    page,
    context,
    request,
  }) => {
    // Signed in, with the GitHub App on a new account, as people are in the online mode.
    const github = "http://127.0.0.1:8400";
    const accountId = randomInt(1_000_000, 2_000_000_000);
    const login = `user-${accountId}`;
    expect(
      (await request.post(`${github}/_fake/install?user=${accountId}.${login}`)).ok(),
    ).toBe(true);
    await context.addCookies([
      { name: "fake_user", value: `${accountId}.${login}`, url: github },
    ]);
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
          "base64",
        ),
        contentType: "image/png",
      }),
    );
    await entrySignIn(page).click();
    const invited = execFileSync(
      "node",
      ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "errors test"],
      { encoding: "utf8" },
    );
    await page.getByLabel("邀请码").fill(/邀请码：(\S+)/.exec(invited)?.[1] ?? "");
    await page.getByRole("button", { name: "继续" }).click();
    await expect(
      page.locator("header").getByRole("button", { name: `账号：${login}` }),
    ).toBeVisible();

    // A place in the built code that is known to come from a known line of the sources.
    const marker = "`animaquill-error-";
    const main = code.find((name) =>
      readFileSync(`/site/assets/${name}`, "utf8").includes(marker),
    );
    if (!main) throw new Error("No code with the marker");
    const built = readFileSync(`/site/assets/${main}`, "utf8");
    const at = built.indexOf(marker);
    const line = built.slice(0, at).split("\n").length;
    const column = at - built.lastIndexOf("\n", at - 1);
    const source = "oss/packages/ui/src/workbench/workbench.ts";
    const sourceLine =
      readFileSync(`/work/${source}`, "utf8")
        .split("\n")
        .findIndex((text) => text.includes(marker)) + 1;
    expect(sourceLine).toBeGreaterThan(0);

    // As the browser says it when that code throws.
    await page.evaluate((place) => {
      const error = new TypeError("e.at is not a function");
      error.stack = `TypeError: e.at is not a function\n    at Xy (${place})`;
      dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
    }, `${EDITOR}/assets/${main}:${line}:${column}`);
    const prompt = page.getByRole("alertdialog", {
      name: "出错了，要发送错误报告吗？",
    });
    await prompt.getByRole("button", { name: "发送", exact: true }).click();
    const sent = page.getByRole("alertdialog", { name: "错误报告已发送" });
    await expect(sent).toContainText(/编号 \S+。/);
    const id = /编号 (\S+)。/.exec((await sent.textContent()) ?? "")?.[1];

    let filed:
      | { group?: string; error: { frames: Record<string, unknown>[] } }
      | undefined;
    await expect
      .poll(() => {
        if (!existsSync(`${REPORTS}/samples/${id}.json`)) return undefined;
        filed = JSON.parse(
          readFileSync(`${REPORTS}/samples/${id}.json`, "utf8"),
        );
        return filed?.group;
      })
      .toMatch(/^[0-9a-f]{16}$/);
    expect(filed?.error.frames[0]).toMatchObject({
      file: `/assets/${main}`,
      line,
      column,
      source,
      sourceLine,
    });
    const summary = JSON.parse(
      readFileSync(`${REPORTS}/${filed?.group}.json`, "utf8"),
    );
    expect(summary).toMatchObject({
      count: 1,
      firstVersion: "dev",
      lastVersion: "dev",
      name: "TypeError",
    });
  });
});

test.describe("the platform API", () => {
  test.use({ withProject: false });
  /** What run.sh starts the API with. */
  const WEBHOOK_SECRET = "deployment-test-secret";
  const sign = (body: string) =>
    `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;

  test("/api goes to the API, and what was there before stays where it was", async ({
    request,
  }) => {
    // The API answers, with its database: run.sh waits for it. Not the gateway's 502.
    const health = await request.get(`${EDITOR}/api/health`);
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      version: "dev",
    });
    expect(health.headers()["cache-control"]).toBe("no-store");
    expect(health.headers()["strict-transport-security"]).toBeTruthy();
    const unknown = await request.get(`${EDITOR}/api/nothing-here`);
    expect(unknown.status()).toBe(404);
    expect(await unknown.json()).toMatchObject({ statusCode: 404 });

    // The report service keeps its path. It only takes POST, and says 501 to anything else, which
    // the API never does. That a report gets through is in "reports of errors" above.
    expect((await request.get(`${EDITOR}/api/diagnostics`)).status()).toBe(501);
    // The editor is still the page, and the other sites have no API.
    expect(
      (await request.get(`${EDITOR}/`)).headers()["content-type"],
    ).toContain("text/html");
    expect((await request.get(`${COMPOSITOR}/api/health`)).status()).toBe(404);
    expect((await request.get(`${SCENES[0]}/api/health`)).status()).toBe(404);
  });

  test("says who is signed in, and nobody is without a session", async ({
    request,
  }) => {
    const session = await request.get(`${EDITOR}/api/auth/session`);
    expect(session.status()).toBe(200);
    expect(await session.json()).toEqual({ status: "signedOut" });
    expect(session.headers()["cache-control"]).toBe("no-store");
  });

  test("signing out takes requests from the editor's page, and nothing else", async ({
    page,
    request,
  }) => {
    // The page sends Referrer-Policy: no-referrer, which must not cost fetch its Origin.
    const fromThePage = await page.evaluate(async () => {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "x-animaquill": "1" },
      });
      return response.status;
    });
    expect(fromThePage).toBe(204);
    expect(
      (await request.post(`${EDITOR}/api/auth/logout`)).status(),
    ).toBe(403);
    expect(
      (
        await request.post(`${EDITOR}/api/auth/logout`, {
          headers: { origin: "https://evil.example", "x-animaquill": "1" },
        })
      ).status(),
    ).toBe(403);
  });

  test("the gateway takes 25 MB for the webhook, and 1 MB for the rest of the API", async ({
    request,
  }) => {
    const big = Buffer.alloc(2 * 1024 * 1024, "x");
    // Turned away by the gateway, not by the API, which answers in JSON.
    const elsewhere = await request.post(`${EDITOR}/api/auth/logout`, {
      headers: { "content-type": "application/octet-stream" },
      data: big,
    });
    expect(elsewhere.status()).toBe(413);
    expect(elsewhere.headers()["content-type"] ?? "").not.toContain("json");
    // Through to the API, which reads all of it and then checks who signed it.
    const webhook = await request.post(`${EDITOR}/api/github/webhook`, {
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      data: big,
    });
    expect(webhook.status()).toBe(401);
  });

  test("the GitHub webhook takes only what is signed with its secret", async ({
    request,
  }) => {
    const body = JSON.stringify({ zen: "Design for failure.", hook_id: 1 });
    const post = (signature: string | undefined, data = body) =>
      request.post(`${EDITOR}/api/github/webhook`, {
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-github-delivery": "deployment-test",
          ...(signature !== undefined && { "x-hub-signature-256": signature }),
        },
        data,
      });
    expect((await post(sign(body))).status()).toBe(204);
    expect((await post(sign(body), `${body} `)).status()).toBe(401);
    expect((await post(sign(`${body} `))).status()).toBe(401);
    expect((await post(undefined)).status()).toBe(401);
  });
});

test("this test and the build agree on what the policy of a scene is", () => {
  const caddyfile = readFileSync("/work/apps/web/Caddyfile", "utf8");
  expect(caddyfile).toContain(scenePolicy);
});
