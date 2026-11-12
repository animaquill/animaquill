import type { TFunction } from "i18next";
import type { CallChange, ModelPack, PackProblem } from "@animaquill/tools";
import { DEFAULT_PACK } from "@animaquill/tools";
import type { PackNote } from "@animaquill/agent";
import type { PackSource } from "./packs.ts";

/** A model pack as people see it named: what AnimaQuill calls its own, else its name. */
export function packName(t: TFunction, pack: Pick<ModelPack, "id" | "name">): string {
  return pack.id === DEFAULT_PACK.id ? t("ai.packs.defaultName") : pack.name;
}

/** A pack with where it comes from: "Claude 5（内置）", "DeepSeek steady（Lin）". */
export function packLabel(t: TFunction, pack: ModelPack): string {
  const name = packName(t, pack);
  if (pack.builtin) return t("ai.packs.labelBuiltin", { name });
  return pack.author ? t("ai.packs.labelAuthor", { name, author: pack.author.name }) : name;
}

/** What an answer recorded of its pack, as `packLabel` says it. */
export function noteLabel(t: TFunction, note: PackNote, id: string | undefined): string {
  const name = id === DEFAULT_PACK.id ? t("ai.packs.defaultName") : note.name;
  if (note.builtin) return t("ai.packs.labelBuiltin", { name });
  return note.author ? t("ai.packs.labelAuthor", { name, author: note.author }) : name;
}

export function sourceText(t: TFunction, source: PackSource): string {
  if (source.kind === "github") {
    return t("ai.packs.sourceGitHub", { url: source.url, commit: source.commit.slice(0, 7) });
  }
  return source.kind === "folder"
    ? t("ai.packs.sourceFolder", { name: source.name })
    : t("ai.packs.sourceFile", { name: source.name });
}

/** Why a pack does not pass, in a line each. */
export function problemText(t: TFunction, problem: PackProblem): string {
  return t(`ai.packs.problem.${problem.code}`, { at: problem.at, ...problem.detail });
}

const FIELDS = {
  reasoning: "reasoning",
  maxOutputTokens: "maxOutputTokens",
  temperature: "temperature",
  parallelToolCalls: "parallelToolCalls",
  cache: "cache",
  "anthropic.thinkingDisplay": "anthropic_thinkingDisplay",
  results: "results",
} as const;

type Field = keyof typeof FIELDS;
const isField = (field: string): field is Field => Object.hasOwn(FIELDS, field);

function valueText(t: TFunction, field: string, value: CallChange["after"]): string {
  if (value === undefined) return t("ai.packs.dialog.callDefault");
  if (typeof value === "boolean") return value ? t("ai.packs.dialog.yes") : t("ai.packs.dialog.no");
  const text = String(value);
  switch (field) {
    case "reasoning":
      return t(`ai.packs.value.reasoning.${text as "off"}`);
    case "cache":
      return t(`ai.packs.value.cache.${text as "short"}`);
    case "anthropic.thinkingDisplay":
      return t(`ai.packs.value.anthropic_thinkingDisplay.${text as "summarized"}`);
    case "results":
      return t(`ai.packs.value.results.${text as "standard"}`);
    default:
      return text;
  }
}

/** One setting of how a pack calls models: "推理强度：默认 → 高". */
export function callText(t: TFunction, change: CallChange): string {
  const line = t("ai.packs.dialog.callRow", {
    field: isField(change.field) ? t(`ai.packs.field.${FIELDS[change.field]}`) : change.field,
    before: valueText(t, change.field, change.before),
    after: valueText(t, change.field, change.after),
  });
  return change.models
    ? `${line}${t("ai.packs.dialog.forModels", { models: change.models.join(", ") })}`
    : line;
}
