import type {
  CloudLink,
  CloudProjectSummary,
  FolderRecord,
  LocalFolder,
  ProjectGroup,
  ProjectMarks,
  ProjectSummary,
} from "@animaquill/host";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { composeStartList, type StartInput } from "../cloud/start-list.ts";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import {
  cardActions,
  cardPlace,
  cardStatus,
  composeCards,
  coverColorOf,
  gitHubAddress,
  initialOf,
  isUnusable,
  marksTargetOf,
  NOTHING_ORGANIZED,
  shownGroups,
  unusableChoices,
  type CardContext,
  type Organized,
  type ProjectCard,
} from "./cards.ts";

/** What the cards of the start page say and offer: the design of the start page, 6.3. */

const i18n = createInstance();
await i18n.init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
});
const t = i18n.t;

const PLATFORM = "https://platform.test";

const folder = (id: string, name: string, openedAt = 5): FolderRecord => ({
  id,
  folder: { name: `dir-${id}` } as LocalFolder,
  project: `project-of-${id}`,
  name,
  openedAt,
});
const kept = (id: string, name: string, more: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  name,
  updatedAt: 10,
  ...more,
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
const repository = (name: string, url = `https://github.com/ada/${name}`) => ({
  id: 7,
  owner: "ada",
  name,
  fullName: `ada/${name}`,
  private: true,
  url,
  state: "ready" as const,
});
const listed = (
  id: string,
  name: string,
  more: Partial<CloudProjectSummary> = {},
): CloudProjectSummary => ({ id, name, updatedAt: 100, copy: "live", ...more });

const listsOf = (more: Partial<StartInput>) =>
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

const marks = (entries: Record<string, Omit<ProjectMarks, "at">>): Organized["marks"] =>
  new Map(Object.entries(entries).map(([key, value]) => [key, { ...value, at: 1 }]));
const group = (id: string, name: string, more: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name,
  at: 1,
  ...more,
});

/** One of everything: a folder, a copy here, two only there, and an old one. */
const EVERYTHING: Partial<StartInput> = {
  records: [folder("f-local", "课程片头", 50)],
  projects: [
    kept("f-local", "课程片头", { folder: true, updatedAt: 45 }),
    kept("k-here", "产品发布", { updatedAt: 20 }),
    kept("old", "旧项目", { updatedAt: 7 }),
  ],
  links: [link("k-here", "p-launch")],
  listed: [
    listed("p-vlog", "旅行 Vlog", { repository: repository("vlog"), updatedAt: 60 }),
    listed("p-launch", "产品发布", { repository: repository("launch") }),
    listed("p-remote", "年会开场", { repository: repository("annual"), updatedAt: 90 }),
  ],
};

const byName = (cards: readonly ProjectCard[], name: string) => {
  const card = cards.find((each) => each.name === name);
  if (!card) throw new Error(`no card ${name}`);
  return card;
};

const CONTEXT: CardContext = { folder: "ready", copies: 0 };
const DAY = 24 * 3600_000;

