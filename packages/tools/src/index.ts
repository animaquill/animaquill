/**
 * The tools that AI uses on an AnimaQuill project, the same for the assistant in the browser, a
 * command line and the MCP of a platform: no pi, no page. See `createToolset`.
 */
export {
  formatAddress,
  isAddress,
  parseAddress,
  valueOfAddress,
  withoutAddresses,
  type Address,
} from "./address.ts";
export { CallerState } from "./caller.ts";
export { describeChanges, type ObjectChange } from "./changes.ts";
export type { OtherChange, OtherWho } from "./context.ts";
export { aiCode, failureText, failureWords, operationFailureText } from "./failures-en.ts";
export { textKeys, type TextKey } from "./text-keys.ts";
export {
  DEFAULT_TEXTS,
  PICTURE_FACTS,
  SENT_FACT,
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
export {
  LOOK_SIDES,
  tokensOf,
  type LookData,
  type LookFinding,
  type LookKind,
  type LookShotData,
} from "./tools/look.ts";
export type {
  JsonSchema,
  LookAnswer,
  LookFailure,
  LookImageRole,
  LookMark,
  LookRequest,
  LookShot,
  LookSize,
  LookText,
  LookTexts,
  LookedShot,
  SelectionFacts,
  SentMessage,
  Tool,
  ToolAnnotations,
  ToolHost,
  ToolImage,
  ToolResult,
} from "./types.ts";
export { mcpInstructions, mcpToolsOf, type McpPlace, type McpTool } from "./mcp.ts";
