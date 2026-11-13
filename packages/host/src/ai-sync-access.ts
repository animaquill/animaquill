import {
  CHANGE_TIMEOUT_MS,
  count,
  isObject,
  REQUEST_TIMEOUT_MS,
  text,
  withinTime,
} from "./answers.ts";
import {
  AiSyncNewer,
  AiSyncOff,
  AiSyncTooLarge,
  ChatNewer,
  CloudOtherAccount,
  CloudSignedOut,
  type AccountAiSettings,
  type AccountChatSummary,
  type AiSyncAccess,
  type ChatSyncAccess,
  type SavedChat,
} from "./index.ts";
import {
  AI_SYNC_BATCH,
  AI_SYNC_KEYS,
  isEntryName,
  type AiEntry,
  type AiSyncKey,
} from "./ai-sync-rules.ts";

export interface BrowserAiSyncOptions {
  /** The address of a path of the platform's API, such as `/me/ai-settings`. */
  readonly api: (path: string) => string;
  /** Headers the platform asks of requests that change something. */
  readonly changeHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** This computer's clock. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/** The platform said it is busy: again after `retryAfterMs`. */
export class AiSyncBusy extends Error {
  override readonly name = "AiSyncBusy";
  constructor(readonly retryAfterMs: number) {
    super("The platform is busy");
  }
}

/** Times as the platform says them, as this computer's clock had them. */
type Clock = (theirs: number) => number;

const entryOf = (value: unknown, clock: Clock): AiEntry | undefined => {
  if (!isObject(value)) return undefined;
  const at = count(value.at);
  if (at === undefined) return undefined;
  if (value.deleted === true) return { at: clock(at), deleted: true };
  return "value" in value ? { at: clock(at), value: value.value } : undefined;
};

const keyOf = (value: unknown, clock: Clock): AiSyncKey | undefined => {
  if (!isObject(value)) return undefined;
  const at = count(value.at);
  if (at === undefined) return undefined;
  if (value.deleted === true) return { at: clock(at), deleted: true };
  const key = text(value.key);
  return key === undefined ? undefined : { at: clock(at), key };
};

const stateOf = (value: unknown, clock: Clock): AccountAiSettings | undefined => {
  if (!isObject(value) || !isObject(value.entries) || !isObject(value.keys)) return undefined;
  const account = text(value.account);
  const revision = count(value.revision);
  const format = count(value.format);
  if (account === undefined || revision === undefined || format === undefined) return undefined;
  if (typeof value.enabled !== "boolean") return undefined;
  const entries: Record<string, AiEntry> = {};
  for (const [name, raw] of Object.entries(value.entries)) {
    const entry = entryOf(raw, clock);
    // Anything that cannot be read is not taken for nothing: the whole answer is not.
    if (!entry || !isEntryName(name)) return undefined;
    entries[name] = entry;
  }
  const keys: Record<string, AiSyncKey> = {};
  for (const [service, raw] of Object.entries(value.keys)) {
    const key = keyOf(raw, clock);
    if (!key) return undefined;
    keys[service] = key;
  }
  return { account, enabled: value.enabled, revision, format, entries, keys };
};

/** Asks the platform, and has its times agree with this computer's clock. */
function asker(options: BrowserAiSyncOptions) {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  return async (path: string, init: RequestInit, signal: AbortSignal) => {
    const sent = now();
    const response = await request(options.api(path), { cache: "no-store", ...init, signal });
    const came = now();
    const answer: unknown =
      response.status === 204 ? {} : await response.json().catch(() => undefined);
    const said = isObject(answer) ? answer.error : undefined;
    if (response.status === 401 || said === "signedOut")
      throw new CloudSignedOut("Nobody is signed in");
    if (response.status === 409 && said === "otherAccount")
      throw new CloudOtherAccount("Somebody else is signed in");
    if (response.status === 409 && said === "off") throw new AiSyncOff("Turned off");
    if (response.status === 409 && said === "newer") {
      const revision = isObject(answer) ? count(answer.revision) : undefined;
      if (path.startsWith("/me/chats/")) throw new ChatNewer(revision ?? 0);
      throw new AiSyncNewer("A newer editor wrote them");
    }
    if (response.status === 413) throw new AiSyncTooLarge("Too large");
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new AiSyncBusy(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000);
    }
    return { response, answer, sent, came };
  };
}

const clockOf = (answer: unknown, sent: number, came: number): Clock => {
  const theirs = isObject(answer) ? count(answer.now) : undefined;
  if (theirs === undefined) throw new Error("The platform did not say what time it is");
  const offset = theirs - (sent + came) / 2;
  return (at) => Math.round(at - offset);
};

/**
 * The AI settings of the person on a platform, over its HTTP API, see `AiSyncAccess`:
 *
 * - `GET <api>/me/ai-settings[?since=<revision>]`: `{now, account, enabled, revision, format,
 *   entries, keys}` by the platform's clock, or `{now, account, enabled, revision, unchanged: true}`
 *   where the revision is still `since`.
 * - `POST <api>/me/ai-settings` `{now, account, format, entries, keys, enable?}`, by this
 *   computer's clock and what that says as it sends them: `{now, refused, state}`.
 * - `DELETE <api>/me/ai-settings?account=`: turned off, nothing kept. 204.
 */