describe("the cards of the start page", () => {
  it("are one of each project, of the kind it is", () => {
    const cards = composeCards(listsOf(EVERYTHING), { marks: new Map(), groups: [] });
    expect(cards.map((card) => [card.name, card.kind])).toEqual([
      ["课程片头", "local"],
      ["旅行 Vlog", "cloudRemote"],
      ["产品发布", "cloudHere"],
      ["年会开场", "cloudRemote"],
      ["旧项目", "onlyHere"],
    ]);
    // A link opens what this browser keeps; one that it has nothing of has no address here.
    expect(cards.map((card) => card.key)).toEqual([
      "f-local",
      undefined,
      "k-here",
      undefined,
      "old",
    ]);
    expect(new Set(cards.map((card) => card.id)).size).toBe(5);
  });

  it("know when each was opened here, and when it changed", () => {
    const cards = composeCards(listsOf(EVERYTHING), {
      marks: marks({
        "k-here": { openedAt: 80 },
        "cloud:p-remote": { openedAt: 85 },
        "f-local": { openedAt: 30 },
      }),
      groups: [],
    });
    expect(cards.map((card) => [card.name, card.openedAt, card.updatedAt])).toEqual([
      // The later of what the folder and what this browser say.
      ["课程片头", 50, 45],
      // Never opened, as the backend says.
      ["旅行 Vlog", undefined, 60],
      // What the backend says, on whichever computer: not what this browser kept by its own key.
      ["产品发布", undefined, 100],
      ["年会开场", 85, 90],
      // From before this was noted: when it changed is what there is.
      ["旧项目", 7, 7],
    ]);
  });

  it("have the stars and the groups people gave them, of the project of the platform first", () => {
    const groups = [group("g-work", "工作"), group("g-gone", "删掉的", { deleted: true })];
    const cards = composeCards(listsOf(EVERYTHING), {
      marks: marks({
        "f-local": { starredAt: 3, group: "g-work" },
        "cloud:p-vlog": { starredAt: null },
        "cloud:p-remote": { group: "g-gone" },
        old: { starredAt: 9 },
      }),
      groups,
    });
    expect(cards.map((card) => [card.name, card.starred, card.group, card.marksKey])).toEqual([
      ["课程片头", true, "g-work", "f-local"],
      ["旅行 Vlog", false, undefined, "cloud:p-vlog"],
      ["产品发布", false, undefined, "cloud:p-launch"],
      // A group that was taken away leads nowhere.
      ["年会开场", false, undefined, "cloud:p-remote"],
      ["旧项目", true, undefined, "old"],
    ]);
  });

  it("say where a star goes: the project on the backend, or what this browser keeps it by", () => {
    const cards = composeCards(listsOf(EVERYTHING), NOTHING_ORGANIZED);
    expect(cards.map(marksTargetOf)).toEqual([
      { key: "f-local" },
      { key: "cloud:p-vlog" },
      { key: "cloud:p-launch" },
      { key: "cloud:p-remote" },
      { key: "old" },
    ]);
  });

  it("cannot organise a project of another account", () => {
    const cards = composeCards(
      listsOf({
        projects: [kept("k", "别人的")],
        links: [link("k", "p-other", { owner: "user-bob" })],
        listed: "unreadable",
      }),
      { marks: marks({ "cloud:p-other": { starredAt: 1 } }), groups: [] },
    );
    expect(cards[0]).toMatchObject({ marksKey: undefined, starred: false });
    expect(cardActions(cards[0] as ProjectCard, CONTEXT).flat()).not.toContain("star");
    expect(cardStatus(cards[0] as ProjectCard, undefined, t).text).toBe("是另一个账号的");
  });

  it("show the groups by name, without those taken away", () => {
    expect(
      shownGroups([
        group("b", "频道"),
        group("a", "工作 10"),
        group("c", "工作 9"),
        group("d", "x", { deleted: true }),
      ]).map((each) => each.name),
    ).toEqual(["工作 9", "工作 10", "频道"]);
  });
});

