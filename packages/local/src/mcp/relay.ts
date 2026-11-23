import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  BRIDGE_MAX_BYTES,
  BRIDGE_PROTOCOL,
  fromPage,
  proofText,
  readMessage,
  type BridgeClient,
  type BridgeResult,
  type BridgeSession,
  type BridgeWaiting,
  type FromPage,
  type PageProject,
  type ToPage,
} from "@animaquill/tools";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { RelayIdentity } from "./identity.ts";
import type { AllowedOrigins } from "./origins.ts";
import { openBrowser } from "../open-browser.ts";
import { peerAuth, peerProof, readPeer, relayProof } from "./peer.ts";
import { lastOrigin, rememberOrigin } from "./state.ts";
import { isOwnUser } from "./uid.ts";

/**
 * The relay of the AI tools on this computer (docs/design/online-offline.md of AnimaQuill Cloud,
 * 5.1): the first `animaquill mcp` listens on 127.0.0.1, the others connect to it as peers, and
 * editors in the browser connect to it as pages. Each call of an AI tool goes to the one page that
 * has its project open and takes calls for it, and its result comes back the same way. Nothing of a
 * project is kept here: sessions say what they work on, pages say what they have open.
 *
 * Who gets in (5.2): only connections to 127.0.0.1 by that name or `localhost` (`Host`, which keeps
 * other sites out by DNS rebinding); pages only from origins that are allowed (`Origin`, which pages
 * cannot make up); peers only without `Origin`, as no page can connect without one, and only once
 * they prove the key of this user (`RelayIdentity.mac`); on Linux, only connections of this user.
 * Pages check the relay themselves, by its signature.
 */

/** What a session works on, as the `animaquill mcp` it is of found it. */
export type Target =
  /** The project in a folder: the page whose folder has the file of the probe in it. */
  | {
      readonly kind: "folder";
      readonly id: string;
      /** What the project is called, as animaquill.json says, for people waiting for it. */
      readonly name?: string;
      readonly root: string;
      readonly probe: { readonly path: string; readonly nonce: string };
    }
  /** An online project by its address. */
  | { readonly kind: "link"; readonly origin: string; readonly project: string }
  /** Whatever project was in front last, and the one found so once there is one. */
  | { readonly kind: "front"; readonly bound?: Bound };

/** The project a session found, as it goes on to look for it. */
export interface Bound {
  readonly origin: string;
  readonly project: PageProject;
}

export interface SessionInfo {
  readonly session: string;
  readonly client?: BridgeClient;
  readonly target: Target;
  readonly since: number;
}

export interface CallRequest {
  readonly call: string;
  readonly session: string;
  readonly answer: string;
  readonly tool: string;
  readonly args: unknown;
  /** It went before, to a relay that went away: see `ToPage`. */
  readonly again?: boolean;
}

/** What the router tells of a call before its answer. */
export interface CallEvents {
  /** It went to a page, where it may run. */
  readonly dispatched?: () => void;
  /** It waits for an editor, as this says, for people. */
  readonly progress?: (message: string) => void;
}

export type CallAnswer =
  | { readonly kind: "result"; readonly result: BridgeResult; readonly bound: Bound }
  /**
   * No page has the project open and takes calls for it. `gaveUp`: an editor was waited for since
   * `WAIT_GIVE_UP_MS` ago, and none came.
   */
  | { readonly kind: "no-page"; readonly gaveUp?: true }
  /** An editor is being opened for it, and it did not come in `OPEN_WAIT_MS`: nothing ran. */
  /**
   * An editor is waited for, and did not come in `OPEN_WAIT_MS`: nothing ran. `opened`: the browser
   * was opened on it; `asked`: the editors that are open say that AI tools wait for it.
   */
  | { readonly kind: "opening"; readonly name: string; readonly how: "opened" | "asked" }
  /** A page has the project open, and the browser does not let it at its folder. */
  | { readonly kind: "needs-permission"; readonly name: string }
  /** The page went away while the call ran. */
  | { readonly kind: "gone" };

