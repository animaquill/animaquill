import { objectOfPath, pathOfObject, type ProjectState } from "@animaquill/core";
import type { TFunction } from "i18next";
import { fieldName } from "../chat/change-line.ts";
import { changeName } from "../chat/objectName.ts";

/**
 * A place of the project in a few words, as people know it: "片段「标题」 透明度", "项目 名称". For
 * the list of what stayed when something was taken back.
 */
export function placeText(t: TFunction, state: ProjectState, path: readonly string[]): string {
  const ref = objectOfPath(path);
  const kind = t(`chat.kinds.${ref.kind}`);
  const name = ref.kind === "project" ? undefined : changeName(t, ref, state);
  const what = name === undefined ? kind : `${kind}「${name}」`;
  const inner = path.slice(ref.kind === "project" ? 1 : pathOfObject(ref).length);
  const at = inner.indexOf("properties");
  const field =
    at >= 0 && inner[at + 1] !== undefined
      ? fieldName(t, `properties.${inner[at + 1]}`)
      : inner[0] !== undefined
        ? fieldName(t, inner[0])
        : undefined;
  return field === undefined ? what : `${what} ${field}`;
}
