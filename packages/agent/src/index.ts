/**
 * AI in the browser: people bring a service and a key, and AI changes the project with the same
 * commands people use. The library that talks to services is behind `pi.ts`, which is loaded on
 * demand: import only its types from here.
 */
import type { Protocol } from "./services.ts";

export {
  Conversation,
  limitReason,
  type ConversationOptions,
  type ConversationSnapshot,
  type RunningTask,
  type TaskEnd,
  type TaskOutcome,
  type TaskTarget,
} from "./conversation.ts";
export {
  readEntry,
  type AnswerEnd,
  type AssistantEntry,
  type ChatEntry,
  type ToolCallEntry,
  type ToolEntry,
  type UserEntry,
} from "./entries.ts";
export type { Endpoint, FakeAnswer, FakeEndpoint, Relayed, ToolSpec } from "./pi.ts";
export { SYSTEM_PROMPT } from "./prompt.ts";
export { HIDDEN_KEY, withoutKeys } from "./secrets.ts";
export {
  DEFAULT_MAX_TOOL_CALLS,
  EMPTY_AI_SETTINGS,
  PROTOCOLS,
  SERVICE_KINDS,
  TOOL_CALL_LIMITS,
  checkBaseUrl,
  failureOf,
  kindOf,
  listModels,
  readAiSettings,
  type AiSettings,
  type FailureKind,
  type ListedModel,
  type ModelList,
  type Protocol,
  type Route,
  type ServiceConfig,
  type ServiceFailure,
  type ServiceKind,
} from "./services.ts";
export {
  MAX_TOOL_TEXT,
  allTools,
  commandTools,
  parametersOf,
  readTools,
  toolName,
  type SelectionFacts,
  type ToolContext,
} from "./tools.ts";

/** The models pi knows of for a kind of service, loading the library on the way. */
export async function knownModels(
  catalog: string | undefined,
  protocol: Protocol,
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  const pi = await import("./pi.ts");
  return pi.knownModels(catalog, protocol);
}
