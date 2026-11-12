/**
 * What the tests of syncing share: a platform in memory that speaks the sync protocol the way the
 * platform does (apps/api of AnimaQuill Cloud has the real one, tested on its own), and the parts of
 * a browser that syncing uses.
 */
import {
  ProjectStore,
  checkUpdate,
  checkWhole,
  checkWritten,
  isEmptyUpdate,
  type ProjectStore as Store,
} from "@animaquill/core";
import {
  CloudSignedOut,
  MemoryCloudLinks,
  Reassembler,
  SYNC_CLOSE,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  framesOf,
  packChecked,
  readSyncClientMessage,
  type CloudAccess,
  type CloudClose,
  type CloudConnection,
  type CloudCopyProblem,
  type CloudWake,
  type CloudLine,
  type CloudProjectSummary,
  type CloudRemoval,
  type CloudRemoveOptions,
  type RepositoryStatus,
  type RepositoryUnusable,
  type SyncClientMessage,
  type SyncRejection,
  type SyncServerMessage,
} from "@animaquill/host";
import { MemoryWriters, type WriterPage } from "@animaquill/host/memory";
import type { CloudEnvironment } from "./session.ts";

/** A change the platform took, as it keeps it. */
export interface PlatformUpdate {
  readonly seq: number;
  readonly digest: string;
  readonly data: Uint8Array;
  readonly kind: string;
  readonly device: string;
  readonly base: number;
  readonly behind: boolean;
}

interface PlatformProject {
  readonly id: string;
  readonly owner: string;
  readonly projectId: string;
  /** What it was called when it was made, for the list. */
  readonly name: string;
  /** Which working copy this is, see `CloudLink.generation`: a test makes it another one. */
  generation: number;
  head: number;
  digest: string;
  /** What came after the snapshot, which is all there is before it was made. */
  updates: PlatformUpdate[];
  snapshot:
    { readonly seq: number; readonly digest: string; readonly state: Uint8Array } | undefined;
  /** Snapshots made before changes made without the latest came in, see the design, 7.6. */
  readonly beforeMerge: { readonly seq: number; readonly device: string }[];
  /** Whether the platform has the working copy, see `CloudProjectSummary.copy`. */
  copy?: "live" | "released" | "restoring";
  /** Where the copy before was when it went, see `release`. */
  releasedFrom?: {
    readonly generation: number;
    readonly head: number;
    readonly archivedSeq: number;
    commonBase?: boolean;
  };
  /** What this copy began as, see `rebuild`: `base` of "hello". */
  began?: { readonly seq: number; readonly digest: string; readonly state: Uint8Array };
  /** Why making it again failed the last time, see `rebuild`. */
  copyProblem?: CloudCopyProblem | undefined;
}

interface ServerSide {
  readonly user: string;
  /** Which browser it is, for a test to drop its connections. */
  readonly tag: string;
  readonly deliver: (data: Uint8Array) => void;
  readonly close: (code: number, reason?: string) => void;
  /** It only reads, see `readOnly` of "hello": it sends no change. */
  readOnly: boolean;
  readonly frames: Reassembler;
  project: PlatformProject | undefined;
  device: string;
  snapshotted: boolean;
}

/** How a test can get in the way of the platform. */
export interface PlatformFaults {
  /** The next changes get turned away like this. */
  readonly rejections: { readonly reason: SyncRejection; readonly retry: boolean }[];
  /** Messages stop going either way, as on a connection that died without a word. */
  silent: boolean;
  /** A slow line, both ways: frames take as long as their bytes do, one after the other. */
  line?: { readonly time: TestTime; readonly bytesPerSecond: number };
  /** Frames that every connection gets first, as from a platform that sends what it should not. */
  first?: readonly Uint8Array[];
  /** The list of projects cannot be read, and none can be taken away: the platform is not there. */
  unreachable?: boolean;
  /** Asking for the list, or to take a project away, gets no answer at all: a line that hangs. */
  hangs?: boolean;
}

/** The repository a project of the platform is saved to, as a test says. */
export interface PlatformRepository {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly state?: "ready" | "paused";
  /** Why archiving paused, see `RepositoryPause`. */
  readonly reason?: string;
  /** It cannot be used, and so the project cannot be edited, see `makeUnusable`. */
  readonly unusable?: RepositoryUnusable;
}

/** What stands for an update and all before it, as the platform makes it: any digest will do. */
export function digestOf(before: string, seq: number, data: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const take = (byte: number) => {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  };
  for (const char of `${before}:${seq}:`) take(char.charCodeAt(0) & 0xff);
  for (const byte of data) take(byte);
  return hash.toString(36);
}

