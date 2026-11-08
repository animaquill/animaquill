import { nameKeyOf } from "@animaquill/core";
import type { PropertySpec } from "@animaquill/schema";
import type { TFunction } from "i18next";

/** Built-in properties find their names by path. What comes from a project brings its own. */
export const textOf = (t: TFunction, key: string, fallback: string): string =>
  (t as unknown as (key: string, options: { defaultValue: string }) => string)(key, {
    defaultValue: fallback,
  });

/** What a property is called. The properties of elements are called the same on every element. */
export const nameOf = (t: TFunction, spec: PropertySpec) =>
  spec.name ?? textOf(t, `property.name.${nameKeyOf(spec.path)}`, spec.path);

/**
 * Groups are words that code makes up as well, so only one that is a plain word can be one of the
 * groups the editor has names for. Anything else shows as it is.
 */
export const groupOf = (t: TFunction, group: string) =>
  /^[A-Za-z][A-Za-z0-9]*$/.test(group) ? textOf(t, `property.group.${group}`, group) : group;

/** What a part of a vector is called: as code names it, and the usual x, y, z and w in capitals. */
export const partNameOf = (name: string) => (/^[xyzw]$/.test(name) ? name.toUpperCase() : name);
