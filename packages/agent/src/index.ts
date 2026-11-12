/**
 * AI in the browser: people bring a service and a key, and AI changes the project with the tools of
 * `@animaquill/tools`, which run the same commands people use. The library that talks to services is behind `pi.ts`, which is loaded on
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
  type PackBy,
  type PackNote,
  type ToolCallEntry,
  type ToolEntry,
  type UserEntry,
} from "./entries.ts";
export { DEFAULT_STAMP, browserSystemPrompt, toolSpecsOf } from "./assistant.ts";
export type {
  AnswerStamp,
  CallSettings,
  Endpoint,
  FakeAnswer,
  FakeEndpoint,
  Relayed,
  ToolOutput,
  ToolSpec,
} from "./pi.ts";
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

/** The models pi knows of for a kind of service, loading the library on the way. */
export async function knownModels(
  catalog: string | undefined,
  protocol: Protocol,
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  const pi = await import("./pi.ts");
  return pi.knownModels(catalog, protocol);
}