/**
 * A platform in memory: projects by their number on it, each with its updates in order. A restart
 * keeps what was kept and forgets everything else, connections included.
 */
export class MemoryPlatform {
  readonly projects = new Map<string, PlatformProject>();
  readonly faults: PlatformFaults = { rejections: [], silent: false };
  /** How many updates go into a snapshot, after which the older ones go. */
  compactAfter = 40;
  /** Users whose sessions ended: their connections close, saying so. */
  readonly signedOut = new Set<string>();
  /** The repositories projects are saved to, by project: one that has none can be taken away. */
  readonly repositories = new Map<string, PlatformRepository>();
  /** What else the list says about a project, by project, as a test sets it. */
  readonly listed = new Map<string, Partial<CloudProjectSummary>>();
  /** Projects that were taken away, in order. */
  readonly removed: string[] = [];
  /**
   * The ids of projects that were taken away, for good: no project is made under one of them
   * again, whoever says hello with it, and whenever, as the platform keeps them.
   */
  readonly deleted = new Set<string>();
  /**
   * Asking to take away a project that is not there keeps one from being made under that id too,
   * as the platform is going to: a hello that is still on its way then makes nothing.
   */
  voidsUnmade = false;
  /** Repairs that brought the platform something it did not have, see "check". */
  effectiveRepairs = 0;
  /**
   * Editors know that a project was deleted (`SYNC_CLOSE.deleted`) and that one cannot be edited
   * (`SYNC_CLOSE.unusable`), as the platform says once its switches are on; otherwise they hear
   * `missing`, as older editors do.
   */
  knowsDeleted = true;
  /** The update of each project its repository has all up to, see `remove`. */
  readonly archivedSeq = new Map<string, number>();
  /** Projects with files still on their way into the large file storage, and how many. */
  readonly uploads = new Map<string, number>();
  /** How each project was asked to go, in order. */
  readonly removals: { readonly id: string; readonly options: CloudRemoveOptions }[] = [];
  /** What the platform turned away, by why. */
  readonly rejected: SyncRejection[] = [];
  #working = new Map<string, Store>();
  readonly #sides = new Set<ServerSide>();
  /** Every connection that opened. */
  connections = 0;

  /** A connection of somebody signed in as `user`, as a browser opens one. */
  connect(user: string, tag = ""): CloudConnection {
    let toClient: (data: Uint8Array) => void = () => {};
    let resolveClosed: (close: CloudClose) => void = () => {};
    let isOpen = false;
    let isClosed = false;
    /** The browser said to close: it hears and says nothing more, and what it sent arrives first. */
    let isClosing = false;
    const closed = new Promise<CloudClose>((resolve) => {
      resolveClosed = resolve;
    });
    const later = (run: () => void) => void Promise.resolve().then(run);
    /** One way of a slow line: what is on it, and what it has to carry still. */
    const way = () => {
      const frames: { readonly data: Uint8Array; readonly arrive: () => void }[] = [];
      let bytes = 0;
      const next = () => {
        const line = this.faults.line;
        const first = frames[0];
        if (!line || !first) return;
        line.time.setTimeout(
          () => {
            frames.shift();
            bytes -= first.data.length;
            first.arrive();
            next();
          },
          Math.ceil((first.data.length / line.bytesPerSecond) * 1000),
        );
      };
      return {
        bytes: () => bytes,
        carry: (data: Uint8Array, arrive: () => void) => {
          if (!this.faults.line) {
            later(arrive);
            return;
          }
          frames.push({ data, arrive });
          bytes += data.length;
          if (frames.length === 1) next();
        },
      };
    };
    const down = way();
    const up = way();
    const side: ServerSide = {
      user,
      tag,
      project: undefined,
      device: "",
      snapshotted: false,
      readOnly: false,
      frames: new Reassembler(SYNC_LIMITS.update),
      deliver: (data) =>
        down.carry(data, () => {
          if (isClosed || isClosing || this.faults.silent) return;
          toClient(data);
        }),
      close: (code, reason) => end(code, reason),
    };
    const end = (code: number, reason = "") => {
      if (isClosed) return;
      isClosed = true;
      this.#sides.delete(side);
      later(() => resolveClosed({ code, reason }));
    };
    this.connections += 1;
    this.#sides.add(side);
    const opened = new Promise<void>((resolve) => {
      later(() => {
        isOpen = true;
        resolve();
        if (this.signedOut.has(user)) end(SYNC_CLOSE.signedOut);
        for (const frame of this.faults.first ?? []) side.deliver(frame);
      });
    });
    return {
      opened,
      closed,
      send: (data) => {
        if (isClosing) return;
        const copy = data.slice();
        up.carry(copy, () => {
          if (isClosed || !isOpen || this.faults.silent) return;
          this.#receive(side, copy);
        });
      },
      onMessage: (listener) => {
        toClient = (data) => listener(data.slice());
      },
      buffered: () => up.bytes(),
      close: () => {
        if (isClosed || isClosing) return;
        isClosing = true;
        // A line that died carries nothing, and the browser gives up on it by itself.
        if (this.faults.silent) {
          end(1000);
          return;
        }
        // As a WebSocket does: what the browser sent before it closed still gets there, however
        // long the line takes, and the platform does what it says. Only then is it closed.
        up.carry(new Uint8Array(0), () => end(1000));
      },
    };
  }

