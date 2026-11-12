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
} from "./texts/index.ts";
export { TOOLSET_VERSION, createToolset } from "./toolset.ts";
export type {
  JsonSchema,
  SelectionFacts,
  Tool,
  ToolAnnotations,
  ToolHost,
  ToolResult,
} from "./types.ts";
