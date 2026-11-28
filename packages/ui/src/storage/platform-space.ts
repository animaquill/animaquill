import {
  CloudSignedOut,
  type AccountAccess,
  type PlatformProjectUse,
  type PlatformSpace,
  type ReleaseBlock,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import { pauseText } from "../cloud/repository-text.ts";
import { Emitter } from "../workbench/emitter.ts";

/**
 * What the person who is signed in keeps on the platform itself (docs/design/online-offline.md of
 * AnimaQuill Cloud, 3.6): the working copies of their projects against what they may keep, as the
 * storage page, the side bar of the start page, the menus of the cards, the dialog that says it is
 * full and the status of syncing say it. Read from the account (`AccountAccess.space`), again as
 * those come up and after what changes it. No DOM.
 */

export type PlatformSpaceStatus = "none" | "signedOut" | "loading" | "ready" | "failed";

export interface PlatformSpaceSnapshot {
  readonly status: PlatformSpaceStatus;
  /** As the platform said last, for whoever is signed in now. */
  readonly space: PlatformSpace | undefined;
}

/** From this part of what may be kept on, the side bar says it is nearly full. */
export const NEARLY_FULL = 0.9;

/** Asked again at most this often by itself, as the start page comes up, say. */
const FRESH_MS = 30_000;

export class PlatformSpaceState {
  readonly #account: AccountAccess | undefined;
  readonly #emitter = new Emitter();
  readonly #now: () => number;
  #snapshot: PlatformSpaceSnapshot;
  #asking: Promise<void> | undefined;
  #askedAt = Number.NEGATIVE_INFINITY;
  #who: string | undefined;

  constructor(account: AccountAccess | undefined, now: () => number = Date.now) {
    this.#account = account;
    this.#now = now;
    this.#snapshot = { status: account?.space ? "loading" : "none", space: undefined };
    this.#who = this.#signedIn();
    account?.subscribe(() => {
      const who = this.#signedIn();
      if (who === this.#who) return;
      // Of somebody else, or of nobody: not theirs.
      this.#who = who;
      this.#askedAt = Number.NEGATIVE_INFINITY;
      this.#set({ space: undefined, status: who === undefined ? "signedOut" : "loading" });
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): PlatformSpaceSnapshot => this.#snapshot;

  #signedIn(): string | undefined {
    const snapshot = this.#account?.getSnapshot();
    return snapshot?.status === "signedIn" ? (snapshot.id ?? snapshot.name) : undefined;
  }

  #set(changes: Partial<PlatformSpaceSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...changes };
    this.#emitter.emit();
  }

  /**
   * Asks the platform again; one question at a time. `fresh`: only where the last answer is older
   * than a little while, as for what comes up by itself.
   */
  refresh({ fresh = false }: { readonly fresh?: boolean } = {}): Promise<void> {
    const read = this.#account?.space;
    if (!read) return Promise.resolve();
    if (fresh && this.#snapshot.status === "ready" && this.#now() - this.#askedAt < FRESH_MS)
      return Promise.resolve();
    this.#asking ??= (async () => {
      const who = this.#who;
      if (this.#snapshot.status !== "ready") this.#set({ status: "loading" });
      try {
        const space = await read.call(this.#account);
        // Of whoever was signed in as it was asked, only.
        if (who !== this.#who) return;
        this.#askedAt = this.#now();
        this.#set(
          space.platform
            ? { status: "ready", space: space.platform }
            : { status: "none", space: undefined },
        );
      } catch (error) {
        if (who !== this.#who) return;
        this.#set({ status: error instanceof CloudSignedOut ? "signedOut" : "failed" });
      } finally {
        this.#asking = undefined;
      }
    })();
    return this.#asking;
  }

  /** The project as the platform listed it last, where it is one of the person's own. */
  project(id: string): PlatformProjectUse | undefined {
    return this.#snapshot.space?.projects.find((each) => each.id === id);
  }
}

// ---- what it comes to

/** How much of what may be kept is kept, 0 to 1 and beyond; undefined where there is no limit. */
export const partOf = (used: number, limit: number | null): number | undefined =>
  limit === null ? undefined : limit === 0 ? (used > 0 ? Infinity : 0) : used / limit;

/** Whether the space or the number of projects is at `NEARLY_FULL` or beyond. */
export const isNearlyFull = (space: PlatformSpace | undefined): boolean => {
  if (!space) return false;
  const parts = [partOf(space.used, space.limit), partOf(space.count.used, space.count.limit)];
  return parts.some((part) => part !== undefined && part >= NEARLY_FULL);
};

/** Whether more is kept than may be: only new projects are kept out then, never editing. */
export const isOver = (space: PlatformSpace | undefined): boolean =>
  space !== undefined &&
  ((space.limit !== null && space.used > space.limit) ||
    (space.count.limit !== null && space.count.used > space.count.limit));

/**
 * What keeps one more project out, as far as the list says: as many projects as may be ("count"),
 * or the bytes ("storage"). `said`: what the platform said as it refused one, which counts first.
 */
export const fullBy = (
  space: PlatformSpace | undefined,
  said?: "count" | "storage",
): "count" | "storage" => {
  if (said) return said;
  if (space?.count.limit != null && space.count.used >= space.count.limit) return "count";
  return "storage";
};

/** Whether the person has room for one more project of `bytes`, as far as the list says. */
export const hasRoom = (space: PlatformSpace | undefined, bytes = 0): boolean =>
  space === undefined ||
  ((space.count.limit === null || space.count.used < space.count.limit) &&
    (space.limit === null || space.used + bytes <= space.limit));

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * Bytes of the platform, as people read them next to what they may keep: by 1024, as the limits
 * are set (`AQ_LIMITS`, the plans), so that 5 GiB is "5 GB", with one decimal where it says
 * something; `exact` keeps it also where it is 0, as what is used next to the limit ("5.0 GB").
 */
export const formatPlatformBytes = (bytes: number, { exact = false } = {}): string => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${exact ? shown : shown.replace(/\.0$/, "")} ${UNITS[unit]}`;
};

/** "平台存储满了（5.0 GB / 5 GB）" or "在线项目数满了（500 / 500）", as far as the list says. */
export const fullTitle = (
  by: "count" | "storage",
  space: PlatformSpace | undefined,
  t: TFunction,
): string => {
  if (by === "count")
    return t("storage.platform.full.countTitle", {
      used: space?.count.used ?? "?",
      limit: space?.count.limit ?? "?",
    });
  return t("storage.platform.full.storageTitle", {
    used: space ? formatPlatformBytes(space.used, { exact: true }) : "?",
    limit: space?.limit != null ? formatPlatformBytes(space.limit) : "?",
  });
};

// ---- why a copy is not let go of

const SHORT = new Set([
  "noRepository",
  "neverArchived",
  "pending",
  "busy",
  "connected",
  "conflicts",
  "uploading",
  "unusable",
  "paused",
  "failing",
  "repository",
]);

/** Why a copy is not let go of, in a few words, as a menu item says it beside itself. */
export const releaseBlockShort = (why: ReleaseBlock, t: TFunction): string =>
  t(`storage.platform.short.${(SHORT.has(why.code) ? why.code : "other") as "busy"}`, {
    count: why.count ?? 0,
  });

/**
 * What helps where a copy is not let go of: opening the project, where what keeps it shows and is
 * seen to ("open": conflicts, a pause, failures, a repository that cannot be used); keeping a whole
 * copy in a folder before deleting it ("saveToFolder": nothing to make it again from); or nothing
 * but a moment.
 */
export type ReleaseFix = "open" | "saveToFolder" | undefined;

const REPOSITORY_LOOKS = new Set([
  "gone",
  "unauthorized",
  "transferred",
  "missing",
  "rewritten",
  "unreachable",
]);

/** Why a copy is not let go of, in people's words, and what helps, see `ReleaseBlock`. */
export function releaseBlockText(
  why: ReleaseBlock,
  t: TFunction,
): { readonly text: string; readonly fix: ReleaseFix } {
  const plain = { interpolation: { escapeValue: false } } as const;
  switch (why.code) {
    case "noRepository":
      return { text: t("storage.platform.why.noRepository"), fix: "saveToFolder" };
    case "neverArchived":
    case "pending":
    case "busy":
    case "connected":
    case "uploading":
      return { text: t(`storage.platform.why.${why.code as "pending"}`), fix: undefined };
    case "conflicts":
      return {
        text: t("storage.platform.why.conflicts", { count: why.count ?? 0 }),
        fix: "open",
      };
    case "unusable":
      return {
        text: t("storage.platform.why.unusable", {
          reason: pauseText({ ...(why.reason !== undefined && { reason: why.reason }) }, t).reason,
          ...plain,
        }),
        fix: "open",
      };
    case "paused":
      return {
        text:
          why.reason === undefined
            ? t("storage.platform.why.pausedPlain")
            : t("storage.platform.why.paused", {
                reason: pauseText({ reason: why.reason }, t).reason,
                ...plain,
              }),
        fix: "open",
      };
    case "failing":
      return {
        text: why.detail
          ? t("storage.platform.why.failingSaid", { detail: why.detail, ...plain })
          : t("storage.platform.why.failing"),
        fix: "open",
      };
    case "repository": {
      const reason = REPOSITORY_LOOKS.has(why.reason ?? "") ? why.reason : "unreachable";
      return {
        text: t(`storage.platform.why.repository.${reason as "gone"}`),
        fix: reason === "unreachable" ? undefined : "open",
      };
    }
    default:
      return {
        text: t("storage.platform.why.other", { code: why.code, ...plain }),
        fix: undefined,
      };
  }
}
