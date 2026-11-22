import {
  EMPTY_AI_SETTINGS,
  canonical,
  keyIntoHeader,
  readAiSettings,
  withSecrets,
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
  AI_SYNC_MODELS_FORMAT,
  AI_SYNC_SECRETS_FORMAT,
  AiSyncNewer,
  AiSyncTooLarge,
  CloudOtherAccount,
  CloudSignedOut,
  SECRET_FIELDS,
  isLaterEntry,
  memoryAccountKeys,
  mergeSecret,
  type AccountAccess,
  type AccountAiSettings,
  type AccountKeys,
  type AiEntry,
  type AiSyncAccess,
  type KeyStore,
  type SecretField,
  type SecretTimes,
  type ServiceSecret,
  type SettingsStore,
  scoped,
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
 *
 * Whether they go with the account is up to this device (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 9.2): turned off here (`setEnabled`), this device neither gives nor takes
 * anything, and keeps the account's as it has them; the platform and other devices go on as ever.
 * Turned on again, they are merged entry by entry, as the first time. As people sign in with it on,
 * this device's own settings (those of before signing in) go into the account's where they changed
 * since they last did (`deviceMerged`).
 */

/** What the settings store and the model packs keep under, which go with the account. */
const SETTINGS = "ai";
const LATEST = "ai.latest";
const PACKS = "ai.packs";
const SCOPED = new Set([SETTINGS, LATEST, PACKS]);
/** The account whose settings were in use last, so that a reload starts with them. */
const SCOPE = "ai.scope";
const stateKey = (account: string) => `ai.sync@${account}`;
/**
 * When this device's settings, as they were then (`print`), went into the account's: kept as
 * people sign out, for the page of the cloud features to say so.
 */
const mergedKey = (account: string) => `device.merged@${account}`;
/**
 * What this device's settings were as this editor first saw them (`print`), for accounts they
 * never went into: they changed since only where they differ from it, see `#changedFor`.
 */
const BASELINE = "device.baseline";
/** What a print is of: the settings with what is secret of each service, as of 0.3.72. */
const PRINT_VERSION = 2;

/** A short sum of a text, to tell whether it changed: FNV-1a. */
const sumOf = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};
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
  keys: Record<string, { at: number; deleted?: true; fields?: SecretTimes }>;
  /** Entries, and keys by service, changed here that the platform does not have yet. */
  pending: string[];
  pendingKeys: string[];
  /** What the platform said last. */
  revision: number;
  /** The format the platform has them in, as it said last: what is given is never lower. */
  format?: number;
  /** They go with the account on this device: people can turn it off here. */
  enabled: boolean;
  /** When everything was last in step with the platform. */
  syncedAt?: number;
  /** What went wrong last, for every window to show. */
  problem?: "offline" | "failed" | "newer" | "tooLarge";
  /** Entries the platform did not take, which stay on this device until they change here. */
  refused?: string[];
  /** Of those, the ones it did not take as the settings would be too large with them. */
  tooLarge?: string[];
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
  /** Signed in, and people did not answer the welcome yet, see `AiSyncOptions.ask`. */
  | "waiting"
  | "syncing"
  | "synced"
  /** Changes wait for the platform to be reachable. */
  | "offline"
  | "failed"
  /** Turned off on this device. */
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

/** How much there is of AI settings: services, the models enabled of them, installed packs. */
export interface AiCounts {
  readonly services: number;
  readonly models: number;
  readonly packs: number;
}

/**
 * What the welcome says, as the settings start to go with an account on this device for the first
 * time, see `AiSyncOptions.ask`.
 */
export interface AiSyncQuestion {
  readonly account: string;
  /** What this device has, which goes into the account. */
  readonly device: AiCounts;
  /** How many keys this device has, which go with them. */
  readonly deviceKeys: number;
  /** How many services the account has already. */
  readonly accountServices: number;
}

/**
 * What came of asking: whether the settings go with the account on this device (`on`), and
 * whether this device's go into the account's (`put`), which they do also while off, as this
 * device's copy of it. Where they do not, they still do while on where they changed since they
 * last did (`deviceMerged`). "elsewhere": another window of this browser answered, and starts them.
 */
