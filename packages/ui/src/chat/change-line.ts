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

/** How one change goes in words, see `changeLine` and `changeParts`. */
type Said = "lines" | "added" | "removed" | "changed" | "renamed" | "cleared" | "set" | "from";

interface Pieces {
  readonly said: Said;
  readonly kind: string;
  /** "「标题」", or nothing where the object has no name to tell. */
  readonly name: string;
  readonly field?: string;
  readonly before?: string;
  readonly after?: string;
  /** How many fields of the object changed, the first of them told. */
  readonly fields: number;
}

/** What `changeLine` and `changeParts` both say, so that they never say it differently. */
function piecesOf(t: TFunction, change: TurnChange, state: ProjectState | undefined): Pieces {
  const kind = t(`chat.kinds.${change.kind}`);
  const renamed = change.fields.find(({ path }) => path === "name");
  const was = renamed && !isNone(renamed.before) ? renamed.before : undefined;
  const named = was ?? changeName(t, change, state);
  const name = named === undefined ? "" : `「${named}」`;
  const fields = change.fields.length;
  if (change.lines) return { said: "lines", kind, name, fields };
  if (change.change === "added" || change.change === "removed")
    return { said: change.change, kind, name, fields };
  const [first] = change.fields;
  if (!first) return { said: "changed", kind, name, fields };
  const { path, before, after } = first;
  const field = fieldName(t, path);
  if (path === "name" && !isNone(after) && was !== undefined)
    return { said: "renamed", kind, name, field, before: was, after, fields };
  if (isNone(after)) return { said: "cleared", kind, name, field, fields };
  if (isNone(before)) return { said: "set", kind, name, field, after, fields };
  return { said: "from", kind, name, field, before, after, fields };
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
  const { said, kind, name, field, before, after, fields } = piecesOf(t, change, state);
  if (said === "lines") return t(`${words}.lines`, { kind, name, ...change.lines, ...asText });
  const line = t(`${words}.${said}`, { kind, name, field, before, after, ...asText });
  return fields > 1 && said !== "added" && said !== "removed" && said !== "changed"
    ? t(`${words}.fieldsMore`, { line, count: fields, ...asText })
    : line;
}

/**
 * One change as the card of a turn lays it out in a row (docs/design/chat-panel.md of AnimaQuill
 * Cloud, 5.5): the object, what of it changed, and its value before and after, which a narrow chat
 * leaves to the row opened. Said as `changeLine` says it.
 */
export interface ChangeParts {
  /** "片段「标题」". */
  readonly object: string;
  /** A field ("位置 Y", "时长等 3 项"), the code, or what became of the object ("新加了"). */
  readonly what: string;
  /** The value before, where there was one; with `after`, "820 → 780". */
  readonly before?: string;
  /** The value after; or what became of the field ("去掉了"), or of the lines ("+6 −2 行"). */
  readonly after?: string;
}

export function changeParts(
  t: TFunction,
  change: TurnChange,
  state: ProjectState | undefined,
  pending = false,
): ChangeParts {
  const words = pending ? "chat.card.rowPending" : "chat.card.row";
  const { said, kind, name, field, before, after, fields } = piecesOf(t, change, state);
  const object = `${kind}${name}`;
  if (said === "lines")
    return {
      object,
      what: t("chat.card.row.code"),
      after: t("chat.card.row.lines", { added: 0, removed: 0, ...change.lines }),
    };
  if (said === "added" || said === "removed" || said === "changed")
    return { object, what: t(`${words}.${said}`) };
  const what =
    fields > 1 ? t("chat.card.row.fieldsMore", { field, count: fields, ...asText }) : (field ?? "");
  if (said === "cleared") return { object, what, after: t(`${words}.cleared`) };
  return {
    object,
    what,
    ...(said === "from" || said === "renamed" ? { before: before as string } : {}),
    after: after as string,
  };
}