  /** Never, where the platform does not answer at all, see `PlatformFaults.hangs`. */
  answers(): Promise<void> {
    return this.faults.hangs ? new Promise(() => {}) : Promise.resolve();
  }

  /** The session of a user ends: their connections close, saying so, until `signIn`. */
  signOut(user: string): void {
    this.signedOut.add(user);
    for (const side of this.#sides) if (side.user === user) side.close(SYNC_CLOSE.signedOut);
  }

  signIn(user: string): void {
    this.signedOut.delete(user);
  }

  /** The projects of a user as the list has them, the way `GET /api/projects` says them. */
  list(user: string): CloudProjectSummary[] {
    if (this.faults.unreachable) throw new Error("The platform is not there");
    if (this.signedOut.has(user)) throw new CloudSignedOut("Nobody is signed in");
    return [...this.projects.values()]
      .filter((project) => project.owner === user)
      .map((project) => {
        const repository = this.repositories.get(project.id);
        return {
          id: project.id,
          name: project.name,
          updatedAt: project.head,
          copy: project.copy ?? "live",
          ...(project.copy !== "live" &&
            project.copyProblem && { copyProblem: project.copyProblem }),
          ...(repository
            ? {
                repository: {
                  id: repository.id,
                  owner: repository.owner,
                  name: repository.name,
                  fullName: `${repository.owner}/${repository.name}`,
                  private: true,
                  url: `https://github.com/${repository.owner}/${repository.name}`,
                  state: repository.state ?? "ready",
                  ...(repository.reason !== undefined && { reason: repository.reason }),
                  ...(repository.unusable && { unusable: repository.unusable }),
                },
                archive: {
                  seq: this.archivedSeq.get(project.id) ?? 0,
                  behind: project.head > (this.archivedSeq.get(project.id) ?? 0),
                },
                ...(repository.unusable
                  ? { attention: "unusable" }
                  : repository.state === "paused" && { attention: "repository" }),
              }
            : { attention: "noRepository" }),
          ...this.listed.get(project.id),
        };
      });
  }

  /**
   * Takes a project away as `DELETE /api/projects/<id>` does: one without a repository, or one
   * whose repository cannot be used, as it is; one with a repository only once it has all of the
   * project, or as people let go of what it does not, see `CloudRemoveOptions`.
   */
  remove(user: string, id: string, options: CloudRemoveOptions = {}): CloudRemoval {
    if (this.faults.unreachable) throw new Error("The platform is not there");
    if (this.signedOut.has(user)) throw new CloudSignedOut("Nobody is signed in");
    this.removals.push({ id, options });
    const project = this.projects.get(id);
    if (!project || project.owner !== user) {
      if (!project && this.voidsUnmade) this.deleted.add(id);
      return "missing";
    }
    const repository = this.repositories.get(id);
    const asked = options.discard === true || options.archived !== undefined;
    if (repository && !asked && !repository.unusable) return "hasRepository";
    const uploads = this.uploads.get(id) ?? 0;
    if (uploads > 0 && options.discard !== true) return { kind: "uploading", uploads };
    if (repository && !repository.unusable && options.discard !== true) {
      const archivedSeq = this.archivedSeq.get(id) ?? 0;
      const state = repository.state ?? "ready";
      if (state !== "ready" || archivedSeq !== project.head || options.archived !== project.head) {
        return {
          kind: "notArchived",
          head: project.head,
          archivedSeq,
          state,
          ...(repository.reason !== undefined && { reason: repository.reason }),
          archiving: false,
        };
      }
    }
    // Its connections go first, so that nothing of it comes back.
    const code = this.knowsDeleted ? SYNC_CLOSE.deleted : SYNC_CLOSE.missing;
    for (const side of this.#sides) if (side.project === project) side.close(code);
    this.projects.delete(id);
    this.#working.delete(id);
    this.removed.push(id);
    this.deleted.add(id);
    return "removed";
  }

  /**
   * The repository of a project cannot be used any more, as when it was deleted on GitHub: the
   * project cannot be edited, its windows close saying why, and no change of it is taken, see
   * `SYNC_CLOSE.unusable`. Without `unusable`, it can be used again.
   */
  makeUnusable(id: string, unusable: RepositoryUnusable | undefined): void {
    const repository = this.repositories.get(id);
    if (!repository) throw new Error(`no repository of ${id}`);
    const { unusable: _, reason: __, state: ___, ...rest } = repository;
    this.repositories.set(
      id,
      unusable
        ? { ...rest, unusable, state: "paused", reason: unusable.reason }
        : { ...rest, state: "ready" },
    );
    if (!unusable) return;
    for (const side of this.#sides) {
      if (side.project?.id !== id || side.readOnly) continue;
      side.close(...this.#unusableClose(unusable.reason));
    }
  }

  #unusableClose(reason: string): [number, string] {
    return this.knowsDeleted ? [SYNC_CLOSE.unusable, reason] : [SYNC_CLOSE.missing, ""];
  }

  /** Drops every connection without a word, and forgets all but what it kept. */
  restart(): void {
    for (const side of this.#sides) side.close(SYNC_CLOSE.unavailable);
    this.#working = new Map();
  }

  /**
   * Comes back from a backup made when the project was at `seq`: what came after it is gone, also
   * what a snapshot after it had. Restarts, as a platform does that comes back from a backup.
   */
  restoreTo(id: string, seq: number): void {
    const project = this.projects.get(id);
    if (!project) throw new Error(`no project ${id}`);
    if (project.snapshot && project.snapshot.seq > seq) {
      throw new Error("a backup that old has no snapshot here: keep compactAfter higher");
    }
    project.updates = project.updates.filter((update) => update.seq <= seq);
    project.head = seq;
    project.digest =
      project.updates.at(-1)?.digest ??
      (project.snapshot?.seq === seq ? project.snapshot.digest : "");
    this.restart();
  }

  /** What each repository has of its project, as files: its last archive, see `archive`. */
  readonly archives = new Map<string, Map<string, string>>();
  /** What the branch of a repository has, where people changed it on GitHub since, see `rebuild`. */
  readonly branches = new Map<string, Map<string, string>>();
  /** A window that says hello for a project the platform let go of has it made again at once. */
  rebuildsOnHello = true;
  /** The next `rebuild` fails like this, once. */
  rebuildFails: CloudCopyProblem["code"] | undefined;

  /**
   * Archives a project as the platform does into its repository: what it has now, up to its head.
   */
  archive(id: string): void {
    const project = this.projects.get(id);
    if (!project || project.copy === "released") throw new Error(`no working copy of ${id}`);
    this.archives.set(id, this.workingCopy(id).exportFiles().files);
    this.archivedSeq.set(id, project.head);
  }

  /**
   * Lets go of the working copy of a project, archived or not, as the platform does once nobody
   * opened it for a while: its windows go first. The list keeps it, as "released".
   */
  release(id: string): void {
    const project = this.projects.get(id);
    if (!project || (project.copy ?? "live") !== "live")
      throw new Error(`no working copy of ${id}`);
    for (const side of this.#sides) if (side.project === project) side.close(1006);
    project.releasedFrom = {
      generation: project.generation,
      head: project.head,
      archivedSeq: this.archives.has(id) ? (this.archivedSeq.get(id) ?? 0) : 0,
    };
    project.copy = "released";
    project.updates = [];
    project.snapshot = undefined;
    this.#working.delete(id);
  }

  /**
   * Makes the working copy of a project again from its repository, as the worker does: from its
   * last archive, or from its branch as it is (`fromBranch`), as another document, the next copy.
   * Its numbers go on from where the copy before was.
   */
  rebuild(id: string, { fromBranch = false } = {}): boolean {
    const project = this.projects.get(id);
    const from = project?.releasedFrom;
    if (!project || !from || project.copy === "live") throw new Error(`nothing to make of ${id}`);
    const failing = this.rebuildFails;
    this.rebuildFails = undefined;
    const files = fromBranch
      ? (this.branches.get(id) ?? this.archives.get(id))
      : this.archives.get(id);
    const store = files && !failing ? ProjectStore.open(files).store : undefined;
    if (!store || !files) {
      project.copy = "released";
      project.copyProblem = {
        code: failing ?? "unreadable",
        at: 1,
        retryAt: 2,
        ...(failing === "unreadable" || !failing ? { files: ["timeline.json"] } : {}),
      };
      return false;
    }
    const state = store.encodeState();
    store.destroy();
    project.generation += 1;
    project.head = from.head + 1;
    project.digest = digestOf(`copy${project.generation}`, project.head, state);
    project.updates = [
      {
        seq: project.head,
        digest: project.digest,
        data: state,
        kind: "first",
        device: "platform",
        base: 0,
        behind: false,
      },
    ];
    project.snapshot = undefined;
    project.began = { seq: project.head, digest: project.digest, state };
    from.commonBase = !fromBranch && from.archivedSeq > 0;
    project.copy = "live";
    project.copyProblem = undefined;
    this.archives.set(id, files);
    this.archivedSeq.set(id, project.head);
    this.#working.delete(id);
    return true;
  }

  /** What `GET /api/projects/<id>/repository` says of the working copy of a project. */
  status(user: string, id: string): RepositoryStatus {
    if (this.faults.unreachable) throw new Error("The platform is not there");
    const project = this.projects.get(id);
    if (!project || project.owner !== user) throw new Error(`no project ${id}`);
    const from = project.releasedFrom;
    const repository = this.repositories.get(id);
    return {
      state: repository ? (repository.state ?? "ready") : "none",
      archiving: false,
      head: project.head,
      archivedSeq: this.archivedSeq.get(id) ?? 0,
      copy: project.copy ?? "live",
      generation: project.generation,
      ...(project.copyProblem && { copyProblem: project.copyProblem }),
      ...(from &&
        from.generation < project.generation && {
          rebuiltFrom: {
            generation: from.generation,
            archivedSeq: from.archivedSeq,
            commonBase: from.commonBase !== false,
          },
        }),
    };
  }

  /**
   * `POST /api/projects/restore`: a repository that has a project at its top becomes a new project
   * of `user`, made from what it has, the first copy. Resolves to its id and name.
   */
  restoreProject(
    user: string,
    repository: { readonly id: number; readonly owner: string; readonly name: string },
    files: ReadonlyMap<string, string>,
  ): { readonly id: string; readonly name: string } {
    const store = ProjectStore.open(files).store;
    if (!store) throw new Error("no project in the repository");
    const state = store.encodeState();
    const { name, id: projectId } = store.getState().manifest;
    store.destroy();
    const id = `restored${this.projects.size + 1}`;
    const digest = digestOf("", 1, state);
    this.projects.set(id, {
      id,
      owner: user,
      projectId,
      name,
      generation: 1,
      head: 1,
      digest,
      updates: [
        { seq: 1, digest, data: state, kind: "first", device: "platform", base: 0, behind: false },
      ],
      snapshot: undefined,
      beforeMerge: [],
      copy: "live",
    });
    this.repositories.set(id, repository);
    this.archives.set(id, new Map(files));
    this.archivedSeq.set(id, 1);
    return { id, name };
  }

  /** `POST /api/projects/<id>/wake`: makes the copy again where it went, see `rebuild`. */
  wake(user: string, id: string, { fromBranch = false } = {}): CloudWake {
    if (this.faults.unreachable) throw new Error("The platform is not there");
    const project = this.projects.get(id);
    if (!project || project.owner !== user) return { copy: "missing" };
    if ((project.copy ?? "live") === "live") return { copy: "live" };
    if (!this.repositories.has(id)) return { copy: "released", refused: "noRepository" };
    if (fromBranch && !project.copyProblem) return { copy: "released", refused: "notAllowed" };
    if (project.copyProblem && !fromBranch && project.copyProblem.code !== "unavailable") {
      return {
        copy: "released",
        refused: "busy",
        copyProblem: project.copyProblem,
        retryAfter: 60,
      };
    }
    project.copy = "restoring";
    return this.rebuild(id, { fromBranch })
      ? { copy: "live" }
      : {
          copy: "released",
          refused: "busy",
          ...(project.copyProblem && { copyProblem: project.copyProblem }),
          retryAfter: 60,
        };
  }

  /** Drops the connections of a browser, or of all of them, as a network that went away. */
  drop(tag?: string): void {
    for (const side of this.#sides) if (tag === undefined || side.tag === tag) side.close(1006);
  }

  /** The working copy of a project, as the platform has it now. */
  workingCopy(id: string): Store {
    const project = this.projects.get(id);
    if (!project) throw new Error(`no project ${id}`);
    let store = this.#working.get(id);
    if (!store) {
      const parts = [
        ...(project.snapshot ? [project.snapshot.state] : []),
        ...project.updates.map((update) => update.data),
      ];
      const opened = ProjectStore.fromUpdates(parts).store;
      if (!opened || opened.isMissingUpdates) throw new Error(`project ${id} does not open`);
      store = opened;
      this.#working.set(id, store);
    }
    return store;
  }

  #send(side: ServerSide, message: SyncServerMessage): void {
    for (const frame of framesOf(message)) side.deliver(frame);
  }

  #receive(side: ServerSide, data: Uint8Array): void {
    const whole = side.frames.take(data);
    if (whole === "more") return;
    const message = whole && readSyncClientMessage(whole);
    if (!message) {
      side.close(SYNC_CLOSE.protocol);
      return;
    }
    switch (message.t) {
      case "hello":
        this.#hello(side, message);
        return;
      case "push":
        this.#push(side, message);
        return;
      case "check": {
        const project = side.project;
        if (!project) return;
        const store = this.workingCopy(project.id);
        this.#send(side, {
          t: "checked",
          head: project.head,
          digest: project.digest,
          payload: packChecked(store.stateVector(), store.deletions()),
        });
        return;
      }
      case "ping":
        this.#send(side, { t: "pong" });
        return;
    }
  }

  /** The digest of `seq`, where the platform still knows it. */
  #digestAt(project: PlatformProject, seq: number): string | undefined {
    if (seq === 0) return "";
    if (seq === project.head) return project.digest;
    const update = project.updates.find((each) => each.seq === seq);
    if (update) return update.digest;
    return project.snapshot?.seq === seq ? project.snapshot.digest : undefined;
  }

