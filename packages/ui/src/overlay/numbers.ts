import { channelOf, sample } from "@animaquill/core";
import type { PropertySpec, PropertyValue } from "@animaquill/schema";

/** Enough for anything a person means, and it keeps float noise out of project files. */
const KEPT_DIGITS = 6;

/** A value as it gets written: within the limits of its property, without float noise. */
export function tidy(value: number, spec: PropertySpec): number {
  const kept = Number(value.toFixed(KEPT_DIGITS));
  return Math.min(Math.max(kept === 0 ? 0 : kept, spec.min ?? -Infinity), spec.max ?? Infinity);
}

/** What a property comes to at a reading of the clock of its clip, as a number. */
export function numberAt(
  value: PropertyValue | undefined,
  spec: PropertySpec,
  clock: number,
): number | undefined {
  const channel = value === undefined ? undefined : channelOf(value, spec.type);
  const found = channel ? sample(channel, clock) : spec.default;
  return typeof found === "number" ? found : undefined;
}
