import { nameKeyOf } from "@animaquill/core";
import type { TFunction } from "i18next";
import { textOf } from "../properties/names.ts";
import type { Operation } from "../workbench/operations.ts";

/** Commands that change properties, which an operation is named after the property for. */
const PROPERTY_COMMANDS = new Set(["property.edit", "clip.setProperty", "clip.clearProperty"]);

/** Commands that come along with what people asked for, and do not name it. */
const ALONG = new Set(["track.add"]);

/** What a property is called, by its path as the project keeps it. */
const propertyName = (t: TFunction, path: string) =>
  textOf(t, `property.name.${nameKeyOf(path)}`, path);

/**
 * An operation in a few words: what people did here by its main command, or by the property it
 * changed; an AI task and a batch of files by how much they changed.
 */
export function operationText(t: TFunction, operation: Operation): string {
  const { source, commands, properties, count } = operation;
  if (source === "ai") return t("operations.ai", { count });
  if (source === "folder") return t("operations.folder", { count });
  if (source === "other") return t("operations.other");
  if (commands.some((command) => PROPERTY_COMMANDS.has(command))) {
    const [only] = properties;
    if (properties.length === 1 && only !== undefined) {
      return t("operations.property", { name: propertyName(t, only) });
    }
    if (properties.length > 1) return t("operations.properties", { count: properties.length });
  }
  const main = commands.find((command) => !ALONG.has(command)) ?? commands[0];
  return main === undefined
    ? t("operations.unknown")
    : textOf(t, `operations.command.${main}`, t("operations.unknown"));
}