/** How often pages are asked whether they are there, and how long one may not answer. */
export const PING_EVERY_MS = 10_000;
export const PAGE_SILENT_MS = 30_000;
/** How many pages and peers the relay takes at once: more is no browser and AI tools of one person. */
export const MAX_PAGES = 32;
export const MAX_PEERS = 64;

/** How long a call waits for a page that has its project, before it says there is none. */
export const PAGE_WAIT_MS = 5_000;
/**
 * How long a call waits for an editor once it waits for one (design 5.5), and how long after the
 * first such wait an editor is still waited for at all.
 */
export const OPEN_WAIT_MS = 20_000;
export const WAIT_GIVE_UP_MS = 2 * 60_000;
/** How long after one project was opened in the browser it is not opened again. */
const OPENED_AGAIN_MS = 2 * 60_000;

/** How long a page has to look for the file of a probe. */
const PROBE_MS = 5_000;

interface PageConnection {
  readonly ws: WebSocket;
  readonly origin: string;
  /** What it says of itself: nothing is routed to it before. */
  info: Extract<FromPage, { t: "page" }> | undefined;
  heardAt: number;
}

interface Session extends SessionInfo {
  /** The page instance it works with now, and what that page has open. */
  page: string | undefined;
  bound: Bound | undefined;
  /** Pages whose folder had the probe, by page instance, and those whose folder did not. */
  readonly probed: Set<string>;
  readonly notProbed: Set<string>;
  /** When it began to wait for an editor, while it does. */
  waitingSince: number | undefined;
  /** An editor was opened in the browser for it once. */
  opened: boolean;
  /** It waited for an editor until `WAIT_GIVE_UP_MS`, and none came. */
  gaveUp: boolean;
  /** Where the browser opens its project, as `#addressOf` checked it, while it waits. */
  address: string | undefined;
}

/** What the router needs to open an editor in the browser, see `Router.call`. */
export interface Opening {
  /** The origin of the editor that connected last, which a folder opens on. */
  readonly lastOrigin: () => Promise<string | undefined>;
  /** Whether a site is one that may take calls, as people allowed it now. */
  readonly allowed: (origin: string) => Promise<boolean>;
  readonly open: (url: string) => void;
  readonly openWaitMs?: number;
  readonly giveUpMs?: number;
}

/** What a page answered to a call, before the router says which project it was. */
type PageAnswer =
  { readonly kind: "result"; readonly result: BridgeResult } | { readonly kind: "gone" };

interface Pending {
  readonly page: string;
  readonly resolve: (answer: PageAnswer) => void;
}

const send = (ws: WebSocket, message: ToPage | Record<string, unknown>) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};

const textOf = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.from(data as ArrayBuffer).toString("utf8");

/**
 * Which project a session waits for, for people: none for one that has not found any yet. Its
 * address is none that a page said: only the one `#addressOf` checked goes to pages.
 */
function waitingOf(
  session: Session,
): Omit<BridgeWaiting, "clients" | "notHere" | "link"> | undefined {
  const { target } = session;
  switch (target.kind) {
    case "folder":
      return {
        key: `offline\n${target.id}`,
        mode: "offline",
        id: target.id,
        name: target.name ?? target.id,
      };
    case "link": {
      const link = `${target.origin}/p/${encodeURIComponent(target.project)}`;
      return { key: `online\n${link}`, mode: "online", name: link };
    }
    case "front": {
      // What it found, which the session itself may not have said again yet.
      const bound = session.bound ?? target.bound;
      const project = bound?.project;
      if (!project) return undefined;
      return project.mode === "offline"
        ? { key: `offline\n${project.id}`, mode: "offline", id: project.id, name: project.name }
        : {
            key: `online\n${bound?.origin}\n${project.key}`,
            mode: "online",
            id: project.id,
            name: project.name,
          };
    }
  }
}

/** Calls to pages and what they answer, for sessions of this process and of peers alike. */
export class Router {
  readonly #opening: Opening | undefined;
  /** When each project was last opened in the browser, by `waitingKey`. */
  readonly #openedAt = new Map<string, number>();
  readonly #pages = new Map<WebSocket, PageConnection>();
  readonly #sessions = new Map<string, Session>();
  readonly #pending = new Map<string, Pending>();
  readonly #probes = new Map<string, (found: boolean | undefined) => void>();
  readonly #listeners = new Set<() => void>();
  readonly #searching = new Map<string, Promise<PageConnection | undefined>>();

