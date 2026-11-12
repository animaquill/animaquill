import {
  CloudSignedOut,
  type AccountAccess,
  type CloudAccess,
  type CloudLink,
  type CloudLinkChange,
  type CloudProjectSummary,
  type FolderRecord,
  type FolderRecords,
  type ProjectLibrary,
  type ProjectSummary,
  type RepositoryUnusable,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import { Emitter } from "../workbench/emitter.ts";

/**
 * What the start page lists, see the design of the start page (docs/design/start-and-cloud.md of
 * AnimaQuill Cloud), 2: the projects on this computer, which are folders, each with how it stands
 * with the platform; the projects of the platform that have no folder here, to open as they are or
 * to download into one; and the projects that are only in this browser, where there are any.
 *
 * It is put together from four things: the folders this browser knows, the projects it keeps, its
 * links to projects of the platform, and the platform's own list. Every project shows once. A
 * project of the platform is the one a folder is connected to, or the one this browser has a copy
 * of ("opened here before"), or neither: it never is two lines.
 *
 * The first three are on this computer, and show at once. The platform's list comes when it comes,
 * and where it does not, as without a network or while nobody is signed in, the links say what
 * they remember, see `CloudLink.name`: a copy in this browser can have changes that the platform
 * does not have yet, and must not disappear with the list.
 *
 * No DOM. `composeStartList` is the rule, and `StartList` reads what it needs and keeps up.
 */

/** Why a project of the platform needs people to do something. */
export type AttentionReason =
  /** Archiving into its repository paused. */
  | "repository"
  /** Changes of its repository clash with the project's. */
  | "conflicts"
  /** Files of its repository could not be taken in. */
  | "blocked"
  /** The platform's list does not have it: taken away there, or never one of this account. */
  | "missing"
  /** Something a newer platform says. */
  | "other";

/** How a project of this computer stands with the platform, for the mark on its line. */
export type CloudMark =
  /** Not connected: only on this computer. */
  | { readonly kind: "local" }
  /**
   * Connected. `repository`: the name of its repository, where it is known. `stale`: as this
   * browser remembers it, since the platform's list could not be read.
   */
  | { readonly kind: "linked"; readonly repository: string | undefined; readonly stale: boolean }
  | {
      readonly kind: "attention";
      readonly reason: AttentionReason;
      readonly repository: string | undefined;
    }
  /** On the platform, or on its way there, without a repository: connecting is not finished. */
  | { readonly kind: "noRepository"; readonly stale: boolean }
  /** A project of the platform of somebody else than whoever is signed in. */
  | { readonly kind: "otherAccount" };

/** A project that is a folder on this computer. */
export interface LocalRow {
  /** What this browser keeps it by, see `FolderRecord.id`. */
  readonly key: string;
  readonly record: FolderRecord;
  readonly name: string;
  /** What its folder is called. */
  readonly folder: string;
  /** Milliseconds since 1970. */
  readonly openedAt: number;
  /** Undefined where the editor is hosted on no platform. */
  readonly mark: CloudMark | undefined;
  /** The project of the platform it is connected to, by its id there. */
  readonly project: string | undefined;
  /** Changes of this browser may not be on the platform yet, see `CloudLink.pending`: a hint. */
  readonly pending: boolean;
  /**
   * When it last changed, as far as this browser knows: in its log here, or on the platform, the
   * later of the two. Undefined where neither says.
   */
  readonly updatedAt: number | undefined;
  /** Where its repository is, as the platform's list says: an https address or nothing. */
  readonly repositoryUrl: string | undefined;
  /** It can be taken away on the platform: see `CloudRow.deletable`. */
  readonly deletable: boolean;
  /** Whose project of the platform it is, see `CloudLink.owner`, where that is known. */
  readonly owner: string | undefined;
  /** See `CloudRow.behind`. */
  readonly behind: boolean;
  /** See `CloudRow.unusable`. */
  readonly unusable: RepositoryUnusable | undefined;
  /** See `CloudRow.copy`; "live" where the platform's list does not say. */
  readonly copy: string;
}

/** A project of the platform that has no folder on this computer. */
export interface CloudRow {
  /** Its id on the platform. */
  readonly project: string;
  readonly name: string;
  readonly repository: { readonly fullName: string; readonly url: string | undefined } | undefined;
  /** When it last changed: as the platform says, and where it does not, as this browser knows. */
  readonly updatedAt: number | undefined;
  /** The copy this browser keeps of it, by its key: it was opened here before. */
  readonly key: string | undefined;
  /** That copy may have changes that the platform does not have yet: a hint. */
  readonly pending: boolean;
  /** How it stands, as for a folder: never "local". */
  readonly mark: CloudMark;
  /** The platform's list has it. Otherwise this is what this browser remembers of its copy. */
  readonly listed: boolean;
  /** Nobody is signed in: the copy syncs again once someone is. */
  readonly needsSignIn: boolean;
  /** See `CloudProjectSummary.copy`: only a "live" one can be opened from the platform. */
  readonly copy: string;
  /**
   * It can be taken away on the platform, see `CloudAccess.remove`: the platform's list of whoever
   * is signed in has it, so it is theirs.
   */
  readonly deletable: boolean;
  /** Whose it is, see `CloudLink.owner`: whoever is signed in for what the list has. */
  readonly owner: string | undefined;
  /**
   * The platform has changes of it that its repository does not have yet, as its list says: it
   * keeps them a week, see the design of the start page, 1.
   */
  readonly behind: boolean;
  /** Its repository cannot be used, and so the project cannot be edited, see the design, 5.1. */
  readonly unusable: RepositoryUnusable | undefined;
}

export interface StartLists {
  /** The projects on this computer, the most recently opened first. */
  readonly local: readonly LocalRow[];
  /** The projects of the platform without a folder here. */
  readonly cloud: readonly CloudRow[];
  /** The projects that are only in this browser, the most recently changed first. */
  readonly browser: readonly ProjectSummary[];
  /**
   * Whether those are known to be only in this browser, without the platform, see the design of
   * the start page, 7: not where the links of this browser cannot be read, as any of them may be
   * a copy of a project of the platform then.
   */
  readonly browserKnown: boolean;
}

export interface StartInput {
  /**
   * The folders this browser knows, the most recently opened first: none where it cannot write
   * folders. Undefined: they cannot be read, and nothing tells which projects are folders then.
   */
  readonly records: readonly FolderRecord[] | undefined;
  /** What this browser keeps, the logs of folders among it. Undefined: it cannot be read. */
  readonly projects: readonly ProjectSummary[] | undefined;
  /** The platform, see `CloudAccess.platform`. Undefined: the editor is hosted on none. */
  readonly platform: string | undefined;
  /** The links of this browser. Undefined: they cannot be read. */
  readonly links: readonly CloudLink[] | undefined;
  /** The platform's list, or why there is none. */
  readonly listed: readonly CloudProjectSummary[] | "loading" | "signedOut" | "unreadable";
  /** Who is signed in on the platform, see `AccountSnapshot.id`, where the host says. */
  readonly account: string | undefined;
  /** The platform takes projects without a repository away, see `CloudAccess.remove`. */
  readonly canDelete: boolean;
}

/**
 * Whether the platform has changes of a project that its repository does not have, as its list
 * says: not for one whose repository cannot be used, which says more than that.
 */
const isBehind = (summary: CloudProjectSummary): boolean =>
  summary.archive?.behind === true &&
  summary.repository !== undefined &&
  summary.repository.unusable === undefined;

const isPending = (link: CloudLink | undefined): boolean =>
  link !== undefined && (link.creating === true || (link.pending ?? 0) > 0);

/** The rule of the start page: which project shows where, once, and what its line says. */
export function composeStartList(input: StartInput): StartLists {
  const { platform, listed, account } = input;
  const links =
    platform === undefined ? [] : (input.links ?? []).filter((link) => link.platform === platform);
  const linkOf = new Map(links.map((link) => [link.key, link]));
  const records = input.records ?? [];
  const folders = new Set(records.map(({ id }) => id));
  const kept = input.projects ?? [];
  const list = typeof listed === "string" ? undefined : listed;
  const summaryOf = new Map((list ?? []).map((summary) => [summary.id, summary]));

  /** As the platform's list says it. `link`: what this browser remembers, where the list says less. */
  const markOfListed = (summary: CloudProjectSummary, link: CloudLink | undefined): CloudMark => {
    const repository = summary.repository?.fullName ?? link?.repository?.fullName;
    switch (summary.attention) {
      case undefined:
        // A platform that says nothing about repositories: what this browser last heard.
        if (!summary.repository && link?.repository === null)
          return { kind: "noRepository", stale: false };
        return { kind: "linked", repository, stale: false };
      case "noRepository":
        return { kind: "noRepository", stale: false };
      case "repository":
        return { kind: "attention", reason: "repository", repository };
      case "conflicts":
        return { kind: "attention", reason: "conflicts", repository };
      case "blocked":
        return { kind: "attention", reason: "blocked", repository };
      default:
        return { kind: "attention", reason: "other", repository };
    }
  };

  const markOf = (link: CloudLink | undefined): CloudMark => {
    if (!link) return { kind: "local" };
    const summary = summaryOf.get(link.project);
    if (summary) return markOfListed(summary, link);
    // Not on the platform yet, as far as this browser knows: connecting has to be finished.
    if (link.creating) return { kind: "noRepository", stale: list === undefined };
    if (account !== undefined && link.owner !== undefined && link.owner !== account)
      return { kind: "otherAccount" };
    if (list)
      return { kind: "attention", reason: "missing", repository: link.repository?.fullName };
    return link.repository === null
      ? { kind: "noRepository", stale: true }
      : { kind: "linked", repository: link.repository?.fullName, stale: true };
  };

  const keptOf = new Map(kept.map((summary) => [summary.id, summary]));
  const local = records.map((record): LocalRow => {
    const link = linkOf.get(record.id);
    const onPlatform = link && summaryOf.get(link.project);
    const times = [keptOf.get(record.id)?.updatedAt, onPlatform?.updatedAt].filter(
      (at): at is number => at !== undefined,
    );
    return {
      key: record.id,
      record,
      name: record.name,
      folder: record.folder.name,
      openedAt: record.openedAt,
      mark: platform === undefined ? undefined : markOf(link),
      project: link?.project,
      pending: isPending(link),
      updatedAt: times.length > 0 ? Math.max(...times) : undefined,
      repositoryUrl: onPlatform?.repository?.url || undefined,
      deletable: input.canDelete && onPlatform !== undefined,
      owner: onPlatform ? (account ?? link?.owner) : link?.owner,
      behind: onPlatform !== undefined && isBehind(onPlatform),
      unusable: onPlatform?.repository?.unusable,
      copy: onPlatform?.copy ?? "live",
    };
  });

  // The log of a folder is in the browser too, and is no project of the browser. Where the folders
  // cannot be read, nothing tells the two apart: then none of them shows as one.
  const isReadable = input.records !== undefined;
  const inBrowser = isReadable
    ? kept.filter((summary) => summary.folder !== true && !folders.has(summary.id))
    : [];

  // Projects of the platform that a folder is connected to show as that folder, and only there.
  // Without knowing the folders, any link may be one of a folder.
  const inFolders = new Set(
    links.filter((link) => !isReadable || folders.has(link.key)).map((link) => link.project),
  );
  /** The copy this browser has of a project of the platform, by the project: the first one. */
  const copyOf = new Map<string, { readonly link: CloudLink; readonly summary: ProjectSummary }>();
  for (const summary of inBrowser) {
    const link = linkOf.get(summary.id);
    if (!link || inFolders.has(link.project) || copyOf.has(link.project)) continue;
    copyOf.set(link.project, { link, summary });
  }
  const copies = new Set([...copyOf.values()].map(({ summary }) => summary.id));

  const fromList = (list ?? [])
    .filter((summary) => !inFolders.has(summary.id))
    .map((summary): CloudRow => {
      const copy = copyOf.get(summary.id);
      return {
        project: summary.id,
        // What the copy here is called where it has changes the platform does not have yet, as one
        // renamed on the start page; and where the list could not say what it is called.
        name:
          (copy && isPending(copy.link) && copy.summary.name) ||
          summary.name ||
          copy?.summary.name ||
          copy?.link.name ||
          "",
        repository: summary.repository && {
          fullName: summary.repository.fullName,
          url: summary.repository.url || undefined,
        },
        updatedAt: summary.updatedAt,
        key: copy?.link.key,
        pending: isPending(copy?.link),
        mark: markOfListed(summary, copy?.link),
        listed: true,
        needsSignIn: false,
        copy: summary.copy ?? "live",
        deletable: input.canDelete,
        owner: account ?? copy?.link.owner,
        behind: isBehind(summary),
        unusable: summary.repository?.unusable,
      };
    });
  // What this browser has and the list does not: all of it while there is no list.
  const remembered = [...copyOf.values()]
    .filter(({ link }) => !summaryOf.has(link.project))
    .toSorted((a, b) => b.summary.updatedAt - a.summary.updatedAt)
    .map(({ link, summary }): CloudRow => ({
      project: link.project,
      name: summary.name || link.name || "",
      repository: link.repository
        ? { fullName: link.repository.fullName, url: undefined }
        : undefined,
      updatedAt: summary.updatedAt,
      key: link.key,
      pending: isPending(link),
      mark: markOf(link),
      listed: false,
      needsSignIn: listed === "signedOut",
      copy: "live",
      deletable: false,
      owner: link.owner,
      behind: false,
      unusable: undefined,
    }));

  return {
    local,
    cloud: [...fromList, ...remembered],
    // What is no copy of a project of the platform, and whatever else would show nowhere.
    browser: inBrowser.filter((summary) => !copies.has(summary.id)),
    browserKnown: platform === undefined || input.links !== undefined,
  };
}

const plain = { interpolation: { escapeValue: false } } as const;

/** The mark on the line of a project: "仅本机", "☁ 已连云端 · ada/atom", "☁ 要处理"… */
export function markText(mark: CloudMark, t: TFunction): string {
  switch (mark.kind) {
    case "local":
      return t("start.mark.local");
    case "linked":
      return mark.repository === undefined
        ? t("start.mark.linked")
        : t("start.mark.linkedRepository", { repository: mark.repository, ...plain });
    case "attention":
      return t("start.mark.attention");
    case "noRepository":
      return t("start.mark.noRepository");
    case "otherAccount":
      return t("start.mark.otherAccount");
  }
}

/** What a mark means and what people can do, for hovering, or undefined where it says it all. */
export function markHint(mark: CloudMark, t: TFunction): string | undefined {
  switch (mark.kind) {
    case "local":
      return undefined;
    case "linked":
      return mark.stale ? t("start.hint.stale") : undefined;
    case "attention":
      return t(`start.hint.${mark.reason}`);
    case "noRepository":
      return t("start.hint.noRepository");
    case "otherAccount":
      return t("start.hint.otherAccount");
  }
}

/** What else the line of a project of the platform says, in order. */
export function cloudRowNotes(row: CloudRow, t: TFunction): string[] {
  return [
    ...(row.key !== undefined ? [t("start.openedHere")] : []),
    ...(row.pending ? [t("start.pending")] : []),
    ...(row.needsSignIn ? [t("start.afterSignIn")] : []),
    ...(row.listed && row.copy !== "live" && row.key === undefined ? [t("start.notLive")] : []),
  ];
}

export interface StartListSnapshot extends StartLists {
  /** Nothing of this computer was read yet. */
  readonly loading: boolean;
  /**
   * How the column of the platform is: "none" where the editor is hosted on no platform;
   * "loading" until the list came for the first time; "ready"; "signedOut": a word about signing
   * in, and below it what this browser remembers; "unreadable": what this browser remembers, and
   * that the list is not up to date.
   */
  readonly cloudState: "none" | "loading" | "ready" | "signedOut" | "unreadable";
  /** What of this computer could not be read: "no projects yet" is not what to say then. */
  readonly failed: {
    readonly projects: boolean;
    readonly folders: boolean;
    readonly links: boolean;
  };
}

export interface StartListOptions {
  readonly projects: Pick<ProjectLibrary, "list">;
  /** The folders this browser knows, where it can write folders. */
  readonly records?: Pick<FolderRecords, "list">;
  /** The platform the editor is hosted on, where it is on one. */
  readonly cloud?: Pick<CloudAccess, "platform" | "list" | "links" | "remove">;
  readonly account?: AccountAccess;
}

const NOTHING: StartListSnapshot = {
  loading: true,
  local: [],
  cloud: [],
  browser: [],
  browserKnown: false,
  cloudState: "none",
  failed: { projects: false, folders: false, links: false },
};

/** What a link remembers of its project for lists, see `CloudLink.name`. */
type Remembered = Pick<CloudLinkChange, "name" | "repository" | "owner">;

const sameRepository = (a: CloudLink["repository"], b: CloudLink["repository"]): boolean =>
  a === b ||
  (a !== null && a !== undefined && b !== null && b !== undefined
    ? a.id === b.id && a.fullName === b.fullName
    : false);

export class StartList {
  readonly #options: StartListOptions;
  readonly #emitter = new Emitter();
  #snapshot: StartListSnapshot;
  /** What this computer has, as last read. Undefined: it could not be read. */
  #here:
    | {
        readonly projects: readonly ProjectSummary[] | undefined;
        readonly records: readonly FolderRecord[] | undefined;
        readonly links: readonly CloudLink[] | undefined;
      }
    | undefined;
  /** The platform's list, as last read: it stays while it is read again. */
  #listed: StartInput["listed"] = "loading";
  /** Only the last time everything was read counts. */
  #turn = 0;
  /** Who was signed in when the list was last asked for. */
  #asked: string | undefined;
  /** This asks who is signed in right now: what the account says meanwhile is its answer. */
  #isAsking = false;
  readonly #stop: (() => void) | undefined;

  constructor(options: StartListOptions) {
    this.#options = options;
    this.#snapshot = { ...NOTHING, cloudState: options.cloud ? "loading" : "none" };
    // Signing in or out changes what the platform says, and whose projects these are.
    this.#stop = options.account?.subscribe(() => {
      if (!this.#isAsking && this.#who() !== this.#asked) void this.refresh();
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): StartListSnapshot => this.#snapshot;

  close(): void {
    this.#turn += 1;
    this.#stop?.();
  }

  /** Who is signed in, as far as asking the platform goes: nobody, somebody, or not known. */
  #who(): string {
    const who = this.#options.account?.getSnapshot();
    if (!who) return "";
    return who.status === "signedIn" ? `in:${who.id ?? who.name}` : who.status;
  }

  #compose(): void {
    const { cloud, account } = this.#options;
    const here = this.#here;
    const who = account?.getSnapshot();
    const listed = this.#listed;
    const lists = composeStartList({
      records: here?.records,
      projects: here?.projects,
      links: here?.links,
      platform: cloud?.platform,
      listed,
      account: who?.status === "signedIn" ? who.id : undefined,
      canDelete: cloud?.remove !== undefined,
    });
    this.#snapshot = {
      ...lists,
      loading: here === undefined,
      cloudState: !cloud ? "none" : typeof listed === "string" ? listed : "ready",
      failed: {
        projects: here !== undefined && here.projects === undefined,
        folders: here !== undefined && here.records === undefined,
        links: here !== undefined && here.links === undefined,
      },
    };
    this.#emitter.emit();
  }

  /**
   * Reads everything again: what this computer has first, which shows at once, and then the
   * platform's list. Never rejects: what cannot be read shows in the snapshot.
   */
  async refresh(): Promise<void> {
    const turn = ++this.#turn;
    const { projects, records, cloud } = this.#options;
    const read = <T>(what: string, work: () => Promise<T>): Promise<T | undefined> =>
      work().catch((error: unknown) => {
        console.warn(`${what} could not be listed`, error);
        return undefined;
      });
    const [kept, known, links] = await Promise.all([
      read("Projects", () => projects.list()),
      records ? read("Project folders", () => records.list()) : Promise.resolve([]),
      cloud ? read("Links to the platform", () => cloud.links.list()) : Promise.resolve([]),
    ]);
    if (turn !== this.#turn) return;
    this.#here = { projects: kept, records: known, links };
    this.#compose();
    await this.#readList(turn);
  }

  async #readList(turn: number): Promise<void> {
    const { cloud, account } = this.#options;
    if (!cloud) return;
    if (account?.getSnapshot().status === "unknown") {
      this.#isAsking = true;
      await account.refresh().finally(() => {
        this.#isAsking = false;
      });
    }
    if (turn !== this.#turn) return;
    this.#asked = this.#who();
    const who = account?.getSnapshot();
    if (who && who.status !== "signedIn") {
      // Whether anybody is signed in could not be found out: the platform is not there now.
      this.#listed = who.status === "signedOut" ? "signedOut" : "unreadable";
      this.#compose();
      return;
    }
    let listed: StartInput["listed"];
    try {
      listed = await cloud.list();
    } catch (error) {
      if (!(error instanceof CloudSignedOut))
        console.warn("The projects on the platform could not be listed", error);
      listed = error instanceof CloudSignedOut ? "signedOut" : "unreadable";
    }
    if (turn !== this.#turn) return;
    this.#listed = listed;
    this.#compose();
    if (typeof listed !== "string") await this.#remember(listed, turn);
  }

  /**
   * Has the links remember what the list said about their projects, for the next time the list
   * cannot be read, see `CloudLink.name`. Only what is new, and nothing fails with it.
   */
  async #remember(listed: readonly CloudProjectSummary[], turn: number): Promise<void> {
    const { cloud, account } = this.#options;
    const links = this.#here?.links;
    if (!cloud || !links) return;
    const who = account?.getSnapshot();
    const owner = who?.status === "signedIn" ? who.id : undefined;
    const summaryOf = new Map(listed.map((summary) => [summary.id, summary]));
    const next: CloudLink[] = [];
    let isChanged = false;
    for (const link of links) {
      const summary = link.platform === cloud.platform ? summaryOf.get(link.project) : undefined;
      if (!summary) {
        next.push(link);
        continue;
      }
      const repository = summary.repository
        ? { id: summary.repository.id, fullName: summary.repository.fullName }
        : summary.attention === "noRepository"
          ? null
          : undefined;
      const change: { -readonly [K in keyof Remembered]: Remembered[K] } = {};
      // A name the platform's list could not say is none to remember.
      if (summary.name !== "" && summary.name !== link.name) change.name = summary.name;
      if (repository !== undefined && !sameRepository(repository, link.repository))
        change.repository = repository;
      // Whoever is signed in has it in their list: it is theirs.
      if (owner !== undefined && owner !== link.owner) change.owner = owner;
      if (Object.keys(change).length === 0) {
        next.push(link);
        continue;
      }
      isChanged = true;
      next.push({ ...link, ...change });
      await cloud.links.update(link.key, link.project, change).catch((error: unknown) => {
        console.warn("What a list shows of a project could not be kept", error);
      });
    }
    if (!isChanged || turn !== this.#turn || !this.#here) return;
    this.#here = { ...this.#here, links: next };
  }
}
