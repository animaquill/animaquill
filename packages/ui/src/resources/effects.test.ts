import { ProjectStore } from "@animaquill/core";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { describe, expect, it } from "vitest";
import { effectTypesUsed } from "./effects.ts";

describe("the effects a project uses", () => {
  it("are those of clips, tracks of sound, buses and the master", () => {
    const { store } = ProjectStore.open(loadFixture("v1"));
    if (!store) throw new Error("The example did not open");
    const used = effectTypesUsed(store.getState());
    // A clip, a track, a bus and the master each have one.
    for (const type of ["blur", "eq", "compressor", "reverb", "limiter"]) {
      expect(used.has(type)).toBe(true);
    }
    expect(used.has("saturation")).toBe(false);
    // The same state gives the same answer, without looking again.
    expect(effectTypesUsed(store.getState())).toBe(used);
  });
});