  constructor(opening?: Opening) {
    this.#opening = opening;
  }

  /** Hears of every change of pages and sessions, for tests. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get pageCount(): number {
    return this.#pages.size;
  }

  get pages(): readonly NonNullable<PageConnection["info"]>[] {
    return [...this.#pages.values()].flatMap(({ info }) => (info ? [info] : []));
  }

  addSession(info: SessionInfo): void {
    const known = this.#sessions.get(info.session);
    // What it found is kept, also where it says it again without it, after the relay changed.
    const bound = (info.target.kind === "front" ? info.target.bound : undefined) ?? known?.bound;
    this.#sessions.set(info.session, {
      ...info,
      page: known?.page,
      bound,
      probed: known?.probed ?? new Set(),
      notProbed: known?.notProbed ?? new Set(),
      waitingSince: known?.waitingSince,
      opened: known?.opened ?? false,
      gaveUp: known?.gaveUp ?? false,
      address: known?.address,
    });
    void this.#bindAll();
  }

  removeSession(session: string): void {
    if (!this.#sessions.delete(session)) return;
    this.#tellSessions();
    this.#tellWaiting();
  }

  /** Runs a call on the page of its session's project. */
  async call(
    request: CallRequest,
    signal?: AbortSignal,
    events: CallEvents = {},
  ): Promise<CallAnswer> {
    const session = this.#sessions.get(request.session);
    if (!session) return { kind: "no-page" };
    // One that waits for an editor already waits for it at once.
    const first = session.waitingSince === undefined ? PAGE_WAIT_MS : 0;
    let page = await this.#waitForPage(session, signal, first);
    if (!page) {
      const waited = await this.#waitForEditor(session, signal, events);
      if (waited.kind !== "page") return waited;
      page = waited.page;
    }
    const info = page.info;
    const project = info?.project;
    if (!info || !project) return { kind: "no-page" };
    const answer = await new Promise<PageAnswer>((resolve) => {
      const onAbort = () => send(page.ws, { t: "cancel", call: request.call });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(request.call, {
        page: info.page,
        resolve: (done) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(done);
        },
      });
      // From here it may run: going again, it says so (`ElectedLink`).
      events.dispatched?.();
      send(page.ws, {
        t: "call",
        call: request.call,
        session: request.session,
        ...(session.client && { client: session.client }),
        answer: request.answer,
        tool: request.tool,
        args: request.args,
        project: { mode: project.mode, key: project.key },
        ...(request.again && { again: true }),
      });
    });
    return answer.kind === "result"
      ? { kind: "result", result: answer.result, bound: { origin: page.origin, project } }
      : answer;
  }

  /**
   * The page of a session, waiting a moment for one: pages connect again right after the relay
   * changed, and say what they have open a little after they connect.
   */
  async #waitForPage(
    session: Session,
    signal: AbortSignal | undefined,
    ms: number,
  ): Promise<PageConnection | undefined> {
    const until = Date.now() + ms;
    for (;;) {
      const page = await this.#pageOf(session);
      if (page || signal?.aborted || Date.now() >= until) return page;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, until - Date.now());
        const stop = this.onChange(done);
        function done() {
          clearTimeout(timer);
          stop();
          resolve();
        }
      });
    }
  }

  /**
   * Waits for an editor to open the project of a session, after `PAGE_WAIT_MS` found none (design
   * 5.5): a page that has it open and is not let at its folder says so at once; otherwise the pages
   * that are connected show that AI tools wait for it, and where none is, the browser opens it,
   * once a session and once in `OPENED_AGAIN_MS` a project. Then `OPEN_WAIT_MS`, and the call says
   * the editor is being opened; `WAIT_GIVE_UP_MS` after the first wait, that none came.
   */
  async #waitForEditor(
    session: Session,
    signal: AbortSignal | undefined,
    events: CallEvents,
  ): Promise<
    | { readonly kind: "page"; readonly page: PageConnection }
    | Exclude<CallAnswer, { kind: "result" | "gone" }>
  > {
    const blocked = this.#blockedFor(session);
    if (blocked) return { kind: "needs-permission", name: blocked };
    // Waited for in vain once: not again, until an editor has the project.
    if (session.gaveUp) return { kind: "no-page", gaveUp: true };
    const opening = this.#opening;
    const waiting = waitingOf(session);
    if (!opening || !waiting) return { kind: "no-page" };
    const now = Date.now();
    // Where nothing can bring an editor, there is nothing to wait for: no page that people see, and
    // nothing to open in the browser.
    const shown = [...this.#pages.values()].some(({ info }) => info !== undefined);
    const url = await this.#addressOf(session, opening);
    session.address = url;
    if (!shown && !session.opened && url === undefined) return { kind: "no-page" };
    if (session.waitingSince === undefined) {
      const since = now;
      session.waitingSince = since;
      // The notices go once it waited as long as it does, whether a call comes again or not.
      setTimeout(() => {
        if (session.waitingSince !== since) return;
        session.waitingSince = undefined;
        session.gaveUp = true;
        this.#tellWaiting();
      }, opening.giveUpMs ?? WAIT_GIVE_UP_MS).unref();
    }
    if (now - session.waitingSince >= (opening.giveUpMs ?? WAIT_GIVE_UP_MS)) {
      session.waitingSince = undefined;
      session.gaveUp = true;
      this.#tellWaiting();
      return { kind: "no-page", gaveUp: true };
    }
    this.#tellWaiting();
    if (shown) {
      events.progress?.(`waiting for the AnimaQuill editor to open "${waiting.name}"`);
    } else if (!session.opened) {
      const last = this.#openedAt.get(waiting.key);
      if (url && (last === undefined || now - last >= OPENED_AGAIN_MS)) {
        session.opened = true;
        this.#openedAt.set(waiting.key, now);
        opening.open(url);
        events.progress?.(`opening the AnimaQuill editor on "${waiting.name}"`);
      }
    }
    const page = await this.#waitForPage(session, signal, opening.openWaitMs ?? OPEN_WAIT_MS);
    if (!page) {
      const late = this.#blockedFor(session);
      return late
        ? { kind: "needs-permission", name: late }
        : {
            kind: "opening",
            name: waiting.name,
            how: session.opened || this.#openedAt.has(waiting.key) ? "opened" : "asked",
          };
    }
    session.waitingSince = undefined;
    this.#tellWaiting();
    return { kind: "page", page };
  }

  /** The name of the project of a session, where a page has it open and is not let at its folder. */
  #blockedFor(session: Session): string | undefined {
    const { target } = session;
    for (const { info } of this.#pages.values()) {
      const project = info?.project;
      if (info?.blocked !== "needs-permission" || !project) continue;
      const fits =
        target.kind === "folder"
          ? project.mode === "offline" && project.id === target.id
          : target.kind === "link"
            ? project.mode === "online" && project.key === target.project
            : (session.bound ?? target.bound) !== undefined &&
              project.mode === (session.bound ?? target.bound)?.project.mode &&
              project.key === (session.bound ?? target.bound)?.project.key;
      if (fits) return project.name;
    }
    return undefined;
  }

  /** Where the browser opens the project of a session, checked against the sites allowed now. */
  async #addressOf(session: Session, opening: Opening): Promise<string | undefined> {
    const { target } = session;
    const bound = target.kind === "front" ? (session.bound ?? target.bound) : undefined;
    let url: URL | undefined;
    try {
      if (target.kind === "link") {
        url = new URL(`/p/${encodeURIComponent(target.project)}`, target.origin);
      } else if (bound?.project.mode === "online") {
        url = new URL(`/p/${encodeURIComponent(bound.project.key)}`, bound.origin);
      } else {
        const id =
          target.kind === "folder"
            ? target.id
            : bound?.project.mode === "offline"
              ? bound.project.id
              : undefined;
        const origin = bound ? bound.origin : await opening.lastOrigin();
        if (id === undefined || origin === undefined) return undefined;
        url = new URL("/offline", origin);
        url.searchParams.set("open", id);
        // What it is called, for a browser that has no folder of it yet.
        const name = target.kind === "folder" ? target.name : bound?.project.name;
        if (name) url.searchParams.set("name", name.slice(0, 200));
      }
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    return (await opening.allowed(url.origin)) ? url.href : undefined;
  }

  /** Tells every page which projects AI tools wait for, each once. */
  #tellWaiting(): void {
    const byProject = new Map<string, BridgeWaiting>();
    for (const session of this.#sessions.values()) {
      if (session.waitingSince === undefined) continue;
      const waiting = waitingOf(session);
      if (!waiting) continue;
      const known = byProject.get(waiting.key);
      const clients = [
        ...(known?.clients ?? []),
        ...(session.client ? [session.client] : [{ name: "" }]),
      ];
      const notHere = [
        ...new Set([
          ...(known?.notHere ?? []),
          ...[...session.notProbed].map((instance) => instance.split("\n")[0] ?? ""),
        ]),
      ];
      const link = known?.link ?? (waiting.mode === "online" ? session.address : undefined);
      byProject.set(waiting.key, {
        ...waiting,
        ...(link !== undefined && { link }),
        clients,
        ...(notHere.length > 0 && { notHere }),
      });
    }
    const message = { t: "waiting", waiting: [...byProject.values()] };
    for (const page of this.#pages.values()) send(page.ws, message);
  }

  /** A page connected, already checked. */
  addPage(ws: WebSocket, origin: string): void {
    const page: PageConnection = { ws, origin, info: undefined, heardAt: Date.now() };
    this.#pages.set(ws, page);
    ws.on("message", (data) => this.#fromPage(page, textOf(data)));
    ws.on("close", () => this.#pageGone(page));
    ws.on("error", () => ws.terminate());
    // Pages answer what this asks: a page in the background has slow timers, but hears messages.
    const ping = setInterval(() => {
      if (Date.now() - page.heardAt > PAGE_SILENT_MS) ws.terminate();
      else send(ws, { t: "ping" });
    }, PING_EVERY_MS);
    ping.unref();
    ws.once("close", () => clearInterval(ping));
    this.#tellSessions(page);
    this.#tellWaiting();
  }

  #fromPage(page: PageConnection, raw: string): void {
    const message = readMessage(fromPage, raw);
    if (!message) {
      page.ws.close(1008, "unreadable");
      return;
    }
    page.heardAt = Date.now();
    switch (message.t) {
      case "page": {
        page.info = message;
        void this.#bindAll();
        break;
      }
      case "result": {
        const pending = this.#pending.get(message.call);
        // Only the page it went to answers it.
        if (!pending || pending.page !== page.info?.page) return;
        this.#pending.delete(message.call);
        pending.resolve({ kind: "result", result: message.result });
        break;
      }
      case "probed": {
        const key = `${page.info?.page}\n${message.probe}`;
        this.#probes.get(key)?.(message.found);
        break;
      }
      case "pong":
        break;
    }
    this.#changed();
  }

  #pageGone(page: PageConnection): void {
    this.#pages.delete(page.ws);
    const instance = page.info?.page;
    if (instance !== undefined) {
      // Another connection of the same page instance may be there already, after the relay changed.
      const still = [...this.#pages.values()].some(({ info }) => info?.page === instance);
      if (!still) {
        for (const [call, pending] of this.#pending) {
          if (pending.page !== instance) continue;
          this.#pending.delete(call);
          pending.resolve({ kind: "gone" });
        }
      }
    }
    void this.#bindAll();
  }

  /** The page a session works with now, finding one where it has none: one search at a time. */
  #pageOf(session: Session): Promise<PageConnection | undefined> {
    const searching = this.#searching.get(session.session);
    if (searching) return searching;
    const search = this.#search(session).finally(() => {
      this.#searching.delete(session.session);
    });
    this.#searching.set(session.session, search);
    return search;
  }

  async #search(session: Session): Promise<PageConnection | undefined> {
    const now = this.#serving().find(({ info }) => info?.page === session.page);
    if (now && this.#fits(session, now)) return now;
    session.page = undefined;
    const found = await this.#find(session);
    if (!found?.info?.project) return undefined;
    session.page = found.info.page;
    session.bound = { origin: found.origin, project: found.info.project };
    session.gaveUp = false;
    // What it waited for is open: the notices of it go, call or not.
    if (session.waitingSince !== undefined) {
      session.waitingSince = undefined;
      this.#tellWaiting();
    }
    this.#tellSessions();
    return found;
  }

  #serving(): PageConnection[] {
    return [...this.#pages.values()]
      .filter(({ info }) => info?.serving === true && info.project !== undefined)
      .toSorted((a, b) => (b.info?.frontAt ?? 0) - (a.info?.frontAt ?? 0));
  }

  /** Whether a page has what the session works on, as far as it can tell without asking it. */
  #fits(session: Session, page: PageConnection): boolean {
    const project = page.info?.project;
    if (!project) return false;
    const { target } = session;
    switch (target.kind) {
      case "folder":
        return (
          project.mode === "offline" &&
          project.id === target.id &&
          session.probed.has(`${page.info?.page ?? ""}\n${project.key}`)
        );
      case "link":
        return (
          project.mode === "online" &&
          page.origin === target.origin &&
          project.key === target.project
        );
      case "front": {
        const bound = session.bound;
        return (
          bound === undefined ||
          (bound.origin === page.origin &&
            bound.project.mode === project.mode &&
            bound.project.key === project.key)
        );
      }
    }
  }

  async #find(session: Session): Promise<PageConnection | undefined> {
    const { target } = session;
    const serving = this.#serving();
    if (target.kind !== "folder") return serving.find((page) => this.#fits(session, page));
    const candidates = serving.filter(
      ({ info }) => info?.project?.mode === "offline" && info.project.id === target.id,
    );
    for (const page of candidates) {
      // A page and the folder it has open: another folder in the same page is probed anew.
      const instance = `${page.info?.page ?? ""}\n${page.info?.project?.key ?? ""}`;
      if (session.probed.has(instance)) return page;
      if (session.notProbed.has(instance)) continue;
      const found = await this.#probe(page, target.probe);
      if (found) {
        session.probed.add(instance);
        return page;
      }
      // Another folder with the same project: a copy.
      if (found === false) session.notProbed.add(instance);
    }
    return undefined;
  }

  /** Asks a page whether its folder has the file of a probe, which only the folder meant has. */
  #probe(
    page: PageConnection,
    probe: { path: string; nonce: string },
  ): Promise<boolean | undefined> {
    const id = randomBytes(9).toString("base64url");
    const key = `${page.info?.page}\n${id}`;
    return new Promise((resolve) => {
      // Undefined where the page did not answer: busy, or gone, which says nothing of its folder.
      const done = (found: boolean | undefined) => {
        clearTimeout(timer);
        this.#probes.delete(key);
        resolve(found);
      };
      const timer = setTimeout(() => done(undefined), PROBE_MS);
      this.#probes.set(key, done);
      page.ws.once("close", () => done(undefined));
      send(page.ws, { t: "probe", probe: id, path: probe.path, nonce: probe.nonce });
    });
  }

  /**
   * Finds pages for sessions that have none, so that pages show who works on them before a call.
   * Not one whose project is whatever is in front: that is the one in front at its first call
   * (design 5.5), not at its start.
   */
  async #bindAll(): Promise<void> {
    for (const session of this.#sessions.values()) {
      if (session.target.kind === "front" && session.bound === undefined) continue;
      await this.#pageOf(session).catch(() => {});
    }
    this.#tellSessions();
  }

  #tellSessions(only?: PageConnection): void {
    const sessions: BridgeSession[] = [...this.#sessions.values()].map((session) => ({
      session: session.session,
      ...(session.client && { client: session.client }),
      since: session.since,
      ...(session.page !== undefined && { page: session.page }),
    }));
    for (const page of only ? [only] : this.#pages.values()) {
      send(page.ws, { t: "sessions", sessions });
    }
    this.#changed();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  close(): void {
    for (const page of this.#pages.values()) page.ws.terminate();
    for (const pending of this.#pending.values()) pending.resolve({ kind: "gone" });
    this.#pending.clear();
  }
}

