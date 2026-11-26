import {
  CloudSignedOut,
  type AccountAccess,
  type AccountSnapshot,
  type AccountSpace,
  type SignInOutcome,
} from "@animaquill/host";
import { REQUEST_HEADER } from "./headers.ts";

/**
 * The account on the backend of the editor's site (`@animaquill/server`), for the editor's account
 * menu: the API under /api/auth, see auth/routes.ts there. Signing in leaves for GitHub and comes
 * back to this address, with how it ended in `signIn`, which this takes out of the address as soon
 * as the page loads.
 */

/** GitHub's pictures of accounts: the only place the account menu shows them from, unless said. */
export const GITHUB_PICTURES = "https://avatars.githubusercontent.com";

const OUTCOMES: Readonly<Record<string, SignInOutcome>> = {
  ok: "signedIn",
  cancelled: "cancelled",
  failed: "failed",
  expired: "expired",
  busy: "busy",
  unavailable: "unavailable",
  disabled: "disabled",
};
const OUTCOME_PARAM = "signIn";
/** Coming back to the window asks again, but not more often than this. */
const ASK_AGAIN_MS = 30_000;
/** How long the platform has to say who is signed in: a line that hangs keeps nobody waiting. */
const ASK_TIMEOUT_MS = 15_000;

/** How the sign-in that brought this page here ended, taken out of the address. */
const takeOutcomeFromAddress = (): SignInOutcome | undefined => {
  const url = new URL(location.href);
  const value = url.searchParams.get(OUTCOME_PARAM);
  if (value === null) return undefined;
  url.searchParams.delete(OUTCOME_PARAM);
  // A reload says nothing again, and a link people copy says nothing either.
  history.replaceState(history.state, "", url);
  return OUTCOMES[value];
};

/** The picture at the size it shows at, twice over for sharp screens; only from `pictures`. */
const pictureOf = (address: unknown, pictures: string): string | undefined => {
  if (typeof address !== "string" || !address.startsWith(`${pictures}/`)) return undefined;
  const url = new URL(address);
  url.searchParams.set("s", "64");
  return url.href;
};

/** The id of whoever is signed in on the platform, which projects there say whose they are by. */
const idOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Who is signed in, as GET /api/auth/session says it, with pictures only from `pictures`. */
export const describeSession = (body: unknown, pictures = GITHUB_PICTURES): AccountSnapshot => {
  const answer = body as {
    status?: unknown;
    id?: unknown;
    user?: { id?: unknown; login?: unknown; avatarUrl?: unknown };
    app?: { installed?: unknown };
    repositories?: unknown;
  } | null;
  if (answer?.status !== "signedIn" || typeof answer.user?.login !== "string")
    return { status: "signedOut" };
  const picture = pictureOf(answer.user.avatarUrl, pictures);
  // With the person, or next to the status: either is the id of the person on the platform.
  const id = idOf(answer.user.id) ?? idOf(answer.id);
  return {
    status: "signedIn",
    ...(id !== undefined && { id }),
    name: answer.user.login,
    ...(picture && { picture }),
    appInstalled: answer.app?.installed === true,
    ...((answer.repositories === "local" || answer.repositories === "none") && {
      repositories: answer.repositories,
    }),
  };
};

const SPACE_MODES: readonly AccountSpace["mode"][] = ["on", "readonly", "off"];
const isSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The cloud space as GET /api/me/storage says it, see me/routes.ts of the server. */
export const describeSpace = (body: unknown): AccountSpace => {
  const answer = body as { mode?: unknown; limit?: unknown; used?: unknown } | null;
  const mode = SPACE_MODES.find((each) => each === answer?.mode);
  if (!mode || !isSize(answer?.limit) || !isSize(answer.used))
    throw new Error("The platform said something else than a cloud space");
  return { mode, limit: answer.limit, used: answer.used };
};

export interface ServerAccountOptions {
  /** Where the pictures of accounts may come from: GitHub's unless said. */
  readonly pictures?: string;
}

/** The account on the backend of this site. */
export function serverAccount(options: ServerAccountOptions = {}): AccountAccess {
  const pictures = options.pictures ?? GITHUB_PICTURES;
  let outcome = takeOutcomeFromAddress();
  let snapshot: AccountSnapshot = { status: "unknown" };
  let askedAt = 0;
  let asking: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const show = (next: AccountSnapshot) => {
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  /** This page as it is now, to come back to. */
  const here = () => encodeURIComponent(location.pathname + location.search);

  const ask = async () => {
    try {
      const response = await fetch("/api/auth/session", {
        cache: "no-store",
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`The platform answered ${response.status}`);
      show(describeSession(await response.json(), pictures));
    } catch (error) {
      // What was known stays: the next time the window comes back asks again.
      console.warn("Who is signed in is not known now", error);
    } finally {
      askedAt = Date.now();
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh() {
      if (asking) return asking;
      if (snapshot.status !== "unknown" && Date.now() - askedAt < ASK_AGAIN_MS)
        return Promise.resolve();
      asking = ask().finally(() => {
        asking = undefined;
      });
      return asking;
    },
    takeOutcome() {
      const taken = outcome;
      outcome = undefined;
      return taken;
    },
    signIn(returnTo) {
      const back = returnTo === undefined ? here() : encodeURIComponent(returnTo);
      location.assign(`/api/auth/github/start?returnTo=${back}`);
    },
    installApp() {
      location.assign(`/api/auth/github/install?returnTo=${here()}`);
    },
    async space() {
      const response = await fetch("/api/me/storage", {
        cache: "no-store",
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      });
      if (response.status === 401) throw new CloudSignedOut("Nobody is signed in");
      if (!response.ok) throw new Error(`The platform answered ${response.status}`);
      return describeSpace(await response.json());
    },
    async signOut() {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { [REQUEST_HEADER]: "1" },
      });
      if (!response.ok) throw new Error(`The platform answered ${response.status}`);
      askedAt = Date.now();
      show({ status: "signedOut" });
    },
  };
}
