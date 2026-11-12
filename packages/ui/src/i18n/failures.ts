import type { CommandFailure } from "@animaquill/core";
import {
  describeMissing,
  describeMissingEffect,
  describeUnsupported,
  describeValueIssue,
  type EffectMissing,
  type TransitionMedia,
  type TransitionMissing,
  type TransitionUse,
  type ValueIssue,
} from "@animaquill/schema";
import type { TFunction } from "i18next";
import zhCN from "./zh-CN.json";

/**
 * Why a change did not happen, in words for people: from its code and parameters, see `FAILURES`
 * of the core. The words are `failures.*` of the texts. What the format says about a value has its
 * words in the format, which the problems of a project use as well.
 */

/** Looks up a text and fills it in, the way i18next's `t` does. */
export type Translate = (key: string, values?: Readonly<Record<string, unknown>>) => string;

/**
 * The texts without i18next, for what has none at hand, such as the folder session: Chinese, which
 * is the only language so far.
 */
export const plainTranslate: Translate = (key, values = {}) => {
  let text: unknown = zhCN;
  for (const part of key.split(".")) {
    text = typeof text === "object" && text !== null ? (text as Record<string, unknown>)[part] : "";
  }
  if (typeof text !== "string") return key;
  return text.replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ""));
};

type Params = Readonly<Record<string, unknown>>;

const str = (value: unknown) => (typeof value === "string" ? value : String(value ?? ""));

function invalidValue(t: Translate, params: Params): string {
  const rule = str(params.rule);
  switch (rule) {
    case "type":
    case "min":
    case "max":
    case "choice":
      return describeValueIssue(params as unknown as ValueIssue);
    case "format":
      return params.path
        ? t("failures.invalid-value.format", params)
        : t("failures.invalid-value.formatPlain", params);
    case "replace-same":
      return t(`failures.invalid-value.${rule}`, {
        ...params,
        kind: t(`failures.kinds.${str(params.kind)}`),
      });
    case "source-kind":
      return params.version === undefined
        ? t("failures.invalid-value.source-kind", params)
        : t("failures.invalid-value.source-kind-version", params);
    default:
      return t(`failures.invalid-value.${rule}`, params);
  }
}

function notFound(t: Translate, params: Params): string {
  const kind = str(params.kind);
  if (kind === "effect" && params.why !== undefined) {
    return describeMissingEffect(params.why as EffectMissing);
  }
  if (kind === "effect" && params.clip !== undefined) {
    return t("failures.not-found.effectOfClip", params);
  }
  return t(`failures.not-found.${kind}`, params);
}

const namesOf = (params: Params) =>
  ((params.clips ?? []) as readonly { readonly id: string; readonly name?: string }[]).map(
    (clip) => clip.name ?? clip.id,
  );

/** What a failure says, without the code. */
export function failureMessage(failure: CommandFailure, t: Translate = plainTranslate): string {
  const { code, params } = failure;
  const key = `failures.${code}`;
  switch (code) {
    case "invalid-params": {
      const issues = (params.issues ?? []) as readonly { path: string; message: string }[];
      const [first] = issues;
      const message = first ? t(key, first) : "";
      return issues.length > 1
        ? t("failures.more", { message, count: issues.length - 1 })
        : message;
    }
    case "user-only":
      if (params.param !== undefined) return t(`${key}.param`, params);
      return params.command !== undefined ? t(`${key}.command`, params) : t(`${key}.tags`);
    case "storage-only":
      return t(params.command === undefined ? `${key}.plain` : `${key}.command`, params);
    case "not-found":
      return notFound(t, params);
    case "id-taken":
      if (params.kind === "effect") return t(`${key}.effect`, params);
      return t(`${key}.plain`, { ...params, by: t(`failures.kinds.${str(params.by)}`) });
    case "wrong-track":
    case "not-adjacent":
    case "asset-in-use":
    case "entry-in-use":
    case "missing-entry":
    case "path-taken":
    case "transition-too-long":
    case "merge-would-break": {
      const which = str(params.holds ?? params.why ?? params.by ?? params.kind);
      return t(`${key}.${which}`, params);
    }
    case "overlap": {
      const names = namesOf(params);
      return params.moved
        ? t(`${key}.moved`, { names: names.join("、") })
        : t(`${key}.plain`, { names: names[0] ?? "" });
    }
    case "source-start":
    case "source-end":
      return t(key, { name: params.name ?? params.clip });
    case "transition-missing":
      return describeMissing(params.why as TransitionMissing);
    case "transition-unsupported":
      if (params.caption) return t(`${key}.caption`);
      return describeUnsupported(
        str(params.type),
        params.media as TransitionMedia,
        params.use as TransitionUse,
      );
    case "file-too-large":
      return t(key, { ...params, size: Number(params.limit) / 1024 ** 2 });
    case "not-in-use":
      return t(key, { ...params, kind: t(`failures.kinds.${str(params.kind)}`) });
    case "undo-blocked":
      return t(`${key}.${failure.obstacle ?? "changed"}`);
    case "invalid-batch":
      return t(params.path === undefined ? `${key}.plain` : `${key}.path`, params);
    case "invalid-value":
      return invalidValue(t, params);
    default:
      return t(key, params);
  }
}

/** The `t` of i18next as a `Translate`. */
export const translateWith =
  (t: TFunction): Translate =>
  (key, values) =>
    String(t(key as never, values as never));

/** The notice for a change that did not happen. */
export const commandFailedText = (t: TFunction, failure: CommandFailure): string =>
  t("notice.commandFailed", { message: failureMessage(failure, translateWith(t)) });
