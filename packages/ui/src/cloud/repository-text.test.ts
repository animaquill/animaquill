import type { RepositoryChoice, RepositoryStatus } from "@animaquill/host";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import {
  archiveStateText,
  choiceNote,
  connectRepositoryName,
  defaultRepositoryName,
  divergedOutcome,
  keptText,
  lastArchiveText,
  linkedProjectOf,
  momentText,
  nameProblem,
  nextRepositoryName,
  pauseDetail,
  pauseText,
  repositoryText,
  unusableAdvice,
  unusableReason,
  unusableText,
} from "./repository-text.ts";

const i18n = createInstance();
await i18n.init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
});
const t = i18n.t;

/** 2026-11-10 14:05 where the tests run. */
const NOW = new Date(2026, 10, 10, 14, 5, 30).getTime();
const MINUTE = 60_000;

const REPOSITORY: NonNullable<RepositoryStatus["repository"]> = {
  id: 7,
  owner: "ada",
  name: "film",
  fullName: "ada/film",
  private: true,
  branch: "main",
  url: "https://github.com/ada/film",
  createdHere: true,
  linkedAt: 1,
};

const status = (more: Partial<RepositoryStatus> = {}): RepositoryStatus => ({
  repository: REPOSITORY,
  state: "ready",
  archiving: false,
  head: 5,
  archivedSeq: 5,
  ...more,
});

const choice = (more: Partial<RepositoryChoice> = {}): RepositoryChoice => ({
  id: 1,
  owner: "ada",
  name: "notes",
  fullName: "ada/notes",
  private: true,
  pushable: true,
  empty: false,
  archived: false,
  linked: false,
  ...more,
});

