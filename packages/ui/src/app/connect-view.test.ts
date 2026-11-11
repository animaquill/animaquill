import type { RepositoryStatus } from "@animaquill/host";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import type { ConnectSnapshot } from "../cloud/connect.ts";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import { connectView, type ConnectViewInput } from "./connect-view.ts";

/** What the dialog that connects a project shows: the design of the start page, 3. */

const i18n = createInstance();
await i18n.init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
});
const t = i18n.t;

const snapshot = (more: Partial<ConnectSnapshot> = {}): ConnectSnapshot => ({
  need: undefined,
  account: "ada",
  repositoryOnly: false,
  phase: "choosing",
  steps: { upload: "waiting", repository: "waiting", archive: "waiting" },
  problem: undefined,
  cancelling: false,
  unconfirmed: false,
  linked: undefined,
  ...more,
});

const view = (more: Partial<ConnectSnapshot> = {}, input: Partial<ConnectViewInput> = {}) =>
  connectView(
    {
      snapshot: snapshot(more),
      name: "原子是什么",
      mode: "create",
      canSubmit: true,
      putOff: false,
      kept: false,
      ...input,
    },
    t,
  );

const LINKED: RepositoryStatus = {
  repository: {
    id: 7,
    owner: "ada",
    name: "atom",
    fullName: "ada/atom",
    private: true,
    branch: "main",
    url: "https://github.com/ada/atom",
    createdHere: true,
    linkedAt: 1,
  },
  state: "ready",
  archiving: true,
  head: 1,
  archivedSeq: 0,
};

describe("before anything is made", () => {
  it("shows the choice, and goes on once the choice can", () => {
    const seen = view();
    expect(seen).toMatchObject({
      title: "把“原子是什么”连接到云端",
      body: "choice",
      intro: "about",
      locked: false,
      steps: [],
      message: undefined,
      asksAboutCancel: false,
      primary: { label: "连接到云端", enabled: true },
      close: { label: "取消", enabled: true },
    });
    expect(view({}, { canSubmit: false }).primary).toEqual({ label: "连接到云端", enabled: false });
  });

  it("asks to sign in, or for the App, first: there is nothing to go on with yet", () => {
    for (const need of ["account", "signIn", "installApp"] as const) {
      const seen = view({ need }, { canSubmit: false });
      expect(seen.body).toBe("need");
      expect(seen.primary).toBeUndefined();
      expect(seen.close).toEqual({ label: "取消", enabled: true });
    }
  });

  it("only asks for the repository of a project that is on the platform already", () => {
    const seen = view({
      repositoryOnly: true,
      steps: { upload: "done", repository: "waiting", archive: "waiting" },
    });
    expect(seen.title).toBe("给“原子是什么”选仓库");
    expect(seen.intro).toBe("repositoryOnly");
    expect(seen.primary?.label).toBe("存进这个仓库");
    // Nothing ran yet: the steps do not show, and the first one never does.
    expect(seen.steps).toEqual([]);
  });
});

describe("while the steps run", () => {
  it("shows them, locks the choice, and can still be given up", () => {
    const seen = view(
      { phase: "working", steps: { upload: "done", repository: "running", archive: "waiting" } },
      { canSubmit: false },
    );
    expect(seen.locked).toBe(true);
    expect(seen.steps.map(({ text, state, stateText }) => [text, state, stateText])).toEqual([
      ["上传项目", "done", "完成"],
      ["新建仓库", "running", "进行中"],
      ["第一次存档", "waiting", "等待"],
    ]);
    expect(seen.message).toEqual({ text: "正在连接，请稍等…", tone: "plain" });
    expect(seen.primary).toEqual({ label: "连接到云端", enabled: false });
    expect(seen.close).toEqual({ label: "取消", enabled: true });
  });

  it("names the second step after what people chose", () => {
    const seen = view(
      { phase: "working", steps: { upload: "running", repository: "waiting", archive: "waiting" } },
      { mode: "existing" },
    );
    expect(seen.steps[1]?.text).toBe("关联仓库");
  });

  it("leaves out the first step for a project that was on the platform before", () => {
    const seen = view({
      repositoryOnly: true,
      phase: "working",
      steps: { upload: "done", repository: "running", archive: "waiting" },
    });
    expect(seen.steps.map(({ id }) => id)).toEqual(["repository", "archive"]);
  });
});

