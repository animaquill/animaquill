import { FAILURE_CODES, type CommandFailure, type FailureCode } from "@animaquill/core";
import { FAILURE_SAMPLES, INVALID_VALUE_SAMPLES } from "@animaquill/core/failure-samples";
import { describe, expect, it } from "vitest";
import { FAILURE_TEXTS, aiCode, failureText, operationFailureText } from "./failures-en.ts";
import { ADVICE } from "./test-support.ts";

/** Chinese, and the punctuation that comes with it. */
const CJK = /[　-〿一-鿿＀-￯]/;

/** Every string a failure was given, which the text can repeat. */
function given(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(given);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(given);
  return [];
}

describe("what failures say to AI", () => {
  it("says how the same call can work, where it can", () => {
    const says = (code: FailureCode) =>
      failureText(FAILURE_SAMPLES.find((sample) => sample.code === code) as CommandFailure);
    expect(says("missing-updates")).toContain("the same call works once they are in");
    expect(says("project-locked")).toContain("until the user removes the tag");
    expect(says("read-only")).toContain("until it can be written again");
    expect(says("conflict")).toContain("a change sent after reading it again is checked");
  });

  it("says what happened, and no advice", () => {
    const texts = [...FAILURE_SAMPLES, ...INVALID_VALUE_SAMPLES].map((sample) =>
      failureText(sample as CommandFailure),
    );
    const found = texts.filter((text) => ADVICE.some((advice) => advice.test(text)));
    expect(found).toEqual([]);
  });

  it("is there for every code", () => {
    expect(Object.keys(FAILURE_TEXTS).toSorted()).toEqual([...FAILURE_CODES].toSorted());
  });

  it.each([...FAILURE_SAMPLES, ...INVALID_VALUE_SAMPLES].map((sample) => [sample.code, sample]))(
    "for %s is English, with the code first",
    (code, sample) => {
      const text = failureText(sample as CommandFailure);
      expect(text.startsWith(`${aiCode(code as FailureCode)}: `)).toBe(true);
      expect(text.length).toBeGreaterThan(code.length + 10);
      expect(text).not.toMatch(/undefined|\[object Object\]/);
      let own = text;
      for (const value of given((sample as CommandFailure).params)) own = own.replaceAll(value, "");
      expect(own).not.toMatch(CJK);
    },
  );

  it("of a batch says which operation it was", () => {
    const failure: CommandFailure = {
      code: "not-found",
      params: { kind: "clip", id: "c9" },
      index: 2,
    };
    expect(operationFailureText(failure, ["clip.add", "clip.move", "clip.remove"])).toBe(
      "error not-found in operations[2] (clip.remove): There is no clip c9.\noperations[0] and [1] were fine; nothing was written",
    );
    const first = { ...failure, index: 0 };
    expect(operationFailureText(first, ["clip.remove", "clip.add"])).toBe(
      "error not-found in operations[0] (clip.remove): There is no clip c9.\nnothing was written; operations after [0] were not checked",
    );
  });

  it("says what only people may do in the words of the tools", () => {
    const failure: CommandFailure = { code: "user-only", params: { command: "project.setTags" } };
    expect(failureText(failure)).toMatch(/^not-allowed: Only the user can do project.setTags/);
  });
});
