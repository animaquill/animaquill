import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomInt } from "node:crypto";
import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import {
  addAnthropic,
  ANTHROPIC,
  anthropicSays,
  closeSettings,
  goToSettingsGroup,
  leaveSettings,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { cardMenu, projectCard, showView, sidebar } from "./start-support.ts";
import { content, editorReady, expect, tab, test } from "./support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * What of the online mode the backend has, and nothing else (docs/design/online-offline.md, 2.1 and
 * O2 of 8), on the real sites through the gateway, with the API, its database and a fake GitHub
 * (scripts/e2e-edge):
 *
 * - The AI settings and keys: set up in one browser, another has them; the keys are on the backend
 *   and in the memory of the page only, in none of the browser's storage.
 * - While the backend cannot be reached: the settings as last read, read-only, "连上以后才能改";
 *   the assistant goes on with the key the page has; a page that starts then has no key, and says so.
 * - Stars, groups and when projects were last opened: two browsers changing them at once both keep
 *   theirs, and each shows the other's as it looks again; offline, nothing changes.
 * - "清掉这台电脑上的数据", and the account's group of the settings in the offline mode, grey.
 */

const GITHUB = "http://127.0.0.1:8400";
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
/** Where the screenshots for people to look at go, besides the test's own output. */
const SHOTS = "/work/oss/packages/ui/test-results/o2-shots";

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
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "online data test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

/** This container has no network but the computer's own: the page says it is on one, unless told. */
const ON_A_NETWORK = () => {
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => (window as { aqOffline?: boolean }).aqOffline !== true,
    configurable: true,
  });
};

/** Projects of the online mode open without a folder. */
const NO_FOLDERS = () => {
  delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
};

const accountMenu = (page: Page, user: GitHubUser) =>
  page.locator("header").getByRole("button", { name: `账号：${user.login}` });

const shot = async (page: Page, name: string, what = page.locator("body")) => {
  await what.screenshot({ path: test.info().outputPath(`${name}.png`) });
  mkdirSync(SHOTS, { recursive: true });
  await what.screenshot({ path: `${SHOTS}/${name}.png` });
};

const api = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return (await response.json()) as any;
  }, path);

async function browserOf(browser: Browser, user: GitHubUser, colorScheme?: "dark" | "light") {
  const context: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 820 },
    ...(colorScheme && { colorScheme }),
  });
  await context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);
  const page = await context.newPage();
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.addInitScript(ON_A_NETWORK);
  await page.addInitScript(NO_FOLDERS);
  await page.goto("/");
  await editorReady(page);
  return { context, page, problems };
}

async function signIn(page: Page, user: GitHubUser, invite?: string) {
  await leaveSettings(page);
  await entrySignIn(page).click();
  if (invite !== undefined) {
    await page.getByLabel("邀请码").fill(invite);
    await page.getByRole("button", { name: "继续" }).click();
  }
  await expect(accountMenu(page, user)).toBeVisible();
}

/** A new project of the online mode, open. */
async function newProject(page: Page, name: string) {
  await page.getByRole("button", { name: "新建项目" }).first().click();
  const making = page.locator("dialog[data-create-phase]");
  await making.getByRole("textbox", { name: "项目名称" }).fill(name);
  await making.getByRole("button", { name: "新建", exact: true }).click();
  await expect(making).toHaveAttribute("data-create-phase", /archiving|done/, { timeout: 60_000 });
  await making.getByRole("button", { name: /^(关闭|完成)$/ }).click();
  await expect(making).toHaveCount(0);
  await expect(tab(page, "preview")).toBeVisible();
}

async function closeProject(page: Page) {
  await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "关闭项目", exact: true }).click();
  await expect(sidebar(page)).toBeVisible();
}

/** The backend cannot be reached from the page, and the browser says it is offline. */
async function goOffline(page: Page) {
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.evaluate(() => {
    (window as { aqOffline?: boolean }).aqOffline = true;
    dispatchEvent(new Event("offline"));
  });
}

async function goOnline(page: Page) {
  await page.unroute("**/api/**");
  await page.evaluate(() => {
    (window as { aqOffline?: boolean }).aqOffline = false;
    dispatchEvent(new Event("online"));
  });
}

