/**
 * AI in the browser: people bring a service and a key, and AI changes the project with the tools of
 * `@animaquill/tools`, which run the same commands people use. The library that talks to services is behind `pi.ts`, which is loaded on
 * demand: import only its types from here.
 */
import type { ListedModel } from "./model-discovery.ts";
import type { Endpoint, ModelTest, SmallAsk } from "./pi.ts";
import type { Protocol } from "./services.ts";

export {
  Conversation,
  limitReason,
  type ConversationOptions,
  type ConversationSnapshot,
  type RetryWait,
  type RunningTask,
  type RunningTool,
  type TaskEnd,
  type TaskOutcome,
  type TaskTarget,
} from "./conversation.ts";
export {
  readEntry,
  type AnswerEnd,
  type AnswerUsage,
  type AssistantEntry,
  type ChatEntry,
  type PackBy,
  type PackNote,
  type ToolCallEntry,
  type ToolEntry,
  type UserEntry,
} from "./entries.ts";
export { NO_LIVE, createLiveStore, type LiveAnswer, type LiveStore } from "./live.ts";
export { AUTO_RETRIES, RETRY_DELAYS_MS, passes, retryDelay } from "./retry.ts";
export { DEFAULT_STAMP, browserSystemPrompt, toolSpecsOf } from "./assistant.ts";
export type {
  AnswerStamp,
  CallSettings,
  Endpoint,
  FakeAnswer,
  ModelTest,
  FakeEndpoint,
  Relayed,
  SmallAsk,
  ToolOutput,
  ToolSpec,
} from "./pi.ts";
export { HIDDEN_KEY, withoutKeys } from "./secrets.ts";
export {
  AI_SETTINGS_VERSION,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOOL_CALLS,
  EMPTY_AI_SETTINGS,
  TOOL_CALL_LIMITS,
  enabledCountOf,
  enabledModelsOf,
  isEnabled,
  readAiSettings,
  recoverOldWrite,
  settledDefault,
  writeAiSettings,
  type AiSettings,
  type AiSettingsReading,
  type CustomModel,
  type KeptSettings,
  type ModelRef,
  type ServiceConfig,
} from "./ai-settings.ts";
export {
  bulkActions,
  filterModels,
  isLastEnabled,
  type BulkActions,
  type ModelRow,
} from "./enabled-models.ts";
export { parseListedModels, type ListedModel, type ReasoningLevel } from "./model-discovery.ts";
export {
  PROTOCOLS,
  SERVICE_GROUPS,
  SERVICE_KINDS,
  checkBaseUrl,
  failureOf,
  kindOf,
  listModels,
  recommendedOf,
  type FailureKind,
  type ModelList,
  type Protocol,
  type Route,
  type ServiceFailure,
  type ServiceGroup,
  type ServiceKind,
} from "./services.ts";

/** The models pi knows of for a kind of service, loading the library on the way. */
export async function knownModels(
  catalog: string | undefined,
  protocol: Protocol,
): Promise<readonly ListedModel[]> {
  const pi = await import("./pi.ts");
  return pi.knownModels(catalog, protocol);
}

/** One small request to a model, such as for the title of a conversation: see `askModel` of `pi.ts`. */
export async function askModel(
  endpoint: Endpoint,
  key: string | undefined,
  options: SmallAsk,
): Promise<ModelTest> {
  const pi = await import("./pi.ts");
  return pi.askModel(endpoint, key, options);
}

/** Asks a model for a word, to see that it can be reached: see `testModel` of `pi.ts`. */
export async function testModel(
  endpoint: Endpoint,
  key: string | undefined,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<ModelTest> {
  const pi = await import("./pi.ts");
  return pi.testModel(endpoint, key, options);
}
