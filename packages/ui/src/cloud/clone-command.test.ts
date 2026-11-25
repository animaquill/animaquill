import { describe, expect, it } from "vitest";
import { cloneCommandOf } from "./projects.ts";

describe("the command that clones a repository of the server's own", () => {
  it("quotes the folder and names the copy after the project, as any shell takes it", () => {
    expect(cloneCommandOf("/var/lib/animaquill/repos/p1.git", "原子是什么", "p1")).toBe(
      'git clone "/var/lib/animaquill/repos/p1.git" "原子是什么"',
    );
    expect(cloneCommandOf("C:\\Users\\a\\.animaquill\\repos\\p1.git", "a/b: c?", "p1")).toBe(
      'git clone "C:\\Users\\a\\.animaquill\\repos\\p1.git" "ab c"',
    );
    expect(cloneCommandOf('/data/"x"$y.git', '$`"', "p1")).toBe(
      'git clone "/data/\\"x\\"\\$y.git" "p1"',
    );
  });
});
