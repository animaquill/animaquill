import { ProjectStore } from "@animaquill/core";
import type { RepositoryAccess, RepositoryConflict, RepositoryStatus } from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ConflictList, groupsOf } from "./conflicts.ts";

const STATUS: RepositoryStatus = { state: "paused", archiving: false, head: 3, archivedSeq: 1 };

/** A platform that keeps conflicts and hears what people chose. */
function platformOf(conflicts: RepositoryConflict[]) {
  const resolved: { ids: readonly string[]; keep: string; seq?: number }[] = [];
  const access = {
    async conflicts() {
      return conflicts;
    },
    async conflict(_: string, id: string) {
      return conflicts.find((each) => each.id === id) as RepositoryConflict;
    },
    async resolve(_: string, choice: { ids: readonly string[]; keep: string; seq?: number }) {
      resolved.push(choice);
      return STATUS;
    },
  } as unknown as RepositoryAccess;
  return { access, resolved };
}

const conflictOf = (more: Partial<RepositoryConflict> & { id: string }): RepositoryConflict => ({
  file: "animaquill.json",
  path: ["manifest", "name"],
  label: "项目的名字",
  kind: "value",
  lost: "batch",
  state: "open",
  at: 1,
  ...more,
});

function setup(conflicts: RepositoryConflict[]) {
  const store = ProjectStore.create(createProject({ name: "这里的名字" }));
  expect(
    store.execute({ type: "file.write", params: { path: "code/a.js", text: "mine\n" } }).ok,
  ).toBe(true);
  const { access, resolved } = platformOf(conflicts);
  const list = new ConflictList({
    access,
    project: "p1",
    store: () => store,
    sent: async () => 7,
  });
  return { store, list, resolved };
}

describe("the list of conflicts with GitHub", () => {
  it("groups the places by what they are about, code by its file", () => {
    const listed = [
      conflictOf({ id: "a" }),
      conflictOf({ id: "b", path: ["manifest", "description"], label: "项目的说明" }),
      conflictOf({ id: "c", file: "code/a.js", path: ["files", "code/a.js"], kind: "lines" }),
    ].map((each) => ({ conflict: each, state: "open" }));
    const groups = groupsOf(listed);
    expect(groups.map(({ rows }) => rows.map(({ conflict }) => conflict.id))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(groups[1]).toMatchObject({
      title: "code/a.js",
      object: { kind: "file", id: "code/a.js" },
    });
  });

  it("takes GitHub's side as an edit people can take back, and tells the platform with the update it is in", async () => {
    const { store, list, resolved } = setup([
      conflictOf({ id: "a", ours: "这里的名字", theirs: "GitHub 的名字" }),
    ]);
    await list.load();
    expect(list.getSnapshot()).toMatchObject({ status: "ready", handled: [] });
    await list.take(["a"]);
    expect(store.getState().manifest.name).toBe("GitHub 的名字");
    expect(resolved).toEqual([{ ids: ["a"], keep: "theirs", seq: 7 }]);
    expect(list.getSnapshot().open).toEqual([]);
    expect(list.getSnapshot().handled.map(({ state }) => state)).toEqual(["theirs"]);
    // Ctrl+Z takes it back like any other edit of people's.
    expect(store.undo().ok).toBe(true);
    expect(store.getState().manifest.name).toBe("这里的名字");
  });

  it("takes all of GitHub's in one step, keeps what only people can settle open, and goes on past a place that changed since", async () => {
    const { store, list, resolved } = setup([
      conflictOf({ id: "a", ours: "这里的名字", theirs: "GitHub 的名字" }),
      conflictOf({
        id: "b",
        file: "code/a.js",
        path: ["files", "code/a.js"],
        kind: "file",
        ours: "mine\n",
        theirs: "theirs\n",
      }),
      // Changed since: the project's description is not what the conflict says it was.
      conflictOf({
        id: "c",
        path: ["manifest", "description"],
        ours: "以前的说明",
        theirs: "GitHub 的说明",
      }),
      conflictOf({
        id: "d",
        kind: "check-duplicate",
        file: "code/a.js",
        path: ["files", "code/a.js"],
      }),
    ]);
    await list.load();
    const before = store.history.length;
    await list.takeAll();
    expect(store.getState().manifest.name).toBe("GitHub 的名字");
    expect(store.getState().files["code/a.js"]).toBe("theirs\n");
    expect(store.history.length).toBe(before + 1);
    expect(resolved).toEqual([
      { ids: ["c"], keep: "ours" },
      { ids: ["a", "b"], keep: "theirs", seq: 7 },
    ]);
    const { open } = list.getSnapshot();
    expect(open.flatMap(({ rows }) => rows.map(({ conflict }) => conflict.id))).toEqual(["d"]);
    // "看过了" settles what only people can.
    await list.keep(["d"]);
    expect(list.openCount).toBe(0);
    expect(store.undo().ok).toBe(true);
    expect(store.getState().manifest.name).toBe("这里的名字");
    expect(store.getState().files["code/a.js"]).toBe("mine\n");
  });

  it("keeps the project's side without changing anything, and says where the platform could not hear it", async () => {
    const { store, list, resolved } = setup([
      conflictOf({ id: "a", ours: "这里的名字", theirs: "x" }),
    ]);
    await list.load();
    const revision = store.revision;
    await list.keepAll();
    expect(store.revision).toBe(revision);
    expect(resolved).toEqual([{ ids: ["a"], keep: "ours" }]);

    const failing = new ConflictList({
      access: {
        conflicts: async () => [conflictOf({ id: "b", ours: "这里的名字", theirs: "x" })],
        resolve: async () => {
          throw new Error("away");
        },
      } as unknown as RepositoryAccess,
      project: "p1",
      store: () => store,
      sent: async () => undefined,
    });
    await failing.load();
    await failing.keep(["b"]);
    expect(failing.getSnapshot()).toMatchObject({ trouble: true, busy: false });
    expect(failing.openCount).toBe(1);
  });
});