  #hello(side: ServerSide, message: Extract<SyncClientMessage, { t: "hello" }>): void {
    if (message.v !== SYNC_PROTOCOL) {
      side.close(SYNC_CLOSE.outdated);
      return;
    }
    side.device = message.device;
    side.readOnly = message.readOnly === true;
    let project = this.projects.get(message.project);
    let created = false;
    if (project && project.owner !== side.user) {
      side.close(SYNC_CLOSE.missing);
      return;
    }
    // A project that was taken away is not made again, whoever asks, and a window that has it
    // hears so, where it knows the word.
    if (!project && this.deleted.has(message.project)) {
      side.close(this.knowsDeleted ? SYNC_CLOSE.deleted : SYNC_CLOSE.missing);
      return;
    }
    if (project && (project.copy ?? "live") !== "live" && project.owner === side.user) {
      if (side.readOnly) {
        if (project.copy === "restoring") side.close(SYNC_CLOSE.unavailable, "restoring");
        else side.close(SYNC_CLOSE.unusable, "released");
        return;
      }
      // Made again from its repository, a moment after the window heard to come back later; or
      // not, where that failed lately, and the platform tries again later ("released").
      side.close(
        SYNC_CLOSE.unavailable,
        project.copy === "released" && project.copyProblem ? "released" : "restoring",
      );
      if (this.rebuildsOnHello && project.copy === "released" && !project.copyProblem) {
        const id = project.id;
        void Promise.resolve().then(() => {
          const now = this.projects.get(id);
          if (now && now.copy === "released" && !now.copyProblem) {
            now.copy = "restoring";
            this.rebuild(id);
          }
        });
      }
      return;
    }
    if (project && message.base === true) {
      const began = project.began;
      if (!began || !side.readOnly || project.owner !== side.user) {
        side.close(SYNC_CLOSE.missing);
        return;
      }
      this.#send(side, {
        t: "welcome",
        head: began.seq,
        digest: began.digest,
        reset: false,
        generation: project.generation,
      });
      this.#send(side, {
        t: "update",
        seq: began.seq,
        digest: began.digest,
        kind: "first",
        at: 0,
        payload: began.state,
      });
      this.#send(side, { t: "synced", head: began.seq, digest: began.digest });
      return;
    }
    const unusable = project && this.repositories.get(project.id)?.unusable;
    if (unusable && !side.readOnly) {
      side.close(...this.#unusableClose(unusable.reason));
      return;
    }
    if (!project && message.create) {
      if (message.payload.length > SYNC_LIMITS.state) {
        side.close(SYNC_CLOSE.tooLarge);
        return;
      }
      const fault = checkUpdate(message.payload, { most: SYNC_LIMITS.structs });
      const { store } = fault ? { store: undefined } : ProjectStore.fromUpdates([message.payload]);
      if (
        !store ||
        store.isMissingUpdates ||
        store.getState().manifest.id !== message.create.projectId ||
        checkWhole(store.doc)
      ) {
        side.close(SYNC_CLOSE.protocol);
        return;
      }
      const digest = digestOf("", 1, message.payload);
      project = {
        id: message.project,
        owner: side.user,
        projectId: message.create.projectId,
        name: message.create.name,
        generation: 1,
        head: 1,
        digest,
        updates: [
          {
            seq: 1,
            digest,
            data: message.payload,
            kind: "first",
            device: side.device,
            base: 0,
            behind: false,
          },
        ],
        snapshot: undefined,
        beforeMerge: [],
      };
      this.projects.set(project.id, project);
      created = true;
    }
    if (!project) {
      side.close(SYNC_CLOSE.missing);
      return;
    }
    // What the window has is of another copy of the project than the one that is here now.
    if (message.generation !== undefined && message.generation !== project.generation) {
      side.close(SYNC_CLOSE.rebuilt);
      return;
    }
    side.project = project;
    const known = message.after > 0 ? this.#digestAt(project, message.after) : "";
    const reset =
      message.after > project.head ||
      (known !== undefined && message.digest !== undefined && message.digest !== known);
    const after = reset ? 0 : created ? project.head : message.after;
    this.#send(side, {
      t: "welcome",
      head: project.head,
      digest: project.digest,
      reset,
      generation: project.generation,
    });
    const oldest = project.updates[0]?.seq ?? project.head + 1;
    if (after < project.head && after + 1 < oldest) {
      // What came after is not there one by one any more: all of it at once.
      const store = this.workingCopy(project.id);
      this.#send(side, {
        t: "update",
        seq: project.head,
        digest: project.digest,
        kind: "snapshot",
        at: 0,
        payload: store.encodeWhole(),
      });
    } else {
      for (const update of project.updates) {
        if (update.seq <= after) continue;
        this.#send(side, {
          t: "update",
          seq: update.seq,
          digest: update.digest,
          kind: update.kind,
          at: 0,
          payload: update.data,
        });
      }
    }
    this.#send(side, { t: "synced", head: project.head, digest: project.digest });
  }

  #push(side: ServerSide, message: Extract<SyncClientMessage, { t: "push" }>): void {
    const project = side.project;
    // A window that only reads sends nothing.
    if (!project || side.readOnly) {
      side.close(SYNC_CLOSE.protocol);
      return;
    }
    const reject = (reason: SyncRejection, retry: boolean) => {
      this.rejected.push(reason);
      this.#send(side, { t: "reject", id: message.id, reason, retry });
    };
    if (message.payload.length > SYNC_LIMITS.update) {
      reject("too-large", false);
      return;
    }
    const injected = this.faults.rejections.shift();
    if (injected) {
      reject(injected.reason, injected.retry);
      return;
    }
    const fault = checkUpdate(message.payload, { most: SYNC_LIMITS.structs });
    if (fault) {
      reject(fault, false);
      return;
    }
    const store = this.workingCopy(project.id);
    if (message.behind && !side.snapshotted && message.base < project.head) {
      const others = project.updates.some(
        (update) => update.seq > message.base && update.device !== side.device,
      );
      if (others || (project.updates[0]?.seq ?? 0) > message.base + 1) {
        project.beforeMerge.push({ seq: project.head, device: side.device });
        side.snapshotted = true;
      }
    }
    let change: ReturnType<Store["applyChecked"]>;
    try {
      change = store.applyChecked(message.payload, "platform");
    } catch {
      this.#working.delete(project.id);
      reject("malformed", false);
      return;
    }
    if (store.isMissingUpdates) {
      this.#working.delete(project.id);
      reject("incomplete", false);
      return;
    }
    if (change.written.some((written) => checkWritten(written.path, written.raw))) {
      this.#working.delete(project.id);
      reject("invalid", false);
      return;
    }
    if (store.getState().manifest.id !== project.projectId) {
      this.#working.delete(project.id);
      reject("identity", false);
      return;
    }
    const { delta } = change;
    if (!delta || isEmptyUpdate(delta)) {
      this.#send(side, { t: "ack", id: message.id, seq: project.head, digest: project.digest });
      return;
    }
    if (message.kind === "repair") this.effectiveRepairs += 1;
    project.head += 1;
    project.digest = digestOf(project.digest, project.head, delta);
    const update: PlatformUpdate = {
      seq: project.head,
      digest: project.digest,
      data: delta,
      kind: message.kind,
      device: side.device,
      base: message.base,
      behind: message.behind,
    };
    project.updates.push(update);
    this.#send(side, { t: "ack", id: message.id, seq: update.seq, digest: update.digest });
    for (const other of this.#sides) {
      if (other === side || other.project !== project) continue;
      this.#send(other, {
        t: "update",
        seq: update.seq,
        digest: update.digest,
        kind: update.kind,
        at: 0,
        payload: delta,
      });
    }
    if (project.updates.length > this.compactAfter) {
      project.snapshot = { seq: project.head, digest: project.digest, state: store.encodeWhole() };
      project.updates = [];
    }
  }
}

