import type { RenderLayer, RenderPlan } from "@animaquill/core";
import type { ChannelChanges } from "./index.ts";

/** What changes about a layer without a new plan. */
export interface LayerChanges {
  readonly channels: ChannelChanges;
  /** It is no curve, because it cannot change over time, but it can still be changed. */
  readonly fit?: RenderLayer["fit"];
}

/** A layer with new curves. Null takes a curve away, so that the default applies again. */
export function layerWith(layer: RenderLayer, { channels, fit }: LayerChanges): RenderLayer {
  const merged = Object.entries({ ...layer.channels, ...channels });
  const left = merged.filter(([, channel]) => channel !== null);
  return {
    ...layer,
    ...(fit === undefined ? {} : { fit }),
    channels: Object.fromEntries(left) as typeof layer.channels,
  };
}

/** A plan with new curves on one layer. What changes while somebody drags is not worth a new plan. */
export function withChannels(plan: RenderPlan, id: string, changes: LayerChanges): RenderPlan {
  const layers = plan.layers.map((layer) => (layer.id === id ? layerWith(layer, changes) : layer));
  return { ...plan, layers };
}
