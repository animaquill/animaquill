import { USER, type ProjectStore } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { keptByOf } from "./undo-text.ts";

const record = (
  revision: number,
  origin: string,
  paths: readonly (readonly string[])[],
  takesBack?: "undo" | "redo",
): ReturnType<ProjectStore["keptChanges"]>[number] => ({
  revision,
  origin,
  paths,
  ...(takesBack && { takesBack }),
});

const NAME = ["manifest", "name"];
const chats: Record<string, string> = { "ai:b": "配乐" };
const chatOf = (origin: string) => chats[origin];

describe("who changed what stayed when a task went back", () => {
  it("is the person, another conversation by its name, or others", () => {
    const records = [
      record(1, "ai:a", [NAME, ["timelines", "main", "markers", "m1"]]),
      record(2, "ai:b", [NAME]),
    ];
    expect(keptByOf(records, "ai:a", [NAME], chatOf)).toEqual({ kind: "chat", title: "配乐" });
    expect(keptByOf([...records, record(3, USER, [NAME])], "ai:a", [NAME], chatOf)).toEqual({
      kind: "you",
    });
    // Taking back is people's doing, whoever made what went back.
    expect(
      keptByOf([...records, record(3, "ai:b", [NAME], "undo")], "ai:a", [NAME], chatOf),
    ).toEqual({ kind: "you" });
    expect(keptByOf([...records, record(3, "ai:x", [NAME])], "ai:a", [NAME], chatOf)).toEqual({
      kind: "others",
    });
  });

  it("meets a place above or below what was written, and says nothing without a record", () => {
    const clip = ["timelines", "main", "clips", "c1"];
    const records = [record(1, "ai:a", [clip]), record(2, "ai:b", [[...clip, "opacity"]])];
    expect(keptByOf(records, "ai:a", [clip], chatOf)).toEqual({ kind: "chat", title: "配乐" });
    // Several who: others.
    const two = [...records, record(3, USER, [NAME])];
    expect(keptByOf(two, "ai:a", [clip, NAME], chatOf)).toEqual({ kind: "others" });
    expect(keptByOf([], "ai:a", [clip], chatOf)).toBeUndefined();
    expect(keptByOf(records, "ai:a", [], chatOf)).toBeUndefined();
  });
});
