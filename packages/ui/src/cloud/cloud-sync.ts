import type { AccountAccess, SettingsStore } from "@animaquill/host";
import type { AiSync, AiSyncAnswer, AiSyncQuestion } from "../chat/ai-sync.ts";
import { Emitter } from "../workbench/emitter.ts";

/**
 * The cloud features that people turn on and off (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 9.2): the AI settings (`AiSync`), the stars and groups of the start page, the
 * conversations about projects of the platform, and whether new projects are of the platform by
 * default. Each switch is of this device, for the account signed in to (`cloud@<account>`): off,
 * this device neither gives nor takes what it is of, and the platform and other devices go on as
 * ever. Nothing is taken away anywhere by turning one off.
 *
 * The first time an account is signed in to in this browser, nothing of it goes anywhere until
 * people answered the welcome (`welcome`): the switches, on by default; "开始使用" and "以后再说"
 * both start them as they are then. What they answered is noted (`welcome@<account>`), and the
 * welcome does not come again for that account in this browser, signed out and in again or not. An
 * account whose AI settings went with it here before there was a welcome (0.3.62) counts as
 * answered, and is never asked.
 */

/** A feature that a switch here is of; "ai" is turned on and off by `AiSync`. */
export type CloudFeature = "ai" | "organizer" | "chats";

/** What the switches are, of this device. */
export type SwitchValues = Readonly<Record<CloudFeature, boolean>>;

export const DEFAULT_SWITCHES: SwitchValues = {
  ai: true,
  organizer: true,
  chats: true,
};

/** The welcome, as it shows, see `CloudSync`. */
export interface WelcomeRequest {
  readonly account: string;
  /** What people know the account by. */
  readonly name: string;
  readonly question: AiSyncQuestion;
  /** What the switches start as: on, unless this device had them otherwise. */
  readonly switches: SwitchValues;
}

export interface CloudSyncSnapshot {
  /** There is a platform that things go with. */
  readonly available: boolean;
  /** Who is signed in, by the id the platform knows them by. */
  readonly account: string | undefined;
  /** People answered the welcome for the account in this browser. */
  readonly welcomed: boolean;
  /** The switches of this device for the account; "ai" is as `AiSync` has it. */
  readonly switches: SwitchValues | undefined;
  /** The welcome, while it is to show. */
  readonly welcome: WelcomeRequest | undefined;
}

export interface CloudSyncOptions {
  /** The settings of this browser, as the host keeps them: not those of the account. */
  readonly settings: SettingsStore;
  /** Whether there is a platform to go with at all. */
  readonly platform: boolean;
  readonly account?: AccountAccess | undefined;
  readonly aiSync: AiSync;
  /** A switch changed, or the welcome was answered: what it is of goes, or stops. */
  readonly changed?: () => void;
  readonly now?: () => number;
}

/** What this browser keeps of the switches of an account. */
interface Kept {
  readonly version: 1;
  /** As the platform had them for all devices, before they were of each device (0.3.72). */
  readonly switches?: Partial<SwitchValues>;
  /** This device's. */
  readonly device?: SwitchValues;
}

/** What people answered the welcome with, as this browser keeps it. */
interface Welcomed {
  readonly at: number;
  /** The switches as they were answered; missing where the account counted as answered. */
  readonly switches?: SwitchValues;
}

const keptKey = (account: string) => `cloud@${account}`;
const welcomeKey = (account: string) => `welcome@${account}`;
const FEATURES = Object.keys(DEFAULT_SWITCHES) as CloudFeature[];

const isKept = (value: unknown): value is Kept =>
  typeof value === "object" && value !== null && (value as Kept).version === 1;
const isWelcomed = (value: unknown): value is Welcomed =>
  typeof value === "object" && value !== null && typeof (value as Welcomed).at === "number";

/**
 * The switches of this device as kept. Before they were of each device, this browser kept them as
 * the platform said them last, for all devices of the account: those are this device's now, so
 * that nothing that was off comes on.
 */
export function deviceSwitchesOf(value: unknown): SwitchValues | undefined {
  if (!isKept(value)) return undefined;
  const from: Partial<Record<CloudFeature, unknown>> | undefined = value.device ?? value.switches;
  if (typeof from !== "object" || from === null) return undefined;
  return Object.fromEntries(
    FEATURES.map((feature) => {
      const said = from[feature];
      return [feature, typeof said === "boolean" ? said : DEFAULT_SWITCHES[feature]];
    }),
  ) as SwitchValues;
}

export class CloudSync {
  readonly #options: CloudSyncOptions;
  readonly #emitter = new Emitter();
  #snapshot: CloudSyncSnapshot;
  /** The welcome waits for this, for the account it is of. */
  #answer: ((answer: AiSyncAnswer | undefined) => void) | undefined;
  #stopListening: (() => void) | undefined;
  #following: Promise<void> = Promise.resolve();