describe("where a step stopped", () => {
  it("says why, keeps the choice, and offers to try again", () => {
    const seen = view({
      steps: { upload: "failed", repository: "waiting", archive: "waiting" },
      problem: { step: "upload", code: "offline" },
    });
    expect(seen.body).toBe("choice");
    expect(seen.locked).toBe(false);
    expect(seen.steps[0]).toMatchObject({ state: "failed", stateText: "没有成功" });
    expect(seen.message).toEqual({
      text: "浏览器没有网络，项目还没传到云端。联网后会自动接着传，传好后再点“连接到云端”。",
      tone: "attention",
    });
    expect(seen.primary?.label).toBe("再试一次");
  });

  it("keeps showing that the project got there while people choose another repository", () => {
    const seen = view({
      steps: { upload: "done", repository: "failed", archive: "waiting" },
      problem: { step: "repository", code: "nameTaken" },
    });
    expect(seen.steps.map(({ state }) => state)).toEqual(["done", "failed", "waiting"]);
    expect(seen.message?.text).toBe("你的 GitHub 上已经有叫这个名字的仓库了，换一个名字。");
    expect(seen.primary).toEqual({ label: "再试一次", enabled: true });
  });

  it("asks to sign in again where the session ended on the way", () => {
    const seen = view({
      need: "signIn",
      steps: { upload: "failed", repository: "waiting", archive: "waiting" },
      problem: { step: "upload", code: "signedOut" },
    });
    expect(seen.body).toBe("need");
    expect(seen.primary).toBeUndefined();
    expect(seen.message?.text).toBe("登录已过期。重新登录后回到这里，接着连接。");
  });
});

describe("once the project has its repository", () => {
  const steps = { upload: "done", repository: "done", archive: "running" } as const;

  it("only closes: nothing is taken back, and the first archive goes on by itself", () => {
    const seen = view({ phase: "archiving", steps, linked: LINKED }, { canSubmit: false });
    expect(seen.body).toBe("result");
    expect(seen.primary).toBeUndefined();
    expect(seen.close).toEqual({ label: "关闭", enabled: true });
    expect(seen.message).toEqual({
      text: "项目已经连上云端。第一次存档正在进行，可以关掉这个对话框，它会在后台完成。",
      tone: "plain",
    });
  });

  it("says why the first archive waits, in place of that it runs", () => {
    const seen = view({
      phase: "archiving",
      steps: { ...steps, archive: "failed" },
      linked: LINKED,
      problem: {
        step: "archive",
        code: "paused",
        status: { ...LINKED, state: "paused", reason: "protected" },
      },
    });
    expect(seen.message?.tone).toBe("attention");
    expect(seen.message?.text).toContain("第一次存档先停着：GitHub 不让存档写进这个仓库");
    expect(seen.close.label).toBe("关闭");
  });

  it("says that it is done", () => {
    const seen = view({
      phase: "done",
      steps: { upload: "done", repository: "done", archive: "done" },
      linked: LINKED,
    });
    expect(seen.message).toEqual({ text: "已连接到云端，第一次存档也完成了。", tone: "done" });
    expect(seen.close.label).toBe("完成");
    expect(seen.primary).toBeUndefined();
  });

  it("says that giving up found a repository after all", () => {
    const seen = view({ phase: "archiving", steps, linked: LINKED }, { kept: true });
    expect(seen.message?.text).toBe(
      "云端已经给这个项目关联了仓库，所以没有取消。它会照常同步和存档。",
    );
  });
});

describe("giving up", () => {
  const made = { upload: "done", repository: "waiting", archive: "waiting" } as const;

  it("says so while what the dialog made is taken back, and takes no other press", () => {
    const seen = view({ cancelling: true, steps: made }, { canSubmit: false });
    expect(seen.message).toEqual({ text: "正在取消…", tone: "plain" });
    expect(seen.locked).toBe(true);
    expect(seen.close.enabled).toBe(false);
    expect(seen.primary?.enabled).toBe(false);
  });

  it("asks what to do where the platform could not say that the project is gone", () => {
    const seen = view({ unconfirmed: true, steps: made });
    expect(seen.asksAboutCancel).toBe(true);
    expect(seen.message?.tone).toBe("attention");
    expect(seen.message?.text).toContain("没法确认云端刚建的项目已经删掉");
    expect(seen.primary).toBeUndefined();
  });

  it("goes back to choosing once people said to wait", () => {
    const seen = view({ unconfirmed: true, steps: made }, { putOff: true });
    expect(seen.asksAboutCancel).toBe(false);
    expect(seen.message).toBeUndefined();
    expect(seen.primary).toEqual({ label: "连接到云端", enabled: true });
    expect(seen.close).toEqual({ label: "取消", enabled: true });
  });
});
