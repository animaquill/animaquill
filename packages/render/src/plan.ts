import type { RenderPlan } from "@animaquill/core";
import type { ChannelChanges } from "./index.ts";

/** A plan with new curves on one layer. What changes while somebody drags is not worth a new plan. */
export function withChannels(plan: RenderPlan, id: string, changes: ChannelChanges): RenderPlan {
  const layers = plan.layers.map((layer) => {
    if (layer.id !== id) return layer;
    const merged = Object.entries({ ...layer.channels, ...changes });
    const left = merged.filter(([, channel]) => channel !== null);
    return { ...layer, channels: Object.fromEntries(left) as typeof layer.channels };
  });
  return { ...plan, layers };
}
