import type { CloudLink, CloudProjectSummary, FolderRecord, LocalFolder } from "@animaquill/host";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { composeStartList, type StartInput } from "../cloud/start-list.ts";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import { agoText, cloudRowView, localRowView } from "./start-view.ts";

/** What the lines of the start page say and offer: the design of the start page, 2. */

const i18n = createInstance();
await i18n.init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
});
const t = i18n.t;

const PLATFORM = "https://platform.test";
/** 2026-11-10 14:08 where the tests run. */
const NOW = new Date(2026, 10, 10, 14, 8, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const folder = (id: string, name: string): FolderRecord => ({
  id,
  folder: { name: id } as LocalFolder,
  project: `project-of-${id}`,
  name,
  openedAt: NOW - 3 * MINUTE,
});
const link = (key: string, project: string, more: Partial<CloudLink> = {}): CloudLink => ({
  key,
  platform: PLATFORM,
  project,
  seq: 1,
  pushed: 1,
  linkedAt: 1,
  ...more,
});
const repository = (name: string) => ({
  id: 7,
  owner: "ada",
  name,
  fullName: `ada/${name}`,
  private: true,
  url: `https://github.com/ada/${name}`,
  state: "ready" as const,
});
const listed = (
  id: string,
  name: string,
  more: Partial<CloudProjectSummary> = {},
): CloudProjectSummary => ({
  id,
  name,
  updatedAt: NOW - 2 * 24 * HOUR,
  copy: "live",
  ...more,
});
const lists = (more: Partial<StartInput>) =>
  composeStartList({
    records: [],
    projects: [],
    platform: PLATFORM,
    links: [],
    listed: [],
    account: "user-ada",
    canDelete: true,
    ...more,
  });

describe("how long ago", () => {
  const ago = (at: number) => agoText(at, NOW, t);

  it("says the last minute, minutes and hours of today", () => {
    expect(ago(NOW - 20_000)).toBe("刚刚");
    expect(ago(NOW - 3 * MINUTE)).toBe("3 分钟前");
    expect(ago(NOW - 59 * MINUTE)).toBe("59 分钟前");
    expect(ago(NOW - 2 * HOUR)).toBe("2 小时前");
    expect(ago(new Date(2026, 10, 10, 0, 5).getTime())).toBe("14 小时前");
  });

  it("says yesterday by the day, not by 24 hours", () => {
    // Late last evening is "yesterday", also when that is less than a day ago.
    expect(ago(new Date(2026, 10, 9, 23, 30).getTime())).toBe("昨天");
    expect(ago(new Date(2026, 10, 9, 0, 1).getTime())).toBe("昨天");
  });

  it("counts days within a week, and says the day after that", () => {
    expect(ago(new Date(2026, 10, 8, 20, 0).getTime())).toBe("2 天前");
    expect(ago(new Date(2026, 10, 4, 9, 0).getTime())).toBe("6 天前");
    expect(ago(new Date(2026, 10, 3, 9, 0).getTime())).toBe("11月3日");
    expect(ago(new Date(2025, 11, 31, 9, 0).getTime())).toBe("2025年12月31日");
  });

  it("never says that something is in the future, with a clock that is a little off", () => {
    expect(ago(NOW + 5 * MINUTE)).toBe("刚刚");
  });
});

describe("a project on this computer", () => {
  it("says its folder, and that it is only here", () => {
    const [row] = lists({ records: [folder("intro", "产品介绍")] }).local;
    expect(localRowView(row!, "ready", t)).toEqual({
      place: "文件夹：intro",
      mark: "仅本机",
      hint: undefined,
      attention: false,
      gone: false,
    });
  });

  it("says its repository where it is connected", () => {
    const [row] = lists({
      records: [folder("atom", "原子是什么")],
      links: [link("atom", "p1")],
      listed: [listed("p1", "原子是什么", { repository: repository("atom") })],
    }).local;
    const view = localRowView(row!, undefined, t);
    // The folder is still being looked at: it says its name meanwhile.
    expect(view.place).toBe("文件夹：atom");
    expect(view.mark).toBe("☁ 已连云端 · ada/atom");
    expect(view.attention).toBe(false);
  });

  it("says that changes are not on the platform yet", () => {
    const [row] = lists({
      records: [folder("atom", "原子是什么")],
      links: [link("atom", "p1", { pending: 2 })],
      listed: [listed("p1", "原子是什么", { repository: repository("atom") })],
    }).local;
    expect(localRowView(row!, "ready", t).mark).toBe("☁ 已连云端 · ada/atom · 有改动还没同步");
  });

  it("stands out where people have to do something, with what to do for hovering", () => {
    const [paused, unfinished] = lists({
      records: [folder("a", "甲"), folder("b", "乙")],
      links: [link("a", "p1"), link("b", "p2")],
      listed: [
        listed("p1", "甲", { repository: repository("a"), attention: "repository" }),
        listed("p2", "乙", { attention: "noRepository" }),
      ],
    }).local;
    expect(localRowView(paused!, "ready", t)).toMatchObject({
      mark: "☁ 要处理",
      attention: true,
      hint: "仓库的存档停下了。打开项目，在云端面板里处理。",
    });
    expect(localRowView(unfinished!, "ready", t)).toMatchObject({
      mark: "还差一步：选仓库",
      attention: true,
    });
  });

  it("says that its folder cannot be found", () => {
    const [row] = lists({ records: [folder("old", "旧项目")] }).local;
    const view = localRowView(row!, "gone", t);
    expect(view.place).toBe("找不到文件夹");
    expect(view.gone).toBe(true);
  });

  it("has no mark where the editor is hosted on no platform", () => {
    const [row] = composeStartList({
      records: [folder("intro", "产品介绍")],
      projects: [],
      platform: undefined,
      links: [],
      listed: [],
      account: undefined,
      canDelete: false,
    }).local;
    expect(localRowView(row!, "ready", t).mark).toBeUndefined();
  });
});

describe("a project of the platform", () => {
  const view = (more: Partial<StartInput>, canDownload = true) => {
    const [row] = lists(more).cloud;
    return cloudRowView(row!, { now: NOW, canDownload }, t);
  };

  it("says its repository and when it changed, and opens on GitHub", () => {
    expect(
      view({ listed: [listed("p1", "片头动画", { repository: repository("opening") })] }),
    ).toEqual({
      about: ["ada/opening", "2 天前改过"],
      mark: undefined,
      hint: undefined,
      download: true,
      more: ["openOnGitHub"],
      address: "https://github.com/ada/opening",
    });
  });

  it("makes a link only of an https address: the platform's word is not checked", () => {
    for (const url of ["javascript:alert(1)", "http://github.com/ada/opening", "//x", ""]) {
      const seen = view({
        listed: [listed("p1", "片头动画", { repository: { ...repository("opening"), url } })],
      });
      expect(seen.address, url).toBeUndefined();
      expect(seen.more, url).toEqual([]);
    }
  });

  it("offers to take any copy out of the browser, also one that the platform's list does not have", () => {
    // The list was read, and the project is not in it: removing says that the copy may be all
    // there is of it, before anything goes.
    const gone = view({
      projects: [{ id: "p1", name: "年会视频", updatedAt: NOW }],
      links: [link("p1", "p1", { repository: { id: 7, fullName: "ada/annual" } })],
      listed: [],
    });
    expect(gone.mark).toBe("☁ 要处理");
    expect(gone.more).toEqual(["removeHere"]);
    // One of another account, and one that never got there: removing asks about those too.
    const others = lists({
      projects: [
        { id: "p2", name: "别人的", updatedAt: NOW },
        { id: "p3", name: "没传上去的", updatedAt: NOW },
      ],
      links: [link("p2", "p2", { owner: "user-bob" }), link("p3", "p3", { creating: true })],
      listed: [],
    }).cloud;
    expect(others).toHaveLength(2);
    for (const row of others) {
      const seen = cloudRowView(row, { now: NOW, canDownload: true }, t);
      expect(seen.more, row.name).toContain("removeHere");
    }
    // Where the list cannot be read, the same.
    const offline = view({
      projects: [{ id: "p1", name: "年会视频", updatedAt: NOW }],
      links: [link("p1", "p1")],
      listed: "unreadable",
    });
    expect(offline.more).toEqual(["removeHere"]);
  });

  it("says that it was opened here, and can be taken out of this browser", () => {
    const seen = view({
      projects: [{ id: "p1", name: "年会视频", updatedAt: NOW }],
      links: [link("p1", "p1", { pending: 3 })],
      listed: [listed("p1", "年会视频", { repository: repository("annual") })],
    });
    expect(seen.about).toEqual([
      "ada/annual",
      "2 天前改过",
      "在这个浏览器里打开过",
      "有改动还没同步",
    ]);
    expect(seen.more).toEqual(["openOnGitHub", "removeHere"]);
  });

  it("can be deleted only where it has no repository, and says that one is missing", () => {
    const seen = view({ listed: [listed("p1", "半截的", { attention: "noRepository" })] });
    expect(seen.mark).toBe("还差一步：选仓库");
    expect(seen.more).toEqual(["deleteCloud"]);
    // A platform that takes no projects away.
    expect(
      view({ canDelete: false, listed: [listed("p1", "半截的", { attention: "noRepository" })] })
        .more,
    ).toEqual([]);
  });

  it("has no way into a folder where the browser cannot write folders", () => {
    expect(view({ listed: [listed("p1", "片头动画")] }, false).download).toBe(false);
  });

  it("says that it syncs again after signing in, for a copy that nobody is signed in for", () => {
    const seen = view({
      projects: [{ id: "p1", name: "年会视频", updatedAt: NOW - HOUR }],
      links: [link("p1", "p1", { repository: { id: 7, fullName: "ada/annual" } })],
      listed: "signedOut",
    });
    expect(seen.about).toEqual([
      "ada/annual",
      "1 小时前改过",
      "在这个浏览器里打开过",
      "登录后继续同步",
    ]);
    // What this browser remembers has no address to open on GitHub.
    expect(seen.more).toEqual(["removeHere"]);
  });

  it("stands out where its repository needs people", () => {
    const seen = view({
      listed: [listed("p1", "片头动画", { repository: repository("o"), attention: "conflicts" })],
    });
    expect(seen.mark).toBe("☁ 要处理");
    expect(seen.hint).toBe("GitHub 上的改动和项目里的改动冲突了。打开项目处理。");
  });
});
