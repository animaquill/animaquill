import type { RepositoryStatus } from "@animaquill/host";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import { cloudPanel, panelInputOf, type CloudPanel, type PanelInput } from "./panel.ts";
import type { CloudProjectsSnapshot } from "./projects.ts";
import type { RepositoryWatchSnapshot } from "./repository-watch.ts";
import type { CloudSnapshot } from "./session.ts";

/** The status of the platform in a project, and the panel it opens: the design of the start page, 4. */

const i18n = createInstance();
await i18n.init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
});
const t = i18n.t;

/** 2026-11-10 14:08 where the tests run. */
const NOW = new Date(2026, 10, 10, 14, 8, 0).getTime();
const MINUTE = 60_000;
const AT_1405 = new Date(2026, 10, 10, 14, 5, 0).getTime();

const sync = (more: Partial<CloudSnapshot> = {}): CloudSnapshot => ({
  state: "online",
  problem: undefined,
  here: true,
  syncedAt: NOW - 1000,
  pending: 0,
  retryAt: undefined,
  seq: 9,
  ...more,
});

const REPOSITORY: NonNullable<RepositoryStatus["repository"]> = {
  id: 7,
  owner: "ada",
  name: "atom",
  fullName: "ada/atom",
  private: true,
  branch: "main",
  url: "https://github.com/ada/atom",
  createdHere: true,
  linkedAt: 1,
};
const LAST = { sha: "a", seq: 9, kind: "auto", changed: 1, removed: 0, url: "", at: AT_1405 };

const status = (more: Partial<RepositoryStatus> = {}): RepositoryStatus => ({
  repository: REPOSITORY,
  state: "ready",
  archiving: false,
  lastArchive: LAST,
  head: 9,
  archivedSeq: 9,
  ...more,
});

const watch = (
  said: RepositoryStatus | undefined = status(),
  more: Partial<RepositoryWatchSnapshot> = {},
): RepositoryWatchSnapshot => ({
  status: said,
  checkedAt: NOW,
  trouble: undefined,
  hurrying: false,
  archiveAt: undefined,
  ...more,
});

/** The platform said nothing about the repository yet. */
const silent = (more: Partial<RepositoryWatchSnapshot> = {}): RepositoryWatchSnapshot => ({
  ...watch(),
  status: undefined,
  ...more,
});

const linked = (more: Partial<PanelInput> = {}): PanelInput => ({
  kind: "linked",
  local: "folder",
  sync: sync(),
  archive: watch(),
  name: "原子是什么",
  canMoveToFolder: true,
  now: NOW,
  ...more,
});

/** The panel as people read it: each row, what is below it, and its buttons. */
const read = (panel: CloudPanel) => ({
  bar: panel.bar,
  level: panel.level,
  rows: panel.rows.map((row) =>
    [
      `${row.label}  ${row.text}`,
      ...row.notes.map((note) => `· ${note}`),
      ...(row.link ? [`<${row.link.label}>`] : []),
      ...row.actions.map(({ label, enabled }) => (enabled ? `[${label}]` : `[${label}，不能点]`)),
    ].join(" "),
  ),
  actions: panel.actions.map(({ label }) => `[${label}]`),
});
const ids = (panel: CloudPanel) => ({
  rows: Object.fromEntries(panel.rows.map((row) => [row.id, row.actions.map(({ id }) => id)])),
  bottom: panel.actions.map(({ id }) => id),
});

