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
import type { ListedArchive } from "./github-status.ts";

/**
 * What the start page lists (docs/design/online-offline.md of AnimaQuill Cloud, 1.2 and 1.3): in
 * the online mode the projects of the platform, with or without a copy in this browser; in the
 * offline mode the folders this browser knows, which are its projects; and in either, the projects
 * that are only in this browser, where there are any.
 *
 * It is put together from four things: the folders this browser knows (offline), the projects it
 * keeps, its links to projects of the platform and the platform's own list (online). Every project
 * shows once.
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

/** A project that is a folder on this computer, of the offline mode. */
export interface LocalRow {
  /** What this browser keeps it by, see `FolderRecord.id`. */
  readonly key: string;
  readonly record: FolderRecord;
  readonly name: string;
  /** What its folder is called. */
  readonly folder: string;
  /** Milliseconds since 1970. */
  readonly openedAt: number;
  /** When it last changed, as far as its log in this browser knows. */
  readonly updatedAt: number | undefined;
  /** What it says about itself, as this browser noted it. */
  readonly description: string | undefined;
}

/** A project of the platform, of the online mode. */
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
  /** The platform let go of its copy, which comes back from the repository as it is opened. */
  readonly released?: boolean;
  /**
   * The platform could not make its working copy from the repository the last time it tried, see
   * `CloudProjectSummary.copyProblem`: why is said once people open it.
   */
  readonly copyFailed?: boolean;
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
  /**
   * What the list says of archiving it into its repository, for how it stands there, see
   * `githubOfListed`. Undefined where the list does not have it.
   */
  readonly archive: ListedArchive | undefined;
  /** Its repository cannot be used, and so the project cannot be edited, see the design, 5.1. */
  readonly unusable: RepositoryUnusable | undefined;
  /**
   * Its cover on the platform, as the list says, see `CloudProjectSummary.cover`: null where the
   * list says it has none, undefined where the list does not say.
   */
  readonly cover: CloudProjectSummary["cover"] | null;
  /** How long its main timeline is, as the list says. */
  readonly durationMs: number | undefined;
  /**
   * What it says about itself, cut short, see `ProjectSummary.description`: as the list says, or
   * the copy here, where it has changes the platform does not have yet or the list does not say.
   */
  readonly description: string | undefined;
}

export interface StartLists {
  /** The folders of the offline mode, the most recently opened first. */
  readonly local: readonly LocalRow[];
  /** The projects of the platform, online. */
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

/** What the list says of archiving a project, for `githubOfListed`. */
const listedArchive = ({
  attention,
  repository,
  archive,
  openedAt,
}: CloudProjectSummary): ListedArchive => ({
  ...(attention !== undefined && { attention }),
  ...(repository && { repository }),
  ...(archive && { archive }),
  ...(openedAt !== undefined && { openedAt }),
});

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

  const markOf = (link: CloudLink): CloudMark => {
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
  const local = records.map((record): LocalRow => ({
    key: record.id,
    record,
    name: record.name,
    folder: record.folder.name,
    openedAt: record.openedAt,
    updatedAt: keptOf.get(record.id)?.updatedAt,
    description: keptOf.get(record.id)?.description,
  }));

  // The log of a folder is in the browser too, and is no project of the browser. Where the folders
  // cannot be read, nothing tells the two apart: then none of them shows as one.
  const isReadable = input.records !== undefined;
  const inBrowser = isReadable
    ? kept.filter((summary) => summary.folder !== true && !folders.has(summary.id))
    : [];

  /** The copy this browser has of a project of the platform, by the project: the first one. */
  const copyOf = new Map<string, { readonly link: CloudLink; readonly summary: ProjectSummary }>();
  for (const summary of inBrowser) {
    const link = linkOf.get(summary.id);
    if (!link || copyOf.has(link.project)) continue;
    copyOf.set(link.project, { link, summary });
  }
  const copies = new Set([...copyOf.values()].map(({ summary }) => summary.id));

  const fromList = (list ?? []).map((summary): CloudRow => {
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
      ...(summary.copy !== "live" && summary.releasedAt !== undefined && { released: true }),
      ...(summary.copy === "released" && summary.copyProblem && { copyFailed: true }),
      deletable: input.canDelete,
      owner: account ?? copy?.link.owner,
      behind: isBehind(summary),
      archive: listedArchive(summary),
      unusable: summary.repository?.unusable,
      cover: summary.cover ?? null,
      durationMs: summary.durationMs,
      description:
        (copy && isPending(copy.link) ? copy.summary.description : undefined) ??
        summary.description ??
        copy?.summary.description,
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
      archive: undefined,
      unusable: undefined,
      cover: undefined,
      durationMs: undefined,
      description: summary.description,
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

/** The mark on the line of a project: "☁ 已连云端 · ada/atom", "☁ 要处理"… */
export function markText(mark: CloudMark, t: TFunction): string {
  switch (mark.kind) {
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
  /** When the platform's list that this has came, in ms since 1970, where it came. */
  readonly listedAt: number | undefined;
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
  listedAt: undefined,
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
  /** When the platform's list came. */
  #listedAt: number | undefined;
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
      listedAt: typeof listed === "string" ? undefined : this.#listedAt,
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
    this.#listedAt = Date.now();
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
