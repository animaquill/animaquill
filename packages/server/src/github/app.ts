import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { GitHubUnavailable, installationFrom, type GitHubInstallation } from "./client.ts";
import { GitHubRest, messageOf, type RestOptions } from "./rest.ts";

/**
 * The GitHub App speaking for itself: a JWT signed with its private key, and with that, tokens of
 * an installation for one repository at a time. Saving projects to GitHub uses those, not the
 * tokens of people: they can be had at any moment, whoever is signed in, and reach only the one
 * repository, with `contents: write` and nothing else.
 *
 * Tokens stay in memory, for as long as GitHub lets them work less a margin, and never go anywhere
 * else: not into the database, the log, or an answer.
 */

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/**
 * A JWT that speaks for the App, for ten minutes at most as GitHub allows: a minute back to allow
 * for clocks, nine ahead. GitHub takes the client id as the issuer, as well as the App's number.
 */
export const appJwt = (issuer: string, privateKey: string | KeyObject, now = Date.now()) => {
  const seconds = Math.floor(now / 1000);
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: issuer }));
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${base64url(signature)}`;
};

/** Why the App cannot have a token for a repository of an installation. */
export type InstallationTrouble =
  /** The App is not installed there any more. */
  | "uninstalled"
  | "suspended"
  /** The repository is not one the installation covers, or not there at all. */
  | "gone";

export class InstallationRefused extends Error {
  override name = "InstallationRefused";
  readonly reason: InstallationTrouble;
  constructor(reason: InstallationTrouble, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Pages of the App's installations looked through at most, see `installationOf`. */
const INSTALLATION_PAGES = 10;
/** A token is used until this long before GitHub stops taking it. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Tokens kept at most, of all repositories together. */
const MOST_TOKENS = 1000;

export interface GitHubAppOptions extends RestOptions {
  /** The client id of the App, or its number: what the JWT says it is. */
  readonly issuer: string;
  readonly privateKey: string;
  readonly now?: () => number;
}

export interface InstallationInfo {
  readonly id: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly suspended: boolean;
}

export class GitHubApp {
  readonly #rest: GitHubRest;
  readonly #issuer: string;
  readonly #key: KeyObject;
  readonly #now: () => number;
  readonly #tokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

  constructor(options: GitHubAppOptions) {
    this.#rest = new GitHubRest(options);
    this.#issuer = options.issuer;
    this.#key = createPrivateKey(options.privateKey);
    this.#now = options.now ?? Date.now;
  }

  #jwt(): string {
    return appJwt(this.#issuer, this.#key, this.#now());
  }

  /**
   * A token of an installation that reaches only this repository, and only its contents. Rejects
   * with InstallationRefused when the installation or the repository says no, and GitHubUnavailable
   * when GitHub could not be asked, or does not take the App's own key.
   */
  async token(installationId: number, repoId: number, { fresh = false } = {}): Promise<string> {
    const key = `${installationId}:${repoId}`;
    const kept = this.#tokens.get(key);
    if (kept && !fresh && kept.expiresAt - TOKEN_MARGIN_MS > this.#now()) return kept.token;
    this.#tokens.delete(key);
    const answer = await this.#rest.call(`/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      bearer: this.#jwt(),
      body: { repository_ids: [repoId], permissions: { contents: "write" } },
    });
    const what = "POST /app/installations/{id}/access_tokens";
    const json = answer.json as { token?: unknown; expires_at?: unknown } | undefined;
    if (answer.status === 201 && typeof json?.token === "string") {
      const expiresAt =
        typeof json.expires_at === "string" ? Date.parse(json.expires_at) : Number.NaN;
      this.#keep(key, json.token, Number.isFinite(expiresAt) ? expiresAt : this.#now() + 3600_000);
      return json.token;
    }
    const later = GitHubRest.unavailable(what, answer);
    if (later) throw later;
    // GitHub does not take the App's own key: nothing an installation can do about that.
    if (answer.status === 401) throw new GitHubUnavailable(`${what}: the App's key is refused`);
    if (answer.status === 403 || answer.status === 404 || answer.status === 422) {
      const installation = await this.installation(installationId);
      if (!installation) throw new InstallationRefused("uninstalled", "the App is not installed");
      if (installation.suspended)
        throw new InstallationRefused("suspended", "the installation is suspended");
      throw new InstallationRefused("gone", `the installation does not cover the repository`);
    }
    throw new GitHubUnavailable(`${what}: ${answer.status} ${messageOf(answer)}`.trim());
  }

  /** The token GitHub turned down: the next one is new. */
  forget(installationId: number, repoId: number): void {
    this.#tokens.delete(`${installationId}:${repoId}`);
  }

  /** An installation of the App, or undefined where there is none of that number. */
  async installation(installationId: number): Promise<InstallationInfo | undefined> {
    const answer = await this.#rest.call(`/app/installations/${installationId}`, {
      bearer: this.#jwt(),
    });
    if (answer.status === 404) return undefined;
    const json = answer.json as
      | { id?: unknown; suspended_at?: unknown; account?: { id?: unknown; login?: unknown } }
      | undefined;
    if (answer.status === 200 && typeof json?.id === "number") {
      return {
        id: json.id,
        accountId: typeof json.account?.id === "number" ? json.account.id : 0,
        accountLogin: typeof json.account?.login === "string" ? json.account.login : "",
        suspended: typeof json.suspended_at === "string" && json.suspended_at !== "",
      };
    }
    throw (
      GitHubRest.unavailable("GET /app/installations/{id}", answer) ??
      new GitHubUnavailable(`GET /app/installations/{id}: ${answer.status}`)
    );
  }

  /**
   * The installation of the App on an account as GitHub has it now, by the App's own key: by the
   * account's name, and where that finds none (it was renamed), among all installations of the App,
   * by its number. Undefined where the App is not installed there. For what the platform may not
   * have heard of, as an installation made again whose webhook was lost.
   */
  async installationOf(account: {
    readonly id: number;
    readonly login: string;
  }): Promise<GitHubInstallation | undefined> {
    const bearer = this.#jwt();
    const ask = async (what: string, path: string) => {
      const answer = await this.#rest.call(path, { bearer });
      const later = GitHubRest.unavailable(what, answer);
      if (later) throw later;
      if (answer.status === 404) return undefined;
      if (answer.status !== 200)
        throw new GitHubUnavailable(`${what}: ${answer.status} ${messageOf(answer)}`.trim());
      return answer.json;
    };
    const byName = installationFrom(
      await ask(
        "GET /users/{login}/installation",
        `/users/${encodeURIComponent(account.login)}/installation`,
      ),
    );
    if (byName?.accountId === account.id) return byName;
    for (let page = 1; page <= INSTALLATION_PAGES; page++) {
      const listed = await ask(
        "GET /app/installations",
        `/app/installations?per_page=100&page=${page}`,
      );
      const items = Array.isArray(listed) ? listed : [];
      for (const item of items) {
        const installation = installationFrom(item);
        if (installation?.accountId === account.id) return installation;
      }
      if (items.length < 100) break;
    }
    return undefined;
  }

  #keep(key: string, token: string, expiresAt: number): void {
    if (this.#tokens.size >= MOST_TOKENS) {
      const now = this.#now();
      for (const [other, kept] of this.#tokens)
        if (kept.expiresAt - TOKEN_MARGIN_MS <= now) this.#tokens.delete(other);
      // Still full: the oldest go, as a Map keeps them in the order they came.
      for (const other of this.#tokens.keys()) {
        if (this.#tokens.size < MOST_TOKENS) break;
        this.#tokens.delete(other);
      }
    }
    this.#tokens.set(key, { token, expiresAt });
  }
}