/** A peer connected, as the relay hears it, once it proved the key. */
export interface PeerConnection {
  readonly ws: WebSocket;
}

export interface RelayOptions {
  readonly identity: RelayIdentity;
  readonly allowed: AllowedOrigins;
  /** `TOOLSET_VERSION` and the hash of the list, which pages compare with theirs. */
  readonly toolset: string;
  readonly list: string;
  /**
   * Where this user's things are (`animaquill mcp`'s home): with it, the relay opens an editor in
   * the browser for a call that finds none, see `Router.call`.
   */
  readonly home?: string;
  /** What opens an address in the browser; `openBrowser` but in tests. */
  readonly open?: (url: string) => void;
  readonly openWaitMs?: number;
  readonly giveUpMs?: number;
  /** Whether a connection is of this user; `isOwnUser` but in tests. */
  readonly ownUser?: (localPort: number, remotePort: number) => Promise<boolean>;
}

/** Why a request to connect was refused, for tests. */
export type Refusal = "host" | "origin" | "path" | "user";

/** Checks a request to connect before it becomes a WebSocket: what `Relay` lets in. */
export async function admit(
  request: IncomingMessage,
  port: number,
  allowed: AllowedOrigins,
  ownUser: (localPort: number, remotePort: number) => Promise<boolean> = isOwnUser,
): Promise<
  { readonly kind: "page"; readonly origin: string } | { readonly kind: "peer" } | Refusal