/** The window came to the front: what changed elsewhere is read. */
const lookAgain = (page: Page) => page.evaluate(() => dispatchEvent(new Event("focus")));

/** The model answers whatever it is asked. */
const pretend = (page: Page, said = "好的。") =>
  page.route(ANTHROPIC, (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: anthropicSays(said),
    }),
  );

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });

/**
 * Everything this browser keeps for the site, as text: every value of every store of every
 * database (bytes and files read as text too), the local and the session storage, and the caches.
 */
const everythingKept = (page: Page) =>
  page.evaluate(async () => {
    const texts: string[] = [];
    const blobs: Blob[] = [];
    const asText = (value: unknown) =>
      JSON.stringify(value, (_key, each: unknown) => {
        if (each instanceof Blob) {
          blobs.push(each);
          return "[blob]";
        }
        if (each instanceof ArrayBuffer) return new TextDecoder().decode(each);
        if (ArrayBuffer.isView(each))
          return new TextDecoder().decode(
            new Uint8Array(each.buffer, each.byteOffset, each.byteLength),
          );
        return each;
      });
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const store of [...database.objectStoreNames]) {
        const all = await new Promise<unknown[]>((resolve) => {
          const request = database.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve([]);
        });
        for (const value of all) texts.push(asText(value));
      }
      database.close();
    }
    for (const blob of blobs) texts.push(await blob.text());
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? "";
        texts.push(key, storage.getItem(key) ?? "");
      }
    }
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys())
        texts.push(request.url, (await (await cache.match(request))?.text()) ?? "");
    }
    return texts.join("\n");
  });

test.describe.configure({ mode: "serial" });

