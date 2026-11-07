import type { KeyEase } from "@animaquill/core";
import type { Key } from "@animaquill/schema";

/** What people pick from. Springs and the more elaborate presets come with the curve editor. */
export const EASE_PRESETS = [
  { id: "linear", ease: { interp: "linear" } },
  { id: "hold", ease: { interp: "hold" } },
  { id: "easeIn", ease: { interp: "bezier", out: [0.42, 0], in: [1, 1] } },
  { id: "easeOut", ease: { interp: "bezier", out: [0, 0], in: [0.58, 1] } },
  { id: "easeInOut", ease: { interp: "bezier", out: [0.42, 0], in: [0.58, 1] } },
  { id: "overshoot", ease: { interp: "bezier", out: [0.34, 1.56], in: [0.64, 1] } },
] as const satisfies readonly { id: string; ease: KeyEase }[];

export type EasePreset = (typeof EASE_PRESETS)[number]["id"];

const sameHandle = (a: readonly number[] | undefined, b: readonly number[]) =>
  a?.[0] === b[0] && a?.[1] === b[1];

/** Which preset a stretch is, as far as it is one. Without a next key only its start can tell. */
export function presetOf(key: Key, next: Key | undefined): EasePreset | undefined {
  const { interp, out } = key;
  if (interp === undefined || interp === "linear") return "linear";
  if (interp === "hold") return "hold";
  if (interp !== "bezier") return undefined;
  const arriving = next?.in ?? [1, 1];
  return EASE_PRESETS.find(
    ({ ease }) =>
      ease.interp === "bezier" &&
      sameHandle(out, ease.out) &&
      (next === undefined || sameHandle(arriving, ease.in)),
  )?.id;
}
