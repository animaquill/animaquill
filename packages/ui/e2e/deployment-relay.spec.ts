import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { leaveSettings, noAutoTitle, openSettingsPage, settingsOf } from "./ai-support.ts";
import { content, expect, tab, test } from "./support.ts";
import { createOnline, entrySignIn } from "./online-support.ts";

/**
 * The relay of AI services, on the real sites through the gateway: a service that does not let a
 * page read its answers (no CORS), reached through the platform, with the answer streaming in and
 * stopping that reaches the service at once. The service is pretend (oss/packages/server/src/test/fake-llm.ts) and
 * speaks like an OpenAI-compatible one, at an address of the internet on the loopback in here,
 * where the API finds it by its name and the browser too. See scripts/e2e-edge and run.sh.
 */

const EDITOR = "https://app.animaquill.com";
const GITHUB = "http://127.0.0.1:8400";
/** What the pretend service got, see oss/packages/server/src/test/fake-llm-server.ts. */
const SERVICE_STATE = "http://127.0.0.1:8401";
const SERVICE = "https://llm.example/v1";
const KEY = "sk-relay-test-0123456789abcdefSECRET";
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
  readonly cut: boolean;
  readonly closed: boolean;
}

const seenByService = async (): Promise<Seen[]> =>
  (
    (await (await fetch(`${SERVICE_STATE}/_fake/state`)).json()) as {
      seen: Seen[];
    }
  ).seen;

interface GitHubUser {
  readonly id: number;
  readonly login: string;
}

const someone = (): GitHubUser => {
  const id = randomInt(1_000_000, 2_000_000_000);
  return { id, login: `user-${id}` };
};

const signedInToGitHub = (context: BrowserContext, user: GitHubUser) =>
  context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);

const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "relay test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

const signInButton = (page: Page) => entrySignIn(page);