export type AiSyncAnswer = { readonly on: boolean; readonly put: boolean } | "elsewhere";

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
   * Before the settings of an account start to go with it on this device: nothing goes anywhere
   * until it resolves, undefined asking again another time. Without it, they go, and this
   * device's go into them.
   */
  readonly ask?: (question: AiSyncQuestion) => Promise<AiSyncAnswer | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the settings are while there are none. */
const emptyOf = (key: string): unknown =>
  key === SETTINGS ? writeAiSettings(EMPTY_AI_SETTINGS) : key === PACKS ? { packs: [] } : undefined;

/** Whether there is anything at all. */
const hasAnyCounts = (counts: AiCounts): boolean =>
  counts.services > 0 || counts.models > 0 || counts.packs > 0;

/** How much there is of AI settings as saved, and of packs as saved. */
export function countsOf(settings: unknown, packs: unknown): AiCounts {
  const entries = entriesOfSettings(settings);
  let services = 0;
  let models = 0;
  for (const [name, value] of entries ?? []) {
    if (!name.startsWith("service:")) continue;
    services += 1;
    if (isRecord(value) && Array.isArray(value.enabled)) models += value.enabled.length;
  }
  return { services, models, packs: entriesOfPacks(packs).size };
}

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
  #beginAgain: ReturnType<typeof setTimeout> | undefined;
  #refollow: (() => void) | undefined;
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
            // What this device's settings are before anything here changes them, see `#changedFor`.
            await this.#baseline(await this.#devicePrint());
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
        ((state.tooLarge?.length ?? 0) > 0
          ? "tooLarge"
          : state.pending.length + state.pendingKeys.length > 0
            ? "syncing"
            : "synced"));
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
    this.#refollow = follow;
    follow();
    // Another window let go of an account, or took one on: who is signed in may have changed.
    this.#base.listen(SCOPE, () => void account.refresh());
    this.#lead();
    if (typeof BroadcastChannel === "function") {
      this.#channel = new BroadcastChannel(scoped(CHANNEL));
      this.#channel.addEventListener("message", () => {
        if (this.#leader) void this.sync();
      });
    }
    if (typeof addEventListener === "function") {
      const ping = () => {
        // Starting for an account that could not, as the platform could not be reached.
        if (this.#scope === undefined && this.#asking === undefined) follow();
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
      .request(scoped(LEADER), () => {
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
    const kept = await this.#base.load(stateKey(id));
    if (isState(kept)) {
      await this.#base.save(SCOPE, id);
      this.#setScope(id);
      if (kept.enabled) await this.#mergeChanged();
      void this.sync();
      return;
    }
    await this.#begin(id);
  }

  /** This device's settings go into the account's in use, where they changed since they last did. */
  async #mergeChanged(): Promise<void> {
    const account = this.#scope;
    if (account === undefined || !(await this.#changedFor(account))) return;
    await this.mergeDevice().catch((error: unknown) =>
      console.warn("The AI settings of this device could not go into the account", error),
    );
  }

  /**
   * Whether this device's settings, of before signing in, changed since they last went into an
   * account, or, where they never did, since this editor first saw them: what was there then had
   * its chance (it was not put in, as people said), and only what they changed since goes in, so
   * that a service taken away on another device does not come back as people sign in again.
   */
  async #changedFor(account: string): Promise<boolean> {
    if (!hasAnyCounts(await this.deviceCounts())) return false;
    const print = await this.#devicePrint();
    const kept = (await this.#base.load(mergedKey(account)).catch(() => undefined)) as
      { print?: unknown; version?: unknown } | undefined;
    if (kept?.version === PRINT_VERSION) return kept.print !== print;
    const baseline = await this.#baseline(print);
    return baseline !== print;
  }

  /** What this device's settings were as this editor first saw them, noted the first time. */
  async #baseline(print: string): Promise<string> {
    const kept = (await this.#base.load(BASELINE).catch(() => undefined)) as
      { print?: unknown } | undefined;
    if (typeof kept?.print === "string") return kept.print;
    await this.#base.save(BASELINE, { at: this.#now(), print }).catch(() => {});
    return print;
  }

  /**
   * The first time on this browser for an account, or since it was let go of: nothing goes until
   * people answered, see `AiSyncOptions.ask`. Then the account's are merged in, and this device's
   * put into them where people said so; the platform is told where they turned it on or off.
   */
  async #begin(account: string): Promise<void> {
    if (this.#asking === account) return;
    this.#set({ status: "waiting" });
    this.#asking = account;
    clearTimeout(this.#beginAgain);
    try {
      const remote = await this.#options.access!.read();
      if (!("entries" in remote)) return;
      if (remote.account !== account) return;
      const accountServices = Object.entries(remote.entries).filter(
        ([name, entry]) => name.startsWith("service:") && !entry.deleted,
      ).length;
      const answer = this.#options.ask
        ? await this.#options.ask({
            account,
            device: await this.deviceCounts(),
            deviceKeys: await this.#deviceKeys(),
            accountServices,
          })
        : { on: true, put: true };
      if (answer === undefined) return;
      if (answer === "elsewhere" || (await this.holds(account))) {
        // Another window answered: it starts them, and this one takes them as they are there.
        await this.#whenHeld(account);
        await this.#base.save(SCOPE, account);
        this.#setScope(account);
        void this.sync();
        return;
      }
      const put = answer.put || (answer.on && (await this.#changedFor(account)));
      await this.#lock(account, async () => {
        if (await this.#readState(account)) return;
        const state = newState(answer.on);
        // Off: this device keeps what it has, and nothing of the account's is taken here.
        if (answer.on) await this.#merge(account, state, remote);
        if (put && hasAnyCounts(await this.deviceCounts())) await this.#putDevice(account, state);
        await this.#writeState(account, state);
      });
      await this.#base.save(SCOPE, account);
      this.#setScope(account);
      void this.sync();
    } catch (error) {
      console.warn("The AI settings could not start to go with the account", error);
      this.#set({ status: globalThis.navigator?.onLine === false ? "offline" : "failed" });
      // Again a while later, and as the window comes back or the browser goes online.
      this.#beginAgain = setTimeout(() => this.#refollow?.(), RETRY_MS);
    } finally {
      this.#asking = undefined;
    }
  }

  /** Resolves once the settings of an account are on this browser, as another window starts them. */
  #whenHeld(account: string): Promise<void> {
    return new Promise((resolve) => {
      let stop: (() => void) | undefined;
      const check = async () => {
        if (!(await this.holds(account))) return;
        stop?.();
        stop = undefined;
        resolve();
      };
      stop = this.#base.listen(stateKey(account), () => void check());
      void check();
    });
  }

  /** How many keys this device has, of those used while nobody is signed in. */
  async #deviceKeys(): Promise<number> {
    let count = 0;
    for (const service of await this.#options.keys.list().catch(() => []))
      if ((await this.#options.keys.read(service).catch(() => undefined))?.key) count += 1;
    return count;
  }

  /** What the settings of this device have, which go into an account as people say so. */
  async deviceCounts(): Promise<AiCounts> {
    const settings = await this.#base.load(SETTINGS).catch(() => undefined);
    const packs = await this.#base.load(PACKS).catch(() => undefined);
    return countsOf(settings, packs);
  }

  /** What the settings in use have. */
  async counts(): Promise<AiCounts> {
    const settings = await this.#base.load(scopedKey(SETTINGS, this.#scope)).catch(() => undefined);
    const packs = await this.#base.load(scopedKey(PACKS, this.#scope)).catch(() => undefined);
    return countsOf(settings, packs);
  }

  /**
   * Puts the settings and keys of this device into those of the account in use, as on the first
   * time, see `#putDevice`: what the account has stays. Resolves to the names of the services that
   * went in.
   */
  async mergeDevice(): Promise<readonly string[]> {
    const account = this.#scope;
    if (account === undefined) return [];
    const names = await this.#lock(account, async () => {
      const state = await this.#readState(account);
      if (!state) return [];
      const added = await this.#putDevice(account, state);
      await this.#writeState(account, state);
      return added;
    });
    this.#schedulePush();
    return names;
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
    const keys = this.#accountKeys.of(account);
    // Where a service is: in what is secret of it, or in it, as settings of before version 4 have it.
    const whereOf = async (service: Record<string, unknown>, store: KeyStore) => {
      const secret =
        typeof service.id === "string"
          ? await store.read(service.id).catch(() => undefined)
          : undefined;
      return secret?.baseUrl ?? (typeof service.baseUrl === "string" ? service.baseUrl : undefined);
    };
    const theirs: { value: Record<string, unknown>; baseUrl: string | undefined }[] = [];
    for (const [name, entry] of Object.entries(state.entries))
      if (name.startsWith("service:") && !entry.deleted && isRecord(entry.value))
        theirs.push({ value: entry.value, baseUrl: await whereOf(entry.value, keys) });
    const added: string[] = [];
    // Older than anything the account has, so that what it has stays.
    const at = 1;
    for (const [name, value] of [...(device ?? []), ...packs]) {
      if (name.startsWith("service:") && isRecord(value)) {
        const baseUrl = await whereOf(value, this.#options.keys);
        const twin = theirs.find(
          (other) => other.value.kind === value.kind && other.baseUrl === baseUrl,
        )?.value;
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
    for (const service of await this.#options.keys.list().catch(() => [])) {
      const target = same.get(service) ?? service;
      if (state.keys[target] && !state.keys[target].deleted) continue;
      const secret = await this.#options.keys.read(service).catch(() => undefined);
      if (secret === undefined) continue;
      await keys.write(target, secret);
      state.keys[target] = { at };
      state.pendingKeys.push(target);
    }
    await this.#writeDocs(account, state);
    await this.#base
      .save(mergedKey(account), {
        at: this.#now(),
        print: await this.#devicePrint(),
        version: PRINT_VERSION,
      })
      .catch(() => {});
    return added;
  }

  /**
   * What the settings and keys of this device are, in short, to tell whether they changed: the
   * settings as they are read, with what is secret of each service, so that the same settings
   * written another way (as settings of before version 4 go to version 4) are the same.
   */
  async #devicePrint(): Promise<string> {
    const saved = await this.#base.load(SETTINGS).catch(() => undefined);
    const packs = await this.#base.load(PACKS).catch(() => undefined);
    const secrets = new Map<string, ServiceSecret>();
    for (const service of (await this.#options.keys.list().catch(() => [])).toSorted()) {
      const secret = await this.#options.keys.read(service).catch(() => undefined);
      if (secret) secrets.set(service, secret);
    }
    const reading = readAiSettings(saved);
    // As the settings store would take them (settings.ts #taken): a key that goes into a header is no key.
    const held = (id: string) => {
      const secret = secrets.get(id);
      return secret?.baseUrl !== undefined || secret?.headers || secret?.models
        ? secret
        : undefined;
    };
    const services =
      reading.kind === "ok"
        ? withSecrets(reading.settings, held).services.map(({ secretAt: _at, ...service }) => {
            const header = reading.keyHeaders?.[service.id];
            const key = secrets.get(service.id)?.key;
            return header !== undefined && key !== undefined
              ? { ...service, headers: keyIntoHeader(service.headers, header, key) }
              : service;
          })
        : (saved ?? null);
    // The rest of what goes into the account too: the default model, how hard each reasons, the
    // packs chosen and the preferences of the chat.
    const {
      services: _services,
      kept: _kept,
      ...rest
    } = reading.kind === "ok" ? reading.settings : { services: undefined, kept: undefined };
    const settings = { services, ...rest };
    const keys = [...secrets].flatMap(([service, { key }]) =>
      key === undefined || (reading.kind === "ok" && reading.keyHeaders?.[service] !== undefined)
        ? []
        : [[service, key]],
    );
    return sumOf(canonical({ settings, packs: packs ?? null, keys }));
  }

  /**
   * When this device's settings went into the account in use, as they are now: undefined where they
   * never did, or changed since.
   */
  async deviceMerged(): Promise<number | undefined> {
    const account = this.#scope;
    if (account === undefined) return undefined;
    return this.deviceMergedFor(account);
  }

  /** The same, of an account, whether it is in use or not yet. */
  async deviceMergedFor(account: string): Promise<number | undefined> {
    const kept = (await this.#base.load(mergedKey(account)).catch(() => undefined)) as
      { at?: unknown; print?: unknown; version?: unknown } | undefined;
    if (
      typeof kept?.at !== "number" ||
      kept.version !== PRINT_VERSION ||
      kept.print !== (await this.#devicePrint())
    )
      return undefined;
    return kept.at;
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
    const name = scoped(`animaquill.ai-sync@${account}`);
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
    // What was too large goes again: changed itself, or with room made by taking something away.
    const again = deleted
      ? (state.tooLarge ?? [])
      : (state.tooLarge ?? []).filter((each) => each === name);
    if (again.length === 0) return;
    state.tooLarge = (state.tooLarge ?? []).filter((each) => !again.includes(each));
    state.refused = (state.refused ?? []).filter((each) => !again.includes(each));
    for (const each of again) if (!state.pending.includes(each)) state.pending.push(each);
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

  /**
   * The settings of this device saved, while nobody is signed in: with only what this window
   * changed since it last read them (`seen`) put onto what is saved now, entry by entry, so that
   * two windows that change different things at once both keep theirs (another service, another
   * model). Resolves to what was saved where that is not `value`, for the window to take.
   */
  async saveDevice(value: unknown, seen: unknown): Promise<unknown> {
    return this.#lock("~device", async () => {
      const after = entriesOfSettings(value);
      const now = await this.#base.load(SETTINGS).catch(() => undefined);
      const current = entriesOfSettings(now);
      const before = entriesOfSettings(seen);
      // Nothing else wrote meanwhile, or nothing that can be told apart entry by entry.
      if (!after || !before || !current || sameEntries(before, current)) {
        await this.#base.save(SETTINGS, value);
        return undefined;
      }
      const { changed, removed } = entryChanges(before, after);
      const merged = new Map(current);
      for (const [name, next] of changed) merged.set(name, next);
      for (const name of removed) merged.delete(name);
      if (sameEntries(merged, after)) {
        await this.#base.save(SETTINGS, value);
        return undefined;
      }
      const saved = settingsOfEntries(merged);
      await this.#base.save(SETTINGS, saved);
      return saved;
    });
  }

  /** Whether the settings of an account are on this browser: not once it was let go of. */
  async holds(account: string): Promise<boolean> {
    return (await this.#readState(account)) !== undefined;
  }

  /** A key of the account's changed here. */
  /**
   * What is secret of a service of the account's changed here: taken away, or these parts of it
   * (all where it is not said), each of which goes as changed on its own, see `mergeSecret`.
   */
  async keyChanged(
    account: string,
    service: string,
    deleted: boolean,
    changed: readonly SecretField[] = SECRET_FIELDS,
  ): Promise<void> {
    await this.#lock(account, async () => {
      const state = await this.#readState(account);
      if (!state) return;
      const before = state.keys[service];
      const at = Math.max(this.#now(), (before?.at ?? 0) + 1);
      const fields: Partial<Record<SecretField, number>> = {
        ...(before && !before.deleted && before.fields),
      };
      for (const field of changed) fields[field] = at;
      state.keys[service] = deleted ? { at, deleted: true } : { at, fields };
      if (!state.pendingKeys.includes(service)) state.pendingKeys.push(service);
      await this.#writeState(account, state);
    });
    this.#schedulePush();
  }

  /** Writes the settings of the account as the entries have them, and has this page take them. */
  async #writeDocs(account: string, state: SyncState, secretsChanged = false): Promise<void> {
    for (const key of [SETTINGS, PACKS]) {
      const saved = await this.#base.load(scopedKey(key, account)).catch(() => undefined);
      const merged = materialize(state, key);
      if (
        saved !== undefined &&
        sameEntries(entriesOf(key, saved) ?? new Map(), entriesOf(key, merged)!)
      ) {
        // What is secret of a service changed, and nothing else: this page reads it again.
        if (secretsChanged && key === SETTINGS && account === this.#scope)
          this.settings.deliver(key, saved);
        continue;
      }
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
    let secretsChanged = false;
    for (const [service, entry] of Object.entries(remote.keys)) {
      const mine = state.keys[service];
      // Changed here and there, each something of it: both, part by part.
      const local =
        mine && !mine.deleted && !entry.deleted && pendingKeys.has(service)
          ? await keys.read(service)
          : undefined;
      if (local && mine && !entry.deleted) {
        const merged = mergeSecret(
          { at: mine.at, secret: local, fieldsAt: mine.fields },
          { at: entry.at, secret: entry.secret, fieldsAt: entry.fieldsAt },
        );
        if (canonical(merged.secret) !== canonical(local)) {
          await keys.write(service, merged.secret);
          secretsChanged = true;
        }
        state.keys[service] = { at: merged.at, fields: merged.fieldsAt };
        const theirs = (field: SecretField) =>
          entry.fieldsAt ? (entry.fieldsAt[field] ?? 0) : entry.at;
        // Nothing of it newer here than there: the platform has it all.
        if (SECRET_FIELDS.every((field) => (merged.fieldsAt[field] ?? 0) <= theirs(field)))
          pendingKeys.delete(service);
        continue;
      }
      if (mine && pendingKeys.has(service) && isLaterEntry(entry, mine)) continue;
      if (entry.deleted) {
        await keys.remove(service);
        state.keys[service] = { at: entry.at, deleted: true };
        secretsChanged = true;
      } else {
        if (canonical((await keys.read(service)) ?? null) !== canonical(entry.secret)) {
          await keys.write(service, entry.secret);
          secretsChanged = true;
        }
        state.keys[service] = {
          at: entry.at,
          ...(entry.fieldsAt && { fields: entry.fieldsAt }),
        };
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
    await this.#writeDocs(account, state, secretsChanged);
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
    // Off on this device: nothing goes, and nothing comes.
    if (!before.enabled) {
      this.#showState(before);
      return;
    }
    let retry = PULL_MS;
    try {
      {
        // Everything where it went wrong, or was off; else only whether anything changed.
        const whole = before.problem !== undefined || before.revision < 0;
        const remote = await access.read(whole ? undefined : before.revision);
        if (remote.account !== account) throw new CloudOtherAccount("Somebody else is signed in");
        await this.#lock(account, async () => {
          const state = await this.#readState(account);
          if (!state?.enabled) return;
          if ("entries" in remote) {
            if (remote.format > AI_SYNC_FORMAT) {
              state.problem = "newer";
              await this.#writeState(account, state);
              return;
            }
            state.format = Math.max(state.format ?? 1, remote.format);
            await this.#merge(account, state, remote);
          }
          delete state.problem;
          await this.#writeState(account, state);
        });
      }
      await this.#push(account);
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
    state.pending = Object.keys(state.entries);
    state.pendingKeys = Object.keys(state.keys);
  }

  /** Gives the platform what changed here, in batches. */
  async #push(account: string): Promise<void> {
    const access = this.#options.access!;
    const keys = this.#accountKeys.of(account);
    // A batch at a time, as long as there is more; never for good, whatever the platform says.
    for (let round = 0; round < 50; round += 1) {
      const state = await this.#readState(account);
      if (!state?.enabled) return;
      if (state.pending.length === 0 && state.pendingKeys.length === 0) return;
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
            const secret = await keys.read(service);
            return secret === undefined
              ? { service, at: entry.at, deleted: true as const }
              : { service, at: entry.at, secret, ...(entry.fields && { fieldsAt: entry.fields }) };
          }),
        )
      ).filter((each) => each !== undefined);
      // Entries of models are of format 2: an editor before them would write the settings back
      // without them (AI_SYNC_MODELS_FORMAT), so from the first one, it leaves them alone. Services
      // without their address are of format 3, which an editor of format 2 cannot read.
      const models = Object.keys(state.entries).some((name) => name.startsWith("model:"));
      const secrets = Object.entries(state.entries).some(
        ([name, entry]) =>
          name.startsWith("service:") &&
          !entry.deleted &&
          isRecord(entry.value) &&
          entry.value.baseUrl === undefined,
      );
      const format = Math.max(
        state.format ?? 1,
        secrets ? AI_SYNC_SECRETS_FORMAT : models ? AI_SYNC_MODELS_FORMAT : 1,
      );
      const answer = await access.change({
        account,
        entries,
        keys: given,
        ...(format > 1 && { format }),
      });
      if (answer.state.account !== account)
        throw new CloudOtherAccount("Somebody else is signed in");
      await this.#lock(account, async () => {
        const after = await this.#readState(account);
        if (!after) return;
        const notTaken = [...answer.refused, ...answer.tooLarge];
        if (notTaken.length > 0)
          after.refused = [...new Set([...(after.refused ?? []), ...notTaken])];
        if (answer.tooLarge.length > 0)
          after.tooLarge = [...new Set([...(after.tooLarge ?? []), ...answer.tooLarge])];
        after.format = Math.max(after.format ?? 1, answer.state.format);
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
    const problem: SyncState["problem"] =
      error instanceof AiSyncNewer
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
      state.problem = problem;
      await this.#writeState(account, state);
    });
  }

  /** Tries again now, after something went wrong. */
  retry(): void {
    if (this.#leader) void this.sync();
    else this.#channel?.postMessage("pull");
  }

  /**
   * Turns the settings going with the account on or off, on this device. Off, nothing goes or comes
   * here any more, and this device keeps what it has; the platform and other devices go on as ever.
   * On again, what this device has and what the platform has are merged, entry by entry, the later
   * winning: everything goes as changed, and what the platform has comes.
   */
  async setEnabled(on: boolean): Promise<void> {
    const account = this.#scope;
    if (account === undefined || !this.#options.access) return;
    await this.#lock(account, async () => {
      const state = await this.#readState(account);
      if (!state) return;
      state.enabled = on;
      delete state.problem;
      // Whatever it had of the platform's is read again, whole.
      if (on) {
        state.revision = -1;
        this.#giveAll(state);
      }
      await this.#writeState(account, state);
    });
    if (on) await this.sync();
  }

  dispose(): void {
    clearTimeout(this.#beginAgain);
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
    // What this window had as it changed it: what another one writes meanwhile is not its change.
    const seen = this.#seen.get(key);
    await this.#sync.ready;
    if (key === SETTINGS && this.#sync.scope === undefined) {
      const merged = await this.#sync.saveDevice(value, seen);
      this.#seen.set(key, merged ?? value);
      if (merged !== undefined) this.#tell(key, merged);
      return;
    }
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

  read(service: string): Promise<ServiceSecret | undefined> {
    return this.#now.read(service);
  }

  list(): Promise<readonly string[]> {
    return this.#now.list();
  }

  async write(service: string, secret: ServiceSecret): Promise<void> {
    await this.update(service, () => secret);
  }

  async update(
    service: string,
    change: (before: ServiceSecret | undefined) => ServiceSecret | undefined,
  ): Promise<ServiceSecret | undefined> {
    const account = this.#sync.scope;
    if (account !== undefined && !(await this.#sync.holds(account)))
      throw new Error("The account was signed out of in another window");
    let changed: SecretField[] = [];
    const after = await this.#now.update(service, (before) => {
      const next = change(before);
      changed = SECRET_FIELDS.filter(
        (field) => canonical(before?.[field] ?? null) !== canonical(next?.[field] ?? null),
      );
      return next;
    });
    if (account !== undefined && changed.length > 0)
      await this.#sync.keyChanged(account, service, after === undefined, changed);
    return after;
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
