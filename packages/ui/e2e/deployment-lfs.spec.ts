import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from "@playwright/test";
import { createOnline, entrySignIn } from "./online-support.ts";
import { expect, tab, test } from "./support.ts";
import { openCard } from "./start-support.ts";

/**
 * A file of an asset into Git LFS of the project's repository through the platform, on the real
 * sites through the gateway, with the API, the worker (its own process) and the fake GitHub as a
 * server (docs/design/phase5-step14.md 3.2.3): the pieces as large as the platform takes go through
 * the gateway, which takes no more than that for them and 1 MB for the rest of the API; the API
 * puts them into its staging folder, reads the file through once all of it is there, which the last
 * piece does not wait for, and the worker puts the file into the storage, whole and the same, over
 * a real HTTP connection with its length. The editor's queue comes with step 14.2③: here the page
 * asks the API the way it will.
 */

const GITHUB = "http://127.0.0.1:8400";
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

interface GitHubUser {
  readonly id: number;
  readonly login: string;
}

const someone = (): GitHubUser => {
  const id = randomInt(1_000_000, 2_000_000_000);
  return { id, login: `user-${id}` };
};

const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "lfs test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

/** A browser in this container says it is offline from the start, see deployment-sync.spec.ts. */
const ON_A_NETWORK = () => {
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => true,
    configurable: true,
  });
};

/** Where the pictures of the downloads go, for people to look at. */
const SHOTS = process.env.AQ_SHOTS ?? "test-results/lfsd-shots";