describe("what a card says", () => {
  const cards = composeCards(listsOf(EVERYTHING), { marks: new Map(), groups: [] });
  const line = (name: string, folderStatus: Parameters<typeof cardStatus>[1] = "ready") =>
    cardStatus(byName(cards, name), folderStatus, t);

  it("says where each project is", () => {
    // A folder says its folder, a project of the platform its repository.
    expect(cards.map((card) => cardStatus(card, "ready", t).text)).toEqual([
      "dir-f-local",
      "ada/vlog",
      "ada/launch",
      "ada/annual",
      "只在浏览器里",
    ]);
    expect(cards.map((card) => cardStatus(card, "ready", t).place)).toEqual([
      "folder",
      "cloud",
      "cloud",
      "cloud",
      "browser",
    ]);
    // That it is not on this computer yet is for hovering.
    expect(cards.map((card) => cardStatus(card, "ready", t).hint)).toEqual([
      expect.any(String),
      "这台电脑还没打开过",
      undefined,
      "这台电脑还没打开过",
      expect.any(String),
    ]);
    expect(cards.map((card) => cardPlace(card, t))).toEqual([
      "本地 · dir-f-local",
      "ada/vlog",
      "ada/launch",
      "ada/annual",
      "只在浏览器里",
    ]);
  });

  it("stands out for a project only in this browser, with what to do", () => {
    expect(line("旧项目")).toMatchObject({
      tone: "warning",
      hint: expect.stringContaining("会丢"),
    });
  });

  it("says that a folder cannot be found", () => {
    expect(line("课程片头", "gone")).toMatchObject({ text: "找不到文件夹", tone: "warning" });
    expect(line("课程片头", "blocked")).toMatchObject({
      text: "浏览器不允许访问",
      tone: "warning",
    });
    // Asking for the folder again is how folders are after a restart of the browser.
    expect(line("课程片头", "ask")).toMatchObject({ text: "dir-f-local", tone: "plain" });
  });

  it("says what needs people, in place of where it is", () => {
    const troubled = composeCards(
      listsOf({
        projects: [kept("f", "原子"), kept("k", "改了的"), kept("s", "暂停的")],
        links: [
          link("f", "p-atom", { pending: 2 }),
          link("k", "p-k", { pending: 1 }),
          link("s", "p-s"),
        ],
        listed: [
          listed("p-atom", "原子", { repository: repository("atom") }),
          listed("p-k", "改了的", { repository: repository("k") }),
          listed("p-s", "暂停的", { attention: "repository", repository: repository("s") }),
          listed("p-half", "半截的", { attention: "noRepository" }),
          listed("p-gone", "取回的", { copy: "released", repository: repository("g") }),
          listed("p-failed", "没取回的", {
            copy: "released",
            copyProblem: { code: "unreadable", at: 1, files: ["timeline.json"] },
            repository: repository("h"),
          }),
        ],
      }),
      { marks: new Map(), groups: [] },
    );
    expect(
      troubled
        .map((card) => cardStatus(card, "ready", t))
        .map(({ text, tone }) => `${text} ${tone}`),
    ).toEqual([
      "有改动还没同步 warning",
      "有改动还没同步 warning",
      "GitHub 同步失败 warning",
      "还差一步：选仓库 warning",
      "打开时从 GitHub 取回 plain",
      "上次从 GitHub 取回没成功 warning",
    ]);
  });

  it("says that a copy syncs again once somebody signs in", () => {
    const signedOut = composeCards(
      listsOf({ projects: [kept("k", "产品发布")], links: [link("k", "p")], listed: "signedOut" }),
      { marks: new Map(), groups: [] },
    );
    expect(cardStatus(signedOut[0] as ProjectCard, undefined, t).text).toBe("登录后继续同步");
  });
});

