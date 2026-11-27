import { closenessFor } from "@animaquill/tools";
import type { ChatSession } from "../session.ts";

/**
 * The model packs people can choose for a model: "自动" first (the pack the rules choose, not
 * people), then those made for the model, then the others there are. The pack the rules choose
 * shows again only where people chose it themselves.
 */
export function packChoicesOf(chat: ChatSession, model: string) {
  const options = chat.packOptions(model);
  const { recommended, current, chosen } = options;
  const listed = options.packs
    .map(({ pack }) => pack)
    .filter((pack) => pack.id !== recommended.id || (chosen && current.id === pack.id));
  const fits = listed.filter((pack) => closenessFor(pack, model) !== undefined);
  const others = listed.filter((pack) => !fits.includes(pack));
  return { options, fits, others };
}
