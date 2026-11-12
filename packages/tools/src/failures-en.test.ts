import { FAILURE_CODES, type CommandFailure } from "@animaquill/core";
import { FAILURE_SAMPLES, INVALID_VALUE_SAMPLES } from "@animaquill/core/failure-samples";
import { describe, expect, it } from "vitest";
import { FAILURE_TEXTS, failureText, operationFailureText } from "./failures-en.ts";

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
  it("is there for every code", () => {
    expect(Object.keys(FAILURE_TEXTS).toSorted()).toEqual([...FAILURE_CODES].toSorted());
  });

  it.each([...FAILURE_SAMPLES, ...INVALID_VALUE_SAMPLES].map((sample) => [sample.code, sample]))(
    "for %s is English, with the code first",
    (code, sample) => {
      const text = failureText(sample as CommandFailure);
      expect(text.startsWith(`${code}: `)).toBe(true);
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
      "Operation 3 (clip.remove) failed, nothing was changed. not-found: There is no clip c9.",
    );
    expect(operationFailureText(failure, ["clip.remove"])).toBe("not-found: There is no clip c9.");
  });
});
