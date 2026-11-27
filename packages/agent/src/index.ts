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
  type RoomMade,
  type RunningTask,
  type RunningTool,
  type TaskEnd,
  type TaskOutcome,
  type TaskTarget,
} from "./conversation.ts";
export {
  NOT_ATTACHED,
  PLAN_FIRST_LINE,
  entriesToKeep,
  latestSummary,
  readEntries,
  promptOf,
  readEntry,
  readImage,
  readSelection,
  readToolPicture,
  type AnswerEnd,
  type AttachedImage,
  type ImageFrame,
  type ImageRef,
  type AnswerUsage,
  type AssistantEntry,
  type ChatEntry,
  type PackBy,
  type OtherEntry,
  type PackNote,
  type SummaryEntry,
  type ToolCallEntry,
  type ToolEntry,
  type ToolPicture,
  type UserEntry,
} from "./entries.ts";
export {
  COMPACT_AT,
  COMPACT_PROMPT,
  contextNow,
  cutOf,
  summaryInForce,
  type ContextNow,
  type Cut,
} from "./compaction.ts";
export { NO_LIVE, createLiveStore, type LiveAnswer, type LiveStore } from "./live.ts";
export { AUTO_RETRIES, RETRY_DELAYS_MS, passes, retryDelay } from "./retry.ts";
export { DEFAULT_STAMP, browserSystemPrompt, toolSpecsOf } from "./assistant.ts";
export { MOST_PICTURES_SENT } from "./pi.ts";
export type {
  AnswerStamp,
  CallSettings,
  Endpoint,
  FakeAnswer,
  ModelTest,
  FakeEndpoint,
  Pictures,
  Relayed,
  SmallAsk,
  ToolOutput,
  ToolSpec,
} from "./pi.ts";
export { HIDDEN_KEY, withoutKeys } from "./secrets.ts";
export {
  AI_SETTINGS_VERSION,
  CATALOG_SOURCES,
  MODEL_APIS,
  MODEL_FIELDS,
  THINKING_VALUE_LENGTH,
  MOST_HEADERS,
  MOST_HEADER_BYTES,
  headerProblem,
  keyIntoHeader,
  secretsOf,
  tooManyHeaders,
  withSecrets,
  readModel,
  writeModel,
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
  favoritesOf,
  writeAiSettings,
  type AiSettings,
  type AiSettingsReading,
  type CatalogFill,
  type CatalogSource,
  type KeptSettings,
  type ModelApi,
  type ModelCompat,
  type ModelConfig,
  type ModelField,
  type ModelValues,
  type PriceDoubt,
  type ModelRef,
  type SendWith,
  type ShotSide,
  type ServiceConfig,
  type ServiceSecret,
} from "./ai-settings.ts";
export {
  canonical,
  entriesOfPacks,
  entriesOfSettings,
  entryChanges,
  isPackEntry,
  packsOfEntries,
  settingsOfEntries,
} from "./ai-sync.ts";
export {
  bulkActions,
  filterModels,
  isLastEnabled,
  type BulkActions,
  type ModelRow,
} from "./enabled-models.ts";
export {
  parseListedModels,
  supportedLevels,
  type ListedModel,
  type ModelCost,
  type ReasoningLevel,
  type ThinkingLevelMap,
} from "./model-discovery.ts";
export {
  OWN_FIELDS,
  THINKING_FIELDS,
  catalogValues,
  editField,
  effectiveValues,
  fieldValue,
  fillModel,
  levelEntry,
  levelSupported,
  levelText,
  liveOf,
  mapFromEfforts,
  markOf,
  revertField,
  settledMap,
  undoFill,
  withField,
  type CatalogSay,
  type CatalogValues,
  type FieldMark,
} from "./model-config.ts";
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

/** Asks a model what colour a picture is, to see that it takes pictures: see `pi.ts`. */
export async function testModelPicture(
  endpoint: Endpoint,
  key: string | undefined,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<ModelTest> {
  const pi = await import("./pi.ts");
  return pi.testModelPicture(endpoint, key, options);
}

/** Whether what a model said of the test picture names its colour. */
export const saysRed = (text: string): boolean => /red|红/i.test(text);

/** Asks a model for a word, to see that it can be reached: see `testModel` of `pi.ts`. */
export async function testModel(
  endpoint: Endpoint,
  key: string | undefined,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<ModelTest> {
  const pi = await import("./pi.ts");
  return pi.testModel(endpoint, key, options);
}
