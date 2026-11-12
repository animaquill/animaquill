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
  scope: "browser",
  at: 1,
  ...more,
});

/** One of everything: a folder, a connected folder, a copy here, one only there, and an old one. */
const EVERYTHING: Partial<StartInput> = {
  records: [folder("f-local", "课程片头", 50), folder("f-cloud", "旅行 Vlog", 40)],
  projects: [
    kept("f-local", "课程片头", { folder: true, updatedAt: 45 }),
    kept("f-cloud", "旅行 Vlog", { folder: true, updatedAt: 30 }),
    kept("k-here", "产品发布", { updatedAt: 20 }),
    kept("old", "旧项目", { updatedAt: 7 }),
  ],
  links: [link("f-cloud", "p-vlog"), link("k-here", "p-launch")],
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

const CONTEXT: CardContext = { hasPlatform: true, canFolders: true, folder: "ready", copies: 0 };
const DAY = 24 * 3600_000;

describe("the cards of the start page", () => {
  it("are one of each project, of the kind it is", () => {
    const cards = composeCards(listsOf(EVERYTHING), { marks: new Map(), groups: [] });
    expect(cards.map((card) => [card.name, card.kind])).toEqual([
      ["课程片头", "local"],
      ["旅行 Vlog", "cloudFolder"],
      ["产品发布", "cloudHere"],
      ["年会开场", "cloudRemote"],
      ["旧项目", "onlyHere"],
    ]);
    // A link opens what this browser keeps; one that it has nothing of has no address here.
    expect(cards.map((card) => card.key)).toEqual([
      "f-local",
      "f-cloud",
      "k-here",
      undefined,
      "old",
    ]);
    expect(new Set(cards.map((card) => card.id)).size).toBe(5);
  });

  it("know when each was opened here, and when it changed", () => {
    const cards = composeCards(listsOf(EVERYTHING), {
      marks: marks({ "k-here": { openedAt: 80 }, "f-local": { openedAt: 30 } }),
      groups: [],
    });
    expect(cards.map((card) => [card.name, card.openedAt, card.updatedAt])).toEqual([
      // The later of what the folder and what this browser say.
      ["课程片头", 50, 45],
      // The later of its log and the platform.
      ["旅行 Vlog", 40, 60],
      ["产品发布", 80, 100],
      // Never opened here: it is not "recent".
      ["年会开场", undefined, 90],
      // From before this was noted: when it changed is what there is.
      ["旧项目", 7, 7],
    ]);
  });

  it("have the stars and the groups people gave them, of the project of the platform first", () => {
    const groups = [group("g-work", "工作"), group("g-gone", "删掉的", { deleted: true })];
    const cards = composeCards(listsOf(EVERYTHING), {
      marks: marks({
        "f-local": { starredAt: 3, group: "g-work" },
        // Organised before it was connected, and again since.
        "f-cloud": { starredAt: 3, group: "g-work" },
        "cloud:p-vlog": { starredAt: null },
        "cloud:p-remote": { group: "g-gone" },
        old: { starredAt: 9 },
      }),
      groups,
    });
    expect(cards.map((card) => [card.name, card.starred, card.group, card.marksKey])).toEqual([
      ["课程片头", true, "g-work", "f-local"],
      ["旅行 Vlog", false, "g-work", "cloud:p-vlog"],
      ["产品发布", false, undefined, "cloud:p-launch"],
      // A group that was taken away leads nowhere.
      ["年会开场", false, undefined, "cloud:p-remote"],
      ["旧项目", true, undefined, "old"],
    ]);
  });

  it("keep the star and the group of a folder that was disconnected, as they were last", () => {
    // Connected, it was starred and moved; both are kept where the folder is kept too.
    const organized = {
      marks: new Map([
        ["cloud:p-vlog", { starredAt: 40, starAt: 40, group: "g-work", groupAt: 41, at: 41 }],
        ["f-cloud", { starredAt: 40, starAt: 40, group: "g-work", groupAt: 41, at: 41 }],
        // From before it was connected, which no longer counts.
        ["f-local", { starredAt: null, starAt: 5, at: 5 }],
      ]),
      groups: [group("g-work", "工作")],
    };
    const connected = composeCards(listsOf(EVERYTHING), organized);
    expect(byName(connected, "旅行 Vlog")).toMatchObject({ starred: true, group: "g-work" });
    const disconnected = composeCards(
      listsOf({ ...EVERYTHING, links: [link("k-here", "p-launch")] }),
      organized,
    );
    expect(byName(disconnected, "旅行 Vlog")).toMatchObject({
      kind: "local",
      starred: true,
      group: "g-work",
    });
    // Whatever was changed last counts, of either.
    const later = composeCards(listsOf(EVERYTHING), {
      ...organized,
      marks: new Map([...organized.marks, ["f-cloud", { starredAt: null, starAt: 50, at: 50 }]]),
    });
    expect(byName(later, "旅行 Vlog")).toMatchObject({ starred: false, group: "g-work" });
  });

  it("say where a star goes, with whose project of the platform it is", () => {
    const cards = composeCards(listsOf(EVERYTHING), NOTHING_ORGANIZED);
    expect(cards.map(marksTargetOf)).toEqual([
      { key: "f-local" },
      { key: "cloud:p-vlog", also: "f-cloud", account: "user-ada" },
      { key: "cloud:p-launch", also: "k-here", account: "user-ada" },
      // Never opened here: whose it is, as the list of whoever is signed in has it.
      { key: "cloud:p-remote", account: "user-ada" },
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
    expect(cardStatus(cards[0] as ProjectCard, undefined, t).text).toBe("云端 · 是另一个账号的");
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
    expect(cards.map((card) => cardStatus(card, "ready", t).text)).toEqual([
      "本地 · dir-f-local",
      "云端 · 文件夹也有一份",
      "云端 · 只在这个浏览器里",
      "云端 · 这台电脑还没打开过",
      "只在浏览器里",
    ]);
    expect(cards.map((card) => cardStatus(card, "ready", t).place)).toEqual([
      "folder",
      "cloud",
      "cloud",
      "cloud",
      "browser",
    ]);
    expect(cards.map((card) => cardPlace(card, t))).toEqual([
      "本地 · dir-f-local",
      "云端 · ada/vlog",
      "云端 · ada/launch",
      "云端 · ada/annual",
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
    expect(line("旅行 Vlog", "blocked")).toMatchObject({
      text: "云端 · 浏览器不允许访问",
      tone: "warning",
    });
    // Asking for the folder again is how folders are after a restart of the browser.
    expect(line("课程片头", "ask")).toMatchObject({ text: "本地 · dir-f-local", tone: "plain" });
  });

  it("says what needs people, in place of where it is", () => {
    const troubled = composeCards(
      listsOf({
        records: [folder("f", "原子")],
        projects: [kept("f", "原子", { folder: true }), kept("k", "改了的"), kept("s", "暂停的")],
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
        ],
      }),
      { marks: new Map(), groups: [] },
    );
    expect(
      troubled
        .map((card) => cardStatus(card, "ready", t))
        .map(({ text, tone }) => `${text} ${tone}`),
    ).toEqual([
      "云端 · 有改动还没同步 warning",
      "云端 · 有改动还没同步 warning",
      "云端 · 要处理 warning",
      "云端 · 还差一步：选仓库 warning",
      "云端 · 打开时从 GitHub 取回 plain",
    ]);
  });

  it("says that a copy syncs again once somebody signs in", () => {
    const signedOut = composeCards(
      listsOf({ projects: [kept("k", "产品发布")], links: [link("k", "p")], listed: "signedOut" }),
      { marks: new Map(), groups: [] },
    );
    expect(cardStatus(signedOut[0] as ProjectCard, undefined, t).text).toBe(
      "云端 · 登录后继续同步",
    );
  });
});

describe("what the menu of a card offers", () => {
  const cards = composeCards(listsOf(EVERYTHING), { marks: new Map(), groups: [] });
  const actions = (name: string, context: Partial<CardContext> = {}) =>
    cardActions(byName(cards, name), { ...CONTEXT, ...context });

  it("offers only what works now, by kind", () => {
    expect(actions("课程片头")).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["connect"],
      ["removeFromList"],
    ]);
    expect(actions("旅行 Vlog")).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["disconnect", "saveAsLocal", "openOnGitHub"],
      ["removeFromList", "deleteCloud"],
    ]);
    expect(actions("产品发布")).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["linkFolder", "saveAsLocal", "openOnGitHub"],
      ["removeHere", "deleteCloud"],
    ]);
    // It cannot be renamed before the platform can change what it has without an editor on it.
    expect(actions("年会开场")).toEqual([
      ["open", "star", "moveToGroup"],
      ["linkFolder", "saveAsLocal", "openOnGitHub"],
      ["deleteCloud"],
    ]);
    expect(actions("旧项目")).toEqual([
      ["open", "rename", "star", "moveToGroup"],
      ["moveToFolder", "connect", "saveCopy"],
      ["delete"],
    ]);
  });

  it("has nothing that needs folders where the browser cannot write them", () => {
    const flat = (name: string) => actions(name, { canFolders: false }).flat();
    expect(flat("产品发布")).not.toContain("linkFolder");
    expect(flat("年会开场")).not.toContain("linkFolder");
    expect(flat("年会开场")).not.toContain("saveAsLocal");
    expect(flat("旧项目")).not.toContain("moveToFolder");
  });

  it("has nothing of the platform where the editor is hosted on none", () => {
    expect(actions("课程片头", { hasPlatform: false }).flat()).not.toContain("connect");
    expect(actions("旧项目", { hasPlatform: false }).flat()).not.toContain("connect");
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
        records: [folder("f", "半截的文件夹")],
        projects: [kept("f", "半截的文件夹", { folder: true })],
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
        records: [folder("f", "有文件夹的")],
        projects: [kept("f", "有文件夹的", { folder: true }), kept("k", "浏览器里的")],
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
      ["saveAsLocal", "recheck", "switchRepository", "disconnect", "openOnGitHub"],
      ["removeFromList", "deleteCloud"],
    ]);
    expect(cardActions(shown[1] as ProjectCard, CONTEXT)[1]).toEqual([
      "saveAsLocal",
      "reinstall",
      "recheck",
      "switchRepository",
      "openOnGitHub",
    ]);
    expect(cardActions(shown[2] as ProjectCard, CONTEXT)[1]).toEqual([
      "saveAsLocal",
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
      "saveAsLocal",
      "recheck",
      "switchRepository",
      "disconnect",
      "deleteCloud",
    ]);
  });

  it("says that the platform keeps changes that are not in the repository only a week", () => {
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
        ],
      }),
      { marks: new Map(), groups: [] },
    );
    expect(shown.map((card) => cardStatus(card, "ready", t).text)).toEqual([
      "有未保存的更改，平台只保留 7 天",
      "云端 · 这台电脑还没打开过",
    ]);
    expect(cardStatus(shown[0] as ProjectCard, "ready", t).tone).toBe("warning");
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
