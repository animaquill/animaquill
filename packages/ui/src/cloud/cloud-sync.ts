import {
  CloudOtherAccount,
  CloudSignedOut,
  type AccountAccess,
  type CloudSwitchChanges,
  type CloudSwitches,
  type CloudSwitchesAccess,
  type SettingsStore,
} from "@animaquill/host";
import type { AiSync, AiSyncAnswer, AiSyncQuestion } from "../chat/ai-sync.ts";
import { Emitter } from "../workbench/emitter.ts";

/**
 * The cloud features that people turn on and off for their account (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 9): the AI settings (`AiSync`), the stars and
 * groups of the start page, the conversations about projects of the platform, and whether new
 * projects are of the platform by default. The platform keeps the switches, for all devices of the
 * account (`CloudSwitchesAccess`); this browser keeps the last it heard of them, so that they are
 * known as a page starts and while offline (`cloud@<account>`).
 *
 * The first time an account is signed in to in this browser, nothing of it goes anywhere until
 * people answered the welcome (`welcome`): the switches, each as the account has them, or on by
 * default; "开始使用" and "以后再说" both start them as they are then. What they answered is noted
 * (`welcome@<account>`), and the welcome does not come again for that account in this browser,
 * signed out and in again or not. An account whose AI settings went with it here before there was a
 * welcome (0.3.62) counts as answered, and is never asked.
 *
 * Turned off on another device, a feature stops here as this browser hears of it. As it was off,
 * the platform has nothing of it any more: what this browser took for the account's goes again
 * once it is on, see `CloudSwitches.organizerEpoch`.
 */

/** A feature that a switch here is of; "ai" is turned on and off by `AiSync`. */
export type CloudFeature = "ai" | "organizer" | "chats" | "newProjectsInCloud";

/** What the switches are, without whose. */
export type SwitchValues = Pick<CloudSwitches, CloudFeature>;

export const DEFAULT_SWITCHES: SwitchValues = {
  ai: true,
  organizer: true,
  chats: true,
  newProjectsInCloud: true,
};

/** The welcome, as it shows, see `CloudSync`. */
export interface WelcomeRequest {
  readonly account: string;
  /** What people know the account by. */
  readonly name: string;
  readonly question: AiSyncQuestion;
  /** What the switches start as: the account's, or the defaults where it has none yet. */
  readonly switches: SwitchValues;
  /** Answering went wrong, as the platform could not be reached: it stays, to try again. */
  readonly failed?: boolean;
  /** Being answered. */
  readonly answering?: boolean;
}

export type SwitchesStatus = "unknown" | "syncing" | "synced" | "offline" | "failed";

export interface CloudSyncSnapshot {
  /** There is a platform that keeps the switches. */
  readonly available: boolean;
  /** Who is signed in, by the id the platform knows them by. */
  readonly account: string | undefined;
  /** People answered the welcome for the account in this browser. */
  readonly welcomed: boolean;
  /** As the platform said last, or this browser heard last; undefined: not known yet. */
  readonly switches:
    (SwitchValues & Pick<CloudSwitches, "organizerEpoch" | "chatsEpoch">) | undefined;
  /** Whether the switches are as the platform has them. */
  readonly status: SwitchesStatus;
  /** A switch being changed. */
  readonly changing: CloudFeature | undefined;
  /** The welcome, while it is to show. */
  readonly welcome: WelcomeRequest | undefined;
}

export interface CloudSyncOptions {
  /** The settings of this browser, as the host keeps them: not those of the account. */
  readonly settings: SettingsStore;
  readonly access?: CloudSwitchesAccess | undefined;
  readonly account?: AccountAccess | undefined;
  readonly aiSync: AiSync;
  /**
   * The copy of the account's stars and groups is not on the platform any more: all of it goes
   * again, see `ProjectOrganizer.resend`.
   */
  readonly resendOrganizer?: (account: string) => Promise<void>;
  /** The same of the conversations, see `CloudChats.detach`. */
  readonly detachChats?: (account: string) => Promise<void>;
  /** A switch changed, or the welcome was answered: what it is of goes, or stops. */
  readonly changed?: () => void;
  readonly now?: () => number;
}