describe("how saving to GitHub reads", () => {
  it("says a moment as people say it", () => {
    expect(momentText(NOW - 20_000, NOW, t)).toBe("刚刚");
    expect(momentText(new Date(2026, 10, 10, 9, 3).getTime(), NOW, t)).toBe("09:03");
    expect(momentText(new Date(2026, 10, 9, 23, 59).getTime(), NOW, t)).toBe("11月9日 23:59");
    // A moment to come is never "just now".
    expect(momentText(NOW + 20_000, NOW, t)).toBe("14:05");
  });

  it("says when it last archived, and that it never did", () => {
    const last = { sha: "a", seq: 5, kind: "manual", changed: 1, removed: 0, url: "" };
    expect(lastArchiveText(status({ lastArchive: { ...last, at: NOW - 5000 } }), NOW, t)).toBe(
      "上次存档：刚刚",
    );
    expect(
      lastArchiveText(
        status({ lastArchive: { ...last, at: new Date(2026, 10, 10, 13, 2).getTime() } }),
        NOW,
        t,
      ),
    ).toBe("上次存档：13:02");
    expect(lastArchiveText(status(), NOW, t)).toBe("还没存过档");
  });

  it("says what archiving does now: done, waiting for a quiet moment, running, failed", () => {
    expect(archiveStateText(status(), NOW, t)).toBe("改动都已存档");
    const waiting = { head: 7, dirtySince: NOW - MINUTE };
    expect(archiveStateText(status({ ...waiting, nextAt: NOW + 3 * MINUTE }), NOW, t)).toBe(
      "有新改动，约 3 分钟后存档",
    );
    expect(archiveStateText(status({ ...waiting, nextAt: NOW + 10_000 }), NOW, t)).toBe(
      "有新改动，约 1 分钟后存档",
    );
    expect(archiveStateText(status({ ...waiting, nextAt: NOW - 10_000 }), NOW, t)).toBe(
      "有新改动，马上存档",
    );
    expect(archiveStateText(status({ ...waiting, archiving: true }), NOW, t)).toBe("正在存档…");
    expect(
      archiveStateText(
        status({ ...waiting, failures: 2, retryAt: new Date(2026, 10, 10, 14, 9).getTime() }),
        NOW,
        t,
      ),
    ).toBe("上次没存成，14:09 再试");
    expect(
      archiveStateText({ state: "none", archiving: false, head: 3, archivedSeq: 0 }, NOW, t),
    ).toBe("还没存到 GitHub。存进你自己的 GitHub 仓库，云端之外多一份。");
  });

  it("says why archiving paused and what helps, for every reason the platform has", () => {
    const reasons = {
      diverged: "GitHub 上有人改了项目的 2 个文件",
      gone: "仓库不见了，或者 GitHub App 不能再访问它",
      uninstalled: "GitHub App 已经从你的账号上卸载",
      suspended: "GitHub App 在你的账号上被暂停了",
      archived: "仓库在 GitHub 上已归档，只能读",
      protected: "GitHub 不让存档写进这个仓库",
      transferred: "仓库已经转到别的账号下",
      manifest: "项目信息文件 animaquill.json 不合格式",
      invalid: "要存的文件读出来不是一个完整的项目",
    };
    for (const [reason, words] of Object.entries(reasons)) {
      const paused = status({
        state: "paused",
        reason,
        diverged: { sha: "b", files: ["a", "b"], deleted: [] },
      });
      const { reason: said, fix } = pauseText(paused, t);
      expect(said).toBe(words);
      expect(fix.length).toBeGreaterThan(4);
      expect(archiveStateText(paused, NOW, t)).toBe(`存档暂停：${words}`);
    }
    // One of a newer platform says what it is.
    expect(pauseText(status({ state: "paused", reason: "conflicts" }), t)).toEqual({
      reason: "conflicts",
      fix: "可以点“现在存档”再试，或者换一个仓库。",
    });
  });

  it("shows GitHub's words for a branch it keeps still, and what is wrong with the files", () => {
    expect(
      pauseDetail(
        { reason: "protected", detail: "Changes must be made through a pull request." },
        t,
      ),
    ).toBe("GitHub 的原话：Changes must be made through a pull request.");
    expect(pauseDetail({ reason: "invalid", detail: "timeline.json：时长要大于 0" }, t)).toBe(
      "详情：timeline.json：时长要大于 0",
    );
    // Notes for whoever runs the platform stay there.
    expect(pauseDetail({ reason: "gone", detail: "the repository was taken out" }, t)).toBe(
      undefined,
    );
  });

  it("lists files the last archive could not write", () => {
    expect(keptText(status(), t)).toBeUndefined();
    expect(keptText(status({ kept: ["scenes/a/scene.json"] }), t)).toBe(
      "这些文件这次没存进去，GitHub 上还是旧的一版：scenes/a/scene.json",
    );
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `code/${name}.js`);
    expect(keptText(status({ kept: many }), t)).toBe(
      "这些文件这次没存进去，GitHub 上还是旧的一版：code/a.js、code/b.js、code/c.js、code/d.js、code/e.js 等 7 个",
    );
  });

  it("names the repository and whether it is private", () => {
    expect(repositoryText(REPOSITORY, t)).toBe("仓库：ada/film（私有）");
    expect(repositoryText({ ...REPOSITORY, private: false }, t)).toBe("仓库：ada/film（公开）");
  });

  it("says why a repository cannot be chosen", () => {
    expect(unusableReason(choice(), undefined, undefined)).toBeUndefined();
    expect(unusableReason(choice({ pushable: false }), undefined, undefined)).toBe("notPushable");
    expect(unusableReason(choice({ archived: true }), undefined, undefined)).toBe("archived");
    expect(unusableReason(choice({ linked: true }), undefined, undefined)).toBe("linked");
    expect(unusableReason(choice({ linked: true }), undefined, 1)).toBe("current");
    // What only trying it tells.
    const there = { code: "hasProject" as const, files: ["animaquill.json", "timelines"] };
    expect(unusableReason(choice(), there, undefined)).toBe("hasProject");
    expect(unusableReason(choice(), { code: "linkedElsewhere" }, undefined)).toBe("linked");
    expect(unusableReason(choice(), { code: "notFound" }, undefined)).toBe("notFound");

    expect(unusableText("notPushable", undefined, t)).toBe("你不能往这个仓库里写");
    expect(unusableText("archived", undefined, t)).toBe("在 GitHub 上已归档，只能读");
    expect(unusableText("linked", undefined, t)).toBe("已经存着另一个项目");
    expect(unusableText("hasProject", there, t)).toBe(
      "根目录已经有项目的文件：animaquill.json、timelines",
    );
  });

  it("says whose repository one is already, and what a project found in one can become", () => {
    const linked = choice({ linked: true, linkedProject: { id: "p9", name: "片头动画" } });
    expect(linkedProjectOf(linked, undefined)).toEqual({ id: "p9", name: "片头动画" });
    expect(unusableAdvice(linked, "linked", undefined, t)).toBe("已经是云端项目“片头动画”的仓库");
    // As the platform said when people tried it.
    const refusal = { code: "linkedElsewhere" as const, project: { id: "p8", name: "年会视频" } };
    expect(linkedProjectOf(choice(), refusal)).toEqual({ id: "p8", name: "年会视频" });
    expect(unusableAdvice(choice(), "linked", refusal, t)).toBe("已经是云端项目“年会视频”的仓库");
    // Somebody else's project: only that it is taken.
    expect(linkedProjectOf(choice({ linked: true }), undefined)).toBeUndefined();
    expect(unusableAdvice(choice({ linked: true }), "linked", undefined, t)).toBe(
      "已经存着另一个项目",
    );
    expect(
      unusableAdvice(choice(), "hasProject", { code: "hasProject", files: ["animaquill.json"] }, t),
    ).toBe("根目录已经有项目的文件：animaquill.json。以后可以从这个仓库恢复成云端项目");
    expect(unusableAdvice(choice(), "archived", undefined, t)).toBe("在 GitHub 上已归档，只能读");
    // A repository with other files in it keeps them.
    expect(choiceNote(choice({ empty: false }), t)).toBe("这个仓库里已有的其他文件不会动。");
    expect(choiceNote(choice({ empty: true }), t)).toBeUndefined();
  });

  it("names the repository of a project that connects after its folder, then after itself", () => {
    expect(connectRepositoryName("atom", "原子是什么")).toBe("atom");
    expect(connectRepositoryName("My Film 2", "原子是什么")).toBe("my-film-2");
    // A folder with a name GitHub does not take: the project's own.
    expect(connectRepositoryName("原子", "Atoms Demo")).toBe("atoms-demo");
    expect(connectRepositoryName(undefined, "Atoms Demo")).toBe("atoms-demo");
    // Neither: a name that always works.
    expect(connectRepositoryName("原子", "原子是什么")).toBe("animaquill-project");
    expect(connectRepositoryName(undefined, "...")).toBe("animaquill-project");
    expect(connectRepositoryName("film.git", "x.git")).toBe("animaquill-project");
    expect(nameProblem(connectRepositoryName("a".repeat(120), "b"))).toBeUndefined();
  });

  it("tries the next name where one is taken, a few times over", () => {
    expect(nextRepositoryName("atom", 1)).toBe("atom-2");
    expect(nextRepositoryName("atom", 2)).toBe("atom-3");
    expect(nextRepositoryName("atom", 8)).toBe("atom-9");
    expect(nextRepositoryName("atom", 9)).toBeUndefined();
    // A name that would get too long is no name to try.
    expect(nextRepositoryName("a".repeat(99), 1)).toBeUndefined();
  });

  it("checks a repository name as GitHub does", () => {
    expect(nameProblem("project_x7k2m9q4ab")).toBeUndefined();
    expect(nameProblem("my-film.v2")).toBeUndefined();
    expect(nameProblem("")).toBe("empty");
    expect(nameProblem("我的片子")).toBe("characters");
    expect(nameProblem("my film")).toBe("characters");
    expect(nameProblem("..")).toBe("dots");
    expect(nameProblem("film.git")).toBe("dotGit");
    expect(nameProblem("a".repeat(101))).toBe("tooLong");
  });

  it("names a new repository after the project where GitHub takes the name, and by its id otherwise", () => {
    expect(defaultRepositoryName("My Film", "project_x7k2m9q4ab")).toBe("my-film");
    expect(defaultRepositoryName("我的片子", "project_x7k2m9q4ab")).toBe("project_x7k2m9q4ab");
    expect(defaultRepositoryName("片子 2", "project_x7k2m9q4ab")).toBe("project_x7k2m9q4ab");
    expect(defaultRepositoryName("...", "project_x7k2m9q4ab")).toBe("project_x7k2m9q4ab");
    expect(nameProblem(defaultRepositoryName("x", "本机1"))).toBeUndefined();
  });

  it("tells files written over from files taken away, where people go on with the editor's content", () => {
    const has = new Set(["timelines/main/timeline.json", "code/gone.js"]);
    expect(
      divergedOutcome(
        {
          sha: "b",
          files: [
            ".gitattributes",
            "code/gone.js",
            "code/old.js",
            "scenes/new/index.html",
            "timelines/main/timeline.json",
          ],
          deleted: ["code/gone.js", "code/old.js"],
        },
        (path) => has.has(path),
      ),
    ).toEqual({
      overwritten: [".gitattributes", "timelines/main/timeline.json"],
      removed: ["scenes/new/index.html"],
      restored: ["code/gone.js"],
    });
  });
});
