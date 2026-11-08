import {
  MANIFEST_FILE,
  createProject,
  readProject,
  writeProject,
  type Problem,
  type ProjectFiles,
} from "@animaquill/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderRefused, readFolder, type ReadOnlyFolder } from "./read-folder.ts";

/**
 * What the format says can change, and reading a folder must not depend on it saying only what it
 * says today. So here it says what it never does.
 */
vi.mock(import("@animaquill/schema"), async (importOriginal) => {
  const schema = await importOriginal();
  return { ...schema, readProject: vi.fn(schema.readProject) };
});

const { readProject: reallyRead } =
  await vi.importActual<typeof import("@animaquill/schema")>("@animaquill/schema");

afterEach(() => {
  vi.mocked(readProject).mockClear().mockImplementation(reallyRead);
});

function folderOf(files: ReadonlyMap<string, string>): ReadOnlyFolder {
  return {
    async *list() {
      yield* files.keys();
    },
    async file(path) {
      const bytes = new TextEncoder().encode(files.get(path));
      return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
    },
  };
}

const projectFiles = () => writeProject(createProject({ name: "文件夹里的项目" }));

/** Says this, on top of what the format says, as long as `when` holds. */
function sayingAlso(problem: Problem, when: (calls: number) => boolean) {
  let calls = 0;
  vi.mocked(readProject).mockImplementation((files: ProjectFiles) => {
    calls += 1;
    // Far more than any project needs, so that a mistake here fails instead of going on forever.
    if (calls > 50) throw new Error("Reads the project again and again");
    const result = reallyRead(files);
    return when(calls) ? { ...result, problems: [...result.problems, problem] } : result;
  });
}

describe("reading a folder, whatever the format says", () => {
  it("gives up when reading again would only find the same", async () => {
    const stuck: Problem = {
      severity: "error",
      code: "new-rule",
      file: MANIFEST_FILE,
      message: "",
    };
    sayingAlso(stuck, () => true);
    const error = await readFolder(folderOf(projectFiles())).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(FolderRefused);
    expect((error as FolderRefused).reason).toBe("invalid");
    expect((error as FolderRefused).problems).toEqual([stuck]);
    expect(readProject).toHaveBeenCalledTimes(1);
  });

  it("names what goes by its file, when it is no document it knows", async () => {
    const odd: Problem = { severity: "error", code: "new-rule", file: "code/a.js", message: "" };
    sayingAlso(odd, (calls) => calls === 1);
    const files = projectFiles().set("code/a.js", "export {};");
    const reading = await readFolder(folderOf(files));
    expect(reading.lost).toEqual([{ file: "code/a.js", part: { kind: "other" }, problems: [odd] }]);
    expect(reading.sources).toEqual({});
  });
});