export function browserAiSyncAccess(options: BrowserAiSyncOptions): AiSyncAccess {
  const ask = asker(options);
  const now = options.now ?? Date.now;
  const timeout = options.timeoutMs;
  return {
    read: (since) =>
      withinTime(timeout ?? REQUEST_TIMEOUT_MS, async (signal) => {
        const path = since === undefined ? "/me/ai-settings" : `/me/ai-settings?since=${since}`;
        const { response, answer, sent, came } = await ask(path, {}, signal);
        if (!response.ok || !isObject(answer))
          throw new Error(`The platform answered ${response.status}`);
        const clock = clockOf(answer, sent, came);
        if (answer.unchanged === true) {
          const revision = count(answer.revision);
          const account = text(answer.account);
          if (
            revision === undefined ||
            account === undefined ||
            typeof answer.enabled !== "boolean"
          )
            throw new Error("The platform answered something that cannot be read");
          return { revision, unchanged: true, account, enabled: answer.enabled };
        }
        const state = stateOf(answer, clock);
        if (!state) throw new Error("The platform answered something that cannot be read");
        return state;
      }),
    change: (changes) =>
      withinTime(timeout ?? CHANGE_TIMEOUT_MS, async (signal) => {
        if (changes.entries.length > AI_SYNC_BATCH || changes.keys.length > AI_SYNC_KEYS)
          throw new RangeError("Too many changes in one go");
        const { response, answer, sent, came } = await ask(
          "/me/ai-settings",
          {
            method: "POST",
            headers: { ...options.changeHeaders, "content-type": "application/json" },
            body: JSON.stringify({ ...changes, now: now(), format: 1 }),
          },
          signal,
        );
        if (!response.ok || !isObject(answer))
          throw new Error(`The platform answered ${response.status}`);
        const state = stateOf(answer.state, clockOf(answer, sent, came));
        const refused = Array.isArray(answer.refused)
          ? answer.refused.filter((name): name is string => typeof name === "string")
          : undefined;
        if (!state || !refused)
          throw new Error("The platform answered something that cannot be read");
        return { state, refused };
      }),
    turnOff: (account) =>
      withinTime(timeout ?? REQUEST_TIMEOUT_MS, async (signal) => {
        const { response } = await ask(
          `/me/ai-settings?account=${encodeURIComponent(account)}`,
          { method: "DELETE", headers: { ...options.changeHeaders } },
          signal,
        );
        if (!response.ok) throw new Error(`The platform answered ${response.status}`);
      }),
  };
}

const summaryOf = (value: unknown): AccountChatSummary | undefined => {
  if (!isObject(value) || !isObject(value.summary)) return undefined;
  const revision = count(value.revision);
  const { summary } = value;
  if (
    revision === undefined ||
    text(summary.id) === undefined ||
    text(summary.title) === undefined ||
    count(summary.updatedAt) === undefined
  )
    return undefined;
  return { revision, summary: summary as unknown as AccountChatSummary["summary"] };
};

/**
 * The conversations of the person about projects of a platform, over its HTTP API, see
 * `ChatSyncAccess`:
 *
 * - `GET <api>/me/chats?project=`: `{chats: [{revision, summary}]}`, newest first.
 * - `GET <api>/me/chats/<project>/<id>`: `{revision, chat}`; 404 where there is none.
 * - `PUT <api>/me/chats/<project>/<id>` `{base, chat}`: `{revision}`; 409 `{error: "newer",
 *   revision}`; 404 for a project that is not the person's, 413 for one too large.
 * - `DELETE <api>/me/chats/<project>/<id>`: 204.
 */
export function browserChatSyncAccess(options: BrowserAiSyncOptions): ChatSyncAccess {
  const ask = asker(options);
  const timeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const at = (project: string, id: string) =>
    `/me/chats/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  return {
    list: (project) =>
      withinTime(timeout, async (signal) => {
        const { response, answer } = await ask(
          `/me/chats?project=${encodeURIComponent(project)}`,
          {},
          signal,
        );
        if (!response.ok || !isObject(answer) || !Array.isArray(answer.chats))
          throw new Error(`The platform answered ${response.status}`);
        return answer.chats.flatMap((each) => {
          const summary = summaryOf(each);
          return summary ? [summary] : [];
        });
      }),
    load: (project, id) =>
      withinTime(timeout, async (signal) => {
        const { response, answer } = await ask(at(project, id), {}, signal);
        if (response.status === 404) return undefined;
        const revision = isObject(answer) ? count(answer.revision) : undefined;
        if (!response.ok || !isObject(answer) || revision === undefined || !isObject(answer.chat))
          throw new Error(`The platform answered ${response.status}`);
        const chat = answer.chat as unknown as SavedChat;
        if (!Array.isArray(chat.entries) || chat.id !== id)
          throw new Error("The platform answered something that cannot be read");
        return { revision, chat };
      }),
    save: (project, chat, base) =>
      withinTime(CHANGE_TIMEOUT_MS, async (signal) => {
        const { synced: _synced, project: _project, ...rest } = chat;
        let result;
        try {
          result = await ask(
            at(project, chat.id),
            {
              method: "PUT",
              headers: { ...options.changeHeaders, "content-type": "application/json" },
              body: JSON.stringify({ base, chat: rest }),
            },
            signal,
          );
        } catch (error) {
          if (error instanceof AiSyncTooLarge) return undefined;
          throw error;
        }
        const { response, answer } = result;
        if (response.status === 404) return undefined;
        const revision = isObject(answer) ? count(answer.revision) : undefined;
        if (!response.ok || revision === undefined)
          throw new Error(`The platform answered ${response.status}`);
        return revision;
      }),
    remove: (project, id) =>
      withinTime(timeout, async (signal) => {
        const { response } = await ask(
          at(project, id),
          { method: "DELETE", headers: { ...options.changeHeaders } },
          signal,
        );
        if (!response.ok && response.status !== 404)
          throw new Error(`The platform answered ${response.status}`);
      }),
  };
}