/** For tests: what windows of one browser say to each other, in memory. */
export class MemoryLines {
  readonly #listeners = new Map<string, Set<(message: unknown) => void>>();

  line(key: string): CloudLine {
    const listeners = this.#listeners.get(key) ?? new Set();
    this.#listeners.set(key, listeners);
    const own = new Set<(message: unknown) => void>();
    return {
      post: (message) => {
        const copy = structuredClone(message);
        for (const listener of listeners) {
          if (!own.has(listener)) void Promise.resolve().then(() => listener(copy));
        }
      },
      listen: (listener) => {
        listeners.add(listener);
        own.add(listener);
        return () => {
          listeners.delete(listener);
          own.delete(listener);
        };
      },
      close: () => {
        for (const listener of own) listeners.delete(listener);
        own.clear();
      },
    };
  }
}

let browsers = 0;

/** For tests: what a browser keeps about syncing, which its windows share. */
export class TestCloudBrowser {
  readonly links = new MemoryCloudLinks();
  readonly writers = new MemoryWriters();
  readonly lines = new MemoryLines();
  /** Which browser this is, see `MemoryPlatform.drop`. */
  readonly tag = `browser${++browsers}`;

  readonly platform: MemoryPlatform;
  readonly user: string;

  constructor(platform: MemoryPlatform, user: string) {
    this.platform = platform;
    this.user = user;
  }

