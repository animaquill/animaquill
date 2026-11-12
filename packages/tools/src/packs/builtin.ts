import { DEFAULT_PACK } from "./apply.ts";
import { checkPack } from "./check.ts";
import { DIRECTIVE_PACK } from "../texts/eval/directive.ts";
import { MANIFEST, type ModelPack } from "./format.ts";

/**
 * The packs that come with AnimaQuill, as their pack.json would be: read with the same check as any
 * other pack. "animaquill/default" is the words of the tools themselves, see `DEFAULT_PACK`.
 */
export const BUILTIN_MANIFESTS: readonly Readonly<Record<string, unknown>>[] = [
  {
    format: 1,
    id: "animaquill/claude-5",
    name: "Claude 5",
    version: "1.0.0",
    description:
      "How to call the Claude 5 models, as Anthropic's documentation says: how hard they think, room for long answers with their thinking, and a summary of it.",
    author: { name: "AnimaQuill" },
    license: "AGPL-3.0-only",
    models: [
      "claude-fable-5*",
      "claude-mythos-5*",
      "claude-opus-5*",
      "claude-sonnet-5*",
      "claude-haiku-5*",
    ],
    // pi gives a model it does not know an output of 8192 tokens; the Claude 5 models count their
    // thinking in it, which cuts off a large file.
    call: {
      reasoning: "medium",
      maxOutputTokens: 32_000,
      anthropic: { thinkingDisplay: "summarized" },
    },
    variants: [{ models: ["claude-fable-5*", "claude-mythos-5*"], call: { reasoning: "high" } }],
  },
];

export { COMPARISON_PACK_ID } from "../texts/eval/directive.ts";

let builtins: readonly ModelPack[] | undefined;

/**
 * The packs that come with AnimaQuill, the default one first, and last the words of toolset 2026.1
 * to compare with, which is hidden (see `ModelPack.hidden`).
 */
export function builtinPacks(): readonly ModelPack[] {
  builtins ??= [
    DEFAULT_PACK,
    ...BUILTIN_MANIFESTS.map((manifest) => {
      const { pack, problems } = checkPack(new Map([[MANIFEST, JSON.stringify(manifest)]]), {
        builtin: true,
      });
      if (!pack) throw new Error(`A built-in pack does not pass: ${JSON.stringify(problems)}`);
      return pack;
    }),
    DIRECTIVE_PACK,
  ];
  return builtins;
}
