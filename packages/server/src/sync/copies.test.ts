import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { afterEach, describe, expect, test } from "vitest";
import { CopiesFull, WorkingCopies, weightOf } from "./copies.ts";

/** The working copies on their own, without a database: what they keep, and what they let go. */

const quiet = { warn() {} };
const copies: WorkingCopies[] = [];
afterEach(async () => {
  for (const each of copies.splice(0)) await each.stop();
});

const project = () => {
  const store = ProjectStore.create(createProject({ name: "测试" }));
  let structs = 0;
  for (const pieces of store.doc.store.clients.values()) structs += pieces.length;
  const state = store.encodeWhole();
  return { state, id: store.getState().manifest.id, weight: weightOf(state.length, structs) };
};

describe("the working copies", () => {
  test("give each person a share, and a project that is more than its share does not open", async () => {
    const a = project();
    const b = project();
    const busy = new Set(["a", "b"]);
    const working = new WorkingCopies({
      heapMb: 256,
      budget: 100 * a.weight,
      perPerson: Math.round(1.5 * a.weight),
      perProject: a.weight * 1.2,
      busy: () => busy,
      log: quiet,
    });
    copies.push(working);
    await working.open("a", [a.state], a.id, a.state.length, "ada", busy);
    // While something is done with both, both are more than ada's share.
    const opening = working.open("b", [b.state], b.id, b.state.length, "ada", busy);
    await expect(opening).rejects.toBeInstanceOf(CopiesFull);
    await expect(opening).rejects.toMatchObject({ isOwn: true });
    // Somebody else has a share of their own.
    await working.open("c", [b.state], b.id, b.state.length, "bob", busy);
    expect(working.isOpen("c")).toBe(true);
  });

  test("let go of what nothing is done with, once the thread says its heap runs full", async () => {
    const a = project();
    const b = project();
    const busy = new Set<string>();
    const working = new WorkingCopies({
      heapMb: 256,
      // Next to nothing: every answer says that the heap is past its high water, whatever is in it.
      heapHigh: 1,
      budget: 100 * a.weight,
      perPerson: 100 * a.weight,
      perProject: 100 * a.weight,
      busy: () => busy,
      log: quiet,
    });
    copies.push(working);
    await working.open("a", [a.state], a.id, a.state.length, "ada", busy);
    busy.add("b");
    await working.open("b", [b.state], b.id, b.state.length, "ada", busy);
    await expect.poll(() => working.isOpen("a")).toBe(false);
    expect(working.isOpen("b")).toBe(true);
    expect(working.heap).toBeGreaterThan(0);
  });
});
