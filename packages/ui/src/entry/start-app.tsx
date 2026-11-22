import "../theme/tokens.css";
import type { AccountAccess, AccountSnapshot, Host } from "@animaquill/host";
import {
  browserModeMemory,
  createOfflineHost,
  createOnlineHost,
  dropUnscopedData,
  isSafariAgent,
  modeOfPath,
  pathOf,
  projectOfPath,
  unscopedUnsent,
  type ModeMemory,
} from "@animaquill/host/browser";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createI18n } from "../i18n/i18n.ts";
import { mountEditor, type EditorOptions } from "../mount.tsx";
import { EntryPage, type EntryProblem } from "./EntryPage.tsx";

/**
 * How a page of the editor starts (docs/design/online-offline.md of AnimaQuill Cloud, 1 and 2.2):
 * in the mode its address says, with the host of that mode. A site with a backend is online for
 * whoever is signed in there, and shows the entry page (signing in, or the offline mode) to
 * whoever is not; the offline mode connects to nothing of the backend, not once. A site without a
 * backend only has the offline mode.
 */

/** What a site with a backend has, for the online mode. */
export interface SiteBackend {
  /** The backend, as the site of the page: what the scope of what this browser keeps names. */
  readonly backend: string;
  /** The account on it. Asked once the page knows it is not offline. */
  readonly account: () => AccountAccess;
  /** What the online host gets of the backend besides the account, made once it is known whose. */
  readonly parts: () => Pick<Host, "cloud" | "aiRelay" | "diagnostics">;
}

export interface AppOptions extends Omit<EditorOptions, "host"> {
  /** The backend of the site. Without it there is only the offline mode. */
  readonly online?: SiteBackend;
  /** For the development page: what it adds to the host, in either mode. */
  readonly extend?: (host: Host) => Host;
  /** For tests: what this browser remembers of the modes. */
  readonly memory?: ModeMemory;
}

/** How long the page waits for the backend before it shows the entry page, saying it waits. */
const WAIT_SHOWN_MS = 800;
/** How long the entry waits to hear who is signed in before it goes by what it remembers. */
const ASK_MS = 15_000;

/** Starts the page of the editor in `element`, in its mode. */
export async function startApp(element: HTMLElement, options: AppOptions): Promise<void> {
  const { online, extend = (host) => host, memory = browserModeMemory(), ...editor } = options;
  const path = location.pathname;
  const goTo = (to: string) => {
    const url = new URL(to, location.href);
    // What else the address says, as the development page has it, stays.
    url.search = location.search;
    return url;
  };

  const offline = () => {
    // A site without a backend has only this, whatever the address said.
    if (modeOfPath(path) !== "offline")
      history.replaceState(history.state, "", goTo(pathOf("offline", projectOfPath(path))));
    const host = createOfflineHost(
      online
        ? {
            goOnline: () => {
              memory.setPrefersOffline(false);
              // Whoever is still signed in goes straight there; anybody else signs in first.
              if (memory.lastAccount(online.backend)) location.assign(goTo("/"));
              else online.account().signIn("/");
            },
          }
        : {},
    );
    void dropOld();
    return mountEditor(element, { ...editor, host: extend(host) });
  };

  // Safari clears what a site keeps after seven days without a visit: no offline mode there, where
  // there is an online one (the user, 2026-11-22).
  const offlineRefused = online !== undefined && isSafariAgent(navigator.userAgent);
  if (!online || (modeOfPath(path) === "offline" && !offlineRefused)) {
    await offline();
    return;
  }
  if (modeOfPath(path) === "offline") history.replaceState(history.state, "", goTo("/"));

  const account = online.account();
  const chooseOffline = () => {
    memory.setPrefersOffline(true);
    location.assign(goTo(pathOf("offline", undefined)));
  };
  // A backend that takes a while to answer gets the entry page meanwhile, saying so: nothing
  // blank, and both ways in work already.
  const entry = entryOn(element);
  const waiting = setTimeout(() => {
    void entry.show({
      account,
      problem: "connecting",
      // Whoever was signed in here before most likely goes on as that: nothing to press meanwhile,
      // which would note a mode they did not mean.
      waiting: memory.lastAccount(online.backend) !== undefined,
      offlineRefused,
      offline: chooseOffline,
      retry: () => location.reload(),
    });
  }, WAIT_SHOWN_MS);
  await Promise.race([
    account.refresh(),
    new Promise<void>((resolve) => setTimeout(resolve, ASK_MS)),
  ]);
  clearTimeout(waiting);
  const snapshot = account.getSnapshot();
  const known = memory.lastAccount(online.backend);
  if (snapshot.status === "signedOut") memory.setLastAccount(online.backend, undefined);
  const who =
    snapshot.status === "signedIn" && snapshot.id !== undefined
      ? { id: snapshot.id, name: snapshot.name }
      : snapshot.status === "unknown"
        ? known
        : undefined;
  if (!who) {
    // The offline mode people chose opens by itself, but not for a link to a project of the
    // online mode: that one asks to sign in, and comes back to it.
    if (
      snapshot.status === "signedOut" &&
      memory.prefersOffline() &&
      !offlineRefused &&
      !projectOfPath(path)
    ) {
      entry.close();
      await offline();
      return;
    }
    await entry.show({
      account,
      problem: snapshot.status === "unknown" ? "unreachable" : outcomeProblem(account),
      offlineRefused,
      offline: chooseOffline,
      retry: () => location.reload(),
    });
    return;
  }
  entry.close();
  memory.setPrefersOffline(false);
  memory.setLastAccount(online.backend, who);
  const host = createOnlineHost({
    backend: online.backend,
    account: who.id,
    parts: { ...online.parts(), account: signsOutToEntry(account, memory, online.backend) },
    ...(!offlineRefused && { offlineAddress: goTo(pathOf("offline", undefined)).href }),
  });
  followAccount(account, who.id);
  void dropOld();
  await mountEditor(element, { ...editor, host: extend(host) });
}

