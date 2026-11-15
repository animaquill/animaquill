import {
  CHANGE_TIMEOUT_MS,
  count,
  isObject,
  REQUEST_TIMEOUT_MS,
  text,
  texts,
  withinTime,
} from "./answers.ts";
import {
  AiSyncNewer,
  AiSyncOff,
  AiSyncTooLarge,
  ChatImagesMissing,
  ChatNewer,
  CloudFeatureOff,
  CloudOtherAccount,
  CloudSignedOut,
  type AccountAiSettings,
  type AccountChatSummary,
  type AiSyncAccess,
  type ChatImageRef,
  type ChatImageUsage,
  type ChatSyncAccess,
  type CloudSwitchChanges,
  type CloudSwitches,
  type CloudSwitchesAccess,
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
    if (response.status === 409 && said === "off")
      throw path.startsWith("/me/chats")
        ? new CloudFeatureOff("Turned off")
        : new AiSyncOff("Turned off");
    if (response.status === 409 && said === "newer") {
      const revision = isObject(answer) ? count(answer.revision) : undefined;
      if (path.startsWith("/me/chats/")) throw new ChatNewer(revision ?? 0);
      throw new AiSyncNewer("A newer editor wrote them");
    }
    // Pictures say why, which `putImage` reads.
    if (response.status === 413 && !path.startsWith("/me/chat-images"))
      throw new AiSyncTooLarge("Too large");
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
 *   computer's clock and what that says as it sends them: `{now, refused, tooLarge, state}`.
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
            body: JSON.stringify({ ...changes, now: now(), format: changes.format ?? 1 }),
          },
          signal,
        );
        if (!response.ok || !isObject(answer))
          throw new Error(`The platform answered ${response.status}`);
        const state = stateOf(answer.state, clockOf(answer, sent, came));
        const names = (value: unknown) =>
          Array.isArray(value)
            ? value.filter((name): name is string => typeof name === "string")
            : [];
        if (!state || !Array.isArray(answer.refused))
          throw new Error("The platform answered something that cannot be read");
        return {
          state,
          refused: names(answer.refused),
          tooLarge: names(answer.tooLarge),
        };
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
 * - `GET <api>/me/chats?project=`: `{chats: [{revision, summary}], epoch}`, newest first.
 * - `GET <api>/me/chats/<project>/<id>`: `{revision, chat, epoch}`; 404 where there is none.
 * - `PUT <api>/me/chats/<project>/<id>` `{base, chat}`: `{revision}`; 409 `{error: "newer",
 *   revision}`; 404 for a project that is not the person's, 413 for one too large.
 *   409 `{error: "missingImages", images}` for pictures it names that the platform does not have.
 * - `DELETE <api>/me/chats/<project>/<id>`: 204.
 * - `POST <api>/me/chat-images` `{hash, bytes, type}`: `{have: true}`, or `{upload: {method, url,
 *   headers}}`, where the picture goes straight to the storage; then `POST
 *   <api>/me/chat-images/<hash>/done`, which reads it back. 413 `full` where there is no room.
 * - `GET <api>/me/chat-images/<hash>`: `{url, type}`, where to read it, for five minutes.
 * - `GET <api>/me/chat-images`: `{used, limit, chats}`.
 */
