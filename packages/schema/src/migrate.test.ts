import { describe, expect, it } from "vitest";
import { loadFixture } from "../scripts/fixture.ts";
import { MIGRATIONS, migrateProject, type Migration } from "./migrate.ts";
import { readProject } from "./project.ts";
import { CURRENT_FORMAT_VERSION } from "./version.ts";

const project = (version: number, extra: object = {}) =>
  new Map([["animaquill.json", JSON.stringify({ formatVersion: version, name: "a", ...extra })]]);

const renameField: Migration = {
  from: 1,
  migrate(files) {
    const manifest = JSON.parse(files.get("animaquill.json") as string);
    manifest.title = manifest.name;
    delete manifest.name;
    files.set("animaquill.json", JSON.stringify(manifest));
  },
};

const addFile: Migration = {
  from: 2,
  migrate(files) {
    files.set("added.json", "{}\n");
  },
};

describe("migrateProject", () => {
  it("leaves a current project alone", () => {
    expect(migrateProject(project(3), [renameField, addFile], 3)).toEqual({ kind: "current" });
  });

  it("goes through every step in order and records the new version", () => {
    const result = migrateProject(project(1), [addFile, renameField], 3);
    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") return;
    expect(result.from).toBe(1);
    const manifest = JSON.parse(result.files.get("animaquill.json") as string);
    expect(manifest).toEqual({ formatVersion: 3, title: "a" });
    expect(result.files.has("added.json")).toBe(true);
  });

  it("starts where the project is", () => {
    const result = migrateProject(project(2), [renameField, addFile], 3);
    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") return;
    expect(JSON.parse(result.files.get("animaquill.json") as string).name).toBe("a");
  });

  it("does not touch the files it was given", () => {
    const original = project(1);
    const before = original.get("animaquill.json");
    migrateProject(original, [renameField, addFile], 3);
    expect(original.get("animaquill.json")).toBe(before);
    expect(original.has("added.json")).toBe(false);
  });

  it("refuses a project from the future", () => {
    expect(migrateProject(project(9), [], 3)).toEqual({ kind: "too-new", version: 9 });
  });

  it("says so when a step is missing, instead of guessing", () => {
    expect(migrateProject(project(1), [addFile], 3)).toEqual({ kind: "no-path", from: 1 });
  });

  it.each([
    ["{oops"],
    ['{"name":"no version"}'],
    ['{"formatVersion":"1"}'],
    ['{"formatVersion":1.5}'],
  ])("does not touch what it cannot read: %s", (text) => {
    expect(migrateProject(new Map([["animaquill.json", text]]))).toEqual({ kind: "unreadable" });
  });

  it("does not touch a folder without a manifest", () => {
    expect(migrateProject(new Map())).toEqual({ kind: "unreadable" });
  });
});

describe("the migrations that shipped", () => {
  it("have one step for every older version", () => {
    const steps = MIGRATIONS.map((migration) => migration.from).toSorted((a, b) => a - b);
    expect(steps).toEqual(Array.from({ length: CURRENT_FORMAT_VERSION - 1 }, (_, i) => i + 1));
  });

  /**
   * The folders under fixtures/ are frozen copies of each format version. They are never edited,
   * so that any old project keeps opening. Add a new folder when the format changes.
   */
  it.each(["v1"])("still open a project of %s", (name) => {
    const files = loadFixture(name);
    const result = migrateProject(files);
    const current = result.kind === "migrated" ? result.files : files;
    expect(["current", "migrated"]).toContain(result.kind);
    const { project: read, problems } = readProject(current);
    expect(read).toBeDefined();
    expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
  });
});