test.describe("the AI settings and keys of the online mode are the backend's", () => {
  test.use({ withProject: false });

  test("set up in one browser, another has them; the key is in none of the browser's storage", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    const user = someone();
    expect((await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok()).toBe(
      true,
    );
    const KEY = "sk-ant-o2-only-on-the-backend-K3Y9";
    const one = await browserOf(browser, user);
    await signIn(one.page, user, newInvite());
    await newProject(one.page, "设置的项目");
    await addAnthropic(one.page, KEY, "claude-test");
    // On the backend, sealed there and opened for the person.
    await expect
      .poll(async () => JSON.stringify((await api(one.page, "/api/me/ai-settings")).keys), {
        timeout: 30_000,
      })
      .toContain(KEY);
    // A conversation, which the backend has too.
    await pretend(one.page);
    await leaveSettings(one.page);
    await tab(one.page, "chat").click();
    await box(one.page).pressSequentially("你好");
    await box(one.page).press("Enter");
    await expect(chat(one.page).getByTestId("chat-answer")).toHaveText("好的。", {
      timeout: 30_000,
    });
    const projects = (await api(one.page, "/api/projects")).projects as { id: string }[];
    await expect
      .poll(async () => (await api(one.page, `/api/me/chats?project=${projects[0]?.id}`)).chats, {
        timeout: 30_000,
      })
      .toHaveLength(1);
    // Nothing of the key in the browser, whatever kept what.
    const kept = await everythingKept(one.page);
    expect(kept).not.toContain(KEY);
    expect(kept).not.toContain(KEY.slice(-12));
    // Nor the conversation: it is on the backend.
    expect(kept).not.toContain("你好");

    // Another browser of the person: the service with its key, and the conversation.
    const two = await browserOf(browser, user);
    await signIn(two.page, user);
    await openSettingsPage(two.page, "AI 模型");
    const service = settingsOf(two.page).getByTestId("ai-service");
    await expect(service.getByTestId("ai-key")).toHaveValue(`••••••••••••${KEY.slice(-4)}`, {
      timeout: 30_000,
    });
    expect(await everythingKept(two.page)).not.toContain(KEY);
    // A setting changed there is here as soon as this window comes to the front.
    await goToSettingsGroup(two.page, "AI 聊天");
    const ask = settingsOf(two.page).getByRole("switch", { name: "AI 改项目前先问我" });
    await expect(ask).not.toBeChecked();
    await ask.click();
    await expect(ask).toBeChecked();
    await expect
      .poll(
        async () =>
          (await api(two.page, "/api/me/ai-settings")).entries["field:askBeforeEdit"]?.value,
        { timeout: 30_000 },
      )
      .toBe(true);
    await lookAgain(one.page);
    await openSettingsPage(one.page, "AI 聊天");
    await expect(
      settingsOf(one.page).getByRole("switch", { name: "AI 改项目前先问我" }),
    ).toBeChecked({ timeout: 30_000 });
    // Where each is kept, as the settings say it: the AI settings on the backend, the theme here.
    await expect(
      settingsOf(one.page).locator('[data-setting="chat.askBeforeEdit"] [data-where]'),
    ).toHaveAttribute("title", "存在服务器上");
    await goToSettingsGroup(one.page, "常规");
    await expect(
      settingsOf(one.page).locator('[data-setting="general.theme"] [data-where]'),
    ).toHaveAttribute("title", "只在这台设备");
    // The account says what the backend has, as it is.
    await goToSettingsGroup(one.page, "账号");
    await expect(settingsOf(one.page).locator('[data-setting="account.server"]')).toContainText(
      "key 加密保存，平台能解开它",
    );
    expect(one.problems).toEqual([]);
    expect(two.problems).toEqual([]);
    await two.context.close();
    await one.context.close();
  });

  test("offline: read-only as last read; the assistant goes on; a page started then has no key", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    const user = someone();
    expect((await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok()).toBe(
      true,
    );
    const one = await browserOf(browser, user);
    await signIn(one.page, user, newInvite());
    await newProject(one.page, "断网的项目");
    await addAnthropic(one.page, "sk-ant-o2-offline-KEY7", "claude-test");
    await expect
      .poll(async () => JSON.stringify((await api(one.page, "/api/me/ai-settings")).keys), {
        timeout: 30_000,
      })
      .toContain("KEY7");
    await pretend(one.page);
    await leaveSettings(one.page);
    // All of it on the backend, the last setting too, before the network goes.
    await expect
      .poll(
        async () => (await api(one.page, "/api/me/ai-settings")).entries["field:autoTitle"]?.value,
        { timeout: 30_000 },
      )
      .toBe(false);

    await goOffline(one.page);
    // The settings: as last read, nothing can change, and they say why.
    await openSettingsPage(one.page, "AI 聊天");
    await expect(settingsOf(one.page).getByTestId("ai-held")).toHaveText(
      "连不上服务器，现在只能看，连上以后才能改。",
    );
    const ask = settingsOf(one.page).getByRole("switch", { name: "AI 改项目前先问我" });
    await expect(ask).toBeDisabled();
    await expect(ask).not.toBeChecked();
    await shot(one.page, "offline-settings-readonly");
    await goToSettingsGroup(one.page, "AI 模型");
    await expect(settingsOf(one.page).getByTestId("ai-held")).toHaveText(
      "连不上服务器，现在只能看，连上以后才能改。",
    );
    await expect(settingsOf(one.page).getByTestId("ai-held").getByRole("button")).toHaveCount(0);
    await shot(one.page, "offline-models-readonly");
    // The packs too: grey, with the same line.
    await goToSettingsGroup(one.page, "模型适配包");
    await expect(settingsOf(one.page).getByTestId("ai-held")).toHaveText(
      "连不上服务器，现在只能看，连上以后才能改。",
    );
    await expect(settingsOf(one.page).getByTestId("pack-add")).toBeDisabled();
    await shot(one.page, "offline-packs-readonly");
    await closeSettings(one.page);
    // The assistant goes on with the key this page has.
    await tab(one.page, "chat").click();
    await box(one.page).pressSequentially("断网了还能说话吗");
    await box(one.page).press("Enter");
    await expect(chat(one.page).getByTestId("chat-answer")).toHaveText("好的。", {
      timeout: 30_000,
    });
    await expect(chat(one.page).getByTestId("chat-keys-away")).toHaveCount(0);

    // Started again without the backend: the settings as last read, and no key.
    await one.page.reload();
    await editorReady(one.page);
    await expect(tab(one.page, "preview")).toBeVisible({ timeout: 30_000 });
    await tab(one.page, "chat").click();
    await expect(chat(one.page).getByTestId("chat-keys-away")).toHaveText(
      "连上服务器后才能用（key 存在服务器上）。",
      { timeout: 30_000 },
    );
    // The model as the settings had it last: not "turned off".
    await expect(chat(one.page)).not.toContainText("已停用");
    await shot(one.page, "offline-reload-no-key");
    expect(await everythingKept(one.page)).not.toContain("KEY7");

    // Back: the key comes, and the settings can change again.
    await goOnline(one.page);
    await expect(chat(one.page).getByTestId("chat-keys-away")).toHaveCount(0, { timeout: 30_000 });
    await openSettingsPage(one.page, "AI 聊天");
    await expect(settingsOf(one.page).getByTestId("ai-held")).toHaveCount(0);
    await expect(
      settingsOf(one.page).getByRole("switch", { name: "AI 改项目前先问我" }),
    ).toBeEnabled();
    await one.context.close();
  });
});

