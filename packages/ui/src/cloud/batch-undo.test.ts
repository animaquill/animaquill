import {
  RepositoryRefused,
  type PlatformBatchState,
  type PlatformBatchTaken,
  type RepositoryAccess,
} from "@animaquill/host";
import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/i18n.ts";
import { Dialogs } from "../workbench/dialogs.ts";
import { Notifications } from "../workbench/notifications.ts";
import { BatchUndo, batchWhyKey } from "./batch-undo.ts";

/** A platform that says what it is told of each batch, and takes them back as it is told. */
function platform(
  states: Record<string, PlatformBatchState>,
  taken: Record<string, PlatformBatchTaken | string>,
) {
  const asked: string[] = [];
  const undone: string[] = [];
  const access = {
    batch: async (_project: string, batch: string) => {
      asked.push(batch);
      const state = states[batch];
      if (!state) throw new RepositoryRefused("notFound");
      return state;
    },
    undoBatch: async (_project: string, batch: string) => {
      undone.push(batch);
      const said = taken[batch];
      if (typeof said === "string") throw new RepositoryRefused("notUndoable", { why: said });
      if (!said) throw new RepositoryRefused("unavailable");
      return said;
    },
  } as unknown as RepositoryAccess;
  return { access, asked, undone };
}

const state = (id: string, more: Partial<PlatformBatchState> = {}): PlatformBatchState => ({
  id,
  kind: "repo",
  label: `GitHub 上的改动 ${id}`,
  files: 2,
  at: 1,
  undone: false,
  next: { batch: id, direction: "undo" },
  ...more,
});

const t = (await createI18n()).t;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setUp(access: RepositoryAccess) {
  const dialogs = new Dialogs();
  const notifications = new Notifications();
  const undo = new BatchUndo({
    t,
    dialogs,
    notifications,
    target: () => ({ access, project: "p1" }),
    state: () => ProjectStore.create(createProject({ name: "测试" })).getState(),
  });
  return { dialogs, notifications, undo };
}

describe("taking merges of GitHub back as a whole", () => {
  it("says what the platform says: undo, redo, or grey with why", async () => {
    const { access, asked } = platform(
      {
        m1: state("m1"),
        m2: state("m2", { undone: true, next: { batch: "u2", direction: "redo" } }),
        m3: state("m3", { why: "changed" }),
        m4: state("m4", { why: "notLatest" }),
      },
      {},
    );
    const { undo } = setUp(access);
    // Until the platform says, as far as this window knows.
    expect(undo.stateOf(["m1"])).toEqual({ direction: "undo" });
    expect(undo.stateOf(["m2"], true)).toEqual({ direction: "redo" });
    expect(undo.stateOf(["m3", "m4"])).toEqual({ direction: "undo" });
    await flush();
    expect(undo.stateOf(["m1"])).toEqual({ direction: "undo" });
    expect(undo.stateOf(["m2"])).toEqual({ direction: "redo" });
    expect(undo.stateOf(["m3"])).toEqual({ direction: "undo", why: "changed" });
    expect(undo.stateOf(["m4"])).toEqual({ direction: "undo", why: "notLatest" });
    // Several at once: all of them the same way, or why not.
    expect(undo.stateOf(["m1", "m3"])).toEqual({ direction: "undo", why: "changed" });
    expect(undo.stateOf(["m1", "m2"])).toEqual({});
    expect(t(batchWhyKey("changed"))).toBe("这次改的地方后来都被改过了");
    expect(t(batchWhyKey("notLatest"))).toBe("这次的改动已经不能撤销了");
    expect(t(batchWhyKey("rebuilt"))).toContain("重建");
    // Asked once each.
    expect(asked.toSorted()).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("asks first, as GitHub goes back too, and says what went back and what stayed", async () => {
    const { access, undone } = platform(
      { m1: state("m1") },
      {
        m1: {
          batch: "u1",
          seq: 9,
          direction: "undo",
          back: [["files", "code/a.js"]],
          kept: [["manifest", "name"]],
          backCount: 1,
          keptCount: 1,
          obstacle: "changed",
          next: { batch: "u1", direction: "redo" },
        },
      },
    );
    const { dialogs, notifications, undo } = setUp(access);
    const going = undo.takeBack(["m1"], "undo", 2);
    await flush();
    const asking = dialogs.getSnapshot();
    expect(asking).toMatchObject({
      title: "撤销 GitHub 上合并进来的改动（2 个文件）",
      message: "下次存档时，GitHub 上也会改回来。",
      confirm: "撤销",
    });
    dialogs.answer(true);
    await going;
    expect(undone).toEqual(["m1"]);
    const [notice] = notifications.getSnapshot();
    expect(notice?.message).toBe("撤销了 1 处");
    expect(notice?.warning?.text).toBe("1 处你后来又改过，保留了你的。");
    expect(notice?.actions?.map(({ label }) => label)).toEqual(["重做"]);
  });

  it("does nothing where people say no, and says why where the platform refuses", async () => {
    const { access, undone } = platform({ m1: state("m1") }, { m1: "drop" });
    const { dialogs, notifications, undo } = setUp(access);
    const no = undo.takeBack(["m1"], "undo", 2);
    await flush();
    dialogs.answer(false);
    await no;
    expect(undone).toEqual([]);
    const yes = undo.takeBack(["m1"], "undo", 2);
    await flush();
    dialogs.answer(true);
    await yes;
    expect(undone).toEqual(["m1"]);
    expect(notifications.getSnapshot().map(({ message }) => message)).toEqual([
      "这次的改动已经不能撤销了",
    ]);
  });
});
