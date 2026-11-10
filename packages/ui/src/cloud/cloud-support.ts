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
  type CloudLine,
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
  head: number;
  digest: string;
  /** What came after the snapshot, which is all there is before it was made. */
  updates: PlatformUpdate[];
  snapshot:
    { readonly seq: number; readonly digest: string; readonly state: Uint8Array } | undefined;
  /** Snapshots made before changes made without the latest came in, see the design, 7.6. */
  readonly beforeMerge: { readonly seq: number; readonly device: string }[];
}

interface ServerSide {
  readonly user: string;
  /** Which browser it is, for a test to drop its connections. */
  readonly tag: string;
  readonly deliver: (data: Uint8Array) => void;
  readonly close: (code: number) => void;
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
  /** Repairs that brought the platform something it did not have, see "check". */
  effectiveRepairs = 0;
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
      frames: new Reassembler(SYNC_LIMITS.update),
      deliver: (data) =>
        down.carry(data, () => {
          if (isClosed || this.faults.silent) return;
          toClient(data);
        }),
      close: (code) => end(code),
    };
    const end = (code: number) => {
      if (isClosed) return;
      isClosed = true;
      this.#sides.delete(side);
      later(() => resolveClosed({ code, reason: "" }));
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
      close: () => end(1000),
    };
  }

  /** The session of a user ends: their connections close, saying so, until `signIn`. */
  signOut(user: string): void {
    this.signedOut.add(user);
    for (const side of this.#sides) if (side.user === user) side.close(SYNC_CLOSE.signedOut);
  }

  signIn(user: string): void {
    this.signedOut.delete(user);
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
    let project = this.projects.get(message.project);
    let created = false;
    if (project && project.owner !== side.user) {
      side.close(SYNC_CLOSE.missing);
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
    side.project = project;
    const known = message.after > 0 ? this.#digestAt(project, message.after) : "";
    const reset =
      message.after > project.head ||
      (known !== undefined && message.digest !== undefined && message.digest !== known);
    const after = reset ? 0 : created ? project.head : message.after;
    this.#send(side, { t: "welcome", head: project.head, digest: project.digest, reset });
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
    if (!project) {
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
      list: async () =>
        [...this.platform.projects.values()]
          .filter((project) => project.owner === this.user)
          .map((project) => ({ id: project.id, name: project.projectId, updatedAt: 0 })),
      links: this.links,
      syncer: (key) => this.writers.writer(`cloud.${key}`, page),
      line: (key) => this.lines.line(key),
    };
  }
}

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
