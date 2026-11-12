/**
 * The tools that AI uses on an AnimaQuill project, the same for the assistant in the browser, a
 * command line and the MCP of a platform: no pi, no page. See `createToolset`.
 */
export { CallerState } from "./caller.ts";
export type { ObjectChange } from "./changes.ts";
export { OPERATION_DOCS, type OperationDoc, type OperationExample } from "./docs/operations.ts";
export { aiCode, failureText, failureWords, operationFailureText } from "./failures-en.ts";
export { TOOLSET_VERSION, createToolset } from "./toolset.ts";
export type {
  JsonSchema,
  SelectionFacts,
  Tool,
  ToolAnnotations,
  ToolHost,
  ToolResult,
} from "./types.ts";
