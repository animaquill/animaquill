import type { Config } from "../config.ts";
import type { Db, Logger } from "../database.ts";
import { createGitHubClient, type GitHubClient } from "../github/client.ts";
import type { GitHubEventHandler } from "../github/webhook.ts";
import { createSealer } from "../seal.ts";
import { createAccounts, type Accounts } from "./accounts.ts";
import type { PeoplePolicy } from "./people.ts";
import { accountEvents, type AccountEventsOptions } from "./events.ts";
import { githubTokenFor, type TokenOptions } from "./tokens.ts";

export interface AccountsSetup {
  /** Undefined when nobody can sign in: see `problems`. */
  readonly accounts: Accounts | undefined;
  /** Where people install the App. */
  readonly installUrl: string | undefined;
  readonly onGitHubEvent: GitHubEventHandler;
  /**
   * A working GitHub access token of a person, for what comes after signing in (phase 5, steps 13
   * and on). See `githubTokenFor`: SignInNeeded means they have to sign in again.
   */
  readonly githubTokenFor:
    ((userId: string, options?: TokenOptions) => Promise<string>) | undefined;
  /** Why nobody can sign in, for the log. Names of settings, never their values. */
  readonly problems: readonly string[];
}

export const callbackUrlOf = (config: Config) => `${config.publicOrigin}/api/auth/github/callback`;

/** Accounts, from the settings, as far as they allow. Nothing here reaches the database yet. */
export const setUpAccounts = (
  config: Config,
  db: Db,
  {
    fetch,
    log,
    events,
    people,
    withoutGitHub = false,
  }: {
    readonly fetch?: typeof globalThis.fetch;
    readonly log?: Logger;
    /** Who may get an account, see people.ts: nobody new unless said. */
    readonly people?: PeoplePolicy;
    /** What webhooks call for besides accounts, such as archives, see auth/events.ts. */
    readonly events?: AccountEventsOptions;
    /**
     * Accounts also without the GitHub App, where the person of this machine signs in without it
     * (`Accounts.localSession`), as the backend of `npx animaquill` does. Only GitHub then.
     */
    readonly withoutGitHub?: boolean;
  } = {},
): AccountsSetup => {
  const { github } = config;
  const problems: string[] = [];
  if (!github.appId || !github.clientId)
    problems.push("GITHUB_APP_ID or GITHUB_CLIENT_ID is not set");
  if (!github.clientSecret) problems.push("GITHUB_CLIENT_SECRET is not set: nobody can sign in");
  if (!github.appSlug) problems.push("GITHUB_APP_SLUG is not set: nobody can install the App");
  let client: GitHubClient | undefined;
  if (github.appId && github.clientId && github.clientSecret) {
    client = createGitHubClient({
      webUrl: github.webUrl,
      apiUrl: github.apiUrl,
      appId: github.appId,
      appSlug: github.appSlug ?? "",
      clientId: github.clientId,
      clientSecret: github.clientSecret,
      ...(fetch && { fetch }),
    });
  }
  // Without the master key nothing can be kept, so nobody signs in. The log says why already.
  const sealer = config.masterKeys ? createSealer(config.masterKeys) : undefined;
  const accounts =
    (client || withoutGitHub) && sealer
      ? createAccounts({
          db,
          sealer,
          github: client,
          callbackUrl: callbackUrlOf(config),
          ...(log && { log }),
          ...(people && { people }),
        })
      : undefined;
  return {
    accounts,
    installUrl: client && github.appSlug ? client.installUrl() : undefined,
    onGitHubEvent: accountEvents(db, { ...events, ...(log && !events?.log && { log }) }),
    githubTokenFor:
      client && sealer
        ? (userId, options) => githubTokenFor(db, sealer, client, userId, options)
        : undefined,
    problems,
  };
};
