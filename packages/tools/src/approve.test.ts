import { USER, type CommandCall, type ProjectStore } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import {
  Approvals,
  allowedStore,
  previewStore,
  type Approval,
  type ApproveRequest,
} from "./approve.ts";
import { CallerState } from "./caller.ts";
import { testHost, toolsOn, type TestHost } from "./test-support.ts";
import { DECLINED, PLAN_FIRST, STOPPED } from "./tool.ts";
import { WRITE_TOOLS } from "./toolset.ts";
import type { ToolResult } from "./types.ts";

/**
 * "AI 改项目前先问我" (S-D4, the design of changes and gates of AnimaQuill Cloud, section 4): while
 * people want to be asked, no tool changes the project before they allow it, and what is written is
 * what they saw, against the project as they saw it. These tests are what keeps it so.
 */

const codeOf = (result: ToolResult | undefined) => /^error ([a-z-]+)/.exec(result?.text ?? "")?.[1];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const user = (store: ProjectStore, type: string, params: unknown) => {
  const done = store.execute({ type, params } as CommandCall, { origin: USER });
  expect(done.ok, JSON.stringify(done)).toBe(true);
};

/** A request people have in front of them, and their answer to it. */
interface Asked {
  readonly request: ApproveRequest;
  readonly answer: (approval: Approval) => void;
}

/** People who want to be asked: each request waits until the test answers it. */
function asking(host: TestHost): Asked[] {
  const asked: Asked[] = [];
  host.approve = (request) => new Promise((answer) => asked.push({ request, answer }));
  return asked;
}

/** Waits until people were asked so many times, or fails. */
async function askedTimes(asked: readonly Asked[], times: number): Promise<void> {
  for (let tries = 0; tries < 100 && asked.length < times; tries += 1) await tick();
  expect(asked.length).toBe(times);
}

const FILE = "code/asked.js";
const TEXT = "export const a = 1;\nexport const b = 2;\n";

/** A change of each tool that writes, which goes through on the sample: see `prepared`. */
const CHANGES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  aq_edit: {
    operations: [{ op: "marker.add", timeline: "main", time: "7", name: "Asked" }],
    summary: "Adds a marker",
  },
  aq_file_edit: { path: FILE, edits: [{ old_text: "a = 1", new_text: "a = 10" }] },
  aq_file_write: { path: "code/new.js", text: "export const n = 1;\n" },
};

/** The sample with the file that aq_file_edit changes, and the tools, people not asked yet. */
async function prepared() {
  const host = testHost();
  const tools = toolsOn(host);
  expect((await tools.call("aq_file_write", { path: FILE, text: TEXT })).isError).toBe(false);
  tools.caller.beginAnswer();
  return { ...tools, host, store: host.store() as ProjectStore };
}