describe("the status of the platform in a project", () => {
  it("says that a project is of this computer only, and opens the dialog that connects it", () => {
    const panel = cloudPanel(
      { kind: "none", name: "原子是什么", canMoveToFolder: true, now: NOW },
      t,
    );
    expect(panel).toMatchObject({
      level: "none",
      bar: "仅本机",
      opens: "connect",
      rows: [],
      sync: undefined,
      archive: undefined,
    });
    expect(panel.actions).toEqual([
      { id: "connect", label: "连接到云端…", enabled: true, kind: "primary" },
    ]);
  });

  it("says in one word that everything is in step, and in the panel what that means", () => {
    const panel = cloudPanel(
      linked({
        archive: watch(
          status({ head: 11, dirtySince: NOW - 2 * MINUTE, nextAt: NOW + 3 * MINUTE }),
        ),
      }),
      t,
    );
    expect(panel.title).toBe("云端 · 原子是什么");
    expect(panel.opens).toBe("panel");
    expect(read(panel)).toEqual({
      bar: "☁ 已同步",
      level: "ok",
      rows: [
        "仓库  ada/atom（私有） <在 GitHub 上打开>",
        "同步  在线，改动都已发送",
        "存档  14:05 存过。有新改动，约 3 分钟后再存 [现在存档]",
      ],
      actions: ["[换一个仓库…]", "[断开云端…]"],
    });
    expect(panel.rows[0]?.link?.url).toBe("https://github.com/ada/atom");
    expect(panel.actions.map(({ kind }) => kind)).toEqual([undefined, "danger"]);
    // What the page says about itself, for whatever reads it.
    expect(panel).toMatchObject({ sync: "online", archive: "ready" });
  });

  it("says how many changes wait while there is no network, and that they go by themselves", () => {
    const offline = cloudPanel(linked({ sync: sync({ state: "offline", pending: 3 }) }), t);
    expect(read(offline)).toMatchObject({
      bar: "☁ 离线，3 个改动待发",
      level: "busy",
    });
    expect(read(offline).rows[1]).toBe("同步  离线，3 个改动待发，联网后自动发送");
    // What did not get to the platform is not in an archive either.
    expect(read(offline).rows[2]).toBe(
      "存档  14:05 存过 · 还有改动没发到云端，发过去以后才会存。 [现在存档]",
    );
    expect(read(cloudPanel(linked({ sync: sync({ state: "offline" }) }), t))).toMatchObject({
      bar: "☁ 离线",
      level: "busy",
    });

    // A platform that cannot be reached is as good as no network.
    const retryAt = new Date(2026, 10, 10, 14, 9, 0).getTime();
    const away = cloudPanel(
      linked({ sync: sync({ state: "reconnecting", pending: 2, retryAt }) }),
      t,
    );
    expect(read(away).bar).toBe("☁ 离线，2 个改动待发");
    expect(read(away).rows[1]).toBe("同步  连不上平台，14:09 再试 · 2 个改动待发");
    expect(read(cloudPanel(linked({ sync: sync({ state: "reconnecting" }) }), t)).rows[1]).toBe(
      "同步  连不上平台，正在重试",
    );

    // On its way, with a connection.
    const sending = cloudPanel(linked({ sync: sync({ pending: 1 }) }), t);
    expect(read(sending)).toMatchObject({ bar: "☁ 正在同步，1 个改动待发", level: "busy" });
    expect(read(sending).rows[1]).toBe("同步  在线，1 个改动待发");
    const connecting = cloudPanel(linked({ sync: sync({ state: "connecting" }) }), t);
    expect(read(connecting)).toMatchObject({ bar: "☁ 正在连接", level: "busy" });
    expect(read(connecting).rows[1]).toBe("同步  正在连接…");
    // Another window of this browser does the syncing.
    expect(read(cloudPanel(linked({ sync: sync({ here: false }) }), t)).rows[1]).toBe(
      "同步  在线，改动都已发送 · 由这个浏览器的另一个窗口同步",
    );
  });

  it("says that people have to do something where syncing stopped, with what helps", () => {
    const stuck = (problem: CloudSnapshot["problem"]) =>
      cloudPanel(linked({ sync: sync({ state: "paused", problem, pending: 2 }) }), t);
    const signedOut = stuck({ kind: "signed-out" });
    expect(read(signedOut)).toMatchObject({ bar: "☁ 要处理", level: "attention" });
    expect(read(signedOut).rows[1]).toBe(
      "同步  登录已过期，登录后继续同步。改动都留在本机。 [登录]",
    );
    expect(signedOut.rows[1]).toMatchObject({ tone: "attention" });
    expect(ids(signedOut).rows["sync"]).toEqual(["signIn"]);
    expect(ids(stuck({ kind: "outdated" })).rows["sync"]).toEqual(["reload"]);
    expect(ids(stuck({ kind: "rebuilt" })).rows["sync"]).toEqual(["reload"]);
    expect(ids(stuck({ kind: "unsupported" })).rows["sync"]).toEqual([]);
    expect(ids(stuck({ kind: "unlinked" })).rows["sync"]).toEqual(["retry"]);
    // What the platform will not take stays here: the project can go on without it.
    for (const problem of [
      { kind: "rejected", reason: "quota" },
      { kind: "diverged" },
      { kind: "missing" },
    ] as const) {
      expect(ids(stuck(problem)).rows["sync"]).toEqual(["retry", "resolveStuck"]);
    }
    expect(read(stuck({ kind: "rejected", reason: "too-large" })).rows[1]).toBe(
      "同步  云端没有接受一个改动（太大），同步已暂停。改动都留在本机，可以重试，或者断开云端连接。 [重试] [处理…]",
    );
    expect(read(stuck({ kind: "rebuilt" })).rows[1]).toContain("已经从仓库重新取回");
    expect(stuck({ kind: "missing" }).sync).toBe("paused");
  });

  it("says that people have to do something where archiving paused, with what helps", () => {
    const paused = (reason: string, more: Partial<RepositoryStatus> = {}) =>
      cloudPanel(linked({ archive: watch(status({ state: "paused", reason, ...more })) }), t);
    const diverged = paused("diverged", {
      diverged: { sha: "b", files: ["code/a.js", "code/b.js"], deleted: [] },
    });
    expect(read(diverged)).toMatchObject({ bar: "☁ 要处理", level: "attention" });
    expect(read(diverged).rows[2]).toBe(
      "存档  存档先停着：GitHub 上有人改了项目的 2 个文件 · 为了不盖掉这些改动，存档先停下。可以以编辑器的内容接着存，GitHub 上的那一版会留在存档历史里；也可以换一个仓库。 [以编辑器的内容接着存…]",
    );
    expect(diverged.rows[2]).toMatchObject({ tone: "attention" });
    expect(diverged.archive).toBe("paused");
    expect(ids(diverged)).toEqual({
      rows: { repository: [], sync: [], archive: ["continueWithEditor"] },
      bottom: ["switchRepository", "disconnect"],
    });
    expect(ids(paused("gone")).rows["archive"]).toEqual(["archiveNow"]);
    expect(ids(paused("uninstalled")).rows["archive"]).toEqual(["installApp"]);
    // Another repository is all that helps: it is where it always is.
    expect(ids(paused("transferred"))).toMatchObject({
      rows: { archive: [] },
      bottom: ["switchRepository", "disconnect"],
    });
    // A reason of a newer platform still has a way on.
    expect(ids(paused("somethingNew")).rows["archive"]).toEqual(["archiveNow"]);
    expect(
      read(paused("protected", { detail: "Changes must be made through a pull request." })).rows[2],
    ).toContain("· GitHub 的原话：Changes must be made through a pull request.");
  });

  it("says how archiving goes, and lets people archive now unless one is on its way", () => {
    const row = (said: RepositoryStatus, more: Partial<RepositoryWatchSnapshot> = {}) =>
      read(cloudPanel(linked({ archive: watch(said, more) }), t)).rows[2];
    expect(row(status())).toBe("存档  14:05 存过 [现在存档]");
    expect(row(status({ lastArchive: { ...LAST, at: NOW - 20_000 } }))).toBe(
      "存档  刚刚存过 [现在存档]",
    );
    expect(row(status({ archiving: true }))).toBe("存档  14:05 存过。正在存档… [现在存档，不能点]");
    const { lastArchive: _last, ...never } = status({ archiving: true, archivedSeq: 0 });
    expect(row(never)).toBe("存档  正在存档… [现在存档，不能点]");
    const { lastArchive: _none, ...idle } = status({ archivedSeq: 9 });
    expect(row(idle)).toBe("存档  还没存过档 [现在存档]");
    expect(row(status({ head: 12, nextAt: NOW - 1 }))).toBe(
      "存档  14:05 存过。有新改动，马上存 [现在存档]",
    );
    const retryAt = new Date(2026, 10, 10, 14, 10, 0).getTime();
    expect(row(status({ failures: 2, retryAt, head: 12 }))).toBe(
      "存档  14:05 存过。上次没存成，14:10 再试 [现在存档]",
    );
    // "Archive now" was asked for too soon, and goes by itself.
    expect(row(status(), { archiveAt: NOW + 40_000 })).toBe(
      "存档  14:05 存过。1 分钟内只能存一次档，40 秒后自动存 [现在存档，不能点]",
    );
    expect(row(status({ kept: ["scenes/a/scene.json"] }))).toBe(
      "存档  14:05 存过 · 这些文件这次没存进去，GitHub 上还是旧的一版：scenes/a/scene.json [现在存档]",
    );
  });

  it("says that a project of the platform has no folder here, and what goes with that", () => {
    const direct = cloudPanel(linked({ local: "browser" }), t);
    expect(read(direct)).toEqual({
      bar: "☁ 云端项目",
      level: "ok",
      rows: [
        "仓库  ada/atom（私有） <在 GitHub 上打开>",
        "同步  在线，改动都已发送",
        "存档  14:05 存过 [现在存档]",
        "本机  没有文件夹，项目放在这个浏览器里 [下载到文件夹…]",
      ],
      // Taking it out of this browser in place of disconnecting it.
      actions: ["[换一个仓库…]", "[从这个浏览器移除…]"],
    });
    expect(ids(direct).bottom).toEqual(["switchRepository", "removeFromBrowser"]);
    expect(ids(direct).rows["local"]).toEqual(["downloadToFolder"]);
    // Without a network, and with something to do, it says what any project says.
    expect(
      cloudPanel(linked({ local: "browser", sync: sync({ state: "offline", pending: 3 }) }), t).bar,
    ).toBe("☁ 离线，3 个改动待发");
    expect(
      cloudPanel(
        linked({ local: "browser", sync: sync({ state: "paused", problem: { kind: "missing" } }) }),
        t,
      ).bar,
    ).toBe("☁ 要处理");
    // A browser that cannot write folders has nowhere to download it to.
    const nowhere = cloudPanel(linked({ local: "browser", canMoveToFolder: false }), t);
    expect(read(nowhere).rows[3]).toBe("本机  没有文件夹，项目放在这个浏览器里");
  });

  it("says that a project from before is one step short: it has no repository yet", () => {
    const legacy = cloudPanel(
      linked({ archive: watch({ state: "none", archiving: false, head: 4, archivedSeq: 0 }) }),
      t,
    );
    expect(read(legacy)).toEqual({
      bar: "☁ 要处理",
      level: "attention",
      rows: ["仓库  还差一步：选仓库 [选仓库…]", "同步  在线，改动都已发送"],
      actions: ["[断开云端…]"],
    });
    expect(legacy.rows[0]).toMatchObject({ tone: "attention" });
    expect(ids(legacy).rows["repository"]).toEqual(["chooseRepository"]);
    expect(legacy.archive).toBe("none");
    // The same for one that was opened without a folder.
    const direct = cloudPanel(
      linked({
        local: "browser",
        archive: watch({ state: "none", archiving: false, head: 4, archivedSeq: 0 }),
      }),
      t,
    );
    expect(read(direct)).toMatchObject({ bar: "☁ 要处理", actions: ["[从这个浏览器移除…]"] });
  });

  it("says of a repository that is gone whether it was deleted, or is out of what the App may reach", () => {
    const paused = (gone?: "deleted" | "unauthorized") =>
      cloudPanel(
        linked({
          archive: watch(status({ state: "paused", reason: "gone", ...(gone && { gone }) })),
        }),
        t,
      );
    // Deleted: no archive goes there again, so another repository is what helps, right there.
    const deleted = paused("deleted");
    expect(read(deleted).rows[2]).toBe(
      "存档  存档先停着：仓库在 GitHub 上被删除了 · 换一个仓库，项目会重新存一份进去。云端的项目和本机的内容都还在。 [换一个仓库…]",
    );
    expect(deleted.rows[2]?.actions).toEqual([
      { id: "switchRepository", label: "换一个仓库…", enabled: true, kind: "primary" },
    ]);
    // Said once: not again at the end of the panel.
    expect(ids(deleted)).toEqual({
      rows: { repository: [], sync: [], archive: ["switchRepository"] },
      bottom: ["disconnect"],
    });
    // Taken out of what the App may reach: putting it back is what helps, and archiving goes on.
    const unauthorized = paused("unauthorized");
    expect(read(unauthorized).rows[2]).toBe(
      "存档  存档先停着：AnimaQuill 不能再访问这个仓库 · 在 GitHub 上把这个仓库加回 AnimaQuill 的授权范围，加回以后会自动接着存，也可以点“现在存档”；或者换一个仓库。 [现在存档]",
    );
    expect(ids(unauthorized)).toEqual({
      rows: { repository: [], sync: [], archive: ["archiveNow"] },
      bottom: ["switchRepository", "disconnect"],
    });
    // The platform cannot tell: what fits both, as before.
    const either = paused();
    expect(read(either).rows[2]).toBe(
      "存档  存档先停着：仓库不见了，或者 GitHub App 不能再访问它 · 在 GitHub 上把仓库加回 App 的授权范围后点“现在存档”，或者换一个仓库。 [现在存档]",
    );
    expect(ids(either).bottom).toEqual(["switchRepository", "disconnect"]);
    for (const panel of [deleted, unauthorized, either]) {
      expect(panel).toMatchObject({ level: "attention", bar: "☁ 要处理", archive: "paused" });
    }
  });

  it("says that connecting is not finished where the project is not on the platform yet, with the way back", () => {
    // The first version is on its way, or waits for a network: nothing is known of a repository.
    const waiting = cloudPanel(
      linked({ made: false, sync: sync({ state: "offline", pending: 0 }), archive: silent() }),
      t,
    );
    expect(read(waiting)).toEqual({
      bar: "☁ 要处理",
      level: "attention",
      rows: [
        "仓库  还没连接完 · 项目还没传到云端，也还没有仓库。联网后会自动接着传；点“接着连接…”把剩下的做完。 [接着连接…]",
        "同步  离线，联网后自动接着同步",
      ],
      actions: ["[断开云端…]"],
    });
    expect(waiting.rows[0]).toMatchObject({ tone: "attention" });
    expect(ids(waiting)).toEqual({
      rows: { repository: ["finishConnect"], sync: [] },
      bottom: ["disconnect"],
    });
    // Also while it connects, and where syncing stopped: what stopped it shows as ever.
    const connecting = cloudPanel(
      linked({ made: false, sync: sync({ state: "connecting" }), archive: silent() }),
      t,
    );
    expect(read(connecting)).toMatchObject({ bar: "☁ 要处理", level: "attention" });
    const stuck = cloudPanel(
      linked({
        made: false,
        sync: sync({ state: "paused", problem: { kind: "signed-out" } }),
        archive: silent(),
      }),
      t,
    );
    expect(ids(stuck).rows).toEqual({ repository: ["finishConnect"], sync: ["signIn"] });
    // Once it is there, what is known of its repository shows, as for any project.
    const made = cloudPanel(linked({ made: true, archive: silent() }), t);
    expect(read(made).rows[0]).toBe("仓库  正在查…");
    expect(read(made)).toMatchObject({ bar: "☁ 已同步", level: "ok" });
    // A platform that saves no projects to repositories has no dialog to go back to: only how
    // syncing goes.
    const { archive: _archive, ...bare } = linked({
      made: false,
      sync: sync({ state: "connecting" }),
    });
    expect(read(cloudPanel(bare, t))).toEqual({
      bar: "☁ 正在连接",
      level: "busy",
      rows: ["同步  正在连接…"],
      actions: ["[断开云端…]"],
    });
  });

  it("has another repository to go to at any time, not only where archiving paused", () => {
    const ready = cloudPanel(linked(), t);
    const paused = cloudPanel(
      linked({ archive: watch(status({ state: "paused", reason: "gone" })) }),
      t,
    );
    const offline = cloudPanel(linked({ sync: sync({ state: "offline" }) }), t);
    for (const panel of [ready, paused, offline]) {
      expect(panel.actions[0]).toEqual({
        id: "switchRepository",
        label: "换一个仓库…",
        enabled: true,
      });
    }
  });

  it("says what is known of the repository while the platform has not said, or cannot", () => {
    const row = (archive: RepositoryWatchSnapshot) =>
      read(cloudPanel(linked({ archive }), t)).rows[0];
    expect(row(silent({ checkedAt: undefined }))).toBe("仓库  正在查…");
    expect(row(silent({ trouble: "signedOut" }))).toBe("仓库  登录后才能看到");
    expect(row(silent({ trouble: "unavailable" }))).toBe("仓库  暂时查不到");
    // What it said before stays, with a word that it is from before.
    expect(row(watch(status(), { trouble: "unavailable" }))).toBe(
      "仓库  ada/atom（私有） · 暂时查不到最新的情况，这是之前查到的。 <在 GitHub 上打开>",
    );
    // Not knowing is no reason to worry people, and nothing to switch from.
    const unknown = cloudPanel(linked({ archive: silent() }), t);
    expect(unknown).toMatchObject({ level: "ok", bar: "☁ 已同步", archive: undefined });
    expect(ids(unknown).bottom).toEqual(["disconnect"]);
    expect(
      read(
        cloudPanel(
          linked({ archive: watch(status({ repository: { ...REPOSITORY, private: false } })) }),
          t,
        ),
      ).rows[0],
    ).toBe("仓库  ada/atom（公开） <在 GitHub 上打开>");
  });

  it("says only how syncing goes where the platform saves no projects to repositories", () => {
    const { archive: _archive, ...without } = linked();
    expect(read(cloudPanel(without, t))).toEqual({
      bar: "☁ 已同步",
      level: "ok",
      rows: ["同步  在线，改动都已发送"],
      actions: ["[断开云端…]"],
    });
  });

  it("is put together from what `CloudProjects` says and what it holds says right now", () => {
    const more = { name: "原子是什么", canMoveToFolder: false, now: NOW };
    expect(panelInputOf({ kind: "none" }, more)).toEqual({ kind: "none", ...more });
    const said = sync({ state: "offline", pending: 1 });
    const archive = watch();
    const snapshot = {
      kind: "linked",
      local: "browser",
      made: false,
      link: { key: "k", platform: "x", project: "p", seq: 1, pushed: 1, linkedAt: 1 },
      session: { getSnapshot: () => said },
      repository: { getSnapshot: () => archive },
    } as unknown as CloudProjectsSnapshot;
    expect(panelInputOf(snapshot, more)).toStrictEqual({
      kind: "linked",
      local: "browser",
      made: false,
      sync: said,
      archive,
      ...more,
    });
    expect(panelInputOf({ ...snapshot, made: true } as CloudProjectsSnapshot, more).made).toBe(
      true,
    );
    const { repository: _repository, ...bare } = snapshot as unknown as Record<string, unknown>;
    expect(
      panelInputOf({ ...bare, repository: undefined } as unknown as CloudProjectsSnapshot, more),
    ).not.toHaveProperty("archive");
  });
});