describe("what a card says of the platform's copy", () => {
  const NOW = Date.UTC(2026, 10, 12, 12);
  const releaseAt = NOW + 3 * DAY;

  it("says a project with no repository yet is one step short, and does not say it goes", () => {
    const cards = composeCards(
      listsOf({
        listed: [
          listed("p-half", "半截的", { attention: "noRepository", releaseAt }),
          listed("p-old", "以前的", { attention: "noRepository" }),
        ],
      }),
      NOTHING_ORGANIZED,
    );
    for (const name of ["半截的", "以前的"]) {
      const said = cardStatus(byName(cards, name), "ready", t, NOW);
      expect(said).toMatchObject({ text: "还差一步：选仓库", tone: "warning" });
      expect(said).not.toHaveProperty("way");
      expect(said).not.toHaveProperty("alert");
    }
  });

  it("says when it was last opened, on any computer, on hovering", () => {
    const cards = composeCards(
      listsOf({
        listed: [
          listed("p-a", "九天前的", { repository: repository("a"), openedAt: NOW - 9 * DAY }),
          listed("p-b", "刚打开的", { repository: repository("b"), openedAt: NOW - 3 * 60_000 }),
          listed("p-c", "没记的", { repository: repository("c") }),
        ],
      }),
      NOTHING_ORGANIZED,
    );
    // None of them was opened on this computer: that comes first.
    expect(cardStatus(byName(cards, "九天前的"), "ready", t, NOW).hint).toBe(
      "这台电脑还没打开过\n上次打开：9 天前",
    );
    expect(cardStatus(byName(cards, "刚打开的"), "ready", t, NOW).hint).toBe(
      "这台电脑还没打开过\n上次打开：3 分钟前",
    );
    expect(cardStatus(byName(cards, "没记的"), "ready", t, NOW).hint).toBe("这台电脑还没打开过");
  });

  it("says that it comes back from GitHub, and why, while it does", () => {
    const cards = composeCards(
      listsOf({
        listed: [
          listed("p-r", "取回中", {
            copy: "restoring",
            releasedAt: NOW - DAY,
            repository: repository("r"),
          }),
          listed("p-n", "恢复中", { copy: "restoring", repository: repository("n") }),
        ],
      }),
      NOTHING_ORGANIZED,
    );
    // The line says what goes on, hovering why.
    const coming = cardStatus(byName(cards, "取回中"), "ready", t, NOW);
    expect(coming.text).toBe("正在从 GitHub 取回…");
    expect(coming.hint).toBe("正在从 GitHub 取回…");
    expect(cardStatus(byName(cards, "恢复中"), "ready", t, NOW).text).toBe("正在从 GitHub 取回…");
  });

  it("says in how many days what GitHub does not have goes, on hovering an error", () => {
    const cards = composeCards(
      listsOf({
        listed: [
          listed("p-s", "暂停的", {
            attention: "repository",
            repository: { ...repository("s"), state: "paused", reason: "archived" },
            archive: { seq: 3, behind: true },
            releaseAt,
          }),
        ],
      }),
      NOTHING_ORGANIZED,
    );
    const said = cardStatus(byName(cards, "暂停的"), "ready", t, NOW);
    // The line does not change: only what hovering says.
    expect(said.text).toBe("GitHub 同步失败");
    expect(said.hint).not.toMatch(/天后清掉/);
  });
});