test.describe("how projects are organised, on the backend", () => {
  test.use({ withProject: false });

  test("two browsers change stars and groups at once: both keep theirs, and see the other's", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    const user = someone();
    expect((await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok()).toBe(
      true,
    );
    const one = await browserOf(browser, user);
    await signIn(one.page, user, newInvite());
    await newProject(one.page, "收藏的片子");
    await closeProject(one.page);
    await newProject(one.page, "放进分组的片子");
    await closeProject(one.page);
    const two = await browserOf(browser, user);
    await signIn(two.page, user);
    await showView(two.page, "全部项目");
    await expect(projectCard(two.page, "收藏的片子")).toBeVisible({ timeout: 30_000 });
    await showView(one.page, "全部项目");

    // At the same time: a star here, a group and a project in it there.
    await Promise.all([
      projectCard(one.page, "收藏的片子").getByRole("button", { name: "收藏“收藏的片子”" }).click(),
      (async () => {
        await sidebar(two.page).getByRole("button", { name: "新建分组" }).click();
        await sidebar(two.page).getByRole("textbox", { name: "分组名称" }).fill("工作");
        await two.page.keyboard.press("Enter");
        await cardMenu(two.page, "放进分组的片子", "移到分组…");
        await two.page
          .getByRole("menu", { name: "把“放进分组的片子”移到分组" })
          .getByRole("menuitemradio", { name: "工作" })
          .click();
      })(),
    ]);
    await expect
      .poll(
        async () => {
          const { groups, marks } = await api(one.page, "/api/organizer");
          return {
            groups: (groups as { name: string }[]).map(({ name }) => name),
            starred: (marks as { star?: { starred: boolean } }[]).filter((m) => m.star?.starred)
              .length,
            grouped: (marks as { group?: { id: string | null } }[]).filter((m) => m.group?.id)
              .length,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ groups: ["工作"], starred: 1, grouped: 1 });
    // Each shows the other's as it looks again, without a reload.
    await lookAgain(one.page);
    await lookAgain(two.page);
    for (const each of [one.page, two.page]) {
      const group = sidebar(each).getByRole("button", { name: /^工作\s*\d*$/ });
      await expect(group).toHaveText("工作1", { timeout: 30_000 });
      await expect(sidebar(each).getByRole("button", { name: /^收藏/ })).toHaveText("收藏1");
    }
    await shot(two.page, "organize-two-browsers");

    // Opened in the first browser only, as each was made there: "最近打开" in the other too.
    await expect
      .poll(
        async () =>
          ((await api(two.page, "/api/organizer")).marks as { opened?: number }[]).filter(
            (m) => m.opened !== undefined,
          ).length,
        { timeout: 30_000 },
      )
      .toBe(2);
    await lookAgain(two.page);
    await showView(two.page, "最近打开");
    await expect(projectCard(two.page, "放进分组的片子")).toBeVisible({ timeout: 30_000 });
    await expect(projectCard(two.page, "收藏的片子")).toBeVisible();

    // Offline: nothing changes, and it says why.
    await goOffline(two.page);
    await showView(two.page, "全部项目");
    await projectCard(two.page, "放进分组的片子")
      .getByRole("button", { name: "收藏“放进分组的片子”" })
      .click();
    await expect(two.page.getByText("连不上服务器，现在只能看，连上以后才能改。")).toBeVisible();
    await expect(
      projectCard(two.page, "放进分组的片子").getByRole("button", {
        name: "收藏“放进分组的片子”",
      }),
    ).toBeVisible();
    // Where the mode is said: that the server cannot be reached.
    await expect(two.page.getByText("在线模式 · 连不上服务器")).toBeVisible();
    await shot(two.page, "organize-offline");
    await goOnline(two.page);
    await two.context.close();
    await one.context.close();
  });
});

test.describe("this computer", () => {
  test.use({ withProject: false });

  for (const scheme of ["dark", "light"] as const) {
    test(`clears what it keeps of the account, once it is all on the backend (${scheme})`, async ({
      browser,
      request,
    }) => {
      test.setTimeout(300_000);
      const user = someone();
      expect(
        (await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok(),
      ).toBe(true);
      const one = await browserOf(browser, user, scheme);
      await signIn(one.page, user, newInvite());
      await newProject(one.page, "清掉的项目");
      await closeProject(one.page);
      const scoped = () =>
        one.page.evaluate(async () =>
          (await indexedDB.databases())
            .map(({ name }) => name ?? "")
            .filter((name) => name.startsWith("aq-online-")),
        );
      expect(await scoped()).not.toEqual([]);
      await openSettingsPage(one.page, "存储和数据");
      const row = settingsOf(one.page).locator('[data-setting="storage.clear"]');
      await shot(one.page, `clear-row-${scheme}`);
      await row.getByRole("button", { name: "清掉这台电脑上的数据…" }).click();
      const asked = one.page.getByRole("dialog", { name: "清掉这台电脑上的数据？" });
      await expect(asked).toContainText("服务器上的项目、设置和对话不受影响");
      await shot(one.page, `clear-confirm-${scheme}`);
      if (scheme === "light") {
        await asked.getByRole("button", { name: "取消" }).click();
        await one.context.close();
        return;
      }
      // The page loads again for it.
      await Promise.all([
        one.page.waitForEvent("load"),
        asked.getByRole("button", { name: "清掉", exact: true }).click(),
      ]);
      await editorReady(one.page);
      await expect(accountMenu(one.page, user)).toBeVisible({ timeout: 30_000 });
      // The project is on the backend, as ever, and this computer has nothing of it.
      await showView(one.page, "全部项目");
      await expect(projectCard(one.page, "清掉的项目")).toBeVisible({ timeout: 30_000 });
      // No copy of it here: no link to it, nothing in the log.
      const copies = await one.page.evaluate(async () => {
        const named = (await indexedDB.databases())
          .map(({ name }) => name ?? "")
          .find((name) => /^aq-online-.*-animaquill-cloud$/.test(name));
        if (!named) return 0;
        return new Promise<number>((resolve) => {
          const request = indexedDB.open(named);
          request.addEventListener("success", () => {
            const database = request.result;
            if (!database.objectStoreNames.contains("links")) return resolve(0);
            const counted = database.transaction("links").objectStore("links").count();
            counted.addEventListener("success", () => resolve(counted.result));
          });
          request.addEventListener("error", () => resolve(-1));
        });
      });
      expect(copies).toBe(0);
      await one.context.close();
    });
  }

  for (const scheme of ["dark", "light"] as const) {
    test(`offline, the account's group of the settings is grey, and asks to sign in (${scheme})`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 820 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await page.goto("/offline");
      await editorReady(page);
      await page.locator("header").getByRole("button", { name: "设置", exact: true }).click();
      const nav = settingsOf(page).getByRole("navigation", { name: "设置分组" });
      const account = nav.getByRole("button", { name: "账号" });
      await expect(account).toHaveAttribute("data-needs-online", "");
      await expect(account).toHaveAttribute("title", "登录后可用");
      await account.hover();
      await shot(page, `offline-account-grey-${scheme}`);
      await account.click({ force: true });
      const asked = page.getByRole("dialog", { name: "这需要登录" });
      await expect(asked).toContainText("“账号”要登录后才能用");
      await expect(asked.getByRole("button", { name: "登录" })).toBeVisible();
      // Not found by searching either: it cannot be opened.
      await asked.getByRole("button", { name: "取消" }).click();
      await expect(asked).toBeHidden();
      if (!(await settingsOf(page).isVisible()))
        await page.locator("header").getByRole("button", { name: "设置", exact: true }).click();
      await settingsOf(page).getByRole("searchbox", { name: "搜索设置" }).fill("额度");
      await expect(settingsOf(page).getByTestId("settings-result")).toHaveCount(0);
      await context.close();
    });
  }
});