async function signUp(page: Page, context: BrowserContext, request: APIRequestContext) {
  const user = someone();
  // With the GitHub App on the account: a project of the platform always has a repository.
  expect((await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok()).toBe(
    true,
  );
  await signedInToGitHub(context, user);
  await signInButton(page).click();
  await expect(page).toHaveURL(`${EDITOR}/signup.html`);
  await page.getByLabel("邀请码").fill(newInvite());
  await page.getByRole("button", { name: "继续" }).click();
  await expect(
    page.locator("header").getByRole("button", { name: `账号：${user.login}` }),
  ).toBeVisible();
  await createOnline(page);
}

/** How a service is reached, as the settings show it: two buttons side by side. */
const routeOf = (service: Locator, name: "浏览器直连" | "经服务器转发") =>
  service.getByRole("group", { name: "连接" }).getByRole("button", { name });

/**
 * 月之暗面, which goes through the relay unless people say otherwise, at the pretend service's
 * address, with a key and its model as the default, as people set it up: from the cards of
 * services, added at once, then its key and address in the settings of the service.
 */
async function setUpService(page: Page, relay = true): Promise<Locator> {
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  const picker = settings.getByTestId("ai-add");
  if (!(await picker.isVisible())) await settings.getByTestId("ai-add-service").click();
  await picker.locator('[data-testid="ai-kind"][data-kind="moonshot"]').click();
  const service = settings.getByTestId("ai-service");
  await service.getByTestId("ai-key").fill(KEY);
  await service.getByTestId("ai-key").press("Enter");
  await expect(service.getByTestId("ai-key")).toHaveValue("••••••••••••CRET");
  await service.getByLabel("地址").fill(SERVICE);
  await service.getByLabel("地址").press("Enter");
  if (relay) await expect(routeOf(service, "经服务器转发")).toHaveAttribute("aria-pressed", "true");
  // The model it starts with is the default: the pretend service answers whatever is asked.
  await noAutoTitle(page);
  return service;
}

const chat = (page: Page) => content(page, "chat");

async function send(page: Page, text: string) {
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill(text);
  await box.press("Enter");
}

/** What a browser says when a page may not read an answer, which is what direct is about here. */
function expectedInConsole(problems: string[]) {
  const left = problems.filter(
    (problem) => !/Failed to load resource|blocked by CORS policy|net::ERR_FAILED/.test(problem),
  );
  problems.splice(0, problems.length, ...left);
}

test.describe("the relay of AI services", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
    await fetch(`${SERVICE_STATE}/_fake/reset`, { method: "POST" });
  });

  test.describe("signed in", () => {
    // The entry page, then the start page of the online mode: the project is made there.
    test.use({ withProject: false });

    test("a service that browsers may not read answers through the platform, as it streams, and stops there too", async ({
      page,
      context,
      request: fakeGitHub,
      problems,
    }) => {
      test.slow();
      await signUp(page, context, fakeGitHub);
      const service = await setUpService(page);

      // The models of the service, which the browser asks for without an Origin.
      await service.getByTestId("ai-fetch-models").click();
      const fetched = page.getByTestId("ai-fetch");
      await expect(fetched.getByTestId("ai-fetch-count")).toHaveText("2 个");
      // A test of the connection goes the same way as the chat.
      await service.getByRole("button", { name: "测试", exact: true }).click();
      await expect(service.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
      await expect(service.getByTestId("ai-test")).toHaveAttribute("title", /连上了/);

      await leaveSettings(page);
      await tab(page, "chat").click();
      await send(page, "你好");
      await expect(chat(page).getByText("你好，我是假的服务。")).toBeVisible();

      // The service got what it needs and nothing of this site.
      const asked = (await seenByService()).filter(
        (seen) => seen.method === "POST" && seen.body.includes("你好"),
      );
      expect(asked).toHaveLength(1);
      const [request] = asked;
      expect(request?.path).toBe("/v1/chat/completions");
      expect(request?.headers["host"]).toBe("llm.example");
      expect(request?.headers["authorization"]).toBe(`Bearer ${KEY}`);
      expect(request?.headers["user-agent"]).toBe("AnimaQuill-Relay/1");
      for (const name of ["cookie", "origin", "referer", "x-animaquill", "x-forwarded-for"])
        expect(request?.headers, name).not.toHaveProperty(name);

      // A slow answer shows as it comes, and stopping it stops the service right away.
      await send(page, "慢慢来");
      const stop = chat(page).getByRole("button", { name: "停止" });
      await expect(chat(page).getByText(/字字字/)).toBeVisible();
      await stop.click();
      await expect(chat(page).getByText(/已停止/)).toBeVisible();
      const stoppedAt = Date.now();
      await expect
        .poll(
          async () => {
            const slow = (await seenByService()).find((seen) => seen.body.includes("慢慢来"));
            return slow?.cut === true && slow.closed;
          },
          { timeout: 5000, intervals: [50] },
        )
        .toBe(true);
      expect(Date.now() - stoppedAt).toBeLessThan(3000);

      // Straight from the browser it cannot be read at all, which is why the relay is there.
      await openSettingsPage(page, "AI 模型");
      await routeOf(service, "浏览器直连").click();
      await leaveSettings(page);
      await tab(page, "chat").click();
      await send(page, "直连试试");
      const failure = chat(page).getByTestId("chat-failure").last();
      await expect(failure).toContainText("连不上服务");
      await expect(failure).toContainText("通过服务器转发");
      // Whatever got there came from the browser, not through the platform. (Playwright answers the
      // question a browser asks before such a request itself, so here the request does get there; a
      // browser of people's would not even send it. Either way the page cannot read the answer.)
      const direct = (await seenByService()).filter((seen) => seen.body.includes("直连试试"));
      for (const seen of direct) {
        expect(seen.headers["origin"]).toBe(EDITOR);
        expect(seen.headers["user-agent"]).not.toBe("AnimaQuill-Relay/1");
      }
      expectedInConsole(problems);

      // Nothing of what went through is in the platform's log, nor where it went.
      const log = readFileSync("/tmp/api.log", "utf8");
      for (const secret of [
        KEY,
        "慢慢来",
        "你好",
        "直连试试",
        "llm.example",
        "/v1/chat/completions",
      ])
        expect(log, secret).not.toContain(secret);
    });

    test("a key in a header of people's own goes through the relay in that header, and only there", async ({
      page,
      context,
      request: fakeGitHub,
      problems,
    }) => {
      test.slow();
      await signUp(page, context, fakeGitHub);
      await openSettingsPage(page, "AI 模型");
      const settings = settingsOf(page);
      const picker = settings.getByTestId("ai-add");
      if (!(await picker.isVisible())) await settings.getByTestId("ai-add-service").click();
      await picker.locator('[data-testid="ai-kind"][data-kind="openai-compatible"]').click();
      const service = settings.getByTestId("ai-service");
      await service.getByLabel("地址").fill(SERVICE);
      await service.getByLabel("地址").press("Enter");
      // No header of its own for the key: the key goes in the headers, as pi-web has it.
      await expect(service.getByLabel("Key 用哪个请求头")).toHaveCount(0);
      // Straight from the browser the pretend service cannot be read: relayed instead.
      await routeOf(service, "经服务器转发").click();
      await expect(routeOf(service, "经服务器转发")).toHaveAttribute("aria-pressed", "true");
      const headers = service.getByTestId("ai-headers");
      await headers.getByRole("button", { name: "添加请求头" }).click();
      for (const [header, sent] of [
        ["Authorization", `Bearer ${KEY}`],
        ["api-key", KEY],
      ] as const) {
        await fetch(`${SERVICE_STATE}/_fake/reset`, { method: "POST" });
        await headers.getByRole("textbox", { name: "名字" }).fill(header);
        const value = headers.getByRole("textbox", { name: "值" });
        await value.fill(sent);
        await value.press("Enter");
        await service.getByRole("button", { name: "测试", exact: true }).click();
        // The pretend service takes a key only as a Bearer: in another header it says no.
        if (header === "Authorization")
          await expect(service.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
        else await expect(service.getByTestId("ai-test")).toContainText("key 不对");
        const [request] = await seenByService();
        expect(request?.headers[header.toLowerCase()], header).toBe(sent);
        if (header !== "Authorization") expect(request?.headers["authorization"]).toBeUndefined();
        expect(JSON.stringify(request?.headers)).not.toContain("none");
      }
      // Neither the header nor the address is in what the platform keeps in the clear.
      const kept = await page.evaluate(async () => {
        const response = await fetch("/api/me/ai-settings", {
          cache: "no-store",
        });
        return (await response.json()) as { entries: unknown };
      });
      expect(JSON.stringify(kept.entries)).not.toContain(KEY);
      expect(JSON.stringify(kept.entries)).not.toContain(new URL(SERVICE).host);
      expectedInConsole(problems);
    });
  });

  test("in the offline mode the relay is not there: it is grey, and asks people to sign in", async ({
    page,
    problems,
  }) => {
    // The offline mode asks nothing of the platform, so nothing goes through it.
    const service = await setUpService(page, false);
    await expect(routeOf(service, "浏览器直连")).toHaveAttribute("aria-pressed", "true");
    const relay = routeOf(service, "经服务器转发");
    await expect(relay).toHaveAttribute("aria-disabled", "true");
    await expect(relay).toHaveAttribute("title", "登录后可用");
    // Grey as what cannot be used now, and still something to press.
    await relay.click({ force: true });
    await expect(page.getByRole("dialog", { name: "这需要登录" })).toBeVisible();
    expect(await seenByService()).toEqual([]);
    expectedInConsole(problems);
  });
});
