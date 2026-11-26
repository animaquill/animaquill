import { describe, expect, it } from "vitest";
import { createI18n, placedT, sayLocalRepositories } from "./i18n.ts";
import zhCN from "./zh-CN.json" with { type: "json" };

/**
 * The words of repositories of the server's own (`<key>_local`): each says a text that is there,
 * the server without GitHub hears them everywhere, and what people of such a server read about
 * archiving never says GitHub where it does not mean it.
 */

const walk = (value: unknown, path = ""): [string, string][] =>
  typeof value === "object" && value !== null
    ? Object.entries(value).flatMap(([key, inner]) => walk(inner, path ? `${path}.${key}` : key))
    : typeof value === "string"
      ? [[path, value]]
      : [];

const all = new Map(walk(zhCN));

/**
 * Where people of a server without GitHub read about their repository: every text here that says
 * GitHub has its words for a repository of the server's own, or is one that only GitHub has.
 */
const SAID_OF_REPOSITORIES = [
  "saveStatus.",
  "github.",
  "repository.pause.",
  "repository.fix.",
  "repository.status.",
  "repository.replace",
  "repoMerge.",
  "operations.",
  "cloud.panel.",
  "cloud.open.",
  "cloud.delete.",
  "cloud.wake.",
  "cloud.takeBack.",
  "cloud.copyProblem.",
  "cloud.problem.",
  "start.hint.",
  "start.status.",
  "start.card.",
  "start.new.",
  "projectProps.storage.",
  // Where assets are: since O8b repositories here have a large file storage of their own.
  "storage.uploads.",
  "storage.download",
  "storage.storedIn.",
];

/** What only GitHub has, which a server without it never shows. */
const ONLY_GITHUB = new Set([
  "cloud.panel.action.openOnGitHub",
  "cloud.panel.action.reauthorize",
  "cloud.panel.action.reinstall",
  "cloud.panel.action.restoreApp",
  "repository.pause.goneDeleted",
  "repository.pause.uninstalled",
  "repository.pause.suspended",
  "repository.pause.archived",
  "repository.pause.protected",
  "repository.fix.goneUnauthorized",
  "repository.fix.suspended",
  "repository.fix.archived",
  "repository.fix.protected",
  "repoMerge.blocked.openOnGitHub",
  "cloud.delete.unusable",
  // The cost of GitHub's large file storage, its quota, and what is said of large files because
  // of them: never asked of, or said to, a project whose repository is here (`localRepository`).
  "storage.uploads.dialog.cost",
  "storage.uploads.dialog.seeQuota",
  "storage.uploads.dialog.acknowledge",
  "storage.uploads.problem.notAcknowledged",
  "storage.uploads.fix.quota",
  "storage.uploads.fix.acknowledgeTitle",
  "storage.uploads.notice.askOne",
  "storage.uploads.notice.askMany",
  "storage.uploads.notice.askLargeOne",
  "storage.uploads.notice.askLargeMany",
  "storage.uploads.notice.cost",
  "storage.uploads.notice.batch",
  "storage.uploads.notice.largeOne",
  "storage.uploads.notice.largeMany",
  "storage.uploads.space.seeQuota",
  "storage.downloads.problem.githubQuota",
  "storage.downloads.fix.quota",
  // A link to the repository on GitHub, which only GitHub has.
  "storage.uploads.row.seeOnGitHub",
]);

describe("words of repositories of the server's own", () => {
  it("each is the other words of a text that is there", () => {
    for (const key of all.keys())
      if (key.endsWith("_local")) expect(all.has(key.slice(0, -6)), key).toBe(true);
  });

  it("every text about the repository that says GitHub has them, unless only GitHub has it", () => {
    const missing = [...all]
      .filter(
        ([key, text]) =>
          !key.endsWith("_local") &&
          text.includes("GitHub") &&
          SAID_OF_REPOSITORIES.some((prefix) => key.startsWith(prefix)) &&
          !ONLY_GITHUB.has(key) &&
          !all.has(`${key}_local`),
      )
      .map(([key]) => key);
    expect(missing).toEqual([]);
    for (const [key, text] of all)
      if (key.endsWith("_local")) expect(text, key).not.toContain("GitHub");
  });

  it("are said of one repository, or everywhere on a server that has no GitHub", async () => {
    const i18n = await createI18n();
    expect(i18n.t("saveStatus.github")).toBe("GitHub 仓库");
    expect(placedT(i18n.t, "local")("saveStatus.github")).toBe("本机仓库");
    expect(placedT(i18n.t, "github")("saveStatus.github")).toBe("GitHub 仓库");
    // A text with no words of its own stays as it is.
    expect(placedT(i18n.t, "local")("cloud.panel.action.archiveNow")).toBe("现在存档");
    sayLocalRepositories(i18n);
    expect(i18n.t("saveStatus.github")).toBe("本机仓库");
    expect(i18n.t("repository.pause.gone")).toBe("本机仓库找不到了");
    expect(i18n.t("cloud.panel.action.archiveNow")).toBe("现在存档");
  });
});
