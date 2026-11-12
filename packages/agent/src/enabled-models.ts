// Adapted from pi-web (https://github.com/agegr/pi-web), components/enabled-models-helpers.ts,
// commit 57cea50. Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
/**
 * Which models people turn on, and the one guard of it: at least one stays on, so that the chat
 * always has a model to send to. Every switch that cannot move says why, rather than doing nothing.
 */

/** A model as a list of them shows it: by id, with a name where there is one. */
export interface ModelRow {
  readonly id: string;
  readonly name?: string | undefined;
  readonly enabled: boolean;
}

/** The rows a filter shows, matched on name and id. */
export function filterModels<T extends ModelRow>(models: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle),
  );
}

export interface BulkActions {
  /** The models "all on" would turn on. */
  readonly enable: readonly string[];
  /** The models "all off" would turn off. */
  readonly disable: readonly string[];
  readonly canEnable: boolean;
  /** False where turning them off would leave no model on anywhere. */
  readonly canDisable: boolean;
}

/**
 * What "all on" and "all off" would do to the rows shown, given how many models are on in all the
 * services: never all off where nothing would be left.
 */
export function bulkActions(enabledTotal: number, shown: readonly ModelRow[]): BulkActions {
  const enable = shown.filter((model) => !model.enabled).map((model) => model.id);
  const disable = shown.filter((model) => model.enabled).map((model) => model.id);
  return {
    enable,
    disable,
    canEnable: enable.length > 0,
    canDisable: disable.length > 0 && enabledTotal - disable.length >= 1,
  };
}

/** Whether turning this one off would leave no model on anywhere. */
export const isLastEnabled = (enabledTotal: number, model: ModelRow): boolean =>
  model.enabled && enabledTotal <= 1;
