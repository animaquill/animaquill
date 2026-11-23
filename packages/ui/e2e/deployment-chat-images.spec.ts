import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomInt } from "node:crypto";
import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import {
  addAnthropic,
  ANTHROPIC,
  anthropicSays,
  leaveSettings,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { openCard } from "./start-support.ts";
import { content, editorReady, expect, tab, test } from "./support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * The pictures of conversations of projects of the platform (docs/design/settings-and-properties.md
 * 10.3, “在线项目的对话里的图片”), on the real sites through the gateway, with the object storage
 * next to them (scripts/e2e-edge): a frame sent in one browser is in the other one's conversation,
 * read from the storage, and goes to the model again from there; one beyond the person's room stays
 * in its browser, and its message says so; the page of the cloud features says how much the
 * pictures take, by conversation.
 */

const GITHUB = "http://127.0.0.1:8400";
const GATEWAY_CA = "/tmp/caddy-gateway/pki/authorities/local/root.crt";
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
/** Where the screenshots for people to look at go, besides the test's own output. */
const SHOTS = "/work/oss/packages/ui/test-results/sc2-shots";

interface GitHubUser {
  readonly id: number;
  readonly login: string;
}

const someone = (): GitHubUser => {
  const id = randomInt(1_000_000, 2_000_000_000);
  return { id, login: `user-${id}` };
};

const command = (...args: string[]) =>
  execFileSync("node", ["/work/apps/api/src/admin.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: GATEWAY_CA },
  });

const newInvite = () => {
  const code = /邀请码：(\S+)/.exec(command("invite", "create", "--note", "chat images"))?.[1];
  if (!code) throw new Error("no invite code");
  return code;
};

const ON_A_NETWORK = () => {
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => true,
    configurable: true,
  });
};

/** Only projects of the platform: they open without a folder. */
const NO_FOLDERS = () => {
  delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
};

const shot = async (page: Page, name: string, what = page.locator("body")) => {
  await what.screenshot({ path: test.info().outputPath(`${name}.png`) });
  mkdirSync(SHOTS, { recursive: true });
  await what.screenshot({ path: `${SHOTS}/${name}.png` });
};

const api = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return { status: response.status, json: (await response.json().catch(() => undefined)) as any };
  }, path);

async function browserOf(browser: Browser, user: GitHubUser) {
  const context: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 820 },
  });
  await context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);
  const page = await context.newPage();
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  await page.addInitScript(ON_A_NETWORK);
  await page.addInitScript(NO_FOLDERS);
  await page.goto("/");
  await editorReady(page);
  return { context, page };
}

async function signIn(page: Page, user: GitHubUser, invite?: string) {
  await leaveSettings(page);
  await entrySignIn(page).click();
  if (invite !== undefined) {
    await page.getByLabel("邀请码").fill(invite);
    await page.getByRole("button", { name: "继续" }).click();
  }
  await expect(
    page.locator("header").getByRole("button", { name: `账号：${user.login}` }),
  ).toBeVisible();
}

async function newCloudProject(page: Page, name: string) {
  await page.getByRole("button", { name: "新建项目" }).first().click();
  const making = page.locator("dialog[data-create-phase]");
  await making.getByRole("textbox", { name: "项目名称" }).fill(name);
  await making.getByRole("button", { name: "新建", exact: true }).click();
  await expect(making).toHaveAttribute("data-create-phase", /archiving|done/, { timeout: 60_000 });
  await making.getByRole("button", { name: /^(关闭|完成)$/ }).click();
  await expect(tab(page, "preview")).toBeVisible();
}

/** The model answers, and what the editor sent it is kept, newest last. */
async function pretend(page: Page, said = "好的。") {
  const sent: any[] = [];
  await page.route(ANTHROPIC, (route: Route) => {
    if (route.request().method() === "POST") sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: anthropicSays(said),
    });
  });
  return sent;
}

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });

/** Pictures of what the editor last sent the model, in the messages of people. */
const picturesSent = (body: any) =>
  (body.messages as any[])
    .filter((message) => message.role === "user" && Array.isArray(message.content))
    .flatMap((message) => message.content as any[])
    .filter((part) => part.type === "image");

const projectOf = async (page: Page, name: string) => {
  const { json } = await api(page, "/api/projects");
  return (json.projects as { id: string; name: string }[]).find((each) => each.name === name)!;
};

test.describe.configure({ mode: "serial" });

