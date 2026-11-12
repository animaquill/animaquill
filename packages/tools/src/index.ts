/**
 * The tools that AI uses on an AnimaQuill project, the same for the assistant in the browser, a
 * command line and the MCP of a platform: no pi, no page. See `createToolset`.
 */
export { CallerState } from "./caller.ts";
export type { ObjectChange } from "./changes.ts";
export { aiCode, failureText, failureWords, operationFailureText } from "./failures-en.ts";
export { textKeys, type TextKey } from "./text-keys.ts";
export {
  DEFAULT_TEXTS,
  type EditExample,
  type OperationExample,
  type TextTable,
  type TextValue,
  type TextsUsed,
  type Entry,
  hashOfTexts,
  systemPromptOf,
} from "./texts/index.ts";
export {
  DEFAULT_TEXTS_USED,
  TOOLSET_VERSION,
  WRITE_TOOLS,
  createToolset,
  textsAt,
  type ToolsetOptions,
} from "./toolset.ts";
export * from "./packs/index.ts";
export type {
  JsonSchema,
  SelectionFacts,
  Tool,
  ToolAnnotations,
  ToolHost,
  ToolResult,
} from "./types.ts";
