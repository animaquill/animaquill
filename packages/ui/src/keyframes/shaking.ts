import { canShake, isNumeric } from "@animaquill/core";
import type { Animation, PropertySpec, ValueType } from "@animaquill/schema";
import type { TFunction } from "i18next";
import type { MenuItem } from "../app/Menu.tsx";

/**
 * What a property does before its first key and after its last, and how it shakes, as the menu of
 * its row and the bubble of shaking show them. The format has it all, see `setExtend`, `setNoise`.
 */

export type ExtendMode = NonNullable<Animation["before"]>;
export type ExtendSide = "before" | "after";

export const EXTEND_SIDES: readonly ExtendSide[] = ["before", "after"];

/** In the order of the menu: holding is what keys do anyway, so it comes first. */
const MODES: readonly ExtendMode[] = ["hold", "loop", "pingpong", "continue"];

/** How a property goes on at both ends. */
export interface Extend {
  readonly before: ExtendMode;
  readonly after: ExtendMode;
}

/** Shaking as people tune it: what the format leaves out is what it means. */
export interface Shaking {
  readonly amount: number;
  readonly frequency: number;
  readonly seed: number;
}

/** Twice a second, the calm wiggle of `wiggle(2, …)` in After Effects. */
export const DEFAULT_FREQUENCY = 2;
/** Seeds that people can read, as the command gives them. */
const SEEDS = 1_000_000;

/** Going on at the slope of the ends needs a single number: the format holds anything else. */
export const modesFor = (type: ValueType): readonly ExtendMode[] =>
  isNumeric(type) ? MODES : MODES.filter((mode) => mode !== "continue");

/** Whether a property has shaking to offer: numbers, angles and vectors. */
export const canShakeType = (type: ValueType): boolean => canShake(type);

/** How far a new shaking goes, by unit: enough to see, little enough to keep the shot. */
const AMOUNTS: Readonly<Record<string, number>> = {
  world: 20,
  deg: 5,
  ratio: 0.05,
  db: 3,
  semitone: 1,
};

export function defaultAmountOf(spec: PropertySpec): number {
  const known = AMOUNTS[spec.unit ?? ""];
  if (known !== undefined) return known;
  const { min, max, softMin, softMax } = spec;
  const low = softMin ?? min;
  const high = softMax ?? max;
  return low !== undefined && high !== undefined && high > low ? (high - low) / 20 : 1;
}

/** How a property goes on and shakes, from what it holds. */
export function extendOf(animation: Animation): Extend {
  return { before: animation.before ?? "hold", after: animation.after ?? "hold" };
}

/** The shaking of a property, as one: the first one the format has, which is what the editor writes. */
export function shakingOf(animation: Animation | undefined): Shaking | undefined {
  const noise = animation?.modifiers?.find((modifier) => modifier.type === "noise");
  return noise && { amount: noise.amount, frequency: noise.frequency ?? 1, seed: noise.seed };
}

/** Another seed, never the one it was, so that the dice always change something. */
export function anotherSeed(seed: number, random: () => number = Math.random): number {
  const next = Math.floor(random() * (SEEDS - 1));
  return next >= seed ? next + 1 : next;
}

export interface PropertyMenuState {
  readonly type: ValueType;
  /** How it goes on at both ends; undefined without keys, which have no ends. */
  readonly extend: Extend | undefined;
  /** Whether it shakes already. */
  readonly shaking: boolean;
  /** Whether the clip can change right now. */
  readonly changeable: boolean;
  /** Whether there is a value to start shaking from. */
  readonly hasValue: boolean;
  setExtend(side: ExtendSide, mode: ExtendMode): void;
  shake(): void;
}

/**
 * What the menu of a row of a property offers for its ends and for shaking: one menu for each end,
 * with what it does now ticked, and the bubble of shaking for what can shake.
 */
export function extendMenuGroup(t: TFunction, state: PropertyMenuState): readonly MenuItem[] {
  const { type, extend, changeable } = state;
  const sides = EXTEND_SIDES.map((side): MenuItem => ({
    id: side,
    label: t(`keyframes.extend.${side}`),
    disabled: !extend || !changeable,
    run: () => undefined,
    items: [
      modesFor(type).map((mode) => ({
        id: `${side}-${mode}`,
        label: t(`keyframes.extend.${mode}`),
        selected: extend?.[side] === mode,
        run: () => state.setExtend(side, mode),
      })),
    ],
  }));
  if (!canShakeType(type)) return sides;
  return [
    ...sides,
    {
      id: "noise",
      label: t("keyframes.noise.action"),
      disabled: !changeable || (!state.shaking && !state.hasValue),
      run: () => state.shake(),
    },
  ];
}
