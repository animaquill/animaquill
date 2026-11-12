import type { CallSettings } from "./pi.ts";

/**
 * How to call models by their names, where AnimaQuill knows better than the defaults of pi: the
 * call settings of the built-in model pack "animaquill/claude-5" (see the design of model packs,
 * sections 2.7, 2.8 and 6.3), until packs come. Without them pi gives a model it does not know an
 * output of 8192 tokens and no summary of its thinking; the Claude 5 models think as they go, and
 * their thinking counts in that, which cuts off a large file.
 */
export interface ModelSettings {
  readonly id: string;
  /** Names it is for: `*` stands for anything, case does not matter, the whole name has to fit. */
  readonly models: readonly string[];
  readonly call: CallSettings;
  /** What differs for some of them: the first that fits goes over `call`. */
  readonly variants?: readonly {
    readonly models: readonly string[];
    readonly call: CallSettings;
  }[];
}

export const MODEL_SETTINGS: readonly ModelSettings[] = [
  {
    id: "animaquill/claude-5",
    models: [
      "claude-fable-5*",
      "claude-mythos-5*",
      "claude-opus-5*",
      "claude-sonnet-5*",
      "claude-haiku-5*",
    ],
    call: {
      reasoning: "medium",
      maxOutputTokens: 32_000,
      anthropic: { thinkingDisplay: "summarized" },
    },
    variants: [{ models: ["claude-fable-5*", "claude-mythos-5*"], call: { reasoning: "high" } }],
  },
];

/** Whether a name fits a pattern: as people wrote it, or what follows its last "/". */
export function fitsModel(pattern: string, model: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${source}$`, "i");
  return regex.test(model) || regex.test(model.slice(model.lastIndexOf("/") + 1));
}

/** How to call a model, as the settings above have it; nothing for the models they do not name. */
export function callSettingsFor(model: string): CallSettings {
  const settings = MODEL_SETTINGS.find(({ models }) =>
    models.some((pattern) => fitsModel(pattern, model)),
  );
  if (!settings) return {};
  const variant = settings.variants?.find(({ models }) =>
    models.some((pattern) => fitsModel(pattern, model)),
  );
  return { ...settings.call, ...variant?.call };
}