test.describe("pictures of conversations of the platform", () => {
  test.beforeAll(() => {
    // Made ready as on the server: the bucket and the rules for the editor's site.
    command("storage", "setup");
  });
  test.afterAll(() => {
    command("chat-images", "limit", "500");
  });

  test("a frame sent in one browser: the other one shows it, from the storage, and sends it on", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    command("chat-images", "limit", "500");
    const user = someone();
    expect((await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok()).toBe(
      true,
    );
    const one = await browserOf(browser, user);
    await signIn(one.page, user, newInvite());
    await newCloudProject(one.page, "图片的项目");
    await addAnthropic(one.page, "sk-ant-account-key-CCCC", "claude-test");
    await pretend(one.page);
    await leaveSettings(one.page);
    await tab(one.page, "chat").click();
    await box(one.page).click();
    await one.page.keyboard.press("Alt+s");
    await expect(chat(one.page).getByTestId("chat-picture")).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 60_000 },
    );
    await box(one.page).pressSequentially("看看这一帧");
    await box(one.page).press("Enter");
    await expect(chat(one.page).getByTestId("chat-answer")).toHaveText("好的。", {
      timeout: 30_000,
    });

    // On the platform: the conversation names the picture, which is in the storage.
    const project = await projectOf(one.page, "图片的项目");
    let hash = "";
    await expect
      .poll(
        async () => {
          const list = await api(one.page, `/api/me/chats?project=${project.id}`);
          const id = list.json?.chats?.[0]?.summary?.id;
          if (!id) return undefined;
          const read = await api(one.page, `/api/me/chats/${project.id}/${id}`);
          const image = read.json?.chat?.entries?.find((entry: any) => entry.images)?.images?.[0];
          hash = String(image?.image ?? "").replace("sha256:", "");
          return image && { held: image.held, type: image.type };
        },
        { timeout: 30_000 },
      )
      .toEqual({ held: undefined, type: "image/jpeg" });
    const there = await api(one.page, `/api/me/chat-images/${hash}`);
    expect(there.status).toBe(200);
    expect(new URL(there.json.url).origin).toBe("https://objects.animaquill.dev");
    // Nothing of the picture itself in the conversation.
    const body = JSON.stringify((await api(one.page, `/api/me/chats?project=${project.id}`)).json);
    expect(body).not.toContain("blob:");
    expect(body).not.toContain("base64");

    // Another browser of the same person: the conversation, with the picture.
    const other = await browserOf(browser, user);
    await signIn(other.page, user);
    await openCard(other.page, "图片的项目");
    await expect(other.page).toHaveTitle("图片的项目 - AnimaQuill", { timeout: 60_000 });
    const sent = await pretend(other.page, "看到了。");
    await tab(other.page, "chat").click();
    await expect(async () => {
      if ((await chat(other.page).getByTestId("chat-sent-picture").count()) > 0) return;
      await chat(other.page).getByTestId("chat-title").click();
      await chat(other.page)
        .getByTestId("chat-list")
        .getByTestId("chat-conversation")
        .first()
        .click();
      await expect(chat(other.page).getByTestId("chat-sent-picture")).toHaveCount(1, {
        timeout: 2000,
      });
    }).toPass({ timeout: 60_000 });
    const picture = chat(other.page).getByTestId("chat-sent-picture");
    await expect(picture).toHaveAttribute("data-state", "shown", { timeout: 30_000 });
    // Shown from this browser: a blob: address, which the policy of the page allows as it is.
    expect(await picture.locator("img").getAttribute("src")).toMatch(
      /^blob:https:\/\/app\.animaquill\.com\//,
    );
    await shot(other.page, "SC2-other-browser", chat(other.page));
    // And it goes to the model from here, as it is.
    await box(other.page).pressSequentially("接着看这张");
    await box(other.page).press("Enter");
    await expect(chat(other.page).getByText("看到了。")).toBeVisible({ timeout: 30_000 });
    const images = picturesSent(sent.at(-1));
    expect(images).toHaveLength(1);
    expect(images[0].source.media_type).toBe("image/jpeg");
    const bytes = Buffer.from(images[0].source.data, "base64");
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    await other.context.close();
    await one.context.close();
  });

  test("beyond the person's room: the picture stays in its browser, and the message says so", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    // 1 MB for everyone, for a while: a picture of about 2 MB has no room. The API reads it again
    // within 10 seconds.
    command("chat-images", "limit", "1");
    const user = someone();
    expect((await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok()).toBe(
      true,
    );
    const one = await browserOf(browser, user);
    await signIn(one.page, user, newInvite());
    await newCloudProject(one.page, "满了的项目");
    await addAnthropic(one.page, "sk-ant-account-key-DDDD", "claude-test");
    await pretend(one.page);
    await leaveSettings(one.page);
    await one.page.waitForTimeout(11_000);
    await tab(one.page, "chat").click();
    // A picture of noise, which no JPEG makes small: about 2 MB once it fits.
    await box(one.page).evaluate(async (element) => {
      const side = 2048;
      const canvas = new OffscreenCanvas(side, side);
      const context = canvas.getContext("2d")!;
      const data = context.createImageData(side, side);
      for (let at = 0; at < data.data.length; at += 65536)
        crypto.getRandomValues(data.data.subarray(at, Math.min(at + 65536, data.data.length)));
      for (let at = 3; at < data.data.length; at += 4) data.data[at] = 255;
      context.putImageData(data, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "噪点.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    });
    await expect(chat(one.page).getByTestId("chat-picture")).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 60_000 },
    );
    await box(one.page).pressSequentially("这张噪点图");
    await box(one.page).press("Enter");
    await expect(chat(one.page).getByTestId("chat-answer")).toHaveText("好的。", {
      timeout: 30_000,
    });
    const held = chat(one.page).getByTestId("chat-picture-held");
    await expect(held).toHaveText("这张图只在这台设备上（对话图片的空间满了）", {
      timeout: 30_000,
    });
    await expect(chat(one.page).getByTestId("chat-sent-picture")).toHaveAttribute(
      "data-state",
      "shown",
    );
    await shot(one.page, "SC2-full", chat(one.page));
    // The conversation went, and says the picture stayed; the platform has none of it.
    const project = await projectOf(one.page, "满了的项目");
    await expect
      .poll(
        async () => {
          const list = await api(one.page, `/api/me/chats?project=${project.id}`);
          const id = list.json?.chats?.[0]?.summary?.id;
          if (!id) return undefined;
          const read = await api(one.page, `/api/me/chats/${project.id}/${id}`);
          return read.json?.chat?.entries?.find((entry: any) => entry.images)?.images?.[0]?.held;
        },
        { timeout: 30_000 },
      )
      .toBe("full");
    expect((await api(one.page, "/api/me/chat-images")).json).toMatchObject({
      used: 0,
      limit: 1024 ** 2,
      chats: [],
    });

    // The page of the account: how much the pictures take, and which conversations.
    command("chat-images", "limit", "500");
    await one.page.waitForTimeout(11_000);
    await box(one.page).pressSequentially("再来一帧");
    await one.page.keyboard.press("Alt+s");
    await expect(chat(one.page).getByTestId("chat-picture")).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 60_000 },
    );
    await box(one.page).press("Enter");
    await expect(chat(one.page).getByTestId("chat-answer")).toHaveCount(2, { timeout: 30_000 });
    await expect
      .poll(async () => (await api(one.page, "/api/me/chat-images")).json?.chats?.length, {
        timeout: 30_000,
      })
      .toBe(1);
    await openSettingsPage(one.page, "账号");
    const usage = settingsOf(one.page).getByTestId("chat-images-usage");
    await expect(usage).toContainText(/^对话里的图片 .+ \/ 500 MB/, { timeout: 30_000 });
    await settingsOf(one.page).getByTestId("chat-images-manage").click();
    const rows = settingsOf(one.page).getByTestId("chat-images-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(/满了的项目 · \d+ 张 · /);
    await shot(
      one.page,
      "SC2-cloud-sync",
      settingsOf(one.page).locator('[data-setting="account.chatImages"]'),
    );
    // Taken away from there: the conversation goes, on the platform and here.
    await rows.first().getByRole("button", { name: "删掉这个对话（连同图片）" }).click();
    await one.page
      .getByRole("dialog")
      .filter({ hasText: "这个对话会连同它的图片从服务器和你所有设备上删掉" })
      .getByRole("button", { name: "删掉这个对话", exact: true })
      .click();
    await expect(rows).toHaveCount(0, { timeout: 30_000 });
    expect((await api(one.page, `/api/me/chats?project=${project.id}`)).json.chats).toEqual([]);
    await one.context.close();
  });
});
