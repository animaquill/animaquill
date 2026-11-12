/**
 * How a project stands with its repository, in three words: each thing the platform says goes to
 * one of them, see the table at the top of github-status.ts.
 */
import type { CloudProjectSummary, RepositoryStatus } from "@animaquill/host";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import {
  FAILING_LONG_MS,
  githubAbout,
  githubOfListed,
  githubOfStatus,
  githubText,
  type GitHubState,
} from "./github-status.ts";

const i18n = createInstance();
await i18n.init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
});
const t = i18n.t;

const NOW = Date.UTC(2026, 10, 12, 12);
const MINUTE = 60_000;

const status = (more: Partial<RepositoryStatus> = {}): RepositoryStatus => ({
  state: "ready",
  archiving: false,
  head: 9,
  archivedSeq: 9,
  ...more,
});

const said = (state: GitHubState) => `${state.kind} ${state.cause} ${githubText(state, t)}`;
const of = (more: Partial<RepositoryStatus>) =>
  said(githubOfStatus({ status: status(more), now: NOW }, t));

describe("how the open project stands with its repository", () => {
  it("is synced, pending or an error by what the platform says", () => {
    expect(of({})).toBe("synced synced 已同步");
    expect(of({ head: 11 })).toBe("pending waiting 待同步");
    expect(of({ dirtySince: NOW - MINUTE })).toBe("pending waiting 待同步");
    expect(of({ head: 11, archiving: true })).toBe("pending archiving 待同步");
    // GitHub away, limiting, the platform's own error: tried again by itself, for an hour.
    expect(of({ head: 11, failures: 3, failingSince: NOW - FAILING_LONG_MS + 1 })).toBe(
      "pending retrying 待同步",
    );
    expect(of({ head: 11, failures: 30, failingSince: NOW - FAILING_LONG_MS })).toBe(
      "error failingLong 同步失败",
    );
    // Whatever pauses archiving needs people, also a reason of a newer platform.
    for (const reason of [
      "diverged",
      "gone",
      "uninstalled",
      "suspended",
      "archived",
      "protected",
      "transferred",
      "manifest",
      "invalid",
      "somethingNew",
    ])
      expect(of({ state: "paused", reason })).toBe("error paused 同步失败");
    expect(of({ kept: ["scenes/a/scene.json"] })).toBe("error kept 同步失败");
    expect(of({ state: "none" })).toBe("error noRepository 还差一步：选仓库");
    expect(said(githubOfStatus({ status: undefined, now: NOW }, t))).toBe("pending unknown 待同步");
    expect(said(githubOfStatus({ status: undefined, unfinished: true, now: NOW }, t))).toBe(
      "error unfinished 还没连接完",
    );
    // A repository that cannot be used says more than any pause.
    expect(
      said(
        githubOfStatus(
          {
            status: status({ state: "paused", reason: "gone" }),
            unusable: { reason: "gone", since: NOW, gone: "deleted" },
            now: NOW,
          },
          t,
        ),
      ),
    ).toBe("error unusable 仓库已删除");
  });

  it("says, where it went wrong, why, what helps and that the platform keeps it a week", () => {
    const paused = githubOfStatus(
      {
        status: status({ state: "paused", reason: "protected", detail: "Use a pull request." }),
        now: NOW,
      },
      t,
    );
    expect(githubAbout(paused, t)).toBe(
      "存进 GitHub 失败：GitHub 不让存档写进这个仓库（GitHub 的原话：Use a pull request.）。仓库可能设了保护规则，不让直接写入。在 GitHub 上去掉这条规则后点“现在存档”，或者换一个仓库。平台临时存储只保存 7 天，请尽快处理。",
    );
    expect(githubAbout(githubOfStatus({ status: status({ head: 11 }), now: NOW }, t), t)).toBe(
      "有改动还没存进 GitHub，平台会自动存进去（停手 5 分钟，或连续编辑 30 分钟存一次），不用管。",
    );
    expect(githubAbout(githubOfStatus({ status: status(), now: NOW }, t), t)).toBe(
      "改动都已存进 GitHub 仓库。",
    );
  });
});

describe("how a project of the list stands with its repository", () => {
  const repository: NonNullable<CloudProjectSummary["repository"]> = {
    id: 1,
    owner: "ada",
    name: "atom",
    fullName: "ada/atom",
    private: true,
    url: "https://github.com/ada/atom",
    state: "ready",
  };
  const listed = (more: Partial<CloudProjectSummary>) =>
    said(githubOfListed({ repository, archive: { seq: 3, behind: false }, ...more }, NOW, t));

  it("goes by the list the same way", () => {
    expect(listed({})).toBe("synced synced 已同步");
    expect(listed({ archive: { seq: 3, behind: true } })).toBe("pending waiting 待同步");
    expect(listed({ archive: { seq: 3, behind: true, failingSince: NOW - MINUTE } })).toBe(
      "pending retrying 待同步",
    );
    expect(
      listed({ archive: { seq: 3, behind: true, failingSince: NOW - 2 * FAILING_LONG_MS } }),
    ).toBe("error failingLong 同步失败");
    expect(
      listed({
        attention: "repository",
        repository: { ...repository, state: "paused", reason: "archived" },
      }),
    ).toBe("error paused 同步失败");
    expect(listed({ attention: "conflicts" })).toBe("error conflicts 同步失败");
    expect(listed({ attention: "blocked" })).toBe("error blocked 同步失败");
    expect(listed({ attention: "somethingNew" })).toBe("error paused 同步失败");
    expect(said(githubOfListed({ attention: "noRepository" }, NOW, t))).toBe(
      "error noRepository 还差一步：选仓库",
    );
    expect(
      listed({
        attention: "unusable",
        repository: { ...repository, unusable: { reason: "gone", since: NOW, gone: "deleted" } },
      }),
    ).toBe("error unusable 仓库已删除");
  });
});
