/**
 * Model packs: the words of the tools and the system prompt, how to call a model and how much
 * results give, made for some models, which people can install. See `docs/model-packs.md`.
 */
export {
  DEFAULT_PACK,
  DEFAULT_PACK_ID,
  fitsModel,
  textsOf,
  usePack,
  usedOf,
  variantOf,
  type PackUse,
} from "./apply.ts";
export { BUILTIN_MANIFESTS, COMPARISON_PACK_ID, builtinPacks } from "./builtin.ts";
export {
  callChanges,
  groupOf,
  wordsChanges,
  type CallChange,
  type WordsChange,
  type WordsGroup,
} from "./changes.ts";
export {
  MAX_DESCRIPTION,
  MAX_EXAMPLE,
  MAX_EXAMPLES,
  MAX_FILE_BYTES,
  MAX_LIST,
  MAX_PACK_BYTES,
  MAX_SYSTEM,
  checkPack,
  defaultsOf,
  filesNamedIn,
  isPackPath,
  limitOf,
  packKeys,
  type CheckOptions,
  type PackCheck,
  type PackFiles,
  type PackFileTooLarge,
  type PackHint,
  type PackProblem,
  type PackProblemCode,
} from "./check.ts";
export { DETAILS, DETAIL_LIMITS, type Detail, type DetailLimits } from "./detail.ts";
export {
  BUILTIN_PREFIX,
  MANIFEST,
  MAX_OUTPUT_TOKENS,
  PACK_FORMAT,
  REASONING,
  type CallSettings,
  type ModelPack,
  type PackAuthor,
  type PackEdit,
  type PackVariant,
} from "./format.ts";
export { HINT_RULES, hintsIn, type HintRule } from "./hints.ts";
export {
  comparePacks,
  previewOf,
  segmentsOf,
  type ComparedSegment,
  type PackPreview,
  type PackSegment,
  type PacksCompared,
} from "./preview.ts";
export { choosePack, closenessFor, type PackChoice, type PackChoiceBy } from "./resolve.ts";