describe("what the menu of a card offers", () => {
  const cards = composeCards(listsOf(EVERYTHING), { marks: new Map(), groups: [] });
  const actions = (name: string, context: Partial<CardContext> = {}) =>
    cardActions(byName(cards, name), { ...CONTEXT, ...context });

  it("offers only what works now, by kind", () => {
    expect(actions("课程片头")).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["removeFromList"],
    ]);
    expect(actions("课程片头", { copies: 1024 })).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["releaseCopies"],
      ["removeFromList"],
    ]);
    expect(actions("产品发布")).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["saveToFolder", "openOnGitHub"],
      ["deleteCloud"],
    ]);
    // Nothing of it in this browser: renamed only where the platform renames it.
    expect(actions("年会开场")).toEqual([
      ["open", "star", "moveToGroup"],
      ["saveToFolder", "openOnGitHub"],
      ["deleteCloud"],
    ]);
    expect(actions("年会开场", { renamesOnline: true })[0]).toEqual([
      "open",
      "rename",
      "star",
      "moveToGroup",
    ]);
    expect(actions("旧项目")).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["saveCopy"],
      ["delete"],
    ]);
  });

  it("offers to let go of the copy on the platform only where people may, before deleting", () => {
    expect(actions("产品发布", { releasable: true })).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["saveToFolder", "openOnGitHub"],
      ["releasePlatform", "deleteCloud"],
    ]);
    // Not of a folder, nor of what is only in this browser.
    expect(actions("课程片头", { releasable: true }).flat()).not.toContain("releasePlatform");
    expect(actions("旧项目", { releasable: true }).flat()).not.toContain("releasePlatform");
    // Not let go of already.
    const released = composeCards(
      listsOf({ listed: [listed("p-r", "放掉的", { copy: "released" })] }),
      NOTHING_ORGANIZED,
    );
    expect(
      cardActions(byName(released, "放掉的"), { ...CONTEXT, releasable: true }).flat(),
    ).not.toContain("releasePlatform");
  });

  it("offers to find a folder again, or to save it elsewhere, where it is gone", () => {
    expect(actions("课程片头", { folder: "gone" })).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["findAgain", "saveElsewhere"],
      ["removeFromList"],
    ]);
    expect(actions("课程片头", { copies: 1024 }).flat()).toContain("releaseCopies");
  });

  it("deletes on the platform whatever the platform's list has, with or without a repository", () => {
    const half = composeCards(
      listsOf({
        projects: [kept("f", "半截的文件夹")],
        links: [link("f", "p-f")],
        listed: [
          listed("p-f", "半截的文件夹", { attention: "noRepository" }),
          listed("p-half", "半截的", { attention: "noRepository" }),
        ],
      }),
      { marks: new Map(), groups: [] },
    );
    expect(half.map((card) => cardActions(card, CONTEXT).flat().includes("deleteCloud"))).toEqual([
      true,
      true,
    ]);
    expect(cards.map((card) => cardActions(card, CONTEXT).flat().includes("deleteCloud"))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    // Not what only this browser remembers, as of another account.
    const remembered = composeCards(
      listsOf({ projects: [kept("k", "别人的")], links: [link("k", "p-x")], listed: "signedOut" }),
      { marks: new Map(), groups: [] },
    );
    expect(cardActions(remembered[0] as ProjectCard, CONTEXT).flat()).not.toContain("deleteCloud");
  });

  it("says that a project cannot be edited, until when, and offers only the ways out", () => {
    const now = 1_000_000;
    const unusable = (reason: string, more: object = {}) => ({
      reason,
      since: now - DAY,
      deleteAt: now + 6 * DAY + 1,
      ...more,
    });
    const shown = composeCards(
      listsOf({
        projects: [kept("f", "有文件夹的"), kept("k", "浏览器里的")],
        links: [link("f", "p-f"), link("k", "p-k")],
        listed: [
          listed("p-f", "有文件夹的", {
            repository: { ...repository("f"), unusable: unusable("gone", { gone: "deleted" }) },
          }),
          listed("p-k", "浏览器里的", {
            repository: { ...repository("k"), unusable: unusable("uninstalled") },
          }),
          listed("p-r", "没打开过的", {
            repository: { ...repository("r"), unusable: unusable("transferred") },
          }),
          // The platform has nothing of it any more: there is nothing to copy.
          listed("p-x", "取不到的", {
            copy: "released",
            repository: { ...repository("x"), unusable: unusable("gone") },
          }),
        ],
      }),
      { marks: new Map(), groups: [] },
    );
    expect(shown.map(isUnusable)).toEqual([true, true, true, true]);
    expect(shown.map((card) => cardStatus(card, "ready", t, now))).toEqual([
      expect.objectContaining({ text: "仓库已删除，7 天后自动删除", tone: "warning" }),
      expect.objectContaining({
        text: "AnimaQuill 在 GitHub 上的授权被卸载了，7 天后自动删除",
        tone: "warning",
      }),
      expect.objectContaining({ text: "仓库已转到别的账号，7 天后自动删除", tone: "warning" }),
      expect.objectContaining({ text: "找不到这个项目的 GitHub 仓库，7 天后自动删除" }),
    ]);
    expect(cardActions(shown[0] as ProjectCard, CONTEXT)).toEqual([
      // Not renamed: it cannot be edited.
      ["open", "star", "moveToGroup"],
      ["saveToFolder", "recheck", "switchRepository", "openOnGitHub"],
      ["deleteCloud"],
    ]);
    expect(cardActions(shown[1] as ProjectCard, CONTEXT)[1]).toEqual([
      "saveToFolder",
      "reinstall",
      "recheck",
      "switchRepository",
      "openOnGitHub",
    ]);
    expect(cardActions(shown[2] as ProjectCard, CONTEXT)[1]).toEqual([
      "saveToFolder",
      "switchRepository",
      "recheck",
      "openOnGitHub",
    ]);
    // Nothing to copy, and nothing to save into another repository.
    expect(cardActions(shown[3] as ProjectCard, CONTEXT)[1]).toEqual([
      "reauthorize",
      "recheck",
      "openOnGitHub",
    ]);
    // Clicking it says why, with these ways out, and deleting it last.
    expect(unusableChoices(shown[0] as ProjectCard, CONTEXT)).toEqual([
      "saveToFolder",
      "recheck",
      "switchRepository",
      "deleteCloud",
    ]);
  });

  it("says only where saving into GitHub went wrong, why, and what helps", () => {
    const NOW = Date.UTC(2026, 10, 12, 12);
    const HOUR = 3600_000;
    const shown = composeCards(
      listsOf({
        projects: [kept("k", "改了的")],
        links: [link("k", "p-k")],
        listed: [
          listed("p-k", "改了的", {
            repository: repository("k"),
            archive: { seq: 3, behind: true },
          }),
          listed("p-r", "存好的", {
            repository: repository("r"),
            archive: { seq: 3, behind: false },
          }),
          listed("p-t", "重试中的", {
            repository: repository("t"),
            archive: { seq: 3, behind: true, failingSince: NOW - HOUR + 60_000 },
          }),
          listed("p-l", "一直失败的", {
            repository: repository("l"),
            archive: { seq: 3, behind: true, failingSince: NOW - 3 * HOUR },
          }),
          listed("p-s", "暂停的", {
            attention: "repository",
            repository: { ...repository("s"), state: "paused", reason: "archived" },
            archive: { seq: 3, behind: true },
          }),
        ],
      }),
      { marks: new Map(), groups: [] },
    );
    const said = shown.map((card) => cardStatus(card, "ready", t, NOW));
    // On their way: plain words, nothing to do.
    expect(said.map(({ text, tone }) => `${text} ${tone}`)).toEqual([
      "待同步 plain",
      "ada/r plain",
      "待同步 plain",
      "GitHub 同步失败 warning",
      "GitHub 同步失败 warning",
    ]);
    expect(said[0]?.hint).toBe(
      "有改动还没存进 GitHub，服务器会自动存进去（停手 5 分钟，或连续编辑 30 分钟存一次），不用管。",
    );
    // An error says why, and what helps.
    expect(said[3]?.hint).toBe(
      "存进 GitHub 失败：已经连续 3 个多小时没能存进去（GitHub 暂时连不上、限流，或者服务器出了错）。服务器会一直自动重试；也可以点“现在存档”再试一次，或者换一个仓库。",
    );
    expect(said[4]?.hint).toBe(
      "存进 GitHub 失败：仓库在 GitHub 上已归档，只能读。在 GitHub 上取消归档后点“现在存档”，或者换一个仓库。",
    );
  });

  it("opens GitHub only at an https address: the platform's word is not checked", () => {
    const odd = composeCards(
      listsOf({
        listed: [
          listed("p-1", "怪的", { repository: repository("odd", "javascript:alert(1)") }),
          listed("p-2", "好的", { repository: repository("fine") }),
        ],
      }),
      { marks: new Map(), groups: [] },
    );
    expect(odd.map(gitHubAddress)).toEqual([undefined, "https://github.com/ada/fine"]);
    expect(cardActions(odd[0] as ProjectCard, CONTEXT).flat()).not.toContain("openOnGitHub");
  });

  it("offers to take the star away from a starred one", () => {
    const starred = composeCards(listsOf(EVERYTHING), {
      marks: marks({ old: { starredAt: 1 } }),
      groups: [],
    });
    expect(cardActions(byName(starred, "旧项目"), CONTEXT)[0]).toEqual([
      "open",
      "rename",
      "unstar",
      "moveToGroup",
    ]);
  });
});

describe("a card without a cover", () => {
  it("has a color of its own, the same wherever it is listed, and the first letter of its name", () => {
    const cards = composeCards(listsOf(EVERYTHING), { marks: new Map(), groups: [] });
    const colors = cards.map(coverColorOf);
    expect(colors.every((color) => color >= 1 && color <= 8)).toBe(true);
    expect(cards.map(coverColorOf)).toEqual(colors);
    expect(new Set(colors).size).toBeGreaterThan(1);
    expect(initialOf(" vlog 第三集")).toBe("V");
    expect(initialOf("原子是什么")).toBe("原");
    expect(initialOf("")).toBe("?");
  });
});
