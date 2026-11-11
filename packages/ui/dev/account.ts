import type { AccountAccess, AccountSnapshot, SignInOutcome } from "@animaquill/host";

/**
 * For the browser tests (`?account=fake`): an account the way a host with accounts has one, kept in
 * this tab. Signing in and installing the App leave the page and come back to it as it was, the way
 * they do with a real one, by loading the address again.
 */

const KEY = "animaquill.fakeAccount";

interface State {
  readonly signedIn: boolean;
  readonly installed: boolean;
  readonly outcome?: SignInOutcome;
}

const read = (): State => {
  try {
    return (
      JSON.parse(sessionStorage.getItem(KEY) ?? "null") ?? { signedIn: false, installed: false }
    );
  } catch {
    return { signedIn: false, installed: false };
  }
};

const write = (state: State) => sessionStorage.setItem(KEY, JSON.stringify(state));

export function fakeAccount(): AccountAccess {
  let snapshot: AccountSnapshot = { status: "unknown" };
  const listeners = new Set<() => void>();
  const show = (next: AccountSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const leaveFor = (state: State) => {
    write(state);
    location.assign(location.pathname + location.search);
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    async refresh() {
      const state = read();
      show(
        state.signedIn
          ? { status: "signedIn", id: "user-octo", name: "octo", appInstalled: state.installed }
          : { status: "signedOut" },
      );
    },
    takeOutcome() {
      const { outcome, ...rest } = read();
      if (outcome) write(rest);
      return outcome;
    },
    signIn: () => leaveFor({ ...read(), signedIn: true, outcome: "signedIn" }),
    installApp: () => leaveFor({ ...read(), installed: true, outcome: "signedIn" }),
    async signOut() {
      write({ ...read(), signedIn: false });
      show({ status: "signedOut" });
    },
  };
}
