import type { TFunction } from "i18next";
import type { CallChange, CallSettings, ModelPack, PackProblem } from "@animaquill/tools";
import { COMPARISON_PACK_ID, DEFAULT_PACK, nameIssues } from "@animaquill/tools";
import type { PackNote } from "@animaquill/agent";
import { isAccount, isRepository, placeOf } from "./github-packs.ts";
import { gitHubPlace, type ModelPacksSnapshot, type PackSource } from "./packs.ts";

/** A model pack as people see it named: what AnimaQuill calls its own, else its name. */
export function packName(t: TFunction, pack: Pick<ModelPack, "id" | "name">): string {
  return pack.id === DEFAULT_PACK.id
    ? t("ai.packs.defaultName")
    : pack.id === COMPARISON_PACK_ID
      ? t("ai.packs.comparisonName")
      : pack.name;
}

/**
 * Where a pack is from, as the editor knows it: never from the pack. With AnimaQuill (`builtin`, set
 * only by AnimaQuill's own code), from "发现", from a GitHub account (as GitHub spells it: letters,
 * digits and "-", so it cannot read "内置"), or from this computer. `gone` is for what an answer
 * recorded of a pack that is not installed any more.
 */
export type PackOrigin =
  | { readonly kind: "builtin" }
  | { readonly kind: "discover" }
  | {
      readonly kind: "github";
      readonly owner: string | undefined;
      readonly repo: string | undefined;
    }
  | { readonly kind: "local" }
  | { readonly kind: "gone" };

/** Where a pack is from: AnimaQuill's own, or as it was installed. */
export function originOf(
  pack: Pick<ModelPack, "builtin">,
  source: PackSource | undefined,
): PackOrigin {
  if (pack.builtin) return { kind: "builtin" };
  if (!source) return { kind: "gone" };
  if (source.kind === "discover") return { kind: "discover" };
  if (source.kind === "github") {
    const place = gitHubPlace(source.url);
    const owner = source.owner ?? place?.owner;
    const repo = source.repo ?? place?.repo;
    return {
      kind: "github",
      owner: owner !== undefined && isAccount(owner) ? owner : undefined,
      repo: repo !== undefined && isRepository(repo) ? repo : undefined,
    };
  }
  return { kind: "local" };
}

/** Where a pack among those there are is from. */
export function originIn(
  pack: Pick<ModelPack, "id" | "builtin">,
  packs: Pick<ModelPacksSnapshot, "installed">,
): PackOrigin {
  return originOf(pack, packs.installed.find(({ id }) => id === pack.id)?.kept.source);
}

/** Where a pack is from, in a word: "内置", "发现", "pipi", "本机". */
export function originText(t: TFunction, origin: PackOrigin): string {
  switch (origin.kind) {
    case "github":
      return origin.owner ?? t("ai.packs.origin.github");
    case "builtin":
    case "discover":
    case "local":
    case "gone":
      return t(`ai.packs.origin.${origin.kind}`);
  }
}

/** A pack as its label shows it: its name, and where it is from. */
export interface PackLabelParts {
  /** The name, or what stands for one that is not allowed (`allowed`). */
  readonly name: string;
  readonly origin: string;
  /** Its name keeps to the rules of names: else it shows as one that does not, see `nameIssues`. */
  readonly allowed: boolean;
}

/**
 * The parts of the label of a pack, "名字(来源)": the name a pack has, and where it is from, which
 * only the editor says (`originOf`). A name that does not keep to the rules (a pack installed
 * before they held) shows as such, never as it is. Of two packs of one name from one account, each
 * says its repository too: "稳重版(pipi/aq-opus)".
 */
export function labelParts(
  t: TFunction,
  pack: Pick<ModelPack, "id" | "name" | "builtin">,
  origin: PackOrigin,
  packs?: Pick<ModelPacksSnapshot, "installed">,
): PackLabelParts {
  const allowed = pack.builtin === true || nameIssues(pack.name).length === 0;
  let where = originText(t, origin);
  if (origin.kind === "github" && origin.repo && packs) {
    const twin = packs.installed.some(
      (each) =>
        each.id !== pack.id &&
        each.pack !== undefined &&
        each.pack.name === pack.name &&
        originText(t, originOf(each.pack, each.kept.source)) === where,
    );
    if (twin) where = `${where}/${origin.repo}`;
  }
  return {
    name: allowed ? packName(t, pack) : t("ai.packs.nameNotAllowed"),
    origin: where,
    allowed,
  };
}

/** A label as text, for where there is only text (a native list, a line in the chat). */
export function labelText(t: TFunction, parts: PackLabelParts, auto = false): string {
  const label = t("ai.packs.label", { name: parts.name, origin: parts.origin });
  return auto ? t("ai.packs.autoLabel", { label }) : label;
}

/** A pack among those there are, as text: "Opus 稳重版(pipi)". */
export function packLabel(
  t: TFunction,
  pack: Pick<ModelPack, "id" | "name" | "builtin">,
  packs: Pick<ModelPacksSnapshot, "installed">,
  auto = false,
): string {
  return labelText(t, labelParts(t, pack, originIn(pack, packs), packs), auto);
}

/**
 * What an answer recorded of its pack, as `packLabel` says it: where it is from as installed now,
 * or that it is not installed any more.
 */
export function noteLabel(
  t: TFunction,
  note: PackNote,
  id: string | undefined,
  packs: Pick<ModelPacksSnapshot, "installed">,
): string {
  const pack = { id: id ?? "", name: note.name, builtin: note.builtin === true };
  return labelText(t, labelParts(t, pack, originIn(pack, packs), packs));
}

/** Who wrote a pack, as it says: the author and their address. */
export function authorText(t: TFunction, pack: ModelPack): string {
  if (!pack.author) return t("ai.packs.authorNone");
  const { name, url } = pack.author;
  return url ? `${name} <${url}>` : name;
}

/** Where a pack was installed from, in a line: its repository and commit, or its folder. */
export function sourceText(t: TFunction, source: PackSource): string {
  switch (source.kind) {
    case "github": {
      const place = placeOf(source);
      const where = place
        ? `github.com/${place.owner}/${place.repo}${place.path ? `/${place.path}` : ""}`
        : source.url;
      return source.ref && source.ref !== source.commit
        ? t(source.tag ? "ai.packs.sourceGitHubTag" : "ai.packs.sourceGitHubBranch", {
            where,
            commit: source.commit.slice(0, 7),
            ref: source.ref,
          })
        : t("ai.packs.sourceGitHub", { where, commit: source.commit.slice(0, 7) });
    }
    case "discover":
      return t("ai.packs.sourceDiscover", { commit: source.commit.slice(0, 7) });
    case "folder":
      return t("ai.packs.sourceFolder", { name: source.name });
    case "file":
      return t("ai.packs.sourceFile", { name: source.name });
  }
}

/** The address of the repository of a pack, to open on GitHub; nothing for one not from there. */
export function repositoryOf(source: PackSource | undefined): string | undefined {
  if (source?.kind !== "github") return undefined;
  const place = placeOf(source);
  if (!place) return undefined;
  return `https://github.com/${place.owner}/${place.repo}${
    place.path
      ? `/tree/${place.commit}/${place.path.split("/").map(encodeURIComponent).join("/")}`
      : ""
  }`;
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
  const online = (each: PackSource) => each.kind === "github" || each.kind === "discover";
  if (online(source) !== online(installedSource)) return true;
  return (
    source.kind === "github" &&
    installedSource.kind === "github" &&
    !sameRepository(source.url, installedSource.url)
  );
}