> {
  const host = request.headers.host?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return "host";
  const { pathname } = new URL(request.url ?? "/", "http://relay");
  const origin = request.headers.origin;
  if (pathname === "/page") {
    if (!allowed.has(origin)) return "origin";
  } else if (pathname === "/peer") {
    // Every page sends one; another `animaquill mcp` none.
    if (origin !== undefined) return "origin";
  } else {
    return "path";
  }
  const remote = request.socket.remotePort;
  if (remote === undefined || !(await ownUser(port, remote))) return "user";
  return pathname === "/page" ? { kind: "page", origin: origin ?? "" } : { kind: "peer" };
}

/** The relay as it listens on one port. */
export class Relay {
  readonly router: Router;
  readonly port: number;
  readonly #server: Server;
  readonly #sockets: WebSocketServer;
  readonly #options: RelayOptions;
  readonly #peers = new Set<WebSocket>();
  /** Peers that connected and did not prove the key yet. */
  #proving = 0;
  /** Pages that are being looked at, before they are pages of the router. */
  #upgrading = 0;
  #onPeer: ((ws: WebSocket) => void) | undefined;

  private constructor(server: Server, port: number, options: RelayOptions) {
    this.#server = server;
    this.port = port;
    this.#options = options;
    const { home, allowed } = options;
    this.router = new Router(
      home === undefined
        ? undefined
        : {
            lastOrigin: () => lastOrigin(home),
            allowed: async (origin) => {
              await allowed.reload().catch(() => {});
              return allowed.has(origin);
            },
            open: options.open ?? openBrowser,
            ...(options.openWaitMs !== undefined && { openWaitMs: options.openWaitMs }),
            ...(options.giveUpMs !== undefined && { giveUpMs: options.giveUpMs }),
          },
    );
    this.#sockets = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_MAX_BYTES });
    server.on("request", (request, response) => void this.#request(request, response));
    server.on("upgrade", (request, socket, head) => void this.#upgrade(request, socket, head));
  }

  /** Listens on the port, or undefined where something listens there already. */
  static listen(port: number, options: RelayOptions): Promise<Relay | undefined> {
    const server = createServer();
    const relay = new Relay(server, port, options);
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(undefined);
        else reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(relay);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port, exclusive: true });
    });
  }

  /** What to do with each peer once it proved the key. */
  onPeer(handler: (ws: WebSocket) => void): void {
    this.#onPeer = handler;
  }

  /**
   * `GET /ping`, the one thing here without a WebSocket: whether this is a relay, and whether it
   * takes the site that asks, so that the editor can tell people why it cannot connect. It says
   * nothing else, and proves nothing: the editor connects only to a relay that proves its key.
   */
  async #request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host?.toLowerCase();
    const { pathname } = new URL(request.url ?? "/", "http://relay");
    const origin = request.headers.origin;
    if (
      request.method !== "GET" ||
      pathname !== "/ping" ||
      (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) ||
      origin === undefined
    ) {
      response.writeHead(404, { "content-type": "text/plain" }).end();
      return;
    }
    await this.#options.allowed.reload().catch(() => {});
    response
      .writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": origin,
        vary: "Origin",
        "cache-control": "no-store",
      })
      .end(JSON.stringify({ relay: true, allowed: this.#options.allowed.has(origin) }));
  }

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    // What `animaquill mcp allow-origin` added since this relay started counts at once.
    const isPage = new URL(request.url ?? "/", "http://relay").pathname === "/page";
    if (!isPage) {
      await this.#admitted(request, socket, head);
      return;
    }
    // A page is counted from here, while it is being looked at.
    this.#upgrading += 1;
    try {
      await this.#options.allowed.reload().catch(() => {});
      await this.#admitted(request, socket, head);
    } finally {
      this.#upgrading -= 1;
    }
  }

  async #admitted(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const { allowed, ownUser } = this.#options;
    const admitted = await admit(request, this.port, allowed, ownUser).catch(() => "user" as const);
    const full =
      typeof admitted !== "string" &&
      (admitted.kind === "page"
        ? this.router.pageCount + this.#upgrading - 1 >= MAX_PAGES
        : this.#peers.size + this.#proving >= MAX_PEERS);
    if (typeof admitted === "string" || full) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    this.#sockets.handleUpgrade(request, socket, head, (ws) => {
      if (admitted.kind === "page") this.#page(ws, request, admitted.origin);
      else this.#peer(ws);
    });
  }

  #page(ws: WebSocket, request: IncomingMessage, origin: string): void {
    const nonce = new URL(request.url ?? "/", "http://relay").searchParams.get("nonce") ?? "";
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(nonce)) {
      ws.close(1008, "nonce");
      return;
    }
    const { identity, toolset, list } = this.#options;
    send(ws, {
      t: "hello",
      protocol: BRIDGE_PROTOCOL,
      toolset,
      list,
      key: identity.publicKey,
      signature: identity.sign(proofText(nonce, origin, this.port)),
    });
    this.router.addPage(ws, origin);
    // The site an editor for a folder opens on, next time one is opened.
    if (this.#options.home !== undefined) {
      void rememberOrigin(this.#options.home, origin).catch(() => {});
    }
  }

  /**
   * A peer proves the key first: it gets a nonce, answers with a proof of it and a nonce of its own,
   * and gets the proof of that. Before that nothing else of it is heard.
   */
  #peer(ws: WebSocket): void {
    const { identity } = this.#options;
    const nonce = randomBytes(18).toString("base64url");
    this.#proving += 1;
    let proving = true;
    const settle = () => {
      if (!proving) return;
      proving = false;
      this.#proving -= 1;
    };
    const timer = setTimeout(() => ws.terminate(), 5_000);
    ws.once("close", () => {
      clearTimeout(timer);
      settle();
    });
    ws.once("message", (data) => {
      clearTimeout(timer);
      settle();
      const message = readPeer(peerAuth, textOf(data));
      if (!message || !identity.checks(peerProof(nonce, this.port), message.mac)) {
        ws.close(1008, "key");
        return;
      }
      send(ws, { t: "peer-ok", mac: identity.mac(relayProof(message.nonce, this.port)) });
      this.#peers.add(ws);
      ws.once("close", () => this.#peers.delete(ws));
      this.#onPeer?.(ws);
    });
    send(ws, { t: "peer-hello", nonce, protocol: BRIDGE_PROTOCOL });
  }

  close(): Promise<void> {
    this.router.close();
    for (const peer of this.#peers) peer.terminate();
    for (const ws of this.#sockets.clients) ws.terminate();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
