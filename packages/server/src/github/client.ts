/**
 * What the platform asks of GitHub for people's accounts: the authorization of the App (sign-in),
 * its tokens, who the person is, and where the App is installed. Tokens go in and come out of here
 * and nowhere else; nothing here logs, and errors say what failed, never with a token or a code in
 * them.
 */

/** The tokens of an authorization. Times are when they stop working. */
export interface GitHubTokens {
  readonly accessToken: string;
  readonly accessExpiresAt: Date | undefined;
  readonly refreshToken: string | undefined;
  readonly refreshExpiresAt: Date | undefined;
}

export type TokenAnswer =
  | { readonly ok: true; readonly tokens: GitHubTokens }
  /** What GitHub said, such as `bad_refresh_token` or `bad_verification_code`. */
  | { readonly ok: false; readonly error: string };

export interface GitHubUser {
  readonly id: number;
  readonly login: string;
  readonly avatarUrl: string | undefined;
}

export interface GitHubInstallation {
  readonly id: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositorySelection: string;
  readonly suspendedAt: Date | undefined;
}

/** GitHub could not be asked, or said something that makes no sense: try again later. */
export class GitHubUnavailable extends Error {
  override name = "GitHubUnavailable";
  /** How long GitHub asked to wait, as when it limits how often it is asked. */
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** GitHub does not take the token any more. */
export class GitHubUnauthorized extends Error {
  override name = "GitHubUnauthorized";
}

export interface GitHubClient {
  /** Where the browser goes to authorize the App, and comes back to `redirectUri` from. */
  authorizeUrl(options: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
  }): string;
  /** Where people install the App on their account. */
  installUrl(): string;
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenAnswer>;
  /** The refresh token works once: after this, only what came back does. */
  refresh(refreshToken: string): Promise<TokenAnswer>;
  user(accessToken: string): Promise<GitHubUser>;
  /** The installations of this App that the person can see, their own account's among them. */
  installations(accessToken: string): Promise<readonly GitHubInstallation[]>;
  /**
   * Takes an access token back, with the App's own credentials, so that it stops working at once.
   * Resolves to whether GitHub did; never rejects.
   */
  revokeToken(accessToken: string): Promise<boolean>;
}

export interface GitHubClientOptions {
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly appId: string;
  readonly appSlug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** For tests, a GitHub of their own. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const USER_AGENT = "AnimaQuill";
/**
 * How long a call may take. Shorter than the time a refresh may hold its lock in the database, see
 * auth/tokens.ts, so that a GitHub that hangs never keeps a connection for long.
 */
const TIMEOUT_MS = 10_000;

const date = (value: unknown): Date | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/** An installation as GitHub describes it, in the REST API and in webhooks alike. */
export const installationFrom = (value: unknown): GitHubInstallation | undefined => {
  const item = value as Record<string, any> | null | undefined;
  const account = item?.account as Record<string, unknown> | null | undefined;
  if (!isNumber(item?.id) || !isNumber(account?.id) || typeof account?.login !== "string")
    return undefined;
  return {
    id: item.id,
    accountId: account.id,
    accountLogin: account.login,
    accountType: typeof account.type === "string" ? account.type : "User",
    repositorySelection:
      typeof item.repository_selection === "string" ? item.repository_selection : "selected",
    suspendedAt: date(item.suspended_at),
  };
};

export const createGitHubClient = (options: GitHubClientOptions): GitHubClient => {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  /** The answer as JSON. Anything that is not an answer of GitHub is GitHubUnavailable. */
  const send = async (url: string, init: RequestInit): Promise<{ status: number; json: any }> => {
    let response: Response;
    try {
      response = await request(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The address has no secret in it; what went wrong is the kind of error only.
      throw new GitHubUnavailable(
        `${init.method ?? "GET"} ${new URL(url).pathname}: ${error instanceof Error ? error.name : "failed"}`,
      );
    }
    const text = await response.text().catch(() => "");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  };

  const api = async (path: string, accessToken: string) => {
    const { status, json } = await send(`${options.apiUrl}${path}`, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (status === 401) throw new GitHubUnauthorized(`GET ${path}: 401`);
    if (status !== 200 || json === undefined) throw new GitHubUnavailable(`GET ${path}: ${status}`);
    return json;
  };

  /** The token endpoint says no with 200 and an `error`. */
  const tokens = async (fields: Record<string, string>): Promise<TokenAnswer> => {
    const now = Date.now();
    const { status, json } = await send(`${options.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        ...fields,
      }),
    });
    if (status !== 200 || typeof json !== "object" || json === null)
      throw new GitHubUnavailable(`POST /login/oauth/access_token: ${status}`);
    if (typeof json.access_token !== "string" || !json.access_token)
      return {
        ok: false,
        error: typeof json.error === "string" ? json.error.slice(0, 100) : "no_token",
      };
    const after = (name: string) =>
      isNumber(json[name]) && json[name] > 0 ? new Date(now + json[name] * 1000) : undefined;
    return {
      ok: true,
      tokens: {
        accessToken: json.access_token,
        accessExpiresAt: after("expires_in"),
        refreshToken:
          typeof json.refresh_token === "string" && json.refresh_token
            ? json.refresh_token
            : undefined,
        refreshExpiresAt: after("refresh_token_expires_in"),
      },
    };
  };

  return {
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL(`${options.webUrl}/login/oauth/authorize`);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.href;
    },
    installUrl: () => `${options.webUrl}/apps/${options.appSlug}/installations/new`,
    exchangeCode: (code, verifier, redirectUri) =>
      tokens({ code, code_verifier: verifier, redirect_uri: redirectUri }),
    refresh: (refreshToken) => tokens({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async user(accessToken) {
      const json = await api("/user", accessToken);
      if (!isNumber(json?.id) || typeof json.login !== "string")
        throw new GitHubUnavailable("GET /user: no id or login");
      return {
        id: json.id,
        login: json.login,
        avatarUrl:
          typeof json.avatar_url === "string" && json.avatar_url.startsWith("https://")
            ? json.avatar_url
            : undefined,
      };
    },
    async revokeToken(accessToken) {
      const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");
      try {
        const { status } = await send(`${options.apiUrl}/applications/${options.clientId}/token`, {
          method: "DELETE",
          headers: {
            "user-agent": USER_AGENT,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            authorization: `Basic ${basic}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_token: accessToken }),
        });
        // 404: GitHub has no such token any more, which is what this was for.
        return status === 204 || status === 404;
      } catch {
        return false;
      }
    },
    async installations(accessToken) {
      const found: GitHubInstallation[] = [];
      // A person sees few installations; ten pages are far more than anyone has.
      for (let page = 1; page <= 10; page++) {
        const json = await api(`/user/installations?per_page=100&page=${page}`, accessToken);
        const list: unknown[] = Array.isArray(json?.installations) ? json.installations : [];
        for (const item of list) {
          const installation = installationFrom(item);
          if (installation && String((item as { app_id?: unknown }).app_id) === options.appId)
            found.push(installation);
        }
        if (list.length < 100) break;
      }
      return found;
    },
  };
};
