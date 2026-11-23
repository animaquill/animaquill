import type { buildApp } from "../app.ts";
import type { FakeGitHub, FakeUser } from "./fake-github.ts";

type App = ReturnType<typeof buildApp>;

/** Like Chrome 157 on Windows, which the sessions then say they are. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

/**
 * A browser for the API's tests, across sites: the editor's, the admin site, both answered by one
 * app, as the gateway sends them there with their host, and a fake GitHub. It keeps cookies by host,
 * as `__Host-` cookies are, and follows redirects from one site to the other until a page.
 */
export class SiteBrowser {
  /** Cookies by host, then by name. */
  readonly jars = new Map<string, Map<string, string>>();
  /** Every Set-Cookie it got, with the host that sent it. */
  readonly setCookies: { readonly host: string; readonly cookie: string }[] = [];
  readonly app: App;
  readonly github: FakeGitHub;
  readonly githubOrigin: string;
  /** Origins whose /api the app answers. */
  readonly sites: readonly string[];
  /** Who is signed in to GitHub in this browser. */
  readonly user: FakeUser;

  constructor(options: {
    readonly app: App;
    readonly github: FakeGitHub;
    readonly githubOrigin: string;
    readonly sites: readonly string[];
    readonly user: FakeUser;
  }) {
    this.app = options.app;
    this.github = options.github;
    this.githubOrigin = options.githubOrigin;
    this.sites = options.sites;
    this.user = options.user;
  }

  /** The cookies of a site. */
  jar(origin: string): Map<string, string> {
    const host = new URL(origin).host;
    let jar = this.jars.get(host);
    if (!jar) {
      jar = new Map();
      this.jars.set(host, jar);
    }
    return jar;
  }

  #take(host: string, header: string | string[] | number | undefined) {
    const all = header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
    const jar = this.jar(`https://${host}`);
    for (const cookie of all) {
      this.setCookies.push({ host, cookie });
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      if (/Max-Age=0\b/.test(cookie)) jar.delete(name);
      else jar.set(name, pair.slice(at + 1));
    }
  }

  /**
   * A request to one of the sites, with that site's cookies. A POST comes from a page of the same
   * site unless `headers` say otherwise, the way `fetch` sends it.
   */
  async request(method: "GET" | "POST", address: string, payload?: unknown, headers = {}) {
    const url = new URL(address);
    const jar = this.jar(url.origin);
    const response = await this.app.inject({
      method,
      url: url.pathname + url.search,
      headers: {
        host: url.host,
        "user-agent": USER_AGENT,
        ...(jar.size > 0 && {
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        }),
        ...(method === "POST" && {
          origin: url.origin,
          "x-animaquill": "1",
          ...(payload !== undefined && { "content-type": "application/json" }),
        }),
        ...headers,
      },
      ...(payload !== undefined && { payload: JSON.stringify(payload) }),
    });
    this.#take(url.host, response.headers["set-cookie"]);
    return response;
  }

  /**
   * Goes to an address and follows where it leads, through the sites and GitHub, until a page:
   * an address of a site that is not its API, or what does not lead on. Resolves to that address, the
   * status it ended with, and every address on the way.
   */
  async go(address: string) {
    let url = new URL(address);
    const visited: string[] = [];
    for (let hop = 0; hop < 12; hop++) {
      visited.push(url.href);
      let status: number;
      let location: string | null;
      if (this.sites.includes(url.origin)) {
        if (!url.pathname.startsWith("/api/")) return { url: url.href, status: 200, visited };
        const response = await this.request("GET", url.href);
        status = response.statusCode;
        location = (response.headers.location as string | undefined) ?? null;
      } else if (url.origin === this.githubOrigin) {
        const response = await this.github.handle(new Request(url), this.user);
        status = response.status;
        location = response.headers.get("location");
      } else throw new Error(`a browser would not go to ${url.href} here`);
      if (status < 300 || status >= 400 || !location) return { url: url.href, status, visited };
      url = new URL(location, url);
    }
    throw new Error("too many redirects");
  }
}