  /** The platform as a window of this browser reaches it. */
  access(page: WriterPage): CloudAccess {
    return {
      platform: "https://platform.test",
      connect: () => this.platform.connect(this.user, this.tag),
      list: async () => {
        await this.platform.answers();
        return this.platform.list(this.user);
      },
      remove: async (project, options) => {
        await this.platform.answers();
        return this.platform.remove(this.user, project, options);
      },
      wake: async (project, options) => {
        await this.platform.answers();
        return this.platform.wake(this.user, project, options);
      },
      links: this.links,
      syncer: (key) => this.writers.writer(`cloud.${key}`, page),
      line: (key) => this.lines.line(key),
    };
  }
}

/** What the platform says of a project, as `RepositoryAccess.status` would, for a browser. */
export const statusFor =
  (browser: TestCloudBrowser) =>
  async (project: string): Promise<RepositoryStatus> => {
    await browser.platform.answers();
    return browser.platform.status(browser.user, project);
  };

/** Time that only moves when a test says so, for the waits of a session. */
export class TestTime implements CloudEnvironment {
  #now = 1_000_000;
  #next = 1;
  readonly #timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  readonly #wakers = new Set<() => void>();
  online = true;
  readonly #losers = new Set<() => void>();

  now = () => this.#now;
  random = () => 0.5;
  isOnline = () => this.online;

