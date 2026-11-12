import { closenessOf, DEFAULT_PACK, fitsModel } from "./apply.ts";
import type { ModelPack } from "./format.ts";

/** How a pack came to be the one for a model. */
export type PackChoiceBy =
  /** People chose it for this model. */
  | "chosen"
  /** It is for this model: the closest of those that are. */
  | "matched"
  /** No pack is for this model: the default one. */
  | "fallback";

export interface PackChoice {
  readonly pack: ModelPack;
  readonly by: PackChoiceBy;
}

/** How closely a pack names a model: its closest pattern that fits, or nothing. */
export function closenessFor(pack: ModelPack, model: string): number | undefined {
  let best: number | undefined;
  for (const pattern of pack.models) {
    if (!fitsModel(pattern, model)) continue;
    const closeness = closenessOf(pattern);
    if (best === undefined || closeness > best) best = closeness;
  }
  return best;
}

/**
 * The pack for a model. People's choice for it comes first, while that pack is there. Otherwise the
 * pack that names the model most closely (the most characters other than `*` in its pattern that
 * fits); of those that name it as closely, AnimaQuill's own, then the one installed first, so that a
 * new pack never takes over unasked. No pack for it: the default one.
 *
 * `packs` are the built-in ones and then those installed, in the order they were installed.
 */
export function choosePack(
  model: string,
  packs: readonly ModelPack[],
  chosen?: string,
): PackChoice {
  if (chosen !== undefined) {
    const pack = chosen === DEFAULT_PACK.id ? DEFAULT_PACK : packs.find(({ id }) => id === chosen);
    if (pack) return { pack, by: "chosen" };
  }
  let best: { pack: ModelPack; closeness: number } | undefined;
  for (const pack of packs) {
    const closeness = closenessFor(pack, model);
    if (closeness === undefined) continue;
    const better =
      !best ||
      closeness > best.closeness ||
      (closeness === best.closeness && pack.builtin && !best.pack.builtin);
    if (better) best = { pack, closeness };
  }
  return best ? { pack: best.pack, by: "matched" } : { pack: DEFAULT_PACK, by: "fallback" };
}
