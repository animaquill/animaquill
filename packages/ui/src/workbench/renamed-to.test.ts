import { describe, expect, test } from "vitest";
import { renamedTo } from "./repo-changes.ts";

describe("the name a rename on the start page gave", () => {
  test("is the batch's own, as the platform labels it", () => {
    expect(renamedTo("在开始页改名为「宣传片」")).toBe("宣传片");
    expect(renamedTo("在开始页改名为「「引号」里」」")).toBe("「引号」里」");
    expect(renamedTo("GitHub 上的改动")).toBeUndefined();
  });
});
