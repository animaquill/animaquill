import type { RenderLayer, RenderPlan } from "@animaquill/core";
import type { ChannelChanges, ContentChanges } from "./index.ts";

/** What changes about a layer without a new plan. */
export interface LayerChanges {
  readonly channels: ChannelChanges;
  /** It is no curve, because it cannot change over time, but it can still be changed. */
  readonly fit?: RenderLayer["fit"];
  /** What the scene of the layer works out itself, as the clip would store it. */
  readonly content?: ContentChanges;
}

/** What is left of a map after changes. Null takes an entry away. */
function merged<T>(
  before: Readonly<Record<string, T>> | undefined,
  changes: Readonly<Record<string, T | null>>,
): Record<string, T> {
  const entries = Object.entries({ ...before, ...changes });
  return Object.fromEntries(entries.filter(([, value]) => value !== null)) as Record<string, T>;
}

/** A layer with new curves. Null takes a curve away, so that the default applies again. */
export function layerWith(
  layer: RenderLayer,
  { channels, fit, content }: LayerChanges,
): RenderLayer {
  return {
    ...layer,
    ...(fit === undefined ? {} : { fit }),
    channels: merged(layer.channels, channels) as typeof layer.channels,
    // A layer without a scene has nothing that would work it out.
    ...(content && layer.content && { content: merged(layer.content, content) }),
  };
}

/** A plan with new curves on one layer. What changes while somebody drags is not worth a new plan. */
export function withChannels(plan: RenderPlan, id: string, changes: LayerChanges): RenderPlan {
  const layers = plan.layers.map((layer) => (layer.id === id ? layerWith(layer, changes) : layer));
  return { ...plan, layers };
}
