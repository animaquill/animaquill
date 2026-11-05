import type { SettingsStore } from "@animaquill/host";

export type Reading<T> =
  | { readonly kind: "empty" }
  | { readonly kind: "broken" }
  | { readonly kind: "ok"; readonly value: T };

/** Reads a setting. Whatever is wrong with it, the answer is "broken", not an exception. */
export async function readSetting<T>(
  settings: SettingsStore,
  key: string,
  parse: (value: unknown) => T | undefined,
): Promise<Reading<T>> {
  try {
    const value = await settings.load(key);
    if (value === undefined) return { kind: "empty" };
    const parsed = parse(value);
    if (parsed !== undefined) return { kind: "ok", value: parsed };
    console.warn(`Setting ${key} has an unknown format`);
  } catch (error) {
    console.warn(`Setting ${key} is unreadable`, error);
  }
  return { kind: "broken" };
}
