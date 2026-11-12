import type { ServiceKind } from "@animaquill/agent";

/** How many tokens a model reads at once, short: "200k", "1M", "1.05M". */
export function contextLabel(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${trim(tokens / 1000)}k`;
  return String(tokens);
}

/** A price per million tokens, as short as it goes: "5", "0.25", "1.32". */
export function priceLabel(dollars: number): string {
  return trim(dollars);
}

const trim = (value: number) => String(Number(value.toFixed(value < 10 ? 2 : 1)));

/** The letter a service shows in place of a logo: the first of its name. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0] ?? "?";
  return first.toUpperCase();
}

/**
 * The color of a service's letter, the same for a kind every time. Ours, not the brands': logos and
 * their colors are trademarks, see the design of the chat and models, section 6.
 */
export function colorOf(kind: ServiceKind | undefined): string {
  if (!kind || kind.custom) return "var(--aq-bg-input)";
  let hash = 0;
  for (const char of kind.id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `var(--aq-cover-${(Math.abs(hash) % 8) + 1})`;
}
