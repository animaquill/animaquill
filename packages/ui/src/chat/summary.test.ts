import type { ChatEntry } from "@animaquill/agent";
import { describe, expect, it } from "vitest";
import { clipsOf, summaryOf } from "./summary.ts";

let calls = 0;
const edit = (data: Record<string, unknown>, name = "aq_edit", ok = true): ChatEntry => ({
  role: "tool",
  call: `c${++calls}`,
  name,
  ok,
  text: "",
  at: calls,
  data,
});

describe("the summary of a turn", () => {
  it("takes each field from before the first change to after the last", () => {
    const summary = summaryOf([
      edit({
        summary: "Rename the title",
        changes: [
          {
            kind: "clip",
            id: "clip_title",
            timeline: "main",
            change: "changed",
            fields: [{ path: "name", before: "标题", after: "A" }],
          },
        ],
      }),
      edit({
        summary: "And again",
        changes: [
          {
            kind: "clip",
            id: "clip_title",
            timeline: "main",
            name: "B",
            change: "changed",
            fields: [{ path: "name", before: "A", after: "B" }],
          },
        ],
      }),
    ]);
    expect(summary.said).toEqual(["Rename the title", "And again"]);
    expect(summary.changes).toEqual([
      {
        key: "clip\nmain\nclip_title",
        kind: "clip",
        id: "clip_title",
        timeline: "main",
        name: "B",
        change: "changed",
        fields: [{ path: "name", before: "标题", after: "B" }],
      },
    ]);
  });

  it("leaves out what the turn made and took away, what failed, and dry runs", () => {
    const summary = summaryOf([
      edit({ changes: [{ kind: "marker", id: "m1", timeline: "main", change: "added" }] }),
      edit({ changes: [{ kind: "marker", id: "m1", timeline: "main", change: "removed" }] }),
      edit({
        dryRun: true,
        changes: [{ kind: "clip", id: "c1", timeline: "main", change: "removed" }],
      }),
      edit(
        { changes: [{ kind: "clip", id: "c2", timeline: "main", change: "removed" }] },
        "aq_edit",
        false,
      ),
      edit(
        { changes: [{ kind: "clip", id: "c3", timeline: "main", change: "removed" }] },
        "aq_timeline_read",
      ),
    ]);
    expect(summary.changes).toEqual([]);
    expect(summary.told).toBe(true);
  });

  it("keeps an object made in the turn as made, and adds up the lines of files", () => {
    const summary = summaryOf([
      edit({ changes: [{ kind: "clip", id: "c1", timeline: "main", change: "added" }] }),
      edit({
        changes: [
          {
            kind: "clip",
            id: "c1",
            timeline: "main",
            change: "changed",
            fields: [{ path: "start", before: "0", after: "1" }],
          },
        ],
      }),
      edit(
        {
          changes: [
            { kind: "file", id: "code/a.js", change: "changed", lines: { added: 2, removed: 1 } },
          ],
        },
        "aq_file_edit",
      ),
      edit(
        {
          changes: [
            { kind: "file", id: "code/a.js", change: "changed", lines: { added: 1, removed: 0 } },
          ],
        },
        "aq_file_edit",
      ),
    ]);
    expect(summary.changes.map(({ id, change }) => `${change} ${id}`)).toEqual([
      "added c1",
      "changed code/a.js",
    ]);
    expect(summary.changes[1]?.lines).toEqual({ added: 3, removed: 1 });
    expect([...clipsOf(summary)]).toEqual(["c1"]);
  });

  it("knows a turn of the tools before, which said nothing of what they changed", () => {
    const old: ChatEntry = {
      role: "tool",
      call: "x",
      name: "marker_add",
      ok: true,
      text: "{}",
      at: 1,
    };
    expect(summaryOf([old])).toEqual({ changes: [], said: [], told: false });
  });
});
