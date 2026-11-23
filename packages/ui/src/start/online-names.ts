import { CloudSignedOut, type CloudAccess, type CloudRename } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/**
 * Renaming projects of the platform from the start page in the online mode: on the platform, at
 * once (`CloudAccess.rename`), which every window and computer of the person hears, see
 * `SyncHub.rename` of the server. Until it answers the card shows the new name (`pending`), and the
 * old one again where it does not take it, which people are told. A project whose working copy the
 * platform let go of comes back from its repository first ("waking"): asked for again until it is
 * there, then renamed. Without a network there is nothing to rename on: people are told so before
 * they try (`online`). No DOM.
 */

/** What came of a rename, for the card: "renamed" also where it was called so already. */
export type OnlineRenameOutcome =
  | "renamed"
  | "locked"
  | "unusable"
  | "invalid"
  | "quota"
  /** It could not be made again from its repository, or not now. */
  | "notBack"
  | "missing"
  | "offline"
  | "signedOut"
  | "failed";

/** A name on its way to the platform. */
export interface PendingName {
  readonly name: string;
  /** "waking": its working copy is on its way back from the repository first. */
  readonly state: "saving" | "waking";
}

export interface OnlineNamesSnapshot {
  /** By the id of the project on the platform. */
  readonly pending: ReadonlyMap<string, PendingName>;
  /** Whether the browser says it has a network: without one, nothing is renamed. */
  readonly online: boolean;
}

export interface OnlineNamesOptions {
  readonly cloud: () => Pick<CloudAccess, "rename" | "wake"> | undefined;
  /** The list of the start page, read again once a name is in. */
  readonly refresh: () => Promise<void>;
  /** How long a copy may take to come back from its repository, and how often it is asked. */
  readonly wakeMs?: number;
  readonly askEveryMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Where the browser says whether it has a network. Without one, it has. */
  readonly network?: {
    readonly onLine: boolean;
    addEventListener(type: "online" | "offline", listener: () => void): void;
    removeEventListener(type: "online" | "offline", listener: () => void): void;
  };
}

const NOTHING: ReadonlyMap<string, PendingName> = new Map();

export class OnlineNames {
  readonly #options: OnlineNamesOptions;
  readonly #emitter = new Emitter();
  #snapshot: OnlineNamesSnapshot;
  /** The latest rename of each project: an older one that answers after it changes nothing. */
  readonly #latest = new Map<string, number>();
  #next = 0;
  readonly #stop: () => void;

  constructor(options: OnlineNamesOptions) {
    this.#options = options;
    const network = options.network;
    this.#snapshot = { pending: NOTHING, online: network?.onLine ?? true };
    const changed = () => {
      const online = network?.onLine ?? true;
      if (online !== this.#snapshot.online) this.#set({ ...this.#snapshot, online });
    };
    network?.addEventListener("online", changed);
    network?.addEventListener("offline", changed);
    this.#stop = () => {
      network?.removeEventListener("online", changed);
      network?.removeEventListener("offline", changed);
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): OnlineNamesSnapshot => this.#snapshot;

  /** Whether projects of the platform can be renamed from here at all. */
  get available(): boolean {
    return this.#options.cloud()?.rename !== undefined;
  }

  /** Renames `project`, showing `name` until the platform answers. Never rejects. */
  async rename(project: string, name: string): Promise<OnlineRenameOutcome> {
    const wanted = name.trim();
    if (wanted === "") return "invalid";
    const cloud = this.#options.cloud();
    if (!cloud?.rename) return "failed";
    if (!this.#snapshot.online) return "offline";
    const ticket = ++this.#next;
    this.#latest.set(project, ticket);
    this.#show(project, { name: wanted, state: "saving" });
    let outcome: OnlineRenameOutcome;
    try {
      outcome = await this.#ask(cloud, project, wanted, ticket);
    } catch (error) {
      outcome = error instanceof CloudSignedOut ? "signedOut" : this.#offlineOr("failed");
    }
    if (this.#latest.get(project) !== ticket) return outcome;
    // The list says the new name before the card stops showing it, so that it never flickers back.
    if (outcome === "renamed") await this.#options.refresh().catch(() => {});
    if (this.#latest.get(project) === ticket) {
      this.#latest.delete(project);
      this.#show(project, undefined);
    }
    return outcome;
  }

  stop(): void {
    this.#stop();
  }

  async #ask(
    cloud: Pick<CloudAccess, "rename" | "wake">,
    project: string,
    name: string,
    ticket: number,
  ): Promise<OnlineRenameOutcome> {
    const { wakeMs = 180_000, askEveryMs = 2000, now = Date.now } = this.#options;
    const sleep = this.#options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    const until = now() + wakeMs;
    for (;;) {
      const said: CloudRename = await (cloud.rename as NonNullable<CloudAccess["rename"]>)(
        project,
        name,
      );
      if ("kind" in said) {
        switch (said.kind) {
          case "renamed":
            return "renamed";
          case "missing":
            return "missing";
          case "refused":
            return said.why;
          case "waking":
            break;
        }
      } else return "notBack";
      // On its way back from the repository: renamed once it is there.
      this.#show(project, { name, state: "waking" });
      for (;;) {
        if (now() > until || this.#latest.get(project) !== ticket) return "notBack";
        await sleep(askEveryMs);
        const woke = await cloud.wake?.(project);
        if (!woke || woke.copy === "released" || woke.copy === "missing")
          return woke?.copy === "missing" ? "missing" : "notBack";
        if (woke.copy === "live") break;
      }
    }
  }

  /** What a request that got no answer says: the network went, or something else. */
  #offlineOr(outcome: OnlineRenameOutcome): OnlineRenameOutcome {
    const online = this.#options.network?.onLine ?? true;
    if (!online && this.#snapshot.online) this.#set({ ...this.#snapshot, online });
    return online ? outcome : "offline";
  }

  #show(project: string, pending: PendingName | undefined): void {
    const next = new Map(this.#snapshot.pending);
    if (pending) next.set(project, pending);
    else next.delete(project);
    this.#set({ ...this.#snapshot, pending: next.size === 0 ? NOTHING : next });
  }

  #set(snapshot: OnlineNamesSnapshot): void {
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }
}
