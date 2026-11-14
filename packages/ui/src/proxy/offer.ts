import type { ProjectStore } from "@animaquill/core";
import { isSameHash } from "@animaquill/media";
import type { NotificationAction } from "../workbench/notifications.ts";
import type { QualityChoice } from "../preview/quality.ts";
import type { ProxyFiles } from "./proxies.ts";

/** What offering a proxy needs, see `offerProxy`. */
export interface ProxyOffer {
  readonly proxies: Pick<ProxyFiles, "offer" | "make"> | undefined;
  readonly store: ProjectStore;
  /** The quality people chose: at full quality the preview never decodes a proxy. */
  readonly quality: () => QualityChoice;
  /** Whether people want to hear of it at all, as the settings say. */
  readonly wanted: () => boolean;
  readonly notify: (message: string, actions: readonly NotificationAction[]) => void;
  readonly words: {
    /** That this video, by its name, decodes too slowly, and a proxy would help. */
    readonly text: (name: string) => string;
    readonly make: string;
  };
}

/**
 * The preview found that a video decodes too slowly to keep up while it plays, see `SlowVideos`:
 * people hear that a proxy would help, with a way to have it made right there. About that video
 * only, once while the project is open, and only where a proxy would be used and can be made, see
 * `ProxyFiles.offer`, and where people did not turn it off in the settings. Nothing gets made
 * unless people say so.
 */
export function offerProxy(
  { proxies, store, quality, wanted, notify, words }: ProxyOffer,
  hash: string,
) {
  if (!proxies || quality() === "full" || !wanted()) return;
  proxies.offer(hash, () => {
    // People may have chosen it, or turned the offer off, meanwhile.
    if (quality() === "full" || !wanted()) return;
    const asset = Object.values(store.getState().assets ?? {}).find(
      (each) => each.hash !== undefined && isSameHash(each.hash, hash),
    );
    notify(words.text(asset?.name ?? asset?.path ?? ""), [
      { label: words.make, run: () => proxies.make(hash) },
    ]);
  });
}