  constructor(options: CloudSyncOptions) {
    this.#options = options;
    this.#snapshot = {
      available: options.platform && options.account !== undefined,
      account: undefined,
      welcomed: false,
      switches: undefined,
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
   * not turn it off on this device. Nothing is held back where there is no platform for it.
   */
  allows(feature: "organizer" | "chats", account: string | undefined): boolean {
    const { available, welcomed, switches } = this.#snapshot;
    if (!available) return true;
    if (account === undefined || account !== this.#snapshot.account || !welcomed) return false;
    return switches?.[feature] ?? true;
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
  }

  async #follow(): Promise<void> {
    const snapshot = this.#options.account?.getSnapshot();
    if (!snapshot || snapshot.status === "unknown") return;
    const id = snapshot.status === "signedIn" ? snapshot.id : undefined;
    if (id === this.#snapshot.account) return;
    this.#stopListening?.();
    this.#stopListening = undefined;
    if (this.#snapshot.welcome) this.#answer?.(undefined);
    this.#answer = undefined;
    if (id === undefined) {
      this.#set({ account: undefined, welcomed: false, switches: undefined, welcome: undefined });
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
    this.#set({ account: id, welcomed, switches: deviceSwitchesOf(kept), welcome: undefined });
    const stops = [
      // Another window answers it: this one takes that.
      settings.listen(welcomeKey(id), (value) => {
        if (!isWelcomed(value) || this.#snapshot.account !== id) return;
        if (this.#snapshot.welcome) {
          this.#set({ welcome: undefined });
          this.#answer?.("elsewhere");
          this.#answer = undefined;
        }
        if (!this.#snapshot.welcomed) {
          this.#set({ welcomed: true });
          this.#options.changed?.();
        }
      }),
      // Another window changed a switch.
      settings.listen(keptKey(id), (value) => {
        if (this.#snapshot.account !== id) return;
        const switches = deviceSwitchesOf(value);
        if (!switches) return;
        this.#set({ switches });
        this.#options.changed?.();
      }),
    ];
    this.#stopListening = () => {
      for (const stop of stops) stop();
    };
    this.#options.changed?.();
  }

  /** Keeps the switches of this device for an account, for every window. */
  async #keep(account: string, switches: SwitchValues): Promise<void> {
    const { settings } = this.#options;
    const before = await settings.load(keptKey(account)).catch(() => undefined);
    await settings.save(keptKey(account), {
      ...(isKept(before) ? before : {}),
      version: 1,
      device: switches,
    } satisfies Kept);
  }

  /**
   * Turns a feature on or off on this device. Off, nothing of it goes or comes here; the platform
   * and other devices keep theirs. On again, what this device has and the account's are merged.
   */
  async set(feature: CloudFeature, on: boolean): Promise<void> {
    const account = this.#snapshot.account;
    if (account === undefined) return;
    if (feature === "ai") await this.#options.aiSync.setEnabled(on);
    const switches = { ...DEFAULT_SWITCHES, ...this.#snapshot.switches, [feature]: on };
    this.#set({ switches });
    await this.#keep(account, switches);
    this.#options.changed?.();
  }

  /**
   * Asks people about the account, once, see `AiSyncOptions.ask`: shows the welcome where they did
   * not answer it in this browser yet; otherwise the AI settings go as this device says.
   */
  async ask(question: AiSyncQuestion): Promise<AiSyncAnswer | undefined> {
    const { account } = question;
    if (!this.#snapshot.available) return { on: true, put: true };
    // As who is signed in is followed: the welcome is of the account that is.
    await this.#following;
    if (account !== this.#snapshot.account) return undefined;
    const known = this.#snapshot.switches;
    const answered = await this.#options.settings.load(welcomeKey(account)).catch(() => undefined);
    if (isWelcomed(answered) || this.#snapshot.welcomed)
      return { on: known?.ai ?? true, put: false };
    const snapshot = this.#options.account?.getSnapshot();
    const name = snapshot?.status === "signedIn" ? snapshot.name : "";
    this.#answer?.(undefined);
    return new Promise((resolve) => {
      this.#answer = resolve;
      this.#set({
        welcome: { account, name, question, switches: { ...DEFAULT_SWITCHES, ...known } },
      });
    });
  }

  /**
   * People changed a switch of the welcome: kept here, so that the welcome shows it again as it
   * comes back after another dialog took its place.
   */
  editWelcome(values: SwitchValues): void {
    const welcome = this.#snapshot.welcome;
    if (!welcome) return;
    this.#set({ welcome: { ...welcome, switches: values } });
  }

  /**
   * People answered the welcome, with whatever button: the switches are kept on this device as they
   * are then, and everything starts as they say.
   */
  async answerWelcome(values: SwitchValues): Promise<void> {
    const welcome = this.#snapshot.welcome;
    if (!welcome) return;
    const { account } = welcome;
    // The AI settings start with what people said, then the welcome is noted, for other windows.
    const answer = this.#answer;
    this.#answer = undefined;
    this.#set({ welcome: undefined, welcomed: true, switches: values });
    await this.#keep(account, values);
    answer?.({ on: values.ai, put: true });
    await this.#options.settings.save(welcomeKey(account), {
      at: this.#now(),
      switches: values,
    } satisfies Welcomed);
    this.#options.changed?.();
  }

  dispose(): void {
    this.#stopListening?.();
  }
}