/** Another computer, signed in to GitHub as the same person, its projects in the browser. */
async function anotherComputer(browser: Browser, user: GitHubUser) {
  const context = await browser.newContext({
    baseURL: "https://app.animaquill.com",
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies([
    { name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB },
  ]);
  await context.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  await context.addInitScript(ON_A_NETWORK);
  await context.addInitScript(() => {
    if (window !== window.top) return;
    try {
      localStorage.setItem("animaquill.projectsInBrowser", "yes");
      localStorage.setItem("animaquill.trial", '{"version":1,"enabled":false}');
    } catch {}
  });
  return context;
}

/**
 * The SHA-256 of the files of this size that the browser keeps for its projects, in hexadecimal:
 * what came is in there, as it was checked and put.
 */
const keptHashes = (page: Page, size: number) =>
  page.evaluate(async (size) => {
    // The database of the account, see host/src/scope.ts.
    const name = (await indexedDB.databases())
      .map((each) => each.name ?? "")
      .find((each) => /^aq-online-.*-animaquill$/.test(each));
    if (name === undefined) return [];
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = await new Promise<{ file?: Blob }[]>((resolve, reject) => {
      const request = database
        .transaction("media")
        .objectStore("media")
        .getAll();
      request.onsuccess = () => resolve(request.result as { file?: Blob }[]);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const hashes: string[] = [];
    for (const { file } of all) {
      if (!(file instanceof Blob) || file.size !== size) continue;
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
      );
      hashes.push(
        [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      );
    }
    return hashes;
  }, size);

/** Signs in with the App installed, makes a project of the platform with a new repository. */
async function savedToGitHub(
  page: Page,
  context: BrowserContext,
  request: APIRequestContext,
) {
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const user = someone();
  const param = `user=${user.id}.${user.login}`;
  expect((await request.post(`${GITHUB}/_fake/install?${param}`)).ok()).toBe(
    true,
  );
  await context.addCookies([
    { name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB },
  ]);
  // From the way back from signing in on.
  await page.addInitScript(ON_A_NETWORK);
  await entrySignIn(page).click();
  await page.getByLabel("邀请码").fill(newInvite());
  await page.getByRole("button", { name: "继续" }).click();
  await expect(
    page.locator("header").getByRole("button", { name: `账号：${user.login}` }),
  ).toBeVisible();
  // A new project is on the platform and in a new repository, made in one dialog.
  await createOnline(page, `lfs-${user.id}`);
  await expect(page.locator("footer [data-cloud]")).toHaveAttribute(
    "data-cloud",
    "online",
  );
  const project = await page.evaluate(async () => {
    const answer = (await (await fetch("/api/projects")).json()) as {
      projects: { id: string }[];
    };
    return answer.projects[0]!.id;
  });
  const repo = await page.evaluate(
    async (project) =>
      (
        (await (
          await fetch(`/api/projects/${project}/repository`)
        ).json()) as any
      ).repository.id as number,
    project,
  );
  return { project, repo, user };
}

test.describe("files of assets into Git LFS", () => {
  // The entry page, then the start page of the online mode: the project is made there.
  test.use({ withProject: false });

  test("go through the gateway in pieces as large as the platform takes, and the worker puts them into the storage, the same", async ({
    page,
    context,
    request,
    problems,
  }) => {
    test.setTimeout(240_000);
    const { project, repo } = await savedToGitHub(page, context, request);

    // Nothing goes before the person said they know what it means, whatever a page sends.
    const said = await page.evaluate(async (project) => {
      const change = {
        "x-animaquill": "1",
        "content-type": "application/json",
      };
      const oid = "0".repeat(64);
      const refused = await fetch(`/api/projects/${project}/lfs/objects`, {
        method: "POST",
        headers: change,
        body: JSON.stringify({ oid, size: 10 }),
      });
      const { account } = (await (await fetch("/api/me/lfs")).json()) as {
        account: string;
      };
      const known = await fetch("/api/me/lfs", {
        method: "POST",
        headers: change,
        body: JSON.stringify({ account, acknowledged: true }),
      });
      return {
        refused: refused.status,
        error: (await refused.json()).error,
        known: known.status,
      };
    }, project);
    expect(said).toEqual({
      refused: 409,
      error: "notAcknowledged",
      known: 200,
    });
    // The browser logs the answer that said no, which was meant.
    problems.splice(
      0,
      problems.length,
      ...problems.filter((problem) => !/status of 409/.test(problem)),
    );

    // A file of a piece of 8 MiB and a little more, as the editor will send it.
    const sent = await page.evaluate(async (project) => {
      const size = 8 * 1024 * 1024 + 100_000;
      const file = new Uint8Array(size);
      for (let at = 0; at < size; at += 65_536)
        crypto.getRandomValues(file.subarray(at, Math.min(size, at + 65_536)));
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", file),
      );
      const oid = [...digest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const change = { "x-animaquill": "1" };
      const begun = await fetch(`/api/projects/${project}/lfs/objects`, {
        method: "POST",
        headers: { ...change, "content-type": "application/json" },
        body: JSON.stringify({ oid, size }),
      });
      const upload = (await begun.json()) as {
        id: string;
        chunk: number;
        minChunk: number;
        state: string;
      };
      const statuses: number[] = [];
      const states: string[] = [];
      const received: number[] = [];
      for (let at = 0; at < size; at += upload.chunk) {
        const piece = file.subarray(at, Math.min(size, at + upload.chunk));
        const answer = await fetch(`/api/lfs/uploads/${upload.id}`, {
          method: "PUT",
          headers: {
            ...change,
            "content-type": "application/octet-stream",
            "upload-offset": String(at),
          },
          body: piece,
        });
        statuses.push(answer.status);
        const said = (await answer.json()) as {
          state: string;
          received: number;
        };
        states.push(said.state);
        received.push(said.received);
      }
      // One piece larger than any the platform takes: the gateway says no before the API does.
      const tooLarge = await fetch(`/api/lfs/uploads/${upload.id}`, {
        method: "PUT",
        headers: {
          ...change,
          "content-type": "application/octet-stream",
          "upload-offset": "0",
        },
        body: new Uint8Array(9 * 1024 * 1024 + 1),
      });
      // And the rest of the API takes 1 MB at most.
      const elsewhere = await fetch(`/api/projects/${project}/lfs/objects`, {
        method: "POST",
        headers: { ...change, "content-type": "application/json" },
        body: JSON.stringify({ oid, size, filler: "x".repeat(1_100_000) }),
      });
      return {
        id: upload.id,
        oid,
        size,
        begun: begun.status,
        answer: upload,
        chunk: upload.chunk,
        minChunk: upload.minChunk,
        statuses,
        states,
        received,
        tooLarge: tooLarge.status,
        elsewhere: elsewhere.status,
      };
    }, project);
    expect(sent.begun, JSON.stringify(sent.answer)).toBe(201);
    expect(sent.chunk).toBe(8 * 1024 * 1024);
    expect(sent.minChunk).toBe(64 * 1024);
    expect(sent.statuses).toEqual([200, 200]);
    // The last piece is answered as the first: all of the file is there, and the platform reads
    // it through after that. How it went, the page asks, below.
    expect(sent.states).toEqual(["receiving", "receiving"]);
    expect(sent.received).toEqual([8 * 1024 * 1024, sent.size]);
    expect(sent.tooLarge).toBe(413);
    expect(sent.elsewhere).toBe(413);

    // The worker puts it into the storage, by itself.
    await expect
      .poll(
        async () =>
          page.evaluate(
            async (id) =>
              ((await (await fetch(`/api/lfs/uploads/${id}`)).json()) as any)
                .state,
            sent.id,
          ),
        { timeout: 120_000 },
      )
      .toBe("done");
    const stored = (await (
      await request.get(`${GITHUB}/_fake/lfs?repo=${repo}`)
    ).json()) as Record<string, { size: number; same: boolean }>;
    expect(stored[sent.oid]).toEqual({ size: sent.size, same: true });

    // Asked again, it is there.
    const again = await page.evaluate(
      async ({ project, oid, size }) => {
        const answer = await fetch(`/api/projects/${project}/lfs/objects`, {
          method: "POST",
          headers: { "x-animaquill": "1", "content-type": "application/json" },
          body: JSON.stringify({ oid, size }),
        });
        return ((await answer.json()) as { state: string }).state;
      },
      { project, oid: sent.oid, size: sent.size },
    );
    expect(again).toBe("present");
    // What the gateway said no to, on purpose.
    const kept = problems.filter((problem) => !/status of 413/.test(problem));
    problems.splice(0, problems.length, ...kept);
  });

  test("from the editor: a file goes on from where it got after the page reloads, and only once it is there does the asset say so", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(300_000);
    const { repo } = await savedToGitHub(page, context, request);
    // A picture with 3 MB after its end, which the browser shows all the same: a few pieces.
    const bytes = Buffer.concat([
      PICTURE,
      Buffer.alloc(3 * 1024 * 1024 + 12_345, 7),
    ]);
    for (let at = PICTURE.length; at < bytes.length; at += 4096)
      bytes[at] = at % 251;
    const { createHash } = await import("node:crypto");
    const oid = createHash("sha256").update(bytes).digest("hex");
    await page.locator('[data-tab="assets"]').click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入" }).click();
    await (
      await chooser
    ).setFiles({ name: "大图.png", mimeType: "image/png", buffer: bytes });
    await page.locator('[data-tab="explorer"]').click();
    await page.getByRole("option", { name: "大图.png" }).click();
    const place = page.getByRole("region", { name: "存放位置" });
    await expect(place).toContainText("只在这个浏览器里");

    // The first piece goes through; the next one hangs, as on a line that went away.
    const offsets: number[] = [];
    let hang = false;
    await page.route("**/api/lfs/uploads/*", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const offset = Number(route.request().headers()["upload-offset"]);
      offsets.push(offset);
      if (hang && offset > 0) return; // never answered
      hang = true;
      return route.continue();
    });
    // The first time, people are asked what it means, in the dialog.
    await place.getByRole("button", { name: "放进 GitHub 大文件存储" }).click();
    const dialog = page.locator("dialog[data-places-dialog]");
    await dialog
      .getByRole("checkbox", { name: /我知道：放进去以后不能单独删掉/ })
      .check();
    await dialog.getByRole("button", { name: /^开始上传（1 个/ }).click();
    await expect
      .poll(() => offsets.length, { timeout: 30_000 })
      .toBeGreaterThan(1);
    const first = offsets[1] as number;
    expect(first).toBeGreaterThan(0);
    // Not there yet: the asset says nothing of it.
    await expect(place).toContainText("正在放进 GitHub 大文件存储");
    const before = await page.evaluate(
      async (id) =>
        (await (await fetch(`/api/projects/${id}/repository`)).json()) as any,
      await page.evaluate(
        async () =>
          (
            (await (await fetch("/api/projects")).json()) as {
              projects: { id: string }[];
            }
          ).projects[0]!.id,
      ),
    );
    expect(before).toBeDefined();

    // The page reloads in the middle of it, and the project opens again: it goes on from there.
    await page.unroute("**/api/lfs/uploads/*");
    const after: number[] = [];
    await page.route("**/api/lfs/uploads/*", async (route) => {
      if (route.request().method() === "PUT")
        after.push(Number(route.request().headers()["upload-offset"]));
      return route.continue();
    });
    page.on("dialog", (asked) => void asked.accept());
    await page.reload();
    await expect(page.locator('[data-tab="preview"]')).toBeVisible({
      timeout: 60_000,
    });
    await page.locator('[data-tab="explorer"]').click();
    await page.getByRole("option", { name: "大图.png" }).click();
    await expect(page.getByRole("region", { name: "存放位置" })).toContainText(
      `GitHub 大文件存储 · user-`,
      { timeout: 180_000 },
    );
    // Nothing that the platform had was sent again.
    expect(after.length).toBeGreaterThan(0);
    expect(Math.min(...after)).toBe(first);
    // The storage has the very file, of its hash.
    const stored = (await (
      await request.get(`${GITHUB}/_fake/lfs?repo=${repo}`)
    ).json()) as Record<string, { size: number; same: boolean }>;
    expect(stored[oid]).toEqual({ size: bytes.length, same: true });
  });
  test("another computer: what clips use comes by itself, checked, goes on after a reload, and only one window gets it", async ({
    page,
    context,
    request,
    browser,
    problems,
  }) => {
    test.setTimeout(420_000);
    mkdirSync(SHOTS, { recursive: true });
    const { project, repo, user } = await savedToGitHub(page, context, request);
    // Two pieces of a download and some: 16 MiB and more.
    const bytes = Buffer.concat([
      PICTURE,
      Buffer.alloc(17 * 1024 * 1024 + 4321, 5),
    ]);
    for (let at = PICTURE.length; at < bytes.length; at += 4096)
      bytes[at] = at % 251;
    const { createHash } = await import("node:crypto");
    const oid = createHash("sha256").update(bytes).digest("hex");

    // On the first computer: in, on the timeline, and into the storage.
    await page.locator('[data-tab="assets"]').click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入" }).click();
    await (
      await chooser
    ).setFiles({ name: "远方.png", mimeType: "image/png", buffer: bytes });
    await page
      .getByRole("option", { name: "远方.png", exact: true })
      .first()
      .dblclick();
    await page.locator('[data-tab="explorer"]').click();
    await page
      .getByRole("option", { name: "远方.png", exact: true })
      .first()
      .click();
    const place = page.getByRole("region", { name: "存放位置" });
    await place.getByRole("button", { name: "放进 GitHub 大文件存储" }).click();
    const dialog = page.locator("dialog[data-places-dialog]");
    await dialog
      .getByRole("checkbox", { name: /我知道：放进去以后不能单独删掉/ })
      .check();
    await dialog.getByRole("button", { name: /^开始上传（1 个/ }).click();
    await expect(place).toContainText("GitHub 大文件存储 · user-", {
      timeout: 180_000,
    });
    await expect(place).toContainText("换电脑能自动下载");

    // The second computer: the project opens there without the file, which comes by itself.
    const other = await anotherComputer(browser, user);
    try {
      const b = await other.newPage();
      const otherProblems: string[] = [];
      b.on("pageerror", (error) => otherProblems.push(error.message));
      await b.goto("/");
      await entrySignIn(b).click();
      await expect(
        b
          .locator("header")
          .getByRole("button", { name: `账号：${user.login}` }),
      ).toBeVisible();

      // GitHub's traffic is used up at first: it says so, and what to do.
      let quota = true;
      const starts: number[] = [];
      let hang = false;
      await other.route("**/api/projects/*/lfs/objects/*", async (route) => {
        if (quota) {
          quota = false;
          return route.fulfill({
            status: 409,
            contentType: "application/json",
            body: '{"error":"githubQuota"}',
          });
        }
        const start = Number(
          /bytes=(\d+)-/.exec(route.request().headers()["range"] ?? "")?.[1],
        );
        starts.push(start);
        if (hang && start > 0) return; // never answered, as a line that went away
        hang = true;
        return route.continue();
      });
      await openCard(b, "测试项目");
      await expect(tab(b, "preview")).toBeVisible({ timeout: 60_000 });
      const status = b.locator('footer [data-save-status="github"]');
      await expect(status).toHaveAttribute("data-downloads", "failed", {
        timeout: 60_000,
      });
      await b.locator('[data-tab="explorer"]').click();
      await b
        .getByRole("option", { name: "远方.png", exact: true })
        .first()
        .click();
      const there = b.getByRole("region", { name: "存放位置" });
      await expect(there).toContainText(
        "GitHub 大文件存储这个月的下载流量用完了",
      );
      // Said once, where it is kept: not again above it, nor as something people could download.
      await expect(b.getByText("这台电脑上没有这个文件")).toHaveCount(0);
      await expect(
        b.locator('[data-download-badge="failed"]').first(),
      ).toHaveText("没下载下来");
      await b.screenshot({ path: `${SHOTS}/failed.png` });
      await there.getByRole("button", { name: "重试" }).click();

      // A piece comes, the next one hangs: the status bar, the panel and the asset say how it goes.
      await expect
        .poll(() => starts.length, { timeout: 60_000 })
        .toBeGreaterThan(1);
      await expect(status).toHaveAttribute("data-downloads", "going");
      await expect(status).toContainText("↓ 素材");
      await expect(there).toContainText("正在下载");
      await expect(b.getByText("这台电脑上没有这个文件")).toHaveCount(0);
      await expect(
        b.locator('[data-download-badge="going"]').first(),
      ).toContainText("下载中");
      // The clip says so, and the preview says nothing of a file it cannot find.
      await expect(b.locator('[data-download="going"]')).toHaveCount(1);
      await tab(b, "preview").click();
      await b.waitForTimeout(1000);
      await expect(
        b.getByText("有素材在这个浏览器里解不了或者找不到"),
      ).toHaveCount(0);
      await b.screenshot({ path: `${SHOTS}/preview.png` });
      await b.locator('[data-tab="explorer"]').click();
      await b
        .getByRole("option", { name: "远方.png", exact: true })
        .first()
        .click();
      await b.screenshot({ path: `${SHOTS}/place.png` });
      await status.screenshot({ path: `${SHOTS}/status.png` });
      await status.click();
      await expect(b.locator("div[data-downloads]")).toContainText(
        "正在下载 1 个",
      );
      await b.screenshot({ path: `${SHOTS}/panel.png` });
      await b.keyboard.press("Escape");

      // Another window of that computer on the project only looks.
      const asked: string[] = [];
      const b2 = await other.newPage();
      b2.on("request", (sent) => {
        if (/\/lfs\/objects\//.test(sent.url())) asked.push(sent.url());
      });
      await b2.goto(b.url());
      await expect(tab(b2, "preview")).toBeVisible({ timeout: 60_000 });
      await b2.locator('[data-tab="explorer"]').click();
      await b2
        .getByRole("option", { name: "远方.png", exact: true })
        .first()
        .click();
      await expect(b2.getByRole("region", { name: "存放位置" })).toContainText(
        "在另一个窗口里下载",
      );
      await b2.waitForTimeout(3000);
      expect(asked).toEqual([]);
      await b2.close();

      // The page reloads in the middle of it: what came stays, and it goes on from there.
      await other.unroute("**/api/projects/*/lfs/objects/*");
      const after: number[] = [];
      await other.route("**/api/projects/*/lfs/objects/*", async (route) => {
        after.push(
          Number(
            /bytes=(\d+)-/.exec(route.request().headers()["range"] ?? "")?.[1],
          ),
        );
        return route.continue();
      });
      await b.reload();
      await expect(tab(b, "preview")).toBeVisible({ timeout: 60_000 });
      await b.locator('[data-tab="explorer"]').click();
      await b
        .getByRole("option", { name: "远方.png", exact: true })
        .first()
        .click();
      await expect(b.getByRole("region", { name: "存放位置" })).toContainText(
        "GitHub 大文件存储 · user-",
        { timeout: 180_000 },
      );
      expect(after.length).toBeGreaterThan(0);
      expect(Math.min(...after)).toBe(16 * 1024 * 1024);
      // The very file of the first computer.
      expect(await keptHashes(b, bytes.length)).toEqual([oid]);
      // A piece through the gateway: as the API sends it, not packed, of the length it says.
      const piece = await b.evaluate(
        async ({ project, oid, size }) => {
          const answer = await fetch(
            `/api/projects/${project}/lfs/objects/${oid}?size=${size}`,
            {
              headers: {
                "x-animaquill": "1",
                range: "bytes=1000-1999",
                "accept-encoding": "gzip, br, zstd",
              },
            },
          );
          return {
            status: answer.status,
            range: answer.headers.get("content-range"),
            length: answer.headers.get("content-length"),
            encoding: answer.headers.get("content-encoding"),
            cache: answer.headers.get("cache-control"),
            bytes: (await answer.arrayBuffer()).byteLength,
          };
        },
        { project, oid, size: bytes.length },
      );
      expect(piece).toEqual({
        status: 206,
        range: `bytes 1000-1999/${bytes.length}`,
        length: "1000",
        encoding: null,
        cache: "no-store, no-transform",
        bytes: 1000,
      });
      expect(otherProblems).toEqual([]);
      const stored = (await (
        await request.get(`${GITHUB}/_fake/lfs?repo=${repo}`)
      ).json()) as Record<string, { size: number; same: boolean }>;
      expect(stored[oid]).toEqual({ size: bytes.length, same: true });
    } finally {
      await other.close();
    }
    problems.splice(0, problems.length);
  });

  test("new assets of an online project go into its repository by themselves and come on another computer; another default moves nothing", async ({
    page,
    context,
    request,
    browser,
  }) => {
    test.setTimeout(420_000);
    mkdirSync(SHOTS, { recursive: true });
    const { repo, user } = await savedToGitHub(page, context, request);
    const picture = (fill: number) => {
      const made = Buffer.concat([
        PICTURE,
        Buffer.alloc(300 * 1024 + fill, fill),
      ]);
      for (let at = PICTURE.length; at < made.length; at += 4096)
        made[at] = (at + fill) % 251;
      return made;
    };
    const bytes = picture(3);
    const { createHash } = await import("node:crypto");
    const oid = createHash("sha256").update(bytes).digest("hex");
    const importPicture = async (name: string, buffer: Buffer) => {
      await page.locator('[data-tab="assets"]').click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "导入" }).click();
      await (await chooser).setFiles({ name, mimeType: "image/png", buffer });
      await expect(
        page.getByRole("option", { name, exact: true }).first(),
      ).toBeVisible();
    };
    const properties = async () => {
      await page
        .locator("header")
        .getByRole("button", { name: "文件", exact: true })
        .click();
      await page
        .getByRole("menu")
        .getByRole("menuitem", { name: "项目属性…", exact: true })
        .click();
      await page
        .getByTestId("project-properties")
        .getByRole("navigation", { name: "项目属性的分组" })
        .getByRole("button", { name: "存放和同步" })
        .click();
      return page
        .getByTestId("project-properties")
        .getByRole("combobox", { name: "默认存储空间" });
    };

    // Imported, and on the timeline: asked once what it means, then into the repository.
    await importPicture("自动.png", bytes);
    await page
      .getByRole("option", { name: "自动.png", exact: true })
      .first()
      .dblclick();
    await page.getByRole("button", { name: "知道了，放进去" }).click();
    await page.locator('[data-tab="explorer"]').click();
    await page
      .getByRole("option", { name: "自动.png", exact: true })
      .first()
      .click();
    const place = page.getByRole("region", { name: "存放位置" });
    await expect(place).toContainText("GitHub 大文件存储 · user-", {
      timeout: 180_000,
    });
    const stored = (await (
      await request.get(`${GITHUB}/_fake/lfs?repo=${repo}`)
    ).json()) as Record<string, { size: number; same: boolean }>;
    expect(stored[oid]).toEqual({ size: bytes.length, same: true });

    // Only this computer from now on: what comes next stays here, what is there stays there.
    const choice = await properties();
    await expect(choice).toHaveValue("lfs");
    await choice.selectOption("local");
    await page.keyboard.press("Escape");
    await importPicture("本机.png", picture(4));
    await page.locator('[data-tab="explorer"]').click();
    await page
      .getByRole("option", { name: "本机.png", exact: true })
      .first()
      .click();
    await page.waitForTimeout(3000);
    await expect(place).toContainText("只在这个浏览器里");
    await page
      .getByRole("option", { name: "自动.png", exact: true })
      .first()
      .click();
    await expect(place).toContainText("GitHub 大文件存储 · user-");
    expect(
      Object.keys(
        (await (
          await request.get(`${GITHUB}/_fake/lfs?repo=${repo}`)
        ).json()) as object,
      ),
    ).toEqual([oid]);

    // Another computer: the file comes by itself, the very one, and the default is the same.
    const other = await anotherComputer(browser, user);
    try {
      const b = await other.newPage();
      await b.goto("/");
      await entrySignIn(b).click();
      await expect(
        b
          .locator("header")
          .getByRole("button", { name: `账号：${user.login}` }),
      ).toBeVisible();
      await openCard(b, "测试项目");
      await expect(tab(b, "preview")).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(() => keptHashes(b, bytes.length), { timeout: 180_000 })
        .toEqual([oid]);
      await b
        .locator("header")
        .getByRole("button", { name: "文件", exact: true })
        .click();
      await b
        .getByRole("menu")
        .getByRole("menuitem", { name: "项目属性…", exact: true })
        .click();
      await b
        .getByTestId("project-properties")
        .getByRole("navigation", { name: "项目属性的分组" })
        .getByRole("button", { name: "存放和同步" })
        .click();
      await expect(
        b
          .getByTestId("project-properties")
          .getByRole("combobox", { name: "默认存储空间" }),
      ).toHaveValue("local");
      await b.screenshot({ path: `${SHOTS}/default-elsewhere.png` });
    } finally {
      await other.close();
    }
  });
});