/** What this browser keeps of the switches of an account. */
interface Kept {
  readonly version: 1;
  readonly switches?: CloudSwitches;
  /** The epochs this browser has taken in, see `CloudSwitches.organizerEpoch`. */
  readonly seen?: { readonly organizer: number; readonly chats: number };
}

/** What people answered the welcome with, as this browser keeps it. */
interface Welcomed {
  readonly at: number;
  /** The switches as they were answered; missing where the account counted as answered. */
  readonly switches?: SwitchValues;
}

const keptKey = (account: string) => `cloud@${account}`;
const welcomeKey = (account: string) => `welcome@${account}`;
const PULL_MS = 5 * 60_000;

const isKept = (value: unknown): value is Kept =>
  typeof value === "object" && value !== null && (value as Kept).version === 1;
const isWelcomed = (value: unknown): value is Welcomed =>
  typeof value === "object" && value !== null && typeof (value as Welcomed).at === "number";

export class CloudSync {
  readonly #options: CloudSyncOptions;
  readonly #emitter = new Emitter();
  #snapshot: CloudSyncSnapshot;
  /** The welcome waits for this, for the account it is of. */
  #answer: ((answer: AiSyncAnswer | undefined) => void) | undefined;
  #stopWelcome: (() => void) | undefined;
  #pullTimer: ReturnType<typeof setTimeout> | undefined;
  /** The welcome, put off as the platform could not be reached: it comes again once it can. */
  #postponed: WelcomeRequest | undefined;
  #turn = 0;
  #following: Promise<void> = Promise.resolve();

  constructor(options: CloudSyncOptions) {
    this.#options = options;
    this.#snapshot = {
      available: options.access !== undefined && options.account !== undefined,
      account: undefined,
      welcomed: false,
      switches: undefined,
      status: "unknown",
      changing: undefined,
      welcome: undefined,
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): CloudSyncSnapshot => this.#snapshot;