/** Why the entry page shows, from how the sign-in that brought the page here ended. */
function outcomeProblem(account: AccountAccess): EntryProblem | undefined {
  const outcome = account.takeOutcome();
  return outcome === undefined || outcome === "signedIn" ? undefined : outcome;
}

/**
 * Signing out of the online mode ends it: the entry page comes, and what this browser keeps of the
 * account stays, unseen, for when it signs in again (2.1).
 */
function signsOutToEntry(
  account: AccountAccess,
  memory: ModeMemory,
  backend: string,
): AccountAccess {
  return {
    ...account,
    async signOut() {
      await account.signOut();
      memory.setLastAccount(backend, undefined);
      const url = new URL(pathOf("online", undefined), location.href);
      // What else the address says stays, as the development page has it.
      url.search = location.search;
      location.assign(url);
    },
  };
}

/**
 * The page is of one account for all its life: where another one signs in, in another window,
 * this one starts again as that one's, as nothing of the one before may go to it.
 */
function followAccount(account: AccountAccess, id: string): void {
  const look = () => {
    const now: AccountSnapshot = account.getSnapshot();
    if (now.status === "signedIn" && now.id !== undefined && now.id !== id) location.reload();
  };
  account.subscribe(look);
}

/**
 * What the editor kept before there were modes goes (docs/design/online-offline.md of AnimaQuill
 * Cloud, 6): it cannot be read any more. Not while its links say that the platform may not have
 * changes of this browser yet: those stay for whoever looks for them, and the page says so.
 */
async function dropOld(): Promise<void> {
  try {
    const unsent = await unscopedUnsent();
    if (unsent > 0) {
      console.warn(
        `What this browser kept before 0.3.118 stays: ${unsent} projects may have changes the platform does not have`,
      );
      return;
    }
    await dropUnscopedData();
  } catch (error) {
    console.warn("What this browser kept before stays for now", error);
  }
}

interface EntryOptions {
  readonly account: AccountAccess;
  readonly problem: EntryProblem | undefined;
  /** The ways in cannot be pressed yet. */
  readonly waiting?: boolean;
  /** This browser gets no offline mode, see `startApp`. */
  readonly offlineRefused: boolean;
  readonly offline: () => void;
  readonly retry: () => void;
}

/** The entry page in `element`, shown as often as asked, and gone once the editor comes. */
function entryOn(element: HTMLElement) {
  let root: Root | undefined;
  let closed = false;
  return {
    async show(options: EntryOptions): Promise<void> {
      const i18n = await createI18n();
      if (closed) return;
      root ??= createRoot(element);
      root.render(
        <StrictMode>
          <EntryPage
            t={i18n.t}
            problem={options.problem}
            waiting={options.waiting === true}
            offlineRefused={options.offlineRefused}
            signIn={() => options.account.signIn()}
            offline={options.offline}
            retry={options.retry}
          />
        </StrictMode>,
      );
    },
    close(): void {
      closed = true;
      root?.unmount();
      root = undefined;
    },
  };
}
