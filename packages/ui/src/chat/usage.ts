import type { AnswerUsage, ChatEntry } from "@animaquill/agent";

/**
 * What a turn or a conversation took, from the usage each answer kept: tokens always, the cost only
 * when every answer that counted knew its price (one that did not would make the sum look smaller
 * than it is), the context only from the newest request.
 */
export interface UsageTotal {
  readonly answers: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** In US dollars, where every answer knew its price. */
  readonly cost: number | undefined;
}

/** How full the context of the model is, as the newest request had it. */
export interface ContextUse {
  /** Tokens the newest request took in: input and cache, read and written. */
  readonly used: number;
  /** How many the model takes, where known. */
  readonly window: number | undefined;
  /** `used` of `window`, 0 to 1, where the window is known. */
  readonly share: number | undefined;
}

export const NO_USAGE: UsageTotal = {
  answers: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: undefined,
};

/**
 * Whether an answer counted anything: one that failed or got stopped before the service said what
 * it took has zeros, which are no usage.
 */
const counted = (usage: AnswerUsage | undefined): usage is AnswerUsage =>
  usage !== undefined && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;

/** The usage of the answers among some entries, added up. */
export function usageOf(entries: readonly ChatEntry[]): UsageTotal {
  let total = { ...NO_USAGE, cost: 0 as number | undefined };
  let priced = true;
  for (const entry of entries) {
    if (entry.role !== "assistant" || !counted(entry.usage)) continue;
    const usage: AnswerUsage = entry.usage;
    total = {
      answers: total.answers + 1,
      input: total.input + usage.input,
      output: total.output + usage.output,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
      cost: (total.cost ?? 0) + (usage.cost ?? 0),
    };
    if (usage.cost === undefined) priced = false;
  }
  return { ...total, cost: priced && total.answers > 0 ? total.cost : undefined };
}

/** How full the context is, from the newest answer that says what it took. */
export function contextOf(entries: readonly ChatEntry[]): ContextUse | undefined {
  const last = entries.findLast((entry) => entry.role === "assistant" && counted(entry.usage));
  const usage = last?.role === "assistant" ? last.usage : undefined;
  if (!usage) return undefined;
  const used = usage.input + usage.cacheRead + usage.cacheWrite;
  const window = usage.window;
  return { used, window, share: window ? used / window : undefined };
}

/** How the share of the context reads: yellow from 70 %, red from 90 %. */
export const contextLevel = (share: number | undefined): "ok" | "warn" | "full" =>
  share === undefined ? "ok" : share >= 0.9 ? "full" : share >= 0.7 ? "warn" : "ok";

/** What part of the input came from the cache, 0 to 1. */
export function cacheShare(total: UsageTotal): number | undefined {
  const all = total.input + total.cacheRead + total.cacheWrite;
  return all > 0 ? total.cacheRead / all : undefined;
}

/** A count of tokens, short: 950, 1.3k, 12k, 1.2M. */
export function tokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${trim((count / 1000).toFixed(1))}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${trim((count / 1_000_000).toFixed(1))}M`;
}

const trim = (text: string) => text.replace(/\.0$/, "");

/** Dollars, as precise as a small sum needs: $0.0042, $0.04, $1.27. */
export function dollars(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** A share, in whole percent: 0.384 is 38%, and anything above 0 is at least 1%. */
export const percent = (share: number): string =>
  `${share > 0 && share < 0.01 ? 1 : Math.round(share * 100)}%`;
