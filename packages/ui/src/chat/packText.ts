import type { TFunction } from "i18next";
import type { CallChange, CallSettings, ModelPack, PackProblem } from "@animaquill/tools";
import { COMPARISON_PACK_ID, DEFAULT_PACK } from "@animaquill/tools";
import type { PackNote } from "@animaquill/agent";
import { gitHubPlace, type PackSource } from "./packs.ts";

/** A model pack as people see it named: what AnimaQuill calls its own, else its name. */
export function packName(t: TFunction, pack: Pick<ModelPack, "id" | "name">): string {
  return pack.id === DEFAULT_PACK.id
    ? t("ai.packs.defaultName")
    : pack.id === COMPARISON_PACK_ID
      ? t("ai.packs.comparisonName")
      : pack.name;
}

/**
 * A pack with whose it is: "Claude 5（内置）" for one that comes with AnimaQuill, and for any other
 * "Steady（第三方 · lin/steady）". The mark of others and their id are always there, so that no name
 * or author a pack has can make it read as AnimaQuill's own.
 */
export function packLabel(t: TFunction, pack: Pick<ModelPack, "id" | "name" | "builtin">): string {
  const name = packName(t, pack);
  return pack.builtin
    ? t("ai.packs.labelBuiltin", { name })
    : t("ai.packs.labelThirdParty", { name, id: pack.id });
}

/** What an answer recorded of its pack, as `packLabel` says it. */
export function noteLabel(t: TFunction, note: PackNote, id: string | undefined): string {
  const name = id === undefined ? note.name : packName(t, { id, name: note.name });
  return note.builtin
    ? t("ai.packs.labelBuiltin", { name })
    : t("ai.packs.labelThirdParty", { name, id: id ?? "?" });
}

/** Who wrote a pack, as it says: the author and their address. */
export function authorText(t: TFunction, pack: ModelPack): string {
  if (!pack.author) return t("ai.packs.authorNone");
  const { name, url } = pack.author;
  return url ? `${name} <${url}>` : name;
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

/**
 * Every setting of how a model is called, one line each, as a pack has them merged for it: "推理强度：
 * 高". Those not set are left to the service.
 */
export function settingsText(t: TFunction, call: CallSettings, results: string): readonly string[] {
  const { anthropic, ...rest } = call;
  const fields: [string, CallChange["after"]][] = [
    ...(Object.entries(rest) as [string, CallChange["after"]][]),
    ...(anthropic?.thinkingDisplay !== undefined
      ? [["anthropic.thinkingDisplay", anthropic.thinkingDisplay] as [string, string]]
      : []),
    ["results", results],
  ];
  return fields.map(([field, value]) =>
    t("ai.packs.preview.setting", {
      field: isField(field) ? t(`ai.packs.field.${FIELDS[field]}`) : field,
      value: valueText(t, field, value),
    }),
  );
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

/** Whether two addresses on GitHub are the same repository and folder, whatever branch or commit. */
function sameRepository(a: string, b: string): boolean {
  const place = (address: string) => {
    const found = gitHubPlace(address);
    return found && `${found.owner}/${found.repo}/${found.path}`.toLowerCase();
  };
  return place(a) !== undefined && place(a) === place(b);
}

/**
 * Whether a new version of a pack comes from another author or place than the version installed:
 * anyone can write any id, so the same id is no proof that it is the same pack. Places are another
 * where one is on GitHub and the other is not, or both are on GitHub in other repositories or
 * folders; folders and files people picked on their computer may have any name.
 */
export function originDiffers(
  pack: ModelPack,
  installed: ModelPack,
  source: PackSource | undefined,
  installedSource: PackSource | undefined,
): boolean {
  const author = (each: ModelPack) => `${each.author?.name ?? ""}\n${each.author?.url ?? ""}`;
  if (author(pack) !== author(installed)) return true;
  if (source === undefined || installedSource === undefined) return false;
  const online = (each: PackSource) => each.kind === "github";
  if (online(source) !== online(installedSource)) return true;
  return (
    source.kind === "github" &&
    installedSource.kind === "github" &&
    !sameRepository(source.url, installedSource.url)
  );
}
