/**
 * Reading what a platform answered, field by field: a platform of another version can say more, or
 * less, and nothing it says is taken for what it should be before it was looked at.
 */

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

/** A field that is only there where it has a value. */
export const optional = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };

/** A project of the platform as an answer names it: its id there, and what it is called. */
export const projectOf = (
  value: unknown,
): { readonly id: string; readonly name: string } | undefined => {
  if (!isObject(value)) return undefined;
  const id = text(value.id);
  return id === undefined || id === "" ? undefined : { id, name: text(value.name) ?? "" };
};
