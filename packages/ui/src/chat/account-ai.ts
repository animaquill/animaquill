import {
  canonical,
  entriesOfPacks,
  entriesOfSettings,
  entryChanges,
  isPackEntry,
  packsOfEntries,
  settingsOfEntries,
} from "@animaquill/agent";
import {
  AI_SYNC_BATCH,
  AI_SYNC_FORMAT,
  AI_SYNC_KEYS,
  AI_SYNC_MODELS_FORMAT,
  AI_SYNC_SECRETS_FORMAT,
  AiSyncNewer,
  AiSyncTooLarge,
  CloudOtherAccount,
  CloudSignedOut,
  SECRET_FIELDS,
  isLaterEntry,
  mergeSecret,
  type AccountAiSettings,
  type AiEntry,
  type AiSyncAccess,
  type AiSyncKey,
  type KeyStore,
  type SecretField,
  type SecretTimes,
  type ServiceSecret,
  type SettingsStore,
  scoped,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/**
 * The AI settings and keys of the online mode (docs/design/online-offline.md of AnimaQuill Cloud,
 * 2.1): the backend has them, and nothing else does. This page reads them as it starts and keeps
 * them in its memory; what people change goes to the backend at once, entry by entry, each with
 * when it changed, so that two windows or devices that change different things keep both (the
 * backend keeps the later of each, see ai-sync-rules.ts of the host).
 *
 * - **Keys** (what is secret of each service) are only ever in the memory of this page: never in
 *   the browser's storage. A page that cannot read the backend as it starts has none.
 * - **The other settings** are kept in the browser too (`ai.cached` in the settings of the online
 *   scope), as the backend last had them, without what is secret: what a page that starts without
 *   the backend shows, read-only.
 * - **Read-only** while the backend cannot be reached (`writable`): what people changed before
 *   goes once it can, and nothing new is taken until then.
 *
 * What the settings store and the model packs read and write goes through `settings` and `keys`
 * here: `ai` and `ai.packs` are the backend's, everything else is the browser's as ever.
 */

const SETTINGS = "ai";
const LATEST = "ai.latest";
const PACKS = "ai.packs";
/** What the browser keeps of the backend's settings, for a page that starts without it. */
export const CACHE_KEY = "ai.cached";

const PULL_MS = 2 * 60_000;
const PUSH_MS = 300;
const RETRY_MS = 1000;
const RETRY_MOST_MS = 60_000;
const CHANNEL = "animaquill.account-ai";

export type AccountAiStatus =
  /** Reading the backend, as the page starts. */
  | "reading"
  /** As the backend has them, or on their way to it. */
  | "ready"
  /** The backend cannot be reached: read-only, as last read. */
  | "offline"
  /** A newer editor wrote them: this one leaves them alone. */
  | "newer";

export interface AccountAiSnapshot {
  readonly status: AccountAiStatus;
  /** The keys were read from the backend in this page: without them, there are none here. */
  readonly keysRead: boolean;
  /** Changes made here that the backend does not have yet. */
  readonly pending: number;
}

export interface AccountAiOptions {
  readonly access: AiSyncAccess;
  /** Whose they are, see `AccountSnapshot.id`. */
  readonly account: string;
  /** The settings of the browser in the online scope: what is not AI, and `CACHE_KEY`. */
  readonly browser: SettingsStore;
  /** The session is of nobody, or of somebody else: who is signed in is to be asked again. */
  readonly signedOut?: () => void;
  /** Entries the backend did not take, as they would be too large together. */
  readonly tooLarge?: () => void;
  /**
   * What changed here could not go to the backend: it is only in this page, until it can. Each
   * time a try fails.
   */
  readonly unsent?: () => void;
  readonly now?: () => number;
  /** Only tests: timers of their own. */
  readonly setTimer?: (run: () => void, ms: number) => () => void;
  /** Only tests: no channel to other windows. */
  readonly channel?: () => BroadcastChannel | undefined;
}

/** What goes to the backend of what is secret of a service. */
type KeyChange = { readonly service: string } & AiSyncKey;

/** When what is secret of a service last changed, and of which part. */
interface KeyTime {
  readonly at: number;
  readonly deleted?: true;
  readonly fieldsAt?: SecretTimes;
}

/** What the browser keeps, see `CACHE_KEY`: nothing secret. */
interface Cached {
  readonly version: 1;
  readonly account: string;
  readonly format: number;
  readonly entries: Record<string, AiEntry>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCached = (value: unknown, account: string): value is Cached =>
  isRecord(value) &&
  value.version === 1 &&
  value.account === account &&
  typeof value.format === "number" &&
  isRecord(value.entries);

/** A service of settings of before 0.3.72 has its headers in it, which may say a key. */
/**
 * What the browser may keep of an entry: a service or a model of settings of before 0.3.72 can
 * have its address and headers in it, which may say a key. Nothing of that, whatever it says.
 */
const withoutSecret = (name: string, entry: AiEntry): AiEntry => {
  if (entry.deleted || !isRecord(entry.value)) return entry;
  if (!name.startsWith("service:") && !name.startsWith("model:")) return entry;
  const { headers: _headers, baseUrl: _baseUrl, ...rest } = entry.value;
  return { at: entry.at, value: rest };
};

const defaultTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** The backend could not be reached: nothing was changed. */
export class AccountAiOffline extends Error {
  override readonly name = "AccountAiOffline";
  constructor() {
    super("The AI settings can only change while the backend can be reached");
  }
}

export class AccountAi {
  readonly #options: AccountAiOptions;
  readonly #emitter = new Emitter();
  readonly #setTimer: (run: () => void, ms: number) => () => void;
  #snapshot: AccountAiSnapshot = { status: "reading", keysRead: false, pending: 0 };
  /** Every entry, as far as this page knows, with when it changed; taken away ones too. */
  #entries = new Map<string, AiEntry>();
  #keyTimes = new Map<string, KeyTime>();
  readonly #secrets = new Map<string, ServiceSecret>();
  readonly #pending = new Set<string>();
  readonly #pendingKeys = new Set<string>();
  #format = 1;
  #revision = -1;
  #ready: Promise<void>;
  #started = false;
  #closed = false;
  #pushing: Promise<void> | undefined;
  #pulling: Promise<void> | undefined;
  #cancelPush: (() => void) | undefined;
  #cancelPull: (() => void) | undefined;
  #failures = 0;
  /** People were told that changes could not go, see `AccountAiOptions.unsent`: once a time. */
  #toldUnsent = false;
  #channel: BroadcastChannel | undefined;
  readonly #listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly #stops: (() => void)[] = [];
  readonly settings: SettingsStore;
  readonly keys: KeyStore;

  constructor(options: AccountAiOptions) {
    this.#options = options;
    this.#setTimer = options.setTimer ?? defaultTimer;
    this.#ready = new Promise((resolve) => {
      this.#begin = resolve;
    });
    this.settings = this.#settingsStore();
    this.keys = this.#keyStore();
  }

  #begin: () => void = () => {};

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): AccountAiSnapshot => this.#snapshot;

  /** Resolves once this page has the settings: the backend's, or the browser's copy of them. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /**
   * Whether changes are taken now: the backend answered last, and nothing newer wrote them. Not
   * what the browser says of its network: a backend on this computer answers without one.
   */
  get writable(): boolean {
    return this.#snapshot.status === "ready";
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #set(changes: Partial<AccountAiSnapshot>): void {
    const next = {
      ...this.#snapshot,
      ...changes,
      pending: this.#pending.size + this.#pendingKeys.size,
    };
    if (
      next.status === this.#snapshot.status &&
      next.keysRead === this.#snapshot.keysRead &&
      next.pending === this.#snapshot.pending
    )
      return;
    this.#snapshot = next;
    this.#emitter.emit();
  }

  /** Reads the backend, and keeps up with it from then on. Never rejects. */
  async start(): Promise<void> {
    if (this.#started) return this.#ready;
    this.#started = true;
    const channel = (this.#options.channel ?? defaultChannel)();
    if (channel) {
      this.#channel = channel;
      channel.addEventListener("message", () => void this.pull());
    }
    if (typeof addEventListener === "function" && !this.#options.channel) {
      const again = () => void this.pull();
      // A hint only: a backend on this computer answers without a network. What says is whether it
      // answers.
      const offline = () => void this.pull();
      const visible = () => {
        if (globalThis.document?.visibilityState === "visible") again();
      };
      addEventListener("focus", again);
      addEventListener("online", again);
      addEventListener("offline", offline);
      globalThis.document?.addEventListener("visibilitychange", visible);
      this.#stops.push(() => {
        removeEventListener("focus", again);
        removeEventListener("online", again);
        removeEventListener("offline", offline);
        globalThis.document?.removeEventListener("visibilitychange", visible);
      });
    }
    await this.pull();
    if (!this.#snapshot.keysRead) await this.#fromCache();
    this.#begin();
  }

  /** What the status is where the backend did not answer. */
  #notReady(): AccountAiStatus {
    return this.#snapshot.status === "newer" ? "newer" : "offline";
  }

  /** The browser's copy, where the backend could not be read as the page started. */
  async #fromCache(): Promise<void> {
    const kept = await this.#options.browser.load(CACHE_KEY).catch(() => undefined);
    if (isCached(kept, this.#options.account)) {
      this.#entries = new Map(Object.entries(kept.entries));
      this.#format = kept.format;
    }
    this.#set({ status: this.#notReady() });
  }

  async #keepCache(): Promise<void> {
    const entries: Record<string, AiEntry> = {};
    for (const [name, entry] of this.#entries) {
      if (!entry.deleted) entries[name] = withoutSecret(name, entry);
    }
    const cached: Cached = {
      version: 1,
      account: this.#options.account,
      format: this.#format,
      entries,
    };
    await this.#options.browser.save(CACHE_KEY, cached).catch((error: unknown) => {
      console.warn("The AI settings could not be kept for while offline", error);
    });
  }

  // ---- reading

  /** Reads what the backend has, and takes it. Never rejects; one at a time. */
  pull(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#pulling ??= this.#pull().finally(() => {
      this.#pulling = undefined;
    });
    return this.#pulling;
  }

  async #pull(): Promise<void> {
    this.#cancelPull?.();
    let wait = PULL_MS;
    try {
      const remote = await this.#options.access.read(
        this.#snapshot.keysRead && this.#revision >= 0 ? this.#revision : undefined,
      );
      if (remote.account !== this.#options.account)
        throw new CloudOtherAccount("Somebody else is signed in");
      if ("entries" in remote) {
        if (remote.format > AI_SYNC_FORMAT) throw new AiSyncNewer();
        this.#take(remote);
        await this.#keepCache();
      }
      this.#failures = 0;
      this.#set({ status: "ready", keysRead: true });
      if (this.#pending.size + this.#pendingKeys.size > 0) this.#pushSoon(0);
    } catch (error) {
      wait = this.#failed(error);
    } finally {
      if (!this.#closed) this.#cancelPull = this.#setTimer(() => void this.pull(), wait);
    }
  }

  /** What went wrong, said; how long until the next try. */
  #failed(error: unknown): number {
    if (error instanceof CloudSignedOut || error instanceof CloudOtherAccount) {
      // Who is signed in is asked again; until then, as for any other failure, again soon.
      this.#options.signedOut?.();
    }
    if (error instanceof AiSyncNewer) {
      this.#set({ status: "newer" });
      return PULL_MS;
    }
    console.warn("The AI settings could not be read from the backend", error);
    this.#failures += 1;
    this.#set({ status: this.#notReady() });
    const busy = (error as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof busy === "number"
      ? busy
      : Math.min(RETRY_MOST_MS, RETRY_MS * 2 ** (this.#failures - 1));
  }

  /**
   * Takes what the backend has, entry by entry: what changed here later and has not gone yet
   * stays, to go; everything else is as the backend has it. Whoever listens hears what changed.
   */
  #take(remote: AccountAiSettings): void {
    const before = { settings: this.#live(SETTINGS), packs: this.#live(PACKS) };
    const entries = new Map<string, AiEntry>();
    for (const [name, entry] of Object.entries(remote.entries)) {
      const mine = this.#entries.get(name);
      if (mine && this.#pending.has(name) && isLaterEntry(entry, mine)) entries.set(name, mine);
      else {
        entries.set(name, entry);
        this.#pending.delete(name);
      }
    }
    // Changed here, and not there yet.
    for (const name of this.#pending) {
      const mine = this.#entries.get(name);
      if (mine && !entries.has(name)) entries.set(name, mine);
    }
    this.#entries = entries;

    let secretsChanged = false;
    const times = new Map<string, KeyTime>();
    for (const [service, entry] of Object.entries(remote.keys)) {
      const mine = this.#keyTimes.get(service);
      const local = this.#secrets.get(service);
      if (this.#pendingKeys.has(service) && mine && !mine.deleted && local && !entry.deleted) {
        const merged = mergeSecret(
          { at: mine.at, secret: local, fieldsAt: mine.fieldsAt },
          { at: entry.at, secret: entry.secret, fieldsAt: entry.fieldsAt },
        );
        if (canonical(merged.secret) !== canonical(local)) {
          this.#secrets.set(service, merged.secret);
          secretsChanged = true;
        }
        times.set(service, { at: merged.at, fieldsAt: merged.fieldsAt });
        const theirs = (field: SecretField) =>
          entry.fieldsAt ? (entry.fieldsAt[field] ?? 0) : entry.at;
        if (SECRET_FIELDS.every((field) => (merged.fieldsAt[field] ?? 0) <= theirs(field)))
          this.#pendingKeys.delete(service);
        continue;
      }
      if (mine && this.#pendingKeys.has(service) && isLaterEntry(entry, mine)) {
        times.set(service, mine);
        continue;
      }
      this.#pendingKeys.delete(service);
      if (entry.deleted) {
        if (this.#secrets.delete(service)) secretsChanged = true;
        times.set(service, { at: entry.at, deleted: true });
      } else {
        if (canonical(local ?? null) !== canonical(entry.secret)) {
          this.#secrets.set(service, entry.secret);
          secretsChanged = true;
        }
        times.set(service, { at: entry.at, ...(entry.fieldsAt && { fieldsAt: entry.fieldsAt }) });
      }
    }
    for (const service of this.#pendingKeys) {
      const mine = this.#keyTimes.get(service);
      if (mine && !times.has(service)) times.set(service, mine);
    }
    // What the backend does not have at all, and was not changed here, is not there.
    for (const service of Array.from(this.#secrets.keys())) {
      if (!times.has(service)) {
        this.#secrets.delete(service);
        secretsChanged = true;
      }
    }
    this.#keyTimes = times;
    this.#format = Math.max(this.#format, remote.format);
    this.#revision = remote.revision;

    const settings = this.#live(SETTINGS);
    if (
      secretsChanged ||
      canonical(Object.fromEntries(settings)) !== canonical(Object.fromEntries(before.settings))
    )
      this.#tell(SETTINGS, settingsOfEntries(settings));
    const packs = this.#live(PACKS);
    if (canonical(Object.fromEntries(packs)) !== canonical(Object.fromEntries(before.packs)))
      this.#tell(PACKS, packsOfEntries(packs));
  }

  /** The entries that are there, of the settings or of the packs, as an object for comparing. */
  #live(key: string): Map<string, unknown> {
    const packs = key === PACKS;
    return new Map(
      [...this.#entries]
        .filter(([name, entry]) => isPackEntry(name) === packs && !entry.deleted)
        .map(([name, entry]) => [name, entry.value]),
    );
  }

  #tell(key: string, value: unknown): void {
    for (const listener of this.#listeners.get(key) ?? []) listener(structuredClone(value));
  }

  // ---- changing

  #change(name: string, value: unknown, at: number, deleted = false): void {
    const before = this.#entries.get(name);
    const time = Math.max(at, (before?.at ?? 0) + 1);
    this.#entries.set(name, deleted ? { at: time, deleted: true } : { at: time, value });
    this.#pending.add(name);
  }

  #save(key: string, value: unknown): void {
    if (!this.writable) throw new AccountAiOffline();
    const after = key === PACKS ? entriesOfPacks(value) : entriesOfSettings(value);
    // Not settings as this editor writes them: nothing can be told apart, and nothing goes.
    if (!after) throw new Error("These are not AI settings");
    const { changed, removed } = entryChanges(this.#live(key), after);
    if (changed.length === 0 && removed.length === 0) return;
    const at = this.#now();
    for (const [name, next] of changed) this.#change(name, next, at);
    for (const name of removed) this.#change(name, undefined, at, true);
    this.#set({});
    this.#pushSoon();
  }

  #keyChanged(service: string, after: ServiceSecret | undefined, fields: readonly SecretField[]) {
    const before = this.#keyTimes.get(service);
    const at = Math.max(this.#now(), (before?.at ?? 0) + 1);
    if (after === undefined) {
      this.#secrets.delete(service);
      this.#keyTimes.set(service, { at, deleted: true });
    } else {
      this.#secrets.set(service, after);
      const fieldsAt: Partial<Record<SecretField, number>> = {
        ...(before && !before.deleted && before.fieldsAt),
      };
      for (const field of fields) fieldsAt[field] = at;
      this.#keyTimes.set(service, { at, fieldsAt });
    }
    this.#pendingKeys.add(service);
    this.#set({});
    // A key goes at once: it is nowhere else, and a page can go right after it was typed.
    this.#cancelPush?.();
    this.#cancelPush = undefined;
    void this.push();
  }

  #pushSoon(ms = PUSH_MS): void {
    if (this.#closed) return;
    this.#cancelPush?.();
    this.#cancelPush = this.#setTimer(() => {
      this.#cancelPush = undefined;
      void this.push();
    }, ms);
  }

  /** Gives the backend what changed here, until nothing is left. Never rejects. */
  push(): Promise<void> {
    this.#pushing ??= this.#push().finally(() => {
      this.#pushing = undefined;
    });
    return this.#pushing;
  }

  async #push(): Promise<void> {
    const { access, account } = this.#options;
    // Nothing to give: how it stands is as the last answer said.
    if (!this.hasUnsent) return;
    try {
      for (let round = 0; round < 50; round += 1) {
        if (this.#pending.size === 0 && this.#pendingKeys.size === 0) break;
        const entries = [...this.#pending].slice(0, AI_SYNC_BATCH).flatMap((name) => {
          const entry = this.#entries.get(name);
          return entry ? [{ name, ...entry }] : [];
        });
        const keys = [...this.#pendingKeys]
          .slice(0, AI_SYNC_KEYS)
          .flatMap((service): KeyChange[] => {
            const time = this.#keyTimes.get(service);
            if (!time) return [];
            const secret = this.#secrets.get(service);
            if (time.deleted || !secret) return [{ service, at: time.at, deleted: true as const }];
            return [
              { service, at: time.at, secret, ...(time.fieldsAt && { fieldsAt: time.fieldsAt }) },
            ];
          });
        const answer = await access.change({
          account,
          entries,
          keys,
          ...(this.#formatNeeded() > 1 && { format: this.#formatNeeded() }),
        });
        if (answer.state.account !== account)
          throw new CloudOtherAccount("Somebody else is signed in");
        // What went is no longer to go, unless it changed here meanwhile; what was not taken is
        // not kept: the settings are as the backend has them.
        const sentAt = new Map(entries.map((entry) => [entry.name, entry.at]));
        for (const [name, at] of sentAt) {
          if ((this.#entries.get(name)?.at ?? 0) <= at) this.#pending.delete(name);
        }
        for (const key of keys) {
          if ((this.#keyTimes.get(key.service)?.at ?? 0) <= key.at)
            this.#pendingKeys.delete(key.service);
        }
        if (answer.tooLarge.length > 0) this.#options.tooLarge?.();
        this.#take(answer.state);
      }
      await this.#keepCache();
      this.#failures = 0;
      this.#toldUnsent = false;
      this.#set({ status: "ready" });
      this.#channel?.postMessage("changed");
    } catch (error) {
      if (error instanceof AiSyncTooLarge) {
        // Nothing of it was kept: what was changed here goes back to what the backend has.
        this.#pending.clear();
        this.#pendingKeys.clear();
        this.#options.tooLarge?.();
        this.#revision = -1;
        void this.pull();
        return;
      }
      const wait = this.#failed(error);
      // What changed is only in this page now: people are told at once, not as it goes.
      if (this.hasUnsent && !this.#toldUnsent) {
        this.#toldUnsent = true;
        this.#options.unsent?.();
      }
      this.#pushSoon(wait);
    }
  }

  /**
   * The format the entries are in: models of their own are of format 2, which an editor before them
   * would write back without; services without their address of format 3, which an editor of
   * format 2 cannot read.
   */
  #formatNeeded(): number {
    const entries = [...this.#entries];
    const models = entries.some(([name]) => name.startsWith("model:"));
    const secrets = entries.some(
      ([name, entry]) =>
        name.startsWith("service:") &&
        !entry.deleted &&
        isRecord(entry.value) &&
        entry.value.baseUrl === undefined,
    );
    return Math.max(
      this.#format,
      secrets ? AI_SYNC_SECRETS_FORMAT : models ? AI_SYNC_MODELS_FORMAT : 1,
    );
  }

  /** Waits until what changed here is on the backend, or it cannot be reached. */
  async flush(): Promise<void> {
    this.#cancelPush?.();
    this.#cancelPush = undefined;
    await this.push();
  }

  /** What changed here that the backend does not have, which goes with the page: see `flush`. */
  get hasUnsent(): boolean {
    return this.#pending.size + this.#pendingKeys.size > 0;
  }

  /** The page goes: what waits goes now, as far as it can. */
  close(): void {
    if (this.hasUnsent) {
      this.#cancelPush?.();
      void this.push();
    }
    this.#closed = true;
    this.#cancelPull?.();
    this.#cancelPush?.();
    this.#channel?.close();
    for (const stop of this.#stops) stop();
  }

  // ---- what the settings store and the packs use

  #settingsStore(): SettingsStore {
    const { browser } = this.#options;
    const ours = (key: string) => key === SETTINGS || key === PACKS || key === LATEST;
    return {
      load: async (key) => {
        if (!ours(key)) return browser.load(key);
        await this.#ready;
        if (key === PACKS) return packsOfEntries(this.#live(PACKS));
        const live = this.#live(SETTINGS);
        // Nothing yet: as an editor that never saved any.
        return live.size === 0 ? undefined : settingsOfEntries(live);
      },
      save: async (key, value) => {
        if (key === LATEST) return;
        if (!ours(key)) return browser.save(key, value);
        await this.#ready;
        this.#save(key, value);
      },
      listen: (key, listener) => {
        if (!ours(key)) return browser.listen(key, listener);
        let listeners = this.#listeners.get(key);
        if (!listeners) this.#listeners.set(key, (listeners = new Set()));
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      remove: async (key) => {
        if (!ours(key)) return browser.remove?.(key);
      },
    };
  }

  #keyStore(): KeyStore {
    const update = async (
      service: string,
      change: (before: ServiceSecret | undefined) => ServiceSecret | undefined,
    ): Promise<ServiceSecret | undefined> => {
      await this.#ready;
      if (!this.writable) throw new AccountAiOffline();
      const before = this.#secrets.get(service);
      const next = change(before && structuredClone(before));
      const after = next && Object.keys(next).length > 0 ? structuredClone(next) : undefined;
      const fields = SECRET_FIELDS.filter(
        (field) => canonical(before?.[field] ?? null) !== canonical(after?.[field] ?? null),
      );
      if (fields.length > 0) this.#keyChanged(service, after, fields);
      return after && structuredClone(after);
    };
    return {
      // Nowhere in this browser: on the backend, and in the memory of this page.
      where: "backend",
      read: async (service) => {
        await this.#ready;
        const found = this.#secrets.get(service);
        return found && structuredClone(found);
      },
      list: async () => {
        await this.#ready;
        return [...this.#secrets.keys()];
      },
      write: async (service, secret) => void (await update(service, () => secret)),
      update,
      remove: async (service) => void (await update(service, () => undefined)),
      clear: async () => {
        await this.#ready;
        for (const service of Array.from(this.#secrets.keys()))
          await update(service, () => undefined);
      },
    };
  }
}

/** The windows of this account on this backend, as their scope is their page's. */
function defaultChannel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(scoped(CHANNEL)) : undefined;
}