  onWake(listener: () => void): () => void {
    this.#wakers.add(listener);
    return () => this.#wakers.delete(listener);
  }

  /** The network is back, or the window came back. */
  wake(): void {
    for (const waker of this.#wakers) waker();
  }

  onOffline(listener: () => void): () => void {
    this.#losers.add(listener);
    return () => this.#losers.delete(listener);
  }

  /** The network goes away, as the browser says. */
  goOffline(): void {
    this.online = false;
    for (const loser of this.#losers) loser();
  }

  setTimeout = (run: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), run });
    return id;
  };

  clearTimeout = (timer: unknown): void => {
    this.#timers.delete(timer as number);
  };

  /** Moves on by this long, running what is due on the way, and what that sets off. */
  async advance(ms: number): Promise<void> {
    const until = this.#now + ms;
    for (;;) {
      await settle();
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .toSorted(([a, x], [b, y]) => x.at - y.at || a - b)[0];
      if (!due) break;
      const [id, timer] = due;
      this.#timers.delete(id);
      this.#now = Math.max(this.#now, timer.at);
      timer.run();
    }
    this.#now = until;
    await settle();
  }
}

/** The network of one browser, on the clock that all of them share. */
export class TestNetwork implements CloudEnvironment {
  online = true;
  readonly #wakers = new Set<() => void>();

  readonly time: TestTime;

  constructor(time: TestTime) {
    this.time = time;
  }

  now = () => this.time.now();
  random = () => this.time.random();
  isOnline = () => this.online && this.time.online;
  setTimeout = (run: () => void, ms: number) => this.time.setTimeout(run, ms);
  clearTimeout = (timer: unknown) => this.time.clearTimeout(timer);

  onWake(listener: () => void): () => void {
    this.#wakers.add(listener);
    const stop = this.time.onWake(listener);
    return () => {
      this.#wakers.delete(listener);
      stop();
    };
  }

  wake(): void {
    for (const waker of this.#wakers) waker();
  }

  readonly #losers = new Set<() => void>();

  onOffline(listener: () => void): () => void {
    this.#losers.add(listener);
    return () => this.#losers.delete(listener);
  }

  /** The network of this browser goes away, as the browser says. */
  goOffline(): void {
    this.online = false;
    for (const loser of this.#losers) loser();
  }
}

/** Lets everything that waits on promises and the next turn go on, a few times over. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}
