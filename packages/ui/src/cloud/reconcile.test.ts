/**
 * Choosing a side for each file that two versions of one project have differently, see
 * `reconcile.ts`: what differs, what is chosen until people say otherwise, and what both sides
 * are to be once they did. The files themselves are `FolderAdopt`'s, see folder/adopt.test.ts.
 */
import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  allOneSide,
  defaultChoices,
  differencesOf,
  isSettled,
  reconcileItems,
  settle,
  whenText,
} from "./reconcile.ts";

const t = ((key: string, words?: Record<string, unknown>) =>
  words ? `${key} ${JSON.stringify(words)}` : key) as never;

function project(files: Record<string, string>) {
  const store = ProjectStore.create(createProject({ name: "片子" }), files);
  return { store, files: store.exportFiles().files };
}

describe("differencesOf", () => {
  it("tells which side has a file, and which one looks newer by the time of the platform", () => {
    const here = new Map([
      ["a.js", "1"],
      ["b.js", "2"],
      ["same.js", "s"],
    ]);
    const cloud = new Map([
      ["a.js", "x"],
      ["c.js", "3"],
      ["same.js", "s"],
    ]);
    const differences = differencesOf(here, cloud, {
      changedAt: (path) => (path === "a.js" ? 500 : 100),
      updatedAt: 300,
      lost: ["broken.json"],
    });
    expect(differences).toEqual([
      { path: "a.js", kind: "both", newer: "here", changedAt: 500 },
      { path: "b.js", kind: "here", newer: "cloud", changedAt: 100 },
      { path: "broken.json", kind: "here", newer: "cloud", changedAt: 100, unreadable: true },
      { path: "c.js", kind: "cloud", newer: "cloud", changedAt: 100 },
    ]);
    // Nothing goes until people say so: what only one side has stays, and the newer side is chosen.
    expect(defaultChoices(differences)).toEqual(
      new Map([
        ["a.js", "here"],
        ["b.js", "here"],
        ["broken.json", "cloud"],
        ["c.js", "cloud"],
      ]),
    );
    // A file that cannot be read here is no choice, all one way or not.
    expect(allOneSide(differences, "here").get("broken.json")).toBe("cloud");
  });
});

describe("settle", () => {
  it("makes each file the side chosen for it, and the platform takes in what it lacks as one batch", () => {
    const { store, files: cloud } = project({ "code/a.js": "云端\n", "code/c.js": "c\n" });
    const here = new Map(cloud);
    here.set("code/a.js", "这里\n");
    here.set("code/b.js", "b\n");
    here.delete("code/c.js");
    const differences = differencesOf(here, cloud);
    const choices = new Map([
      ["code/a.js", "here" as const],
      ["code/b.js", "cloud" as const],
      ["code/c.js", "here" as const],
    ]);
    const settled = settle(store, here, cloud, differences, choices, "test");
    expect(isSettled(settled)).toBe(true);
    if (!isSettled(settled)) return;
    expect(settled.after.get("code/a.js")).toBe("这里\n");
    expect(settled.after.has("code/b.js")).toBe(false);
    expect(settled.after.has("code/c.js")).toBe(false);
    expect(settled.changes).toEqual([
      { path: "code/a.js", base: "云端\n", text: "这里\n" },
      { path: "code/c.js", base: "c\n", text: undefined },
    ]);
    expect(settled.origin).toBe("folder:test");
    // Nothing of the project changed: that is for whoever carries it out.
    expect(store.getState().files["code/a.js"]).toBe("云端\n");
  });

  it("refuses where a file has no choice, and changes nothing", () => {
    const { store, files: cloud } = project({ "code/a.js": "云端\n" });
    const here = new Map(cloud);
    here.set("code/a.js", "这里\n");
    here.set("code/b.js", "b\n");
    const differences = differencesOf(here, cloud);
    const settled = settle(
      store,
      here,
      cloud,
      differences,
      new Map([["code/b.js", "here"]]),
      "test",
    );
    expect(isSettled(settled)).toBe(false);
    // Nor can a file that cannot be read here be chosen as it is here.
    const lost = differencesOf(here, cloud, { lost: ["code/a.js"] });
    const chosen = new Map([
      ["code/a.js", "here" as const],
      ["code/b.js", "here" as const],
    ]);
    expect(isSettled(settle(store, here, cloud, lost, chosen, "test"))).toBe(false);
  });
});

describe("reconcileItems", () => {
  it("says how each side has a file, with the side that keeps it first", () => {
    const now = new Date(2026, 10, 12, 18, 0).getTime();
    const at = new Date(2026, 10, 12, 14, 5).getTime();
    const differences = differencesOf(
      new Map([
        ["a.js", "1"],
        ["b.js", "2"],
      ]),
      new Map([
        ["a.js", "x"],
        ["c.js", "3"],
      ]),
      { changedAt: () => at, updatedAt: at - 1 },
    );
    const items = reconcileItems(differences, defaultChoices(differences), t, {
      now,
      words: "folder.adopt",
    });
    expect(items).toEqual([
      {
        path: "a.js",
        status: 'folder.adopt.newerHere {"time":"reconcile.today {\\"time\\":\\"14:05\\"}"}',
        options: [
          { id: "here", label: "folder.adopt.useHere" },
          { id: "cloud", label: "folder.adopt.useCloud" },
        ],
        value: "here",
      },
      {
        path: "b.js",
        status: "folder.adopt.onlyHere",
        options: [
          { id: "here", label: "folder.adopt.keep" },
          { id: "cloud", label: "folder.adopt.drop" },
        ],
        value: "here",
      },
      {
        path: "c.js",
        status: "folder.adopt.onlyCloud",
        options: [
          { id: "cloud", label: "folder.adopt.keep" },
          { id: "here", label: "folder.adopt.drop" },
        ],
        value: "cloud",
      },
    ]);
  });

  it("says the day where it was not today", () => {
    const now = new Date(2026, 10, 12, 9).getTime();
    expect(whenText(new Date(2026, 10, 8, 7, 3).getTime(), now, t)).toBe(
      'reconcile.day {"month":11,"day":8,"time":"07:03"}',
    );
    expect(whenText(new Date(2025, 0, 2, 7, 3).getTime(), now, t)).toBe(
      'reconcile.dayOfYear {"month":1,"day":2,"time":"07:03","year":2025}',
    );
  });
});