describe("asked before a change", () => {
  it("knows the tools that change the project", () => {
    expect([...WRITE_TOOLS].toSorted()).toEqual(Object.keys(CHANGES).toSorted());
  });

  it.each([...WRITE_TOOLS])(
    "%s writes nothing while people have not answered, and nothing once they say no",
    async (name) => {
      const { call, caller, host, store } = await prepared();
      const asked = asking(host);
      const revision = store.revisionId;
      const files = store.exportFiles().files;
      let done = false;
      const waiting = call(name, CHANGES[name]).then((result) => {
        done = true;
        return result;
      });
      await askedTimes(asked, 1);
      for (let index = 0; index < 20; index += 1) await tick();
      // Never answered: it waits, and the project is as it was.
      expect(done).toBe(false);
      expect(store.revisionId).toBe(revision);
      expect(store.exportFiles().files).toEqual(files);
      // What people see is what it would change, and the project now and after it.
      const { request } = asked[0] as Asked;
      expect(request.tool).toBe(name);
      expect(request.revision).toBe(revision);
      expect(request.before).toBe(store.getState());
      expect(request.after).not.toBe(store.getState());
      expect(request.changes.length).toBeGreaterThan(0);
      asked[0]?.answer("no");
      const result = await waiting;
      expect(result.text).toBe(DECLINED);
      expect(result.data?.declined).toBe(true);
      expect(store.revisionId).toBe(revision);
      expect(store.exportFiles().files).toEqual(files);
      // The rest of the answer is held back, people not asked again; the next answer asks again.
      for (const other of WRITE_TOOLS) {
        expect(codeOf(await call(other, CHANGES[other]))).toBe("not-run");
      }
      expect(asked.length).toBe(1);
      expect(store.revisionId).toBe(revision);
      caller.beginAnswer();
      const again = call(name, CHANGES[name]);
      await askedTimes(asked, 2);
      asked[1]?.answer("once");
      expect((await again).isError).toBe(false);
      expect(store.revisionId).not.toBe(revision);
    },
  );

  it.each([...WRITE_TOOLS])("%s writes once allowed, and asks again for the next", async (name) => {
    const { call, host, store } = await prepared();
    const asked = asking(host);
    const revision = store.revisionId;
    const first = call(name, CHANGES[name]);
    await askedTimes(asked, 1);
    asked[0]?.answer("once");
    const result = await first;
    expect(result.isError, result.text).toBe(false);
    expect(result.data?.approved).toBe("once");
    expect(store.revisionId).not.toBe(revision);
    // What was written is what people saw.
    expect(store.getState()).toEqual(asked[0]?.request.after);
    const written = store.revisionId;
    const second = call("aq_edit", CHANGES.aq_edit);
    await askedTimes(asked, 2);
    expect(store.revisionId).toBe(written);
    asked[1]?.answer("once");
    expect((await second).isError).toBe(false);
  });

  it("allows every change of the run with 'task', and of no other run, nor after a reload", async () => {
    const { host, store, caller } = await prepared();
    const asked = asking(host);
    const run = toolsOn(host, caller);
    const first = run.call("aq_edit", CHANGES.aq_edit);
    await askedTimes(asked, 1);
    asked[0]?.answer("task");
    expect((await first).data?.approved).toBe("task");
    for (const name of WRITE_TOOLS) {
      const result = await run.call(name, CHANGES[name]);
      expect(result.isError, result.text).toBe(false);
      expect(result.data?.approved).toBe("earlier");
    }
    expect(asked.length).toBe(1);
    // Another run of a task (another message, or the same task tried again): asked again.
    const next = toolsOn(host, caller);
    const revision = store.revisionId;
    const other = next.call("aq_edit", CHANGES.aq_edit);
    await askedTimes(asked, 2);
    expect(store.revisionId).toBe(revision);
    asked[1]?.answer("no");
    expect((await other).text).toBe(DECLINED);
    // After a reload, with what the conversation kept: asked again.
    const reloaded = toolsOn(host, CallerState.from(JSON.parse(JSON.stringify(caller))));
    const after = reloaded.call("aq_edit", CHANGES.aq_edit);
    await askedTimes(asked, 3);
    expect(store.revisionId).toBe(revision);
    asked[2]?.answer("stopped");
    expect((await after).text).toBe(STOPPED);
  });

  it("keeps what one run allowed for that run: one Approvals for each", async () => {
    const { host, caller } = await prepared();
    const asked = asking(host);
    const approvals = new Approvals();
    const first = toolsOn(host, caller, undefined, { approvals });
    const done = first.call("aq_edit", CHANGES.aq_edit);
    await askedTimes(asked, 1);
    asked[0]?.answer("task");
    await done;
    // The same run makes its tools again, as after making room in the context: still allowed.
    const again = toolsOn(host, caller, undefined, { approvals });
    expect((await again.call("aq_edit", CHANGES.aq_edit)).data?.approved).toBe("earlier");
    expect(asked.length).toBe(1);
  });

  it("writes nothing that people did not see: what changed meanwhile at that place is a conflict", async () => {
    const { call, host, store } = await prepared();
    await call("aq_timeline_read");
    const asked = asking(host);
    const rename = {
      operations: [
        { op: "clip.update", timeline: "main", clip: "clip_title", changes: { name: "AI" } },
      ],
    };
    const waiting = call("aq_edit", rename);
    await askedTimes(asked, 1);
    user(store, "clip.update", { timeline: "main", clip: "clip_title", changes: { name: "用户" } });
    const changed = store.revisionId;
    // AI reads it meanwhile, as calls that run beside it may: that is no leave to write over it.
    await call("aq_object_read", { timeline: "main", ids: ["clip_title"] });
    asked[0]?.answer("once");
    const result = await waiting;
    expect(codeOf(result)).toBe("conflict");
    expect(result.text).toContain("the project changed while this change waited for the user");
    expect(result.data?.changedWhileAsked).toBe(true);
    expect(store.getState().timelines.main?.clips.clip_title?.name).toBe("用户");
    expect(store.revisionId).toBe(changed);
  });

  it("writes nothing of a file that changed while people looked", async () => {
    const { call, host, store } = await prepared();
    const asked = asking(host);
    const waiting = call("aq_file_edit", CHANGES.aq_file_edit);
    await askedTimes(asked, 1);
    // People change another line of the same file.
    user(store, "file.write", { path: FILE, text: TEXT.replace("b = 2", "b = 3") });
    const changed = store.revisionId;
    asked[0]?.answer("once");
    const result = await waiting;
    expect(result.isError).toBe(true);
    expect(store.revisionId).toBe(changed);
    expect(store.getState().files[FILE]).toBe(TEXT.replace("b = 2", "b = 3"));
  });

  it("writes what people saw where the project changed elsewhere meanwhile, the same ids too", async () => {
    const { call, host, store } = await prepared();
    const asked = asking(host);
    const waiting = call("aq_edit", CHANGES.aq_edit);
    await askedTimes(asked, 1);
    user(store, "clip.update", { timeline: "main", clip: "clip_logo", changes: { name: "别处" } });
    asked[0]?.answer("once");
    const result = await waiting;
    expect(result.isError, result.text).toBe(false);
    const seen = Object.keys(asked[0]?.request.after.timelines.main?.markers ?? {});
    const now = Object.keys(store.getState().timelines.main?.markers ?? {});
    expect(now).toEqual(seen);
    expect(store.getState().timelines.main?.clips.clip_logo?.name).toBe("别处");
  });

  it("asks nothing of a change that fails as a preview, nor of a dry run, nor while a plan comes first", async () => {
    const { call, caller, host, store } = await prepared();
    const asked = asking(host);
    const revision = store.revisionId;
    const wrong = await call("aq_edit", {
      operations: [{ op: "clip.update", timeline: "main", clip: "nobody", changes: { name: "x" } }],
    });
    expect(codeOf(wrong)).toBe("not-found");
    caller.beginAnswer();
    const dry = await call("aq_edit", { ...CHANGES.aq_edit, dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.text).toContain("dry run");
    host.plan = true;
    for (const name of WRITE_TOOLS) expect((await call(name, CHANGES[name])).text).toBe(PLAN_FIRST);
    expect(asked.length).toBe(0);
    expect(store.revisionId).toBe(revision);
    // The same change for real after its dry run: asked.
    host.plan = false;
    const real = call("aq_edit", CHANGES.aq_edit);
    await askedTimes(asked, 1);
    expect(store.revisionId).toBe(revision);
    asked[0]?.answer("no");
    await real;
    expect(store.revisionId).toBe(revision);
  });

  it("gives back by request_id only what people allowed and was written", async () => {
    const { call, caller, host, store } = await prepared();
    const asked = asking(host);
    const change = { ...CHANGES.aq_edit, request_id: "r1" };
    const declined = call("aq_edit", change);
    await askedTimes(asked, 1);
    asked[0]?.answer("no");
    expect((await declined).text).toBe(DECLINED);
    caller.beginAnswer();
    // Not allowed is not kept: the same request asks again.
    const revision = store.revisionId;
    const again = call("aq_edit", change);
    await askedTimes(asked, 2);
    expect(store.revisionId).toBe(revision);
    asked[1]?.answer("once");
    const written = await again;
    expect(written.isError).toBe(false);
    const after = store.revisionId;
    // Allowed and written: sent again, it is given back, written once, nobody asked.
    expect((await call("aq_edit", change)).text).toBe(written.text);
    expect(store.revisionId).toBe(after);
    // Other parameters under the same request_id are refused.
    const other = await call("aq_edit", {
      operations: [{ op: "marker.add", timeline: "main", time: "8", name: "Other" }],
      request_id: "r1",
    });
    expect(codeOf(other)).toBe("invalid-params");
    expect(asked.length).toBe(2);
    expect(store.revisionId).toBe(after);
  });

  it("asks and writes once for the same request_id sent twice at once", async () => {
    const { call, host, store } = await prepared();
    const asked = asking(host);
    const change = { ...CHANGES.aq_edit, request_id: "twice" };
    const first = call("aq_edit", change);
    const second = call("aq_edit", change);
    await askedTimes(asked, 1);
    asked[0]?.answer("once");
    const [one, two] = await Promise.all([first, second]);
    expect(one.isError).toBe(false);
    expect(two.text).toBe(one.text);
    expect(asked.length).toBe(1);
    expect(Object.keys(store.getState().timelines.main?.markers ?? {})).toHaveLength(
      Object.keys(asked[0]?.request.after.timelines.main?.markers ?? {}).length,
    );
  });

  it("writes nothing when the task stops, or the project closes, while it waits", async () => {
    const { call, caller, host, store } = await prepared();
    const asked = asking(host);
    const revision = store.revisionId;
    const stopped = call("aq_edit", CHANGES.aq_edit);
    await askedTimes(asked, 1);
    asked[0]?.answer("stopped");
    expect((await stopped).text).toBe(STOPPED);
    // Stopped right as people allowed it: nothing is written.
    let stopping = false;
    host.stopped = () => stopping;
    const late = asking(host);
    const allowedLate = call("aq_edit", CHANGES.aq_edit);
    await askedTimes(late, 1);
    stopping = true;
    late[0]?.answer("once");
    expect((await allowedLate).text).toBe(STOPPED);
    stopping = false;
    // A host whose asking failed: a failure of the editor, which holds back the rest of the answer.
    host.approve = () => Promise.reject(new Error("gone"));
    expect(codeOf(await call("aq_edit", CHANGES.aq_edit))).toBe("internal");
    expect(codeOf(await call("aq_edit", CHANGES.aq_edit))).toBe("not-run");
    caller.beginAnswer();
    const closing = asking(host);
    const closed = call("aq_edit", CHANGES.aq_edit);
    await askedTimes(closing, 1);
    host.open(undefined);
    closing[0]?.answer("once");
    expect(codeOf(await closed)).toBe("no-project");
    expect(store.revisionId).toBe(revision);
  });

  it("asks one change at a time: the next waits until the one before is answered", async () => {
    const { call, host, store } = await prepared();
    const asked = asking(host);
    const first = call("aq_edit", CHANGES.aq_edit);
    const second = call("aq_file_edit", CHANGES.aq_file_edit);
    await askedTimes(asked, 1);
    for (let index = 0; index < 20; index += 1) await tick();
    expect(asked.length).toBe(1);
    asked[0]?.answer("once");
    await first;
    await askedTimes(asked, 2);
    // Worked out after the first was written: from the project with it.
    expect(asked[1]?.request.revision).toBe(store.revisionId);
    asked[1]?.answer("once");
    expect((await second).isError).toBe(false);
  });

  it("holds back what waited behind a change not allowed, and keeps no result of it", async () => {
    const { call, caller, host, store } = await prepared();
    const asked = asking(host);
    const revision = store.revisionId;
    const first = call("aq_edit", CHANGES.aq_edit);
    const second = call("aq_file_write", { ...CHANGES.aq_file_write, request_id: "behind" });
    await askedTimes(asked, 1);
    asked[0]?.answer("no");
    expect((await first).text).toBe(DECLINED);
    const held = await second;
    expect(codeOf(held)).toBe("not-run");
    expect(held.data?.afterDeclined).toBe(true);
    expect(asked.length).toBe(1);
    expect(store.revisionId).toBe(revision);
    // Not a failure of this answer, and no result to give again: the next answer asks.
    expect(caller.answer.failedWrite).toBe(false);
    caller.beginAnswer();
    const again = call("aq_file_write", { ...CHANGES.aq_file_write, request_id: "behind" });
    await askedTimes(asked, 2);
    asked[1]?.answer("once");
    expect((await again).isError).toBe(false);
  });

  it("leaves what the conversation read as it was, for a change not allowed", async () => {
    const { call, caller, host } = await prepared();
    await call("aq_timeline_read");
    const before = JSON.stringify(caller);
    const asked = asking(host);
    const waiting = call("aq_file_edit", CHANGES.aq_file_edit);
    await askedTimes(asked, 1);
    asked[0]?.answer("no");
    await waiting;
    expect(JSON.stringify(caller)).toBe(before);
  });

  it("is as before where the host does not ask", async () => {
    const { call, store } = await prepared();
    const revision = store.revisionId;
    const result = await call("aq_edit", CHANGES.aq_edit);
    expect(result.isError).toBe(false);
    expect(result.data?.approved).toBeUndefined();
    expect(store.revisionId).not.toBe(revision);
  });
});

describe("the stores around a change people are asked about", () => {
  const marker = [{ type: "marker.add", params: { timeline: "main", time: "7", name: "M" } }];

  it("writes nothing on the preview, and only what it found once allowed, with its ids", async () => {
    const { store } = await prepared();
    const revision = store.revisionId;
    const preview = previewStore(store);
    const tried = preview.store.executeBatch(marker, { origin: "ai:t1" });
    expect(tried.ok).toBe(true);
    expect(store.revisionId).toBe(revision);
    const [found] = preview.found;
    const done = allowedStore(store, revision, preview.found).executeBatch(marker, {
      origin: "ai:t1",
    });
    expect(done.ok).toBe(true);
    expect(done.ok && done.patches).toEqual(found?.patches);
  });

  it("refuses what differs from the preview, and more than it found", async () => {
    const { store } = await prepared();
    const revision = store.revisionId;
    const preview = previewStore(store);
    preview.store.executeBatch(marker, { origin: "ai:t1" });
    const [found] = preview.found;
    if (!found) throw new Error("no preview");
    const other = [
      {
        ...found,
        patches: found.patches.map((patch, index) =>
          index === 0 ? { ...patch, path: ["x"] } : patch,
        ),
      },
    ];
    const tampered = allowedStore(store, revision, other).executeBatch(marker, { origin: "ai:t1" });
    expect(!tampered.ok && tampered.error.code).toBe("conflict");
    const more = allowedStore(store, revision, []).executeBatch(marker, { origin: "ai:t1" });
    expect(!more.ok && more.error.code).toBe("conflict");
    expect(store.revisionId).toBe(revision);
  });

  it("refuses whatever else would change the project", async () => {
    const { store } = await prepared();
    const preview = previewStore(store);
    expect(() => preview.store.undo()).toThrow();
    expect(() => preview.store.importFile("code/x.js", "", { origin: USER })).toThrow();
    expect(() => preview.store.doc).toThrow();
  });
});
