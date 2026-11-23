import type { Tx } from "../database.ts";

/**
 * Who may get an account. Someone GitHub knows who has none yet is either let in as they sign in
 * (`admit`), or waits (`signups`), with what GitHub gave sealed, until they give a code on a page of
 * the site (`POST /api/auth/signup`), and the policy says whether it is one (`redeem`). On the
 * platform it is an invite code; for a server of one team, a list of who may (`allowList`). Without
 * a policy nobody new gets in.
 */
export interface PeoplePolicy {
  /**
   * In the transaction that would make the account, as someone without one comes back from GitHub:
   * what to note of them once the account is there, in the same transaction, or undefined where
   * they wait for a code instead. Not asked of someone who has an account.
   */
  admit?(tx: Tx, person: GitHubPerson, at: Date): Promise<Admitted | undefined>;
  /**
   * In the transaction that makes the account: undefined where the code is not one (any more), or
   * what to note of it once the account is there, in the same transaction.
   */
  redeem(tx: Tx, code: string, at: Date): Promise<Admitted | undefined>;
}

/** Who someone is on GitHub, as signing in found out. */
export interface GitHubPerson {
  readonly id: number;
  readonly login: string;
}

export interface Admitted {
  onCreated(tx: Tx, userId: string): Promise<void>;
}

/** Nobody new gets in. */
export const NOBODY_NEW: PeoplePolicy = { redeem: async () => undefined };

const NOTHING_TO_NOTE: Admitted = { onCreated: async () => {} };

/**
 * Those on the list get an account as they first sign in, with no code; nobody else gets one. Each
 * is a GitHub account: by its number (which stays as the account is renamed, so the safer one), or
 * by its login, as GitHub has it now, in any case. Someone taken off the list keeps the account they
 * have: that is for whoever runs the server to disable.
 */
export const allowList = (people: readonly (number | string)[]): PeoplePolicy => {
  const ids = new Set<number>();
  const logins = new Set<string>();
  for (const each of people) {
    if (typeof each === "number") {
      if (!Number.isSafeInteger(each) || each <= 0)
        throw new Error(`not a number of a GitHub account: ${each}`);
      ids.add(each);
    } else {
      const login = each.trim().toLowerCase();
      if (!/^[a-z\d](?:[a-z\d-]{0,38})$/.test(login))
        throw new Error(`not a login of GitHub: ${JSON.stringify(each)}`);
      logins.add(login);
    }
  }
  return {
    admit: async (_tx, person) =>
      ids.has(person.id) || logins.has(person.login.toLowerCase()) ? NOTHING_TO_NOTE : undefined,
    redeem: async () => undefined,
  };
};
