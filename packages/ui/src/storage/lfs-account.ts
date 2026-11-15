import {
  CloudSignedOut,
  type AccountAccess,
  type LfsAccount,
  type LfsAccountAccess,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/**
 * What the person who is signed in has in the large file storage of GitHub through the platform,
 * and how they go about it (docs/design/asset-storage.md of AnimaQuill Cloud, 4.3): whether they
 * said once that they know what it means, which projects put new assets there by themselves, and
 * what is there by repository, for the storage page of the start page. The platform keeps it for
 * all their computers. No DOM.
 */

export type LfsAccountStatus = "none" | "signedOut" | "loading" | "ready" | "failed";

export interface LfsAccountSnapshot {
  readonly status: LfsAccountStatus;
  /** As the platform said last, for whoever is signed in now. */
  readonly account: LfsAccount | undefined;
}

export class LfsAccountState {
  readonly #access: LfsAccountAccess | undefined;
  readonly #account: AccountAccess | undefined;
  readonly #emitter = new Emitter();
  #snapshot: LfsAccountSnapshot;
  #asking: Promise<void> | undefined;

  constructor(access: LfsAccountAccess | undefined, account: AccountAccess | undefined) {
    this.#access = access;
    this.#account = account;
    this.#snapshot = { status: access ? "loading" : "none", account: undefined };
    account?.subscribe(() => {
      const who = this.#who();
      // Of somebody else, or of nobody: not theirs.
      if (this.#snapshot.account && this.#snapshot.account.account !== who)
        this.#set({ account: undefined, status: who === undefined ? "signedOut" : "loading" });
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): LfsAccountSnapshot => this.#snapshot;

  #who(): string | undefined {
    const snapshot = this.#account?.getSnapshot();
    return snapshot?.status === "signedIn" ? snapshot.id : undefined;
  }

  #set(changes: Partial<LfsAccountSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...changes };
    this.#emitter.emit();
  }

  #took(account: LfsAccount): void {
    // Only of whoever is signed in now.
    const who = this.#who();
    if (who !== undefined && account.account !== who) return;
    this.#set({ status: "ready", account });
  }

  /** Asks the platform again; one question at a time. */
  refresh(): Promise<void> {
    const access = this.#access;
    if (!access) return Promise.resolve();
    this.#asking ??= (async () => {
      if (this.#snapshot.status !== "ready") this.#set({ status: "loading" });
      try {
        this.#took(await access.read());
      } catch (error) {
        this.#set({ status: error instanceof CloudSignedOut ? "signedOut" : "failed" });
      } finally {
        this.#asking = undefined;
      }
    })();
    return this.#asking;
  }

  /** Whether people said they know what it means, as far as is known. */
  get acknowledged(): boolean {
    return this.#snapshot.account?.acknowledgedAt !== undefined;
  }

  /** Whether new assets of a project go into the storage by themselves. */
  isAuto(project: string): boolean {
    return this.#snapshot.account?.auto.includes(project) ?? false;
  }

  /** People said they know what it means: kept for good, for all their computers. */
  async acknowledge(): Promise<boolean> {
    return this.#change({ acknowledged: true });
  }

  /** Whether new assets of a project go into the storage by themselves. Resolves to whether it took. */
  async setAuto(project: string, on: boolean): Promise<boolean> {
    return this.#change({ auto: { project, on } });
  }

  async #change(changes: Parameters<LfsAccountAccess["change"]>[1]): Promise<boolean> {
    const access = this.#access;
    const who = this.#who();
    if (!access || who === undefined) return false;
    try {
      this.#took(await access.change(who, changes));
      return true;
    } catch (error) {
      console.warn("The large file storage of the account could not be changed", error);
      return false;
    }
  }
}
