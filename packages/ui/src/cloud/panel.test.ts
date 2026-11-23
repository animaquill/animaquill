import type { RepositoryStatus, RepositoryUnusable } from "@animaquill/host";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import { githubText } from "./github-status.ts";
import {
  cloudPanel,
  panelInputOf,
  type CloudPanel,
  type PanelInput,
  type PanelRow,
} from "./panel.ts";
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
  place: "github",
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
  sync: sync(),
  archive: watch(),
  name: "原子是什么",
  now: NOW,
  ...more,
});

/** A row as people read it: what it says, what is below it, and its buttons. */
const line = (row: PanelRow) =>
  [
    `${row.label}  ${row.text}`,
    ...row.notes.map((note) => `· ${note}`),
    ...(row.link ? [`<${row.link.label}>`] : []),
    ...row.actions.map(({ label, enabled }) => (enabled ? `[${label}]` : `[${label}，不能点]`)),
  ].join(" ");

/** The row of a project in a folder whose name the panel was not told, which most tests have. */
const SOME_FOLDER = "本机  在这台电脑的文件夹里";
/** The rows in an order of their own, which the tests below go by: see "in three parts". */
const ORDER: readonly PanelRow["id"][] = ["repository", "sync", "archive", "local"];

/**
 * The panel as people read it: each row, without the one that only says that the project is in a
 * folder, and what is at the bottom. `github`: the third status, its kind and its word.
 */
