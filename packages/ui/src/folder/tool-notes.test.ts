import { hashTextHex } from "@animaquill/media";
import { describe, expect, it } from "vitest";
import {
  batchOfChanges,
  isAlive,
  knownTool,
  parseBatchNote,
  parseConnection,
  toolUses,
  type ToolBatchNote,
} from "./tool-notes.ts";

const note = (batch: string, files: Record<string, string | null>, at = 1): ToolBatchNote => ({
  batch,
  session: "s",
  client: { name: "claude-code" },
  startedAt: at,
  updatedAt: at,
  files: new Map(Object.entries(files)),
});

describe("the notes of the local MCP", () => {
  it("are read as packages/local/src/mcp/notes.ts writes them, and nothing else", () => {
    const hash = hashTextHex("x");
    const read = parseBatchNote(
      JSON.stringify({
        format: 1,
        batch: "2026-11-15T10-00-00-000Z-abcdef012345",
        session: "abcdef012345",
        client: { name: "claude-code", version: "2.1.0" },
        startedAt: 1,
        updatedAt: 2,
        files: { "a.json": hash, "b.json": null, "c.json": "not a hash" },
      }),
    );
    expect(read?.files).toEqual(
      new Map<string, string | null>([
        ["a.json", hash],
        ["b.json", null],
      ]),
    );
    expect(read?.client).toEqual({ name: "claude-code", version: "2.1.0" });
    expect(parseBatchNote("{")).toBeUndefined();
    expect(parseBatchNote(JSON.stringify({ format: 2, batch: "a" }))).toBeUndefined();
    expect(parseBatchNote(JSON.stringify({ format: 1, batch: "../x", files: {} }))).toBeUndefined();
    const connection = parseConnection(
      JSON.stringify({
        format: 1,
        session: "s",
        client: undefined,
        pid: 1,
        startedAt: 1,
        aliveAt: 5,
      }),
    );
    expect(connection).toMatchObject({ session: "s", startedAt: 1, aliveAt: 5 });
    // Two minutes without a word is gone.
    expect(isAlive(connection!, 5 + 2 * 60 * 1000)).toBe(true);
    expect(isAlive(connection!, 6 + 2 * 60 * 1000)).toBe(false);
  });

  it("hash as the local MCP does: SHA-256 of the text in hex", () => {
    expect(hashTextHex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("make a merge the batch whose files are all as it left them", () => {
    const a = hashTextHex("A");
    const b = hashTextHex("B");
    const one = note("one", { "a.json": a, "b.json": null }, 1);
    const two = note("two", { "a.json": a }, 2);
    expect(batchOfChanges([{ path: "a.json", text: "A" }], [one, two])?.batch).toBe("two");
    expect(
      batchOfChanges(
        [
          { path: "a.json", text: "A" },
          { path: "b.json", text: undefined },
        ],
        [one, two],
      )?.batch,
    ).toBe("one");
    // A file somebody else changed since, or one no batch wrote: nobody's in particular.
    expect(batchOfChanges([{ path: "a.json", text: "C" }], [one, two])).toBeUndefined();
    expect(batchOfChanges([{ path: "x.json", text: "A" }], [one])).toBeUndefined();
    expect(
      batchOfChanges(
        [
          { path: "a.json", text: "A" },
          { path: "b.json", text: "B" },
        ],
        [two, note("three", { "b.json": b }, 3)],
      ),
    ).toBeUndefined();
  });

  it("name the AI tools people know, and count what each did", () => {
    expect(knownTool({ name: "claude-code" })).toBe("claudeCode");
    expect(knownTool({ name: "codex-mcp-client" })).toBe("codex");
    expect(knownTool({ name: "cursor-vscode" })).toBe("cursor");
    expect(knownTool({ name: "Visual Studio Code" })).toBe("vscode");
    expect(knownTool({ name: "claude-ai" })).toBe("claudeDesktop");
    expect(knownTool({ name: "zed" })).toBeUndefined();
    expect(knownTool(undefined)).toBeUndefined();
    const uses = toolUses([
      note("1", {}, 5),
      note("2", {}, 9),
      { ...note("3", {}, 7), client: { name: "codex" } },
    ]);
    expect(uses.map(({ client, lastAt, batches }) => [client?.name, lastAt, batches])).toEqual([
      ["claude-code", 9, 2],
      ["codex", 7, 1],
    ]);
  });
});
