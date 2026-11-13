import {
  EMPTY_AI_SETTINGS,
  canonical,
  entriesOfPacks,
  entriesOfSettings,
  entryChanges,
  isPackEntry,
  packsOfEntries,
  settingsOfEntries,
  writeAiSettings,
} from "@animaquill/agent";
import {
  AI_SYNC_BATCH,
  AI_SYNC_FORMAT,
  AI_SYNC_KEYS,
  AiSyncNewer,
  AiSyncOff,
  AiSyncTooLarge,
  CloudOtherAccount,
  CloudSignedOut,
  isLaterEntry,
  memoryAccountKeys,
  type AccountAccess,
  type AccountAiSettings,
  type AccountKeys,
  type AiEntry,
  type AiSyncAccess,
  type KeyStore,
  type SettingsStore,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/**
 * The AI settings and keys going with the account people are signed in to (docs/design/
 * chat-and-models.md of AnimaQuill Cloud, 5), see `AiSyncAccess`.
 *
 * What the settings store and the model packs read and write goes through `settings` and `keys`
 * here, which are those of this device (`ai`, the keys of `Host.keys`) while nobody is signed in,
 * and those of the account (`ai@<account>`, `AccountKeys.of`) while somebody is: an account's never
 * mix with another's, nor with this device's, which come back as people sign out. Pages of before
 * 0.3.62 only ever see the device's.
 *
 * The account's are kept here as entries too (`ai.sync@<account>`, see `SyncState`), each with
 * when it last changed: what this window saves is told apart from what it read before
 * (`entryChanges`), so that only what it changed goes as changed, never what it had not heard of
 * yet from another window or device; and what the platform has is merged in entry by entry, the
 * later wins. Every change of the entries, and every write of the settings of the account, is under
 * one lock of the browser for the account, so windows take turns.
 *
 * One window of the browser talks to the platform (the lock `animaquill.ai-sync.leader`): it reads
 * as it starts, as a window of the browser comes to the front, as the browser goes online, every
 * two minutes; and gives what changed a second after it did, also what other windows changed.
 */

/** What the settings store and the model packs keep under, which go with the account. */
const SETTINGS = "ai";
const LATEST = "ai.latest";
const PACKS = "ai.packs";
const SCOPED = new Set([SETTINGS, LATEST, PACKS]);
/** The account whose settings were in use last, so that a reload starts with them. */
const SCOPE = "ai.scope";
const stateKey = (account: string) => `ai.sync@${account}`;
const scopedKey = (key: string, account: string | undefined) =>
  account === undefined || !SCOPED.has(key) ? key : `${key}@${account}`;

const PULL_MS = 2 * 60_000;
const PUSH_MS = 1000;
const RETRY_MS = 30_000;
const LEADER = "animaquill.ai-sync.leader";
const CHANNEL = "animaquill.ai-sync";

/** What a browser keeps of the account's settings besides the settings themselves. */
interface SyncState {
  readonly version: 1;
  /** Every entry, as far as this browser knows, with when it changed. */
  entries: Record<string, AiEntry>;
  /** When each key last changed, and whether it was taken away: the keys are in `AccountKeys`. */
  keys: Record<string, { at: number; deleted?: true }>;
  /** Entries, and keys by service, changed here that the platform does not have yet. */
  pending: string[];
  pendingKeys: string[];
  /** What the platform said last. */
  revision: number;
  /** People turned it off, on this device or another one. */
  enabled: boolean;
  /** When everything was last in step with the platform. */
  syncedAt?: number;
  /** What went wrong last, for every window to show. */
  problem?: "offline" | "failed" | "newer" | "tooLarge";
  /** Entries the platform did not take, which stay on this device until they change here. */
  refused?: string[];
}

const newState = (enabled: boolean): SyncState => ({
  version: 1,
  entries: {},
  keys: {},
  pending: [],
  pendingKeys: [],
  revision: 0,
  enabled,
});

const isState = (value: unknown): value is SyncState =>
  typeof value === "object" &&
  value !== null &&
  (value as SyncState).version === 1 &&
  typeof (value as SyncState).entries === "object" &&
  Array.isArray((value as SyncState).pending);

export type AiSyncStatus =
  /** Nobody is signed in, or there is no platform: the settings are of this device. */
  | "local"
  /** Signed in, and people were not asked yet whether to start. */
  | "waiting"
  | "syncing"
  | "synced"
  /** Changes wait for the platform to be reachable. */
  | "offline"
  | "failed"
  /** Turned off for the account. */
  | "off"
  /** A newer editor wrote the account's settings: this one leaves them alone. */
  | "newer"
  | "tooLarge";

export interface AiSyncSnapshot {
  /** Whether settings can go with an account here at all. */
  readonly available: boolean;
  /** The account whose settings are in use; undefined: this device's. */
  readonly account: string | undefined;
  readonly status: AiSyncStatus;
  readonly syncedAt: number | undefined;
}

/** What people are asked once, as the settings start to go with an account on this device. */
export interface AiSyncQuestion {
  /** How many services this device has, which could go into the account. */
  readonly services: number;
  /** How many the account has already. */
  readonly accountServices: number;
}

export interface AiSyncOptions {
  /** The settings of this browser, as the host keeps them. */
  readonly settings: SettingsStore;
  /** The keys of this device. */
  readonly keys: KeyStore;
  readonly accountKeys?: AccountKeys;
  readonly access?: AiSyncAccess;
  readonly account?: AccountAccess;
  readonly locks?: () => LockManager | undefined;
  readonly now?: () => number;
  /**
   * Asks people, once, before the settings of this device start to go with the account:
   * "put" puts this device's in, "skip" does not, undefined asks again another time.
   */
  readonly ask?: (question: AiSyncQuestion) => Promise<"put" | "skip" | undefined>;
  /** Tells people which services of this device went into the account. */
  readonly added?: (names: readonly string[]) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the settings are while there are none. */
const emptyOf = (key: string): unknown =>
  key === SETTINGS ? writeAiSettings(EMPTY_AI_SETTINGS) : key === PACKS ? { packs: [] } : undefined;

/** The entries of what is saved under a key, or undefined where they cannot be told. */
const entriesOf = (key: string, value: unknown): Map<string, unknown> | undefined =>
  key === SETTINGS
    ? value === undefined
      ? entriesOfSettings(emptyOf(SETTINGS))
      : entriesOfSettings(value)
    : entriesOfPacks(value);

const ofKey = (key: string) => (name: string) =>
  key === PACKS ? isPackEntry(name) : !isPackEntry(name);

/** The entries that are there, of a key, out of a state. */
function liveOf(state: SyncState, key: string): Map<string, unknown> {
  const of = ofKey(key);
  return new Map(
    Object.entries(state.entries)
      .filter(([name, entry]) => of(name) && !entry.deleted)
      .map(([name, entry]) => [name, entry.value]),
  );
}

const materialize = (state: SyncState, key: string): unknown =>
  key === SETTINGS ? settingsOfEntries(liveOf(state, key)) : packsOfEntries(liveOf(state, key));

const sameEntries = (a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>) =>
  canonical(Object.fromEntries(a)) === canonical(Object.fromEntries(b));

/** One after the other, within this page only: where the browser has no locks. */
function pageLocks(): (name: string, work: () => Promise<unknown>) => Promise<unknown> {
  const chains = new Map<string, Promise<unknown>>();
  return (name, work) => {
    const next = (chains.get(name) ?? Promise.resolve()).then(work, work);
    chains.set(
      name,
      next.catch(() => {}),
    );
    return next;
  };
}

export class AiSync {
  readonly #options: AiSyncOptions;
  readonly #base: SettingsStore;
  readonly #accountKeys: AccountKeys;
  readonly #emitter = new Emitter();
  readonly #pageLock = pageLocks();
  #scope: string | undefined;
  #snapshot: AiSyncSnapshot;
  #ready: Promise<void>;
  #leader = false;
  #pullTimer: ReturnType<typeof setTimeout> | undefined;
  #pushTimer: ReturnType<typeof setTimeout> | undefined;
  #channel: BroadcastChannel | undefined;
  #asking: string | undefined;
  #following: Promise<void> = Promise.resolve();
  #stopState: (() => void) | undefined;
  #syncing: Promise<void> | undefined;
  readonly settings: ScopedSettings;
  readonly keys: ScopedKeys;

  constructor(options: AiSyncOptions) {
    this.#options = options;
    this.#base = options.settings;
    this.#accountKeys = options.accountKeys ?? memoryAccountKeys();
    this.#snapshot = {
      available: options.access !== undefined && options.account !== undefined,
      account: undefined,
      status: "local",
      syncedAt: undefined,
    };
    this.settings = new ScopedSettings(this);
    this.keys = new ScopedKeys(this, options.keys, this.#accountKeys);
    // The account whose settings were in use last, so that a reload does not flash this device's.
    this.#ready = this.#available
      ? this.#base
          .load(SCOPE)
          .then(async (scope) => {
            if (typeof scope === "string" && isState(await this.#base.load(stateKey(scope))))
              this.#setScope(scope);
          })
          .catch(() => {})
      : Promise.resolve();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): AiSyncSnapshot => this.#snapshot;

  get #available(): boolean {
    return this.#snapshot.available;
  }

  /** Whose settings are in use: an account, or this device (undefined). */
  get scope(): string | undefined {
    return this.#scope;
  }

  /** Resolves once it is known whose settings are in use as the page starts. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  get base(): SettingsStore {
    return this.#base;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #set(changes: Partial<AiSyncSnapshot>): void {
    const next = { ...this.#snapshot, ...changes };
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = next;
    this.#emitter.emit();
  }

  #setScope(account: string | undefined): void {
    if (account === this.#scope) return;
    this.#scope = account;
    this.#stopState?.();
    this.#stopState = undefined;
    if (account !== undefined) {
      // What other windows changed: the window that talks to the platform gives it, and every
      // window shows how it stands.
      this.#stopState = this.#base.listen(stateKey(account), (value) => {
        if (isState(value)) this.#showState(value);
        if (this.#leader) this.#schedulePush();
      });
    }
    this.#set({ account, status: account === undefined ? "local" : this.#snapshot.status });
    this.settings.scopeChanged();
    this.keys.scopeChanged();
  }

  #showState(state: SyncState): void {
    const status: AiSyncStatus = !state.enabled
      ? "off"
      : (state.problem ??
        (state.pending.length + state.pendingKeys.length > 0 ? "syncing" : "synced"));
    this.#set({ status, syncedAt: state.syncedAt });
  }

  /** Starts following who is signed in. Without a platform or accounts, nothing goes anywhere. */
  async start(): Promise<void> {
    await this.#ready;
    const { account, access } = this.#options;
    if (!account || !access) return;
    const follow = () => {
      this.#following = this.#following
        .then(() => this.#follow())
        .catch((error: unknown) => {
          console.warn("The AI settings could not follow the account", error);
        });
    };
    account.subscribe(follow);
    follow();
    // Another window let go of an account, or took one on: who is signed in may have changed.
    this.#base.listen(SCOPE, () => void account.refresh());
    this.#lead();
    if (typeof BroadcastChannel === "function") {
      this.#channel = new BroadcastChannel(CHANNEL);
      this.#channel.addEventListener("message", () => {
        if (this.#leader) void this.sync();
      });
    }
    if (typeof addEventListener === "function") {
      const ping = () => {
        if (this.#leader) void this.sync();
        else this.#channel?.postMessage("pull");
      };
      addEventListener("focus", ping);
      addEventListener("online", ping);
    }
  }

  /** Becomes the window that talks to the platform, once no other is. */
  #lead(): void {
    const locks = (this.#options.locks ?? (() => globalThis.navigator?.locks))();
    if (!locks) {
      this.#leader = true;
      void this.sync();
      return;
    }
    void locks
      .request(LEADER, () => {
        this.#leader = true;
        void this.sync();
        // Held for as long as the page is there.
        return new Promise<void>(() => {});
      })
      .catch(() => {});
  }

  async #follow(): Promise<void> {
    const snapshot = this.#options.account?.getSnapshot();
    if (!snapshot || snapshot.status === "unknown") return;
    const id = snapshot.status === "signedIn" ? snapshot.id : undefined;
    if (this.#scope !== undefined && this.#scope !== id) await this.#leave(this.#scope);
    if (id === undefined) {
      this.#setScope(undefined);
      return;
    }
    if (this.#scope === id) return;
    if (isState(await this.#base.load(stateKey(id)))) {
      await this.#base.save(SCOPE, id);
      this.#setScope(id);
      void this.sync();
      return;
    }
    await this.#begin(id);
  }

  /**
   * The first time on this device for an account: people are told the settings and keys go to the
   * platform, and asked whether this device's go into the account.
   */
  async #begin(account: string): Promise<void> {
    if (this.#asking === account) return;
    this.#set({ status: "waiting" });
    this.#asking = account;
    try {
      const remote = await this.#options.access!.read();
      if (!("entries" in remote)) return;
      if (remote.account !== account) return;
      const device = entriesOfSettings(await this.#base.load(SETTINGS).catch(() => undefined));
      const services = [...(device?.keys() ?? [])].filter((name) => name.startsWith("service:"));
      const accountServices = Object.entries(remote.entries).filter(
        ([name, entry]) => name.startsWith("service:") && !entry.deleted,
      ).length;
      // Turned off for the account: nothing goes anywhere, so there is nothing to tell.
      const answer = remote.enabled
        ? await (this.#options.ask?.({ services: services.length, accountServices }) ?? "skip")
        : "put";
      if (answer === undefined) return;
      // Another window may have been answered meanwhile.
      if (isState(await this.#base.load(stateKey(account)))) {
        await this.#base.save(SCOPE, account);
        this.#setScope(account);
        return;
      }
      const added = await this.#lock(account, async () => {
        const state = newState(remote.enabled);
        await this.#merge(account, state, remote);
        const names = answer === "put" ? await this.#putDevice(account, state) : [];
        await this.#writeState(account, state);
        return names;
      });
      await this.#base.save(SCOPE, account);
      this.#setScope(account);
      if (added.length > 0) this.#options.added?.(added);
      void this.sync();
    } catch (error) {
      console.warn("The AI settings could not start to go with the account", error);
      this.#set({ status: "failed" });
    } finally {
      this.#asking = undefined;
    }
  }

  /**
   * Puts this device's settings and keys into the account, under what the account has: a service
   * of the same kind at the same address is the account's, and an entry the account has already
   * stays as it has it. Resolves to the names of the services that went in.
   */
  async #putDevice(account: string, state: SyncState): Promise<string[]> {
    const device = entriesOfSettings(await this.#base.load(SETTINGS).catch(() => undefined));
    const packs = entriesOfPacks(await this.#base.load(PACKS).catch(() => undefined));
    const same = new Map<string, string>();
    const theirs = Object.entries(state.entries).flatMap(([name, entry]) =>
      name.startsWith("service:") && !entry.deleted && isRecord(entry.value) ? [entry.value] : [],
    );
    const added: string[] = [];
    // Older than anything the account has, so that what it has stays.
    const at = 1;
    for (const [name, value] of [...(device ?? []), ...packs]) {
      if (name.startsWith("service:") && isRecord(value)) {
        const twin = theirs.find(
          (other) => other.kind === value.kind && other.baseUrl === value.baseUrl,
        );
        if (twin && typeof twin.id === "string" && typeof value.id === "string") {
          same.set(value.id, twin.id);
          continue;
        }
        if (typeof value.name === "string") added.push(value.name);
      }
      if (name === "order") {
        const order = Array.isArray(state.entries.order?.value) ? state.entries.order.value : [];
        const mine = (value as unknown[]).filter((id) => typeof id === "string" && !same.has(id));
        this.#change(state, "order", [...new Set([...order, ...mine])], this.#now());
        continue;
      }
      if (state.entries[name]) continue;
      state.entries[name] = { at, value };
      state.pending.push(name);
    }
    const keys = this.#accountKeys.of(account);
    for (const service of await this.#options.keys.list().catch(() => [])) {
      const target = same.get(service) ?? service;
      if (state.keys[target] && !state.keys[target].deleted) continue;
      const key = await this.#options.keys.read(service).catch(() => undefined);
      if (key === undefined) continue;
      await keys.write(target, key);
      state.keys[target] = { at };
      state.pendingKeys.push(target);
    }
    await this.#writeDocs(account, state);
    return added;
  }

  /** Lets go of an account on this device, as people sign out of it or into another one. */
  async #leave(account: string): Promise<void> {
    await this.#lock(account, async () => {
      const state = await this.#readState(account);
      // What this device changed that the platform does not have yet stays, for the next time
      // people sign in to it here: it is theirs, and nothing of it shows to anyone else.
      if (
        !state ||
        (state.enabled && state.pending.length === 0 && state.pendingKeys.length === 0)
      ) {
        for (const key of [SETTINGS, LATEST, PACKS])
          await this.#base.remove?.(scopedKey(key, account));
        await this.#base.remove?.(stateKey(account));
        await this.#accountKeys.forget(account);
      }
    });
    // Other windows hear of it, and ask who is signed in.
    await this.#base.save(SCOPE, null);
  }

  /** Gives the platform what changed here before people sign out: it is let go of then. */
  async beforeSignOut(): Promise<void> {
    if (this.#scope === undefined) return;
    await Promise.race([
      this.sync().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  async #lock<T>(account: string, work: () => Promise<T>): Promise<T> {
    const locks = (this.#options.locks ?? (() => globalThis.navigator?.locks))();
    const name = `animaquill.ai-sync@${account}`;
    if (!locks) return (await this.#pageLock(name, work)) as T;
    return (await locks.request(name, work)) as T;
  }

  async #readState(account: string): Promise<SyncState | undefined> {
    const value = await this.#base.load(stateKey(account)).catch(() => undefined);
    return isState(value) ? structuredClone(value) : undefined;
  }

  async #writeState(account: string, state: SyncState): Promise<void> {
    await this.#base.save(stateKey(account), state);
    if (account === this.#scope) this.#showState(state);
  }

  /** An entry changed here at `at`, after whatever this browser has of it. */
  #change(state: SyncState, name: string, value: unknown, at: number, deleted = false): void {
    const before = state.entries[name];
    const time = Math.max(at, (before?.at ?? 0) + 1);
    state.entries[name] = deleted ? { at: time, deleted: true } : { at: time, value };
    if (!state.pending.includes(name)) state.pending.push(name);
    if (state.refused?.includes(name))
      state.refused = state.refused.filter((each) => each !== name);
  }

  /**
   * What a window saves of the account's settings under `key`, after it read `seen`: what it
   * changed goes into the entries, and the settings saved are the entries then, which can have
   * what it had not heard of yet. Resolves to those, where they differ from what it saved.
   */
  async saveScoped(key: string, value: unknown, seen: unknown): Promise<unknown> {
    const account = this.#scope;
    if (account === undefined || (key !== SETTINGS && key !== PACKS)) {
      await this.#base.save(scopedKey(key, account), value);
      return undefined;
    }
    const result = await this.#lock(account, async () => {
      const after = entriesOf(key, value);
      const state = await this.#readState(account);
      // The account was let go of on this browser, as another window signed out: nothing of it is
      // written here again.
      if (!state) return undefined;
      if (!after) {
        await this.#base.save(scopedKey(key, account), value);
        return undefined;
      }
      const before =
        entriesOf(key, seen ?? (await this.#base.load(scopedKey(key, account)))) ?? new Map();
      const { changed, removed } = entryChanges(before, after);
      const at = this.#now();
      for (const [name, next] of changed) this.#change(state, name, next, at);
      for (const name of removed)
        if (state.entries[name] && !state.entries[name].deleted)
          this.#change(state, name, undefined, at, true);
      await this.#writeState(account, state);
      const merged = materialize(state, key);
      const same = sameEntries(entriesOf(key, merged) ?? new Map(), after);
      await this.#base.save(scopedKey(key, account), same ? value : merged);
      return same ? undefined : merged;
    });
    this.#schedulePush();
    return result;
  }

  /** Whether the settings of an account are on this browser: not once it was let go of. */
  async holds(account: string): Promise<boolean> {
    return (await this.#readState(account)) !== undefined;
  }

  /** A key of the account's changed here. */
  async keyChanged(account: string, service: string, deleted: boolean): Promise<void> {
    await this.#lock(account, async () => {
      const state = await this.#readState(account);
      if (!state) return;
      const before = state.keys[service];
      const at = Math.max(this.#now(), (before?.at ?? 0) + 1);
      state.keys[service] = deleted ? { at, deleted: true } : { at };
      if (!state.pendingKeys.includes(service)) state.pendingKeys.push(service);
      await this.#writeState(account, state);
    });
    this.#schedulePush();
  }

  /** Writes the settings of the account as the entries have them, and has this page take them. */
  async #writeDocs(account: string, state: SyncState): Promise<void> {
    for (const key of [SETTINGS, PACKS]) {
      const saved = await this.#base.load(scopedKey(key, account)).catch(() => undefined);
      const merged = materialize(state, key);
      if (
        saved !== undefined &&
        sameEntries(entriesOf(key, saved) ?? new Map(), entriesOf(key, merged)!)
      )
        continue;
      await this.#base.save(scopedKey(key, account), merged);
      if (account === this.#scope) this.settings.deliver(key, merged);
    }
  }

  /**
   * Takes what the platform has, entry by entry: the later wins, and what was changed here later
   * stays, to be given. What this browser has that the platform does not, as after people turned
   * it off and on again, is given again; what was taken away long ago is forgotten.
   */
  async #merge(account: string, state: SyncState, remote: AccountAiSettings): Promise<void> {
    const pending = new Set(state.pending);
    for (const [name, entry] of Object.entries(remote.entries)) {
      const mine = state.entries[name];
      if (mine && pending.has(name) && isLaterEntry(entry, mine)) continue;
      state.entries[name] = entry;
      pending.delete(name);
    }
    const refused = new Set(state.refused);
    for (const [name, entry] of Object.entries(state.entries)) {
      if (name in remote.entries) continue;
      if (entry.deleted) {
        if (!pending.has(name)) delete state.entries[name];
      } else if (!refused.has(name)) pending.add(name);
    }
    state.pending = [...pending];

    const keys = this.#accountKeys.of(account);
    const pendingKeys = new Set(state.pendingKeys);
    for (const [service, entry] of Object.entries(remote.keys)) {
      const mine = state.keys[service];
      if (mine && pendingKeys.has(service) && isLaterEntry(entry, mine)) continue;
      if (entry.deleted) {
        await keys.remove(service);
        state.keys[service] = { at: entry.at, deleted: true };
      } else {
        if ((await keys.read(service)) !== entry.key) await keys.write(service, entry.key);
        state.keys[service] = { at: entry.at };
      }
      pendingKeys.delete(service);
    }
    for (const [service, entry] of Object.entries(state.keys)) {
      if (service in remote.keys) continue;
      if (entry.deleted) {
        if (!pendingKeys.has(service)) delete state.keys[service];
      } else pendingKeys.add(service);
    }
    state.pendingKeys = [...pendingKeys];
    state.revision = remote.revision;
    state.enabled = remote.enabled;
    await this.#writeDocs(account, state);
  }

  #schedulePush(): void {
    if (!this.#leader || this.#scope === undefined) return;
    clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => void this.sync(), PUSH_MS);
  }

  #schedulePull(ms: number): void {
    clearTimeout(this.#pullTimer);
    if (this.#leader) this.#pullTimer = setTimeout(() => void this.sync(), ms);
  }

  /** Reads what the platform has and gives it what changed here, once at a time. */
  sync(): Promise<void> {
    this.#syncing ??= this.#sync().finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }

  async #sync(): Promise<void> {
    const account = this.#scope;
    const access = this.#options.access;
    if (account === undefined || !access) return;
    clearTimeout(this.#pushTimer);
    const before = await this.#readState(account);
    if (!before) return;
    let retry = PULL_MS;
    try {
      {
        // Everything where it is off here, or went wrong: whether it is on again, and what is
        // there; else only whether anything changed.
        const whole = before.problem !== undefined || !before.enabled;
        const remote = await access.read(whole ? undefined : before.revision);
        if (remote.account !== account) throw new CloudOtherAccount("Somebody else is signed in");
        await this.#lock(account, async () => {
          const state = await this.#readState(account);
          if (!state) return;
          if ("entries" in remote) {
            if (remote.format > AI_SYNC_FORMAT) {
              state.problem = "newer";
              await this.#writeState(account, state);
              return;
            }
            const wasOff = !state.enabled;
            await this.#merge(account, state, remote);
            // Turned on again elsewhere: what this device has goes too.
            if (wasOff && remote.enabled) this.#giveAll(state);
          } else state.enabled = remote.enabled;
          delete state.problem;
          await this.#writeState(account, state);
        });
      }
      await this.#push(account, false);
      await this.#lock(account, async () => {
        const state = await this.#readState(account);
        if (!state) return;
        state.syncedAt = this.#now();
        await this.#writeState(account, state);
      });
    } catch (error) {
      retry = RETRY_MS;
      await this.#failed(account, error);
    } finally {
      this.#schedulePull(retry);
    }
  }

  /** Every entry and key that is there goes as changed. */
  #giveAll(state: SyncState): void {
    state.pending = Object.keys(state.entries).filter((name) => !state.entries[name]!.deleted);
    state.pendingKeys = Object.keys(state.keys).filter((service) => !state.keys[service]!.deleted);
  }

  /** Gives the platform what changed here, in batches; `enable` turns it on again. */
  async #push(account: string, enable: boolean): Promise<void> {
    const access = this.#options.access!;
    const keys = this.#accountKeys.of(account);
    // A batch at a time, as long as there is more; never for good, whatever the platform says.
    for (let round = 0; round < 50; round += 1) {
      const state = await this.#readState(account);
      if (!state || (!state.enabled && !enable)) return;
      if (state.pending.length === 0 && state.pendingKeys.length === 0 && !enable) return;
      const entries = state.pending.slice(0, AI_SYNC_BATCH).flatMap((name) => {
        const entry = state.entries[name];
        return entry ? [{ name, ...entry }] : [];
      });
      const given = (
        await Promise.all(
          state.pendingKeys.slice(0, AI_SYNC_KEYS).map(async (service) => {
            const entry = state.keys[service];
            if (!entry) return undefined;
            if (entry.deleted) return { service, at: entry.at, deleted: true as const };
            const key = await keys.read(service);
            return key === undefined
              ? { service, at: entry.at, deleted: true as const }
              : { service, at: entry.at, key };
          }),
        )
      ).filter((each) => each !== undefined);
      const answer = await access.change({
        account,
        entries,
        keys: given,
        ...(enable && { enable: true }),
      });
      if (answer.state.account !== account)
        throw new CloudOtherAccount("Somebody else is signed in");
      enable = false;
      await this.#lock(account, async () => {
        const after = await this.#readState(account);
        if (!after) return;
        if (answer.refused.length > 0)
          after.refused = [...new Set([...(after.refused ?? []), ...answer.refused])];
        await this.#merge(account, after, answer.state);
        // What the platform took, or refused, is no longer to be given, unless it changed here
        // meanwhile: refused, it stays on this device only.
        const sentAt = new Map(entries.map((entry) => [entry.name, entry.at]));
        const keyAt = new Map(given.map((key) => [key.service, key.at]));
        after.pending = after.pending.filter((name) => {
          const at = sentAt.get(name);
          return at === undefined || (after.entries[name]?.at ?? 0) > at;
        });
        after.pendingKeys = after.pendingKeys.filter((service) => {
          const at = keyAt.get(service);
          return at === undefined || (after.keys[service]?.at ?? 0) > at;
        });
        delete after.problem;
        await this.#writeState(account, after);
      });
    }
  }

  async #failed(account: string, error: unknown): Promise<void> {
    if (error instanceof CloudSignedOut || error instanceof CloudOtherAccount) {
      await this.#options.account?.refresh();
      return;
    }
    const problem: SyncState["problem"] | "off" =
      error instanceof AiSyncOff
        ? "off"
        : error instanceof AiSyncNewer
          ? "newer"
          : error instanceof AiSyncTooLarge
            ? "tooLarge"
            : globalThis.navigator?.onLine === false
              ? "offline"
              : "failed";
    if (problem === "failed") console.warn("The AI settings could not go with the account", error);
    await this.#lock(account, async () => {
      const state = await this.#readState(account);
      if (!state) return;
      if (problem === "off") {
        state.enabled = false;
        delete state.problem;
      } else state.problem = problem;
      await this.#writeState(account, state);
    });
  }

  /** Tries again now, after something went wrong. */
  retry(): void {
    if (this.#leader) void this.sync();
    else this.#channel?.postMessage("pull");
  }

  /**
   * Turns the settings going with the account on or off, for all devices. Off, the platform keeps
   * nothing of them, keys included; this device keeps what it has. On again, what this device has
   * goes, merged with what another device that turned it on before gave.
   */
  async setEnabled(on: boolean): Promise<void> {
    const account = this.#scope;
    const access = this.#options.access;
    if (account === undefined || !access) return;
    if (!on) {
      await access.turnOff(account);
      await this.#lock(account, async () => {
        const state = await this.#readState(account);
        if (!state) return;
        state.enabled = false;
        delete state.problem;
        await this.#writeState(account, state);
      });
      return;
    }
    await this.#lock(account, async () => {
      const state = await this.#readState(account);
      if (!state) return;
      this.#giveAll(state);
      await this.#writeState(account, state);
    });
    try {
      await this.#push(account, true);
      await this.sync();
    } catch (error) {
      await this.#failed(account, error);
      throw error;
    }
  }

  dispose(): void {
    clearTimeout(this.#pullTimer);
    clearTimeout(this.#pushTimer);
    this.#channel?.close();
    this.#stopState?.();
  }
}

/**
 * The settings of whoever's they are now, see `AiSync`: of this device, or of the account. As the
 * account changes, everything listening hears the settings of the other one.
 */
export class ScopedSettings implements SettingsStore {
  readonly #sync: AiSync;
  /** What this page last read or wrote under each key that goes with the account. */
  readonly #seen = new Map<string, unknown>();
  readonly #listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly #stops = new Map<string, () => void>();

  constructor(sync: AiSync) {
    this.#sync = sync;
  }

  async load(key: string): Promise<unknown> {
    await this.#sync.ready;
    const value = await this.#sync.base.load(scopedKey(key, this.#sync.scope));
    if (SCOPED.has(key)) this.#seen.set(key, value);
    return value;
  }

  async save(key: string, value: unknown): Promise<void> {
    await this.#sync.ready;
    if (!SCOPED.has(key) || this.#sync.scope === undefined) {
      await this.#sync.base.save(scopedKey(key, this.#sync.scope), value);
      return;
    }
    const merged = await this.#sync.saveScoped(key, value, this.#seen.get(key));
    this.#seen.set(key, merged ?? value);
    if (merged !== undefined) this.#tell(key, merged);
  }

  async remove(key: string): Promise<void> {
    await this.#sync.base.remove?.(scopedKey(key, this.#sync.scope));
  }

  listen(key: string, listener: (value: unknown) => void): () => void {
    let listeners = this.#listeners.get(key);
    if (!listeners) {
      this.#listeners.set(key, (listeners = new Set()));
      this.#follow(key);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  #follow(key: string): void {
    this.#stops.get(key)?.();
    this.#stops.set(
      key,
      this.#sync.base.listen(scopedKey(key, this.#sync.scope), (value) => {
        if (SCOPED.has(key)) this.#seen.set(key, value);
        this.#tell(key, value);
      }),
    );
  }

  #tell(key: string, value: unknown): void {
    for (const listener of this.#listeners.get(key) ?? []) listener(structuredClone(value));
  }

  /** What the sync wrote of the settings of the account in use, for this page to take. */
  deliver(key: string, value: unknown): void {
    this.#seen.set(key, value);
    this.#tell(key, value);
  }

  /** The account changed: everything listening hears the settings of the other one. */
  scopeChanged(): void {
    for (const key of this.#listeners.keys()) {
      if (!SCOPED.has(key)) continue;
      this.#follow(key);
      void this.#sync.base
        .load(scopedKey(key, this.#sync.scope))
        .catch(() => undefined)
        .then((value) => {
          this.#seen.set(key, value);
          const told = value ?? emptyOf(key);
          if (told !== undefined) this.#tell(key, told);
        });
    }
  }
}

/** The keys of whoever's the settings are now: of this device, or of the account. */
export class ScopedKeys implements KeyStore {
  readonly #sync: AiSync;
  readonly #device: KeyStore;
  readonly #accounts: AccountKeys;

  constructor(sync: AiSync, device: KeyStore, accounts: AccountKeys) {
    this.#sync = sync;
    this.#device = device;
    this.#accounts = accounts;
  }

  get #now(): KeyStore {
    const account = this.#sync.scope;
    return account === undefined ? this.#device : this.#accounts.of(account);
  }

  get where(): string | undefined {
    return this.#now.where;
  }

  read(service: string): Promise<string | undefined> {
    return this.#now.read(service);
  }

  list(): Promise<readonly string[]> {
    return this.#now.list();
  }

  async write(service: string, key: string): Promise<void> {
    const account = this.#sync.scope;
    if (account !== undefined && !(await this.#sync.holds(account)))
      throw new Error("The account was signed out of in another window");
    await this.#now.write(service, key);
    if (account !== undefined) await this.#sync.keyChanged(account, service, false);
  }

  async remove(service: string): Promise<void> {
    const account = this.#sync.scope;
    await this.#now.remove(service);
    if (account !== undefined) await this.#sync.keyChanged(account, service, true);
  }

  async clear(): Promise<void> {
    for (const service of await this.list()) await this.remove(service);
  }

  scopeChanged(): void {}
}
