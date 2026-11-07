import type { PropertySpec } from "@animaquill/schema";
import type { TFunction } from "i18next";

/** Built-in properties find their names by path. What comes from a project brings its own. */
export const textOf = (t: TFunction, key: string, fallback: string): string =>
  (t as unknown as (key: string, options: { defaultValue: string }) => string)(key, {
    defaultValue: fallback,
  });

export const nameOf = (t: TFunction, spec: PropertySpec) =>
  spec.name ?? textOf(t, `property.name.${spec.path}`, spec.path);

export const groupOf = (t: TFunction, group: string) => textOf(t, `property.group.${group}`, group);
