import { GitHubUnavailable } from "./client.ts";

/**
 * Calls of GitHub's REST API for saving projects to GitHub: with a token of the App's installation
 * (archive/github-host.ts) or a person's (archive/service.ts), or the App's own JWT (app.ts). Nothing
 * here logs; errors name the call, never a token, and what GitHub answered only as its status and,
 * for what it refused, its message.
 */

export interface RestOptions {
  readonly apiUrl: string;
  /** For tests, a GitHub of their own. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface RestAnswer {
  readonly status: number;
  /** The JSON of the answer, or undefined when it had none or something else. */
  readonly json: any;
  readonly headers: Headers;
}

export interface CallOptions {
  readonly method?: string;
  /** "Bearer <this>": a token, or the App's JWT. */
  readonly bearer?: string;
  /** "Basic" with a user and a password, as Git and Git LFS take a token, in place of `bearer`. */
  readonly basic?: readonly [string, string];
  readonly body?: unknown;
  /** What the body is and what is asked for, where it is not GitHub's own JSON: Git LFS's. */
  readonly mediaType?: string;
  /** Stops the call, along with its own time, as a piece of work that ran out of its time. */
  readonly signal?: AbortSignal | undefined;
}

const USER_AGENT = "AnimaQuill";
/** Longer than a call of the sign-in, as a tree or a commit of a large project takes a while. */
const TIMEOUT_MS = 30_000;

/** What GitHub says about refusing an archive, short enough for a log and for people. */
export const messageOf = (answer: RestAnswer): string => {
  const message = (answer.json as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message.slice(0, 200) : "";
};

/**
 * How long GitHub asks to wait, when it limits how often it is asked: `retry-after`, or the reset
 * of a primary limit that is used up. Undefined where the answer is not about that.
 */
export const retryAfterOf = (answer: RestAnswer, now = Date.now()): number | undefined => {
  if (answer.status !== 403 && answer.status !== 429) return undefined;
  const after = Number(answer.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return after * 1000;
  if (answer.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(answer.headers.get("x-ratelimit-reset"));
    return Number.isFinite(reset) ? Math.max(1000, reset * 1000 - now) : 60_000;
  }
  if (/rate limit/i.test(messageOf(answer))) return 60_000;
  return answer.status === 429 ? 60_000 : undefined;
};

export class GitHubRest {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: RestOptions) {
    this.#apiUrl = options.apiUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * One call. Rejects with GitHubUnavailable when GitHub could not be asked; any answer, a refusal
   * included, resolves, for the caller to tell what it means.
   */
  async call(path: string, options: CallOptions = {}): Promise<RestAnswer> {
    return this.request(`${this.#apiUrl}${path}`, options);
  }

  /**
   * One call of an address of GitHub other than its REST API, such as Git LFS's on the web site, as
   * `call`. Errors name its path, without the query.
   */
  async request(url: string, options: CallOptions = {}): Promise<RestAnswer> {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const path = new URL(url).pathname;
    const media = options.mediaType;
    const authorization =
      options.basic !== undefined
        ? `Basic ${Buffer.from(`${options.basic[0]}:${options.basic[1]}`).toString("base64")}`
        : options.bearer !== undefined
          ? `Bearer ${options.bearer}`
          : undefined;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          "user-agent": USER_AGENT,
          accept: media ?? "application/vnd.github+json",
          ...(media === undefined && { "x-github-api-version": "2022-11-28" }),
          ...(authorization !== undefined && { authorization }),
          ...(options.body !== undefined && { "content-type": media ?? "application/json" }),
        },
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
        redirect: "manual",
        signal:
          options.signal === undefined
            ? AbortSignal.timeout(this.#timeoutMs)
            : AbortSignal.any([AbortSignal.timeout(this.#timeoutMs), options.signal]),
      });
    } catch (error) {
      throw new GitHubUnavailable(
        `${method} ${path}: ${error instanceof Error ? error.name : "failed"}`,
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new GitHubUnavailable(
        `${method} ${path}: ${error instanceof Error ? error.name : "failed"} while reading`,
      );
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, headers: response.headers };
  }

  /** GitHubUnavailable for an answer that says to come back later: 5xx, or a limit. */
  static unavailable(what: string, answer: RestAnswer): GitHubUnavailable | undefined {
    const wait = retryAfterOf(answer);
    if (wait !== undefined) return new GitHubUnavailable(`${what}: limited`, wait);
    if (answer.status >= 500) return new GitHubUnavailable(`${what}: ${answer.status}`);
    return undefined;
  }
}