export function browserChatSyncAccess(options: BrowserAiSyncOptions): ChatSyncAccess {
  const ask = asker(options);
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const hexOf = (ref: ChatImageRef) => {
    const hex = /^sha256:([0-9a-f]{64})$/.exec(ref.image)?.[1];
    if (!hex) throw new RangeError("Not a picture of a conversation");
    return hex;
  };
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
        return {
          chats: answer.chats.flatMap((each) => {
            const summary = summaryOf(each);
            return summary ? [summary] : [];
          }),
          epoch: count(answer.epoch),
        };
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
        return { revision, chat, epoch: count(answer.epoch) };
      }),
    save: (project, chat, base) =>
      withinTime(CHANGE_TIMEOUT_MS, async (signal) => {
        const { synced: _synced, syncedAt: _syncedAt, project: _project, ...rest } = chat;
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
        if (response.status === 409 && isObject(answer) && answer.error === "missingImages")
          throw new ChatImagesMissing(texts(answer.images) ?? []);
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
    putImage: (ref, blob) =>
      withinTime(CHANGE_TIMEOUT_MS, async (signal) => {
        const hash = hexOf(ref);
        const begun = await ask(
          "/me/chat-images",
          {
            method: "POST",
            headers: { ...options.changeHeaders, "content-type": "application/json" },
            body: JSON.stringify({ hash, bytes: blob.size, type: ref.type }),
          },
          signal,
        );
        const said = isObject(begun.answer) ? begun.answer.error : undefined;
        if (begun.response.status === 413) return said === "full" ? "full" : "unavailable";
        if (begun.response.status === 503 && said === "unavailable") return "unavailable";
        if (!begun.response.ok || !isObject(begun.answer))
          throw new Error(`The platform answered ${begun.response.status}`);
        if (begun.answer.have === true) return "stored";
        const upload = begun.answer.upload;
        const url = isObject(upload) ? text(upload.url) : undefined;
        if (!isObject(upload) || url === undefined || !isObject(upload.headers))
          throw new Error("The platform answered something that cannot be read");
        const headers: Record<string, string> = { "content-type": ref.type };
        for (const [name, value] of Object.entries(upload.headers))
          if (typeof value === "string") headers[name] = value;
        const put = await request(url, { method: "PUT", headers, body: blob, signal });
        await put.body?.cancel().catch(() => {});
        if (!put.ok) throw new Error(`The storage answered ${put.status}`);
        const done = await ask(
          `/me/chat-images/${hash}/done`,
          { method: "POST", headers: { ...options.changeHeaders } },
          signal,
        );
        if (!done.response.ok) throw new Error(`The platform answered ${done.response.status}`);
        return "stored";
      }),
    getImage: (ref) =>
      withinTime(CHANGE_TIMEOUT_MS, async (signal) => {
        const hash = hexOf(ref);
        const { response, answer } = await ask(`/me/chat-images/${hash}`, {}, signal);
        if (response.status === 404) return undefined;
        const url = isObject(answer) ? text(answer.url) : undefined;
        if (!response.ok || url === undefined)
          throw new Error(`The platform answered ${response.status}`);
        const got = await request(url, { cache: "no-store", signal });
        if (got.status === 404) return undefined;
        if (!got.ok) throw new Error(`The storage answered ${got.status}`);
        const bytes = await got.arrayBuffer();
        // Only what it says it is.
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (hex !== hash) throw new Error("The picture the storage gave is not the one asked for");
        const said = isObject(answer) ? text(answer.type) : undefined;
        return new Blob([bytes], { type: ref.type || (said ?? "") });
      }),
    imageUsage: () =>
      withinTime(timeout, async (signal) => {
        const { response, answer } = await ask("/me/chat-images", {}, signal);
        const used = isObject(answer) ? count(answer.used) : undefined;
        const limit = isObject(answer) ? count(answer.limit) : undefined;
        if (!response.ok || !isObject(answer) || used === undefined || limit === undefined)
          throw new Error(`The platform answered ${response.status}`);
        const chats: ChatImageUsage["chats"][number][] = [];
        for (const each of Array.isArray(answer.chats) ? answer.chats : []) {
          if (!isObject(each)) continue;
          const project = text(each.project);
          const chat = text(each.chat);
          const images = count(each.images);
          const bytes = count(each.bytes);
          if (project === undefined || chat === undefined || images === undefined) continue;
          if (bytes === undefined) continue;
          chats.push({
            project,
            projectName: text(each.projectName) ?? "",
            chat,
            title: text(each.title) ?? "",
            images,
            bytes,
          });
        }
        return { used, limit, chats };
      }),
  };
}

const switchesOf = (value: unknown): CloudSwitches | undefined => {
  if (!isObject(value) || !isObject(value.prefs)) return undefined;
  const account = text(value.account);
  const organizerEpoch = count(value.organizerEpoch);
  const chatsEpoch = count(value.chatsEpoch);
  const { ai, organizer, chats } = value;
  const cloud = value.prefs.newProjectsInCloud;
  if (
    account === undefined ||
    organizerEpoch === undefined ||
    chatsEpoch === undefined ||
    typeof ai !== "boolean" ||
    typeof organizer !== "boolean" ||
    typeof chats !== "boolean" ||
    typeof cloud !== "boolean"
  )
    return undefined;
  return {
    account,
    ai,
    organizer,
    organizerEpoch,
    chats,
    chatsEpoch,
    newProjectsInCloud: cloud,
  };
};

/**
 * The switches of the cloud features of the person on a platform, over its HTTP API, see
 * `CloudSwitchesAccess`:
 *
 * - `GET <api>/me/cloud`: `{now, account, ai, organizer, organizerEpoch, chats, chatsEpoch,
 *   prefs: {newProjectsInCloud}}`.
 * - `POST <api>/me/cloud` `{account, organizer?, chats?, prefs?: {newProjectsInCloud?}}`: the same.
 */
export function browserCloudSwitchesAccess(options: BrowserAiSyncOptions): CloudSwitchesAccess {
  const ask = asker(options);
  const timeout = options.timeoutMs;
  const answered = (response: Response, answer: unknown) => {
    if (!response.ok) throw new Error(`The platform answered ${response.status}`);
    const switches = switchesOf(answer);
    if (!switches) throw new Error("The platform answered something that cannot be read");
    return switches;
  };
  return {
    read: () =>
      withinTime(timeout ?? REQUEST_TIMEOUT_MS, async (signal) => {
        const { response, answer } = await ask("/me/cloud", {}, signal);
        return answered(response, answer);
      }),
    change: (account: string, changes: CloudSwitchChanges) =>
      withinTime(timeout ?? CHANGE_TIMEOUT_MS, async (signal) => {
        const { newProjectsInCloud, ...switches } = changes;
        const { response, answer } = await ask(
          "/me/cloud",
          {
            method: "POST",
            headers: { ...options.changeHeaders, "content-type": "application/json" },
            body: JSON.stringify({
              account,
              ...switches,
              ...(newProjectsInCloud !== undefined && { prefs: { newProjectsInCloud } }),
            }),
          },
          signal,
        );
        return answered(response, answer);
      }),
  };
}