const read = (panel: CloudPanel) => ({
  bar: panel.bar,
  level: panel.level,
  github: panel.github && `${panel.github.kind} ${githubText(panel.github, t)}`,
  rows: panel.rows
    .toSorted((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
    .map(line)
    .filter((each) => each !== SOME_FOLDER),
  actions: panel.actions.map(({ label }) => `[${label}]`),
});
/** A row of the panel, by its id. */
const rowOf = (panel: CloudPanel, id: PanelRow["id"]) =>
  panel.rows.find((row) => row.id === id) as PanelRow;
/** What each row offers, by its id: the row of where it is only where it offers something. */
const ids = (panel: CloudPanel) => ({
  rows: Object.fromEntries(
    panel.rows
      .filter((row) => row.id !== "local" || row.actions.length > 0)
      .map((row) => [row.id, row.actions.map(({ id }) => id)]),
  ),
  bottom: panel.actions.map(({ id }) => id),
});

describe("the status of the platform in a project", () => {
  it("says in one word that everything is in step, and in the panel what that means", () => {
    const panel = cloudPanel(
      linked({
        archive: watch(
          status({ head: 11, dirtySince: NOW - 2 * MINUTE, nextAt: NOW + 3 * MINUTE }),
        ),
      }),
      t,
    );
    expect(panel.title).toBe("在线 · 原子是什么");
    // The platform has changes that its repository does not have yet: on their way, nothing to
    // do, and syncing is in step all the same.
    expect(read(panel)).toEqual({
      bar: "已同步",
      level: "ok",
      github: "pending 待同步",
      rows: [
        "仓库  ada/atom（私有） <在 GitHub 上打开>",
        "同步  在线，改动都已发送",
        "存档  14:05 存过。有新改动，约 3 分钟后再存 [现在存档]",
      ],
      actions: ["[换一个仓库…]", "[保存到文件夹…]"],
    });
    expect(rowOf(panel, "archive")).toMatchObject({ tone: "plain" });
    expect(rowOf(panel, "repository").link?.url).toBe("https://github.com/ada/atom");
    expect(panel.actions.map(({ kind }) => kind)).toEqual([undefined, undefined]);
    // Once all of it is in the repository, nothing more is said.
    const inStep = cloudPanel(linked(), t);
    expect(read(inStep)).toMatchObject({ bar: "已同步", level: "ok", github: "synced 已同步" });
    // In two parts, in the order of the statuses: syncing, the repository.
    expect(panel.rows.map(({ id, section }) => `${section}:${id}`)).toEqual([
      "sync:sync",
      "github:repository",
      "github:archive",
    ]);
    expect(read(inStep).rows[2]).toBe("存档  14:05 存过 [现在存档]");
    // Whoever it is of can take it away there, at the end.
    expect(ids(cloudPanel(linked({ canDelete: true }), t)).bottom).toEqual([
      "switchRepository",
      "saveToFolder",
      "deleteCloud",
    ]);
    // What the page says about itself, for whatever reads it.
    expect(panel).toMatchObject({ sync: "online", archive: "ready" });
  });

  it("says how many changes wait while there is no network, and that they go by themselves", () => {
    const offline = cloudPanel(linked({ sync: sync({ state: "offline", pending: 3 }) }), t);
    expect(read(offline)).toMatchObject({
      bar: "离线",
      level: "busy",
    });
    expect(read(offline).rows[1]).toBe("同步  离线，3 个改动待发，联网后自动发送");
    // What did not get to the platform is not in an archive either.
    expect(read(offline).rows[2]).toBe(
      "存档  14:05 存过 · 还有改动没发到服务器，发过去以后才会存。 [现在存档]",
    );
    expect(read(cloudPanel(linked({ sync: sync({ state: "offline" }) }), t))).toMatchObject({
      bar: "离线",
      level: "busy",
    });

    // A platform that cannot be reached is as good as no network.
    const retryAt = new Date(2026, 10, 10, 14, 9, 0).getTime();
    const away = cloudPanel(
      linked({ sync: sync({ state: "reconnecting", pending: 2, retryAt }) }),
      t,
    );
    expect(read(away).bar).toBe("离线");
    expect(read(away).rows[1]).toBe("同步  连不上服务器，14:09 再试 · 2 个改动待发");
    expect(read(cloudPanel(linked({ sync: sync({ state: "reconnecting" }) }), t)).rows[1]).toBe(
      "同步  连不上服务器，正在重试",
    );

    // On its way, with a connection.
    const sending = cloudPanel(linked({ sync: sync({ pending: 1 }) }), t);
    expect(read(sending)).toMatchObject({ bar: "同步中", level: "busy" });
    expect(read(sending).rows[1]).toBe("同步  在线，1 个改动待发");
    const connecting = cloudPanel(linked({ sync: sync({ state: "connecting" }) }), t);
    expect(read(connecting)).toMatchObject({ bar: "同步中", level: "busy" });
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
    expect(read(signedOut)).toMatchObject({ bar: "出错", level: "attention" });
    expect(read(signedOut).rows[1]).toBe(
      "同步  登录已过期，登录后继续同步。改动都留在本机。 [登录]",
    );
    expect(rowOf(signedOut, "sync")).toMatchObject({ tone: "attention" });
    expect(ids(signedOut).rows["sync"]).toEqual(["signIn"]);
    expect(ids(stuck({ kind: "outdated" })).rows["sync"]).toEqual(["reload"]);
    // Taking it back onto the copy the platform made again goes by itself, until it stops.
    expect(ids(stuck({ kind: "rebuilt" })).rows["sync"]).toEqual([]);
    const takingBack = (state: "running" | "stopped") =>
      cloudPanel(
        linked({
          sync: sync({ state: "paused", problem: { kind: "rebuilt" }, pending: 2 }),
          takeBack: state,
        }),
        t,
      );
    expect(read(takingBack("running")).rows[1]).toBe(
      "同步  服务器已从 GitHub 重新取回这个项目，正在把这台电脑上的改动接回去…",
    );
    expect(ids(takingBack("running")).rows["sync"]).toEqual([]);
    expect(read(takingBack("stopped")).rows[1]).toBe(
      "同步  服务器已从 GitHub 重新取回这个项目，这台电脑上的改动还没接回。接回之前这个项目只能看、不能改。 [接回]",
    );
    expect(ids(takingBack("stopped")).rows["sync"]).toEqual(["takeBack"]);
    // While the platform makes it again, which the window waits for.
    expect(
      read(cloudPanel(linked({ sync: sync({ state: "reconnecting", restoring: "restoring" }) }), t))
        .rows[1],
    ).toBe("同步  正在从 GitHub 取回…");
    // ...and could not lately: why, and what helps where the repository had what kept it.
    const notMade = (code: string) =>
      cloudPanel(
        linked({
          sync: sync({ state: "reconnecting", restoring: "released" }),
          copyProblem: { code, at: 1, files: ["timeline.json"] },
        }),
        t,
      );
    expect(read(notMade("unreadable")).rows[1]).toBe(
      "同步  上次取回没成功：GitHub 仓库里有读不懂的文件：timeline.json · 在 GitHub 上修好以后，可以按 GitHub 上现在的样子取回。 · 按 GitHub 上现在的样子取回时，分不清这台电脑上哪些是新改的，两边不一样的文件会让你逐个选。 [我已在 GitHub 上修好，按现在的样子取回]",
    );
    expect(ids(notMade("unreadable")).rows["sync"]).toEqual(["wakeAsItIs"]);
    expect(rowOf(notMade("unreadable"), "sync")).toMatchObject({ tone: "attention" });
    expect(ids(notMade("unavailable")).rows["sync"]).toEqual([]);
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
      "同步  服务器没有接受一个改动（太大），同步已暂停。改动都留在这个浏览器里，可以重试，或者点“处理…”。 [重试] [处理…]",
    );
    expect(read(stuck({ kind: "rebuilt" })).rows[1]).toContain("已经从 GitHub 重新取回");
    expect(stuck({ kind: "missing" }).sync).toBe("paused");
  });

  it("says that people have to do something where archiving paused, with what helps", () => {
    const paused = (reason: string, more: Partial<RepositoryStatus> = {}) =>
      cloudPanel(linked({ archive: watch(status({ state: "paused", reason, ...more })) }), t);
    const diverged = paused("diverged", {
      diverged: { sha: "b", files: ["code/a.js", "code/b.js"], deleted: [] },
    });
    // Syncing is in step: the repository is what needs people.
    expect(read(diverged)).toMatchObject({ bar: "已同步", level: "ok", github: "error 同步失败" });
    expect(diverged.github).toMatchObject({ cause: "paused" });
    expect(read(diverged).rows[2]).toBe(
      "存档  存档先停着：GitHub 上有人改了项目的 2 个文件 · 为了不盖掉这些改动，存档先停下。可以以编辑器的内容接着存，GitHub 上的那一版会留在存档历史里；也可以换一个仓库。 [以编辑器的内容接着存…]",
    );
    expect(rowOf(diverged, "archive")).toMatchObject({ tone: "attention" });
    expect(diverged.archive).toBe("paused");
    expect(ids(diverged)).toEqual({
      rows: { repository: [], sync: [], archive: ["continueWithEditor"] },
      bottom: ["switchRepository", "saveToFolder"],
    });
    expect(ids(paused("gone")).rows["archive"]).toEqual(["archiveNow"]);
    expect(ids(paused("uninstalled")).rows["archive"]).toEqual(["installApp"]);
    // Another repository is all that helps: it is where it always is.
    expect(ids(paused("transferred"))).toMatchObject({
      rows: { archive: [] },
      bottom: ["switchRepository", "saveToFolder"],
    });
    // A reason of a newer platform still has a way on.
    expect(ids(paused("somethingNew")).rows["archive"]).toEqual(["archiveNow"]);
    expect(
      read(paused("protected", { detail: "Changes must be made through a pull request." })).rows[2],
    ).toContain("· GitHub 的原话：Changes must be made through a pull request.");
  });

  it("says what merging changes on GitHub waits for, in few words, and the way to it (the design, 10)", () => {
    const paused = (reason: string, more: Partial<RepositoryStatus> = {}) =>
      cloudPanel(linked({ archive: watch(status({ state: "paused", reason, ...more })) }), t);
    const conflicts = paused("conflicts", { conflicts: 2 });
    expect(read(conflicts)).toMatchObject({ github: "error 同步失败 · 2 处冲突" });
    expect(conflicts.github).toMatchObject({ cause: "conflicts", count: 2 });
    expect(read(conflicts).rows[2]).toBe("存档  存档先停着：有 2 处和 GitHub 上的改动冲突 [处理…]");
    expect(ids(conflicts).rows["archive"]).toEqual(["resolveMerge"]);
    const blocked = paused("blocked", {
      blocked: [{ path: "timelines/main/timeline.json", reason: "invalid", detail: "第 12 行" }],
    });
    expect(read(blocked).rows[2]).toBe(
      "存档  存档先停着：GitHub 上的 timelines/main/timeline.json 没有并进来 [查看…]",
    );
    expect(blocked.github).toMatchObject({ cause: "blocked" });
    const diverged = {
      sha: "b".repeat(40),
      files: ["code/secret.js"],
      deleted: ["code/secret.js"],
    };
    expect(ids(paused("rewritten", { diverged })).rows["archive"]).toEqual(["resolveMerge"]);
    expect(read(paused("unmerged", { diverged })).rows[2]).toContain(
      "GitHub 上去掉的 1 个文件还在项目里",
    );
    expect(ids(paused("unmerged", { diverged })).rows["archive"]).toEqual(["resolveMerge"]);
    expect(ids(paused("too-large", { diverged })).rows["archive"]).toEqual(["continueWithEditor"]);
    // Locked: unlocking is the way, which is in the project's properties.
    expect(read(paused("locked")).rows[2]).toContain(
      "项目锁着，GitHub 上的改动没有并进来 · 解锁以后会自动再合并。",
    );
    expect(ids(paused("locked")).rows["archive"]).toEqual([]);
    // A merge lately says so first, while it goes on as ever.
    const merged = cloudPanel(
      linked({
        archive: watch(status({ merge: { at: NOW - 5 * MINUTE, sha: "c", files: 2, url: "" } })),
      }),
      t,
    );
    expect(rowOf(merged, "archive").text).toBe("合并了 GitHub 上的改动（2 个文件），14:05 存过");
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
    // Never archived: all of it waits for the repository.
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
    // Failing for GitHub's or the platform's sake is tried again by itself: on its way, for an
    // hour; failing longer than that is something people have to know about.
    const retrying = cloudPanel(
      linked({
        archive: watch(status({ failures: 2, retryAt, head: 12, failingSince: NOW - 59 * MINUTE })),
      }),
      t,
    );
    expect(rowOf(retrying, "archive")).toMatchObject({ tone: "plain" });
    expect(retrying.github).toMatchObject({ kind: "pending", cause: "retrying" });
    const failing = cloudPanel(
      linked({
        archive: watch(
          status({
            failures: 9,
            retryAt,
            head: 12,
            failingSince: NOW - 2 * 60 * MINUTE,
            detail: "GitHub is down",
          }),
        ),
      }),
      t,
    );
    expect(rowOf(failing, "archive")).toMatchObject({ tone: "attention" });
    expect(failing).toMatchObject({ bar: "已同步", level: "ok" });
    expect(read(failing).github).toBe("error 同步失败");
    expect(read(failing).rows[2]).toBe(
      "存档  14:05 存过。上次没存成，14:10 再试 · 已经连续 2 个多小时没能存进去（GitHub 暂时连不上、限流，或者服务器出了错）：GitHub is down · 服务器会一直自动重试；也可以点“现在存档”再试一次，或者换一个仓库。 [现在存档]",
    );
    // "Archive now" was asked for too soon, and goes by itself.
    expect(row(status(), { archiveAt: NOW + 40_000 })).toBe(
      "存档  14:05 存过。1 分钟内只能存一次档，40 秒后自动存 [现在存档，不能点]",
    );
    expect(row(status({ kept: ["scenes/a/scene.json"] }))).toBe(
      "存档  14:05 存过 · 这些文件这次没存进去，GitHub 上还是旧的一版：scenes/a/scene.json · 在编辑器里改好这些文件以后会自动接着存。 [现在存档]",
    );
  });

  it("says that a project from before is one step short: it has no repository yet", () => {
    const legacy = cloudPanel(
      linked({ archive: watch({ state: "none", archiving: false, head: 4, archivedSeq: 0 }) }),
      t,
    );
    expect(read(legacy)).toEqual({
      bar: "已同步",
      level: "ok",
      github: "error 还差一步：选仓库",
      rows: ["仓库  还差一步：选仓库", "同步  在线，改动都已发送"],
      actions: ["[保存到文件夹…]"],
    });
    expect(rowOf(legacy, "repository")).toMatchObject({ tone: "attention" });
    // No project of the platform is without a repository any more: nothing to choose it with.
    expect(ids(legacy).rows["repository"]).toEqual([]);
    expect(legacy.archive).toBe("none");
    // The same for one that was opened without a folder.
    const direct = cloudPanel(
      linked({
        archive: watch({ state: "none", archiving: false, head: 4, archivedSeq: 0 }),
      }),
      t,
    );
    expect(read(direct)).toMatchObject({
      github: "error 还差一步：选仓库",
      actions: ["[保存到文件夹…]"],
    });
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
      "存档  存档先停着：仓库在 GitHub 上被删除了 · 换一个仓库，项目会重新存一份进去。服务器的项目和本机的内容都还在。 [换一个仓库…]",
    );
    expect(rowOf(deleted, "archive").actions).toEqual([
      { id: "switchRepository", label: "换一个仓库…", enabled: true, kind: "primary" },
    ]);
    // Said once: not again at the end of the panel.
    expect(ids(deleted)).toEqual({
      rows: { repository: [], sync: [], archive: ["switchRepository"] },
      bottom: ["saveToFolder"],
    });
    // Taken out of what the App may reach: putting it back is what helps, and archiving goes on.
    const unauthorized = paused("unauthorized");
    expect(read(unauthorized).rows[2]).toBe(
      "存档  存档先停着：AnimaQuill 不能再访问这个仓库 · 在 GitHub 上把这个仓库加回 AnimaQuill 的授权范围，加回以后会自动接着存，也可以点“现在存档”；或者换一个仓库。 [现在存档]",
    );
    expect(ids(unauthorized)).toEqual({
      rows: { repository: [], sync: [], archive: ["archiveNow"] },
      bottom: ["switchRepository", "saveToFolder"],
    });
    // The platform cannot tell: what fits both, as before.
    const either = paused();
    expect(read(either).rows[2]).toBe(
      "存档  存档先停着：仓库不见了，或者 GitHub App 不能再访问它 · 在 GitHub 上把仓库加回 App 的授权范围后点“现在存档”，或者换一个仓库。 [现在存档]",
    );
    expect(ids(either).bottom).toEqual(["switchRepository", "saveToFolder"]);
    for (const panel of [deleted, unauthorized, either]) {
      expect(panel).toMatchObject({ level: "ok", bar: "已同步", archive: "paused" });
      expect(panel.github).toMatchObject({ kind: "error", cause: "paused" });
    }
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
    expect(unknown).toMatchObject({ level: "ok", bar: "已同步", archive: undefined });
    expect(unknown.github).toEqual({ kind: "pending", cause: "unknown" });
    expect(ids(unknown).bottom).toEqual(["saveToFolder"]);
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
      bar: "已同步",
      level: "ok",
      github: undefined,
      rows: ["同步  在线，改动都已发送"],
      actions: ["[保存到文件夹…]"],
    });
  });

  it("says why a project whose repository cannot be used cannot be edited, until when, and what helps", () => {
    const DAY = 24 * 3600_000;
    const unusable = (reason: string, more: { gone?: "deleted" | "unauthorized" } = {}) => ({
      reason,
      since: NOW - DAY,
      deleteAt: NOW + 6 * DAY + 1000,
      ...more,
    });
    const panelOf = (said: RepositoryUnusable, more: Partial<PanelInput> = {}) =>
      cloudPanel(
        linked({
          unusable: said,
          canDelete: true,
          sync: sync({ state: "paused", problem: { kind: "unusable", reason: said.reason } }),
          archive: watch(status({ state: "paused", reason: said.reason, head: 12 })),
          ...more,
        }),
        t,
      );
    const deleted = panelOf(unusable("gone", { gone: "deleted" }));
    // Syncing stopped, and the repository says why, as more than an error.
    expect(read(deleted)).toEqual({
      bar: "出错",
      level: "attention",
      github: "error 仓库已删除",
      rows: [
        "仓库  仓库已删除，7 天后自动删除 · 在 GitHub 上恢复仓库后点“再检查一次”；也可以换一个仓库。 · 仓库能用之前不能编辑，可以看、播放和导出。出问题之前的改动都留在这台电脑上，仓库修好后接着同步。 · 这期间也可以保存到文件夹，把内容复制出来，或者删除这个项目。 [再检查一次] [换一个仓库…]",
        "同步  仓库用不了，这个在线项目现在不能编辑。出问题之前的改动都留在本机。",
        // Nothing about archiving, and no "unsaved changes": the row of the repository says it all.
      ],
      actions: ["[保存到文件夹…]", "[删除项目…]"],
    });
    expect(rowOf(deleted, "repository")).toMatchObject({ tone: "attention" });
    // Nothing to retry about syncing: it goes on by itself once the repository can be used.
    expect(ids(deleted).rows["sync"]).toEqual([]);
    // What helps is by why it cannot be used.
    expect(ids(panelOf(unusable("gone", { gone: "unauthorized" }))).rows["repository"]).toEqual([
      "reauthorize",
      "switchRepository",
      "recheck",
    ]);
    expect(ids(panelOf(unusable("gone"))).rows["repository"]).toEqual([
      "reauthorize",
      "switchRepository",
      "recheck",
    ]);
    expect(read(panelOf(unusable("gone"))).github).toBe("error 找不到这个项目的 GitHub 仓库");
    expect(ids(panelOf(unusable("transferred"))).rows["repository"]).toEqual([
      "switchRepository",
      "recheck",
    ]);
    expect(ids(panelOf(unusable("uninstalled"))).rows["repository"]).toEqual([
      "reinstall",
      "recheck",
      "switchRepository",
    ]);
    expect(ids(panelOf(unusable("suspended"))).rows["repository"]).toEqual([
      "restoreApp",
      "recheck",
      "switchRepository",
    ]);
    // A copy only in this browser has no folder to go on with.
    const direct = panelOf(unusable("transferred"), {});
    expect(ids(direct).bottom).toEqual(["saveToFolder", "deleteCloud"]);
    expect(read(direct).rows[0]).not.toContain("有文件夹的也可以断开服务器");
    // Where the platform does not take such projects away by itself yet: no days.
    const { deleteAt: _, ...forever } = unusable("transferred");
    expect(read(panelOf(forever)).rows[0]).toMatch(/^仓库  仓库已转到别的账号，现在不能编辑/);
    // ...and on the last day.
    expect(read(panelOf({ ...forever, deleteAt: NOW - 1 })).rows[0]).toMatch(
      /^仓库  仓库已转到别的账号，马上会被自动删除/,
    );
  });

  it("is put together from what `CloudProjects` says and what it holds says right now", () => {
    const more = { name: "原子是什么", now: NOW };
    expect(panelInputOf({ kind: "none" }, more)).toEqual({ kind: "none", ...more });
    const said = sync({ state: "offline", pending: 1 });
    const archive = watch();
    const snapshot = {
      kind: "linked",
      made: false,
      link: { key: "k", platform: "x", project: "p", seq: 1, pushed: 1, linkedAt: 1 },
      session: { getSnapshot: () => said },
      repository: { getSnapshot: () => archive },
    } as unknown as CloudProjectsSnapshot;
    expect(panelInputOf(snapshot, more)).toStrictEqual({
      kind: "linked",
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
    name: "原子",
    now: NOW,
    ...more,
  });

  it("says that it is not safe, and gives the way out", () => {
    const panel = cloudPanel(onlyHere(), t);
    expect(panel).toMatchObject({ level: "attention", bar: "只在浏览器里" });
    expect(panel.rows.map((row) => row.text)).toEqual([
      "这个项目只在浏览器里，不安全，浏览器清理数据时会丢",
    ]);
    expect(panel.rows[0]?.actions.map((action) => action.label)).toEqual(["另存一份…"]);
  });

  it("is what the open project is, as `CloudProjects` says it", () => {
    const snapshot: CloudProjectsSnapshot = { kind: "none" };
    const input = panelInputOf(snapshot, { name: "原子", now: NOW });
    expect(input).toMatchObject({ kind: "none" });
    expect(cloudPanel(input, t).bar).toBe("只在浏览器里");
  });
});

describe("a project of the platform only in this browser, and what the browser keeps (R-ST-9)", () => {
  const direct = (more: Partial<PanelInput> = {}): PanelInput => ({
    ...linked(),
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