  #set(changes: Partial<CloudSyncSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...changes };
    this.#emitter.emit();
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /**
   * Whether what a switch is of goes with the account now: people answered the welcome, and did
   * not turn it off. Nothing goes where there is no platform for the switches.
   */
  allows(feature: "organizer" | "chats", account: string | undefined): boolean {
    const { available, welcomed, switches } = this.#snapshot;
    if (!available) return true;
    if (account === undefined || account !== this.#snapshot.account || !welcomed) return false;
    return switches?.[feature] ?? true;
  }

  /** Whether new projects are of the platform by default, as people said for the account. */
  get newProjectsInCloud(): boolean {
    return this.#snapshot.switches?.newProjectsInCloud ?? true;
  }

  /** Resolves once who is signed in now is followed: whether they answered the welcome is known. */
  settled(): Promise<void> {
    return this.#following;
  }

  /** Starts following who is signed in. */
  start(): void {
    const { account } = this.#options;
    if (!this.#snapshot.available || !account) return;
    const follow = () => {
      this.#following = this.#following
        .then(() => this.#follow())
        .catch((error: unknown) =>
          console.warn("The cloud features could not follow the account", error),
        );
    };
    account.subscribe(follow);
    follow();
    if (typeof addEventListener === "function") {
      const again = () => void this.refresh();
      addEventListener("focus", again);
      addEventListener("online", again);
    }
  }

  async #follow(): Promise<void> {
    const snapshot = this.#options.account?.getSnapshot();
    if (!snapshot || snapshot.status === "unknown") return;
    const id = snapshot.status === "signedIn" ? snapshot.id : undefined;
    if (id === this.#snapshot.account) return;
    this.#turn += 1;
    this.#stopWelcome?.();
    this.#stopWelcome = undefined;
    clearTimeout(this.#pullTimer);
    if (this.#snapshot.welcome || this.#postponed) this.#answer?.(undefined);
    this.#answer = undefined;
    this.#postponed = undefined;
    if (id === undefined) {
      this.#set({
        account: undefined,
        welcomed: false,
        switches: undefined,
        status: "unknown",
        welcome: undefined,
      });
      this.#options.changed?.();
      return;
    }
    const { settings } = this.#options;
    const kept = await settings.load(keptKey(id)).catch(() => undefined);
    let welcomed = isWelcomed(await settings.load(welcomeKey(id)).catch(() => undefined));
    // Its AI settings went with it here before there was a welcome: it was answered then.
    if (!welcomed && (await this.#options.aiSync.holds(id))) {
      await settings.save(welcomeKey(id), { at: this.#now() } satisfies Welcomed);
      welcomed = true;
    }
    this.#set({
      account: id,
      welcomed,
      switches: isKept(kept) ? kept.switches : undefined,
      status: "unknown",
      welcome: undefined,
    });
    // Another window answers it: this one takes that.
    this.#stopWelcome = settings.listen(welcomeKey(id), (value) => {
      if (!isWelcomed(value) || this.#snapshot.account !== id) return;
      if (this.#snapshot.welcome || this.#postponed) {
        this.#postponed = undefined;
        this.#set({ welcome: undefined });
        this.#answer?.("elsewhere");
        this.#answer = undefined;
      }
      if (!this.#snapshot.welcomed) {
        this.#set({ welcomed: true });
        void this.refresh();
      }
    });
    this.#options.changed?.();
    await this.refresh();
  }

  /** Reads the switches of the account again. Never rejects. */
  async refresh(): Promise<void> {
    const account = this.#snapshot.account;
    const access = this.#options.access;
    if (account === undefined || !access) return;
    const turn = this.#turn;
    clearTimeout(this.#pullTimer);
    if (this.#snapshot.status !== "synced") this.#set({ status: "syncing" });
    try {
      const switches = await access.read();
      if (turn !== this.#turn) return;
      if (switches.account !== account) throw new CloudOtherAccount("Somebody else is signed in");
      await this.#take(switches);
      this.#set({ status: "synced" });
      const postponed = this.#postponed;
      if (postponed) {
        this.#postponed = undefined;
        this.#set({ welcome: { ...postponed, failed: false } });
      }
    } catch (error) {
      if (turn !== this.#turn) return;
      if (error instanceof CloudSignedOut || error instanceof CloudOtherAccount) {
        await this.#options.account?.refresh();
        return;
      }
      console.warn("The switches of the cloud features could not be read", error);
      this.#set({ status: globalThis.navigator?.onLine === false ? "offline" : "failed" });
    } finally {
      if (turn === this.#turn) this.#pullTimer = setTimeout(() => void this.refresh(), PULL_MS);
    }
  }

  /** Keeps switches as the platform says them, and does what changed of them. */
  async #take(switches: CloudSwitches): Promise<void> {
    const { account } = switches;
    const { settings } = this.#options;
    const before = await settings.load(keptKey(account)).catch(() => undefined);
    const seen = isKept(before) ? before.seen : undefined;
    // What this browser took for the account's is not there any more: it goes again.
    if (switches.organizerEpoch !== (seen?.organizer ?? 0))
      await this.#options.resendOrganizer?.(account);
    if (switches.chatsEpoch !== (seen?.chats ?? 0)) await this.#options.detachChats?.(account);
    await settings.save(keptKey(account), {
      version: 1,
      switches,
      seen: { organizer: switches.organizerEpoch, chats: switches.chatsEpoch },
    } satisfies Kept);
    const was = this.#snapshot.switches;
    this.#set({ switches });
    if (
      !was ||
      was.organizer !== switches.organizer ||
      was.chats !== switches.chats ||
      was.organizerEpoch !== switches.organizerEpoch ||
      was.chatsEpoch !== switches.chatsEpoch
    )
      this.#options.changed?.();
  }

  /**
   * Turns a feature on or off for all devices of the account. Off, the platform keeps nothing of it
   * any more; this browser keeps what it has. Rejects where the platform could not be reached:
   * nothing changed then.
   */
  async set(feature: CloudFeature, on: boolean): Promise<void> {
    const account = this.#snapshot.account;
    const access = this.#options.access;
    if (account === undefined || !access) return;
    this.#set({ changing: feature });
    try {
      if (feature === "ai") {
        await this.#options.aiSync.setEnabled(on);
        await this.refresh();
        return;
      }
      const switches = await access.change(account, { [feature]: on } as CloudSwitchChanges);
      if (switches.account !== account) throw new CloudOtherAccount("Somebody else is signed in");
      await this.#take(switches);
      this.#set({ status: "synced" });
    } finally {
      this.#set({ changing: undefined });
    }
  }

  /**
   * Asks people about the account, once, see `AiSyncOptions.ask`: shows the welcome where they did
   * not answer it in this browser yet; otherwise the AI settings go as the account says, and this
   * device's stay out of them (people can put them in on the page of the cloud features).
   */
  async ask(question: AiSyncQuestion): Promise<AiSyncAnswer | undefined> {
    const { account } = question;
    if (!this.#snapshot.available) return { on: question.enabled, put: true };
    // As who is signed in is followed: the welcome is of the account that is.
    await this.#following;
    if (account !== this.#snapshot.account) return undefined;
    const answered = await this.#options.settings.load(welcomeKey(account)).catch(() => undefined);
    if (isWelcomed(answered) || this.#snapshot.welcomed)
      return { on: question.enabled, put: false };
    const snapshot = this.#options.account?.getSnapshot();
    const name = snapshot?.status === "signedIn" ? snapshot.name : "";
    const known = this.#snapshot.switches;
    this.#answer?.(undefined);
    return new Promise((resolve) => {
      this.#answer = resolve;
      this.#set({
        welcome: {
          account,
          name,
          question,
          switches: {
            ...DEFAULT_SWITCHES,
            ...(known && {
              organizer: known.organizer,
              chats: known.chats,
              newProjectsInCloud: known.newProjectsInCloud,
            }),
            ai: question.enabled,
          },
        },
      });
    });
  }

  /**
   * Puts the welcome off, where answering it failed as the platform could not be reached: nothing
   * starts, and it comes again once the platform can be reached.
   */
  postponeWelcome(): void {
    const welcome = this.#snapshot.welcome;
    if (!welcome || welcome.answering) return;
    this.#postponed = welcome;
    this.#set({ welcome: undefined });
  }

  /**
   * People answered the welcome, with whatever button: the switches go to the account as they are
   * then, and everything starts as they say. Resolves to false where the platform could not be
   * reached: the welcome stays, to try again.
   */
  async answerWelcome(values: SwitchValues): Promise<boolean> {
    const welcome = this.#snapshot.welcome;
    const access = this.#options.access;
    if (!welcome || welcome.answering || !access) return false;
    const { account } = welcome;
    this.#set({ welcome: { ...welcome, answering: true, failed: false } });
    try {
      const known = this.#snapshot.switches;
      const changes: CloudSwitchChanges = {
        ...((known?.organizer ?? true) !== values.organizer && { organizer: values.organizer }),
        ...((known?.chats ?? true) !== values.chats && { chats: values.chats }),
        ...((known?.newProjectsInCloud ?? true) !== values.newProjectsInCloud && {
          newProjectsInCloud: values.newProjectsInCloud,
        }),
      };
      const switches =
        Object.keys(changes).length > 0 || !known
          ? await access.change(account, changes)
          : undefined;
      if (this.#snapshot.account !== account) return false;
      if (switches) {
        if (switches.account !== account) throw new CloudOtherAccount("Somebody else is signed in");
        await this.#take(switches);
      }
    } catch (error) {
      console.warn("The welcome could not be answered", error);
      if (this.#snapshot.welcome?.account === account)
        this.#set({ welcome: { ...welcome, switches: values, answering: false, failed: true } });
      return false;
    }
    // The AI settings start with what people said, then the welcome is noted, for other windows.
    const answer = this.#answer;
    this.#answer = undefined;
    this.#set({ welcome: undefined, welcomed: true });
    answer?.({ on: values.ai, put: true });
    await this.#options.settings.save(welcomeKey(account), {
      at: this.#now(),
      switches: values,
    } satisfies Welcomed);
    this.#options.changed?.();
    return true;
  }

  dispose(): void {
    clearTimeout(this.#pullTimer);
    this.#stopWelcome?.();
  }
}