describe("a project only in this browser, without the platform (the design of the start page, 7)", () => {
  const onlyHere = (more: Partial<PanelInput> = {}): PanelInput => ({
    kind: "none",
    local: "browser",
    name: "原子",
    canMoveToFolder: true,
    now: NOW,
    ...more,
  });

  it("says that it is not safe, and gives the ways out", () => {
    const panel = cloudPanel(onlyHere(), t);
    expect(panel).toMatchObject({ level: "attention", bar: "只在浏览器里", opens: "panel" });
    expect(panel.rows.map((row) => row.text)).toEqual([
      "这个项目只在浏览器里，不安全，浏览器清理数据时会丢",
    ]);
    expect(panel.rows[0]?.actions.map((action) => action.label)).toEqual([
      "移到文件夹…",
      "连接到云端…",
      "另存一份…",
    ]);
    // Where the browser cannot write folders, there is no folder to move it to.
    const without = cloudPanel(onlyHere({ canMoveToFolder: false }), t);
    expect(without.rows[0]?.actions.map((action) => action.id)).toEqual(["connect", "saveCopy"]);
  });

  it("is what the open project is, as `CloudProjects` says it", () => {
    const snapshot: CloudProjectsSnapshot = { kind: "none", local: "browser" };
    const input = panelInputOf(snapshot, { name: "原子", canMoveToFolder: false, now: NOW });
    expect(input).toMatchObject({ kind: "none", local: "browser" });
    // A folder that is not connected is "仅本机", as before.
    expect(
      cloudPanel(
        panelInputOf({ kind: "none" }, { name: "原子", canMoveToFolder: false, now: NOW }),
        t,
      ).bar,
    ).toBe("仅本机");
  });
});

