import { nameKeyOf, type ProjectState } from "@animaquill/core";
import type { TFunction } from "i18next";
import { changeName } from "./objectName.ts";
import type { TurnChange } from "./summary.ts";
import { textOf } from "../properties/names.ts";

/** Text from a project is text, whatever it looks like. */
const asText = { interpolation: { escapeValue: false } } as const;

/** A value the tools wrote down as missing (`shortText` of `@animaquill/tools`). */
const isNone = (value: string | undefined) => value === undefined || value === "none";

/** What a field of an object is called: a property by its name, anything else as the chat has it. */
export function fieldName(t: TFunction, path: string): string {
  if (path.startsWith("properties.")) {
    const property = path.slice("properties.".length);
    return textOf(t, `property.name.${nameKeyOf(property)}`, property);
  }
  const [top = path] = path.split(".");
  return t(`chat.fields.${top}`, { defaultValue: path });
}

/**
 * One change of what an AI tool did, as a sentence people read at once: "把片段「标题」改名为
 * 「新标题」", "把片段「标题」的时长从 5 改成 6". An object goes by the name it had before, which is
 * what people know it by. More fields of one object end in "等 N 项".
 */
export function changeLine(
  t: TFunction,
  change: TurnChange,
  state: ProjectState | undefined,
  pending = false,
): string {
  // A change people are asked about (S-D4) is not made yet: "新加标记", not "新加了标记".
  const words = pending ? "localAi.changePending" : "localAi.change";
  const kind = t(`chat.kinds.${change.kind}`);
  const renamed = change.fields.find(({ path }) => path === "name");
  const was = renamed && !isNone(renamed.before) ? renamed.before : undefined;
  const named = was ?? changeName(t, change, state);
  const name = named === undefined ? "" : `「${named}」`;
  if (change.lines) {
    return t(`${words}.lines`, { kind, name, ...change.lines, ...asText });
  }
  if (change.change === "added") return t(`${words}.added`, { kind, name, ...asText });
  if (change.change === "removed") return t(`${words}.removed`, { kind, name, ...asText });
  const [first] = change.fields;
  if (!first) return t(`${words}.changed`, { kind, name, ...asText });
  const { path, before, after } = first;
  const field = fieldName(t, path);
  const line =
    path === "name" && !isNone(after) && was !== undefined
      ? t(`${words}.renamed`, { kind, before: was, after, ...asText })
      : isNone(after)
        ? t(`${words}.cleared`, { kind, name, field, ...asText })
        : isNone(before)
          ? t(`${words}.set`, { kind, name, field, after, ...asText })
          : t(`${words}.from`, { kind, name, field, before, after, ...asText });
  return change.fields.length > 1
    ? t(`${words}.fieldsMore`, { line, count: change.fields.length, ...asText })
    : line;
}