describe("a project of the platform only in this browser, and what the browser keeps (R-ST-9)", () => {
  const direct = (more: Partial<PanelInput> = {}): PanelInput => ({
    ...linked({ local: "browser" }),
    ...more,
  });
  const notesOf = (panel: CloudPanel) => panel.rows.find((row) => row.id === "local")?.notes ?? [];

  it("says where the browser did not say it keeps it", () => {
    expect(notesOf(cloudPanel(direct({ persisted: true }), t))).toEqual([]);
    expect(notesOf(cloudPanel(direct(), t))).toEqual([]);
    expect(notesOf(cloudPanel(direct({ persisted: false }), t))).toEqual([
      "浏览器没有答应长期保存：磁盘紧张时可能清掉还没同步的改动。",
    ]);
  });

  it("says in Safari, with changes that did not get to the platform, to sync or install it", () => {
    const pending = sync({ pending: 2 });
    const safari = notesOf(cloudPanel(direct({ clearsWhenIdle: true, sync: pending }), t));
    expect(safari.some((note) => note.includes("Safari 会在 7 天"))).toBe(true);
    // Nothing that is not on the platform: nothing to lose.
    expect(notesOf(cloudPanel(direct({ clearsWhenIdle: true }), t))).toEqual([]);
    // Kept for good: Safari does not clear it.
    expect(
      notesOf(cloudPanel(direct({ clearsWhenIdle: true, persisted: true, sync: pending }), t)),
    ).toEqual([]);
  });
});
