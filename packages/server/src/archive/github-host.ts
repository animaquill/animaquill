import { GitHubApp, InstallationRefused } from "../github/app.ts";
import { GitHubUnauthorized, GitHubUnavailable } from "../github/client.ts";
import { GitHubRest, messageOf, type RestAnswer, type RestOptions } from "../github/rest.ts";
import {
  LfsQuota,
  RepoPaused,
  RepoRefused,
  blobShaOf,
  bytesOf,
  type CommitInfo,
  type Comparison,
  type LfsAction,
  type LfsAnswer,
  type LfsObject,
  type Person,
  type RepoHost,
  type RepoInfo,
  type GitHubPlace,
  type RepoSession,
  type TreeChange,
  type TreeEntry,
} from "./repo-host.ts";
import { readTarball, TarballTooLarge } from "./tarball.ts";

/**
 * `RepoHost` on GitHub: the Git Data API with a token of the App's installation that reaches only
 * the one repository, and the contents API for the first commit of an empty repository, which the
 * Git Data API does not write to; and the batch API of its large file storage, Git LFS, on the web
 * site, with the same token as the password of Basic (as it was found to
 * work). Also what a person's own token does: make a repository, and list those of their
 * installation, see `GitHubPersonRepos`.
 */

/** What Git LFS's batch API speaks. */
const LFS_MEDIA = "application/vnd.git-lfs+json";
/** Objects one call of the batch API is asked about at most, as Git LFS itself does. */
const LFS_BATCH = 100;
/** What GitHub says where the large file storage of the account has no room or traffic left. */
const QUOTA = /quota|data pack|exceeded.*(?:storage|bandwidth)|(?:storage|bandwidth).*exceeded/i;

/** A file larger than this goes as a blob of its own, not in the request for the tree. */
export const INLINE_BYTES = 256 * 1024;
/** What the files in one request for a tree come to at most; more goes in another on top of it. */
export const TREE_REQUEST_BYTES = 2 * 1024 * 1024;
/** Entries of one request for a tree at most. */
export const TREE_REQUEST_ENTRIES = 1000;
/** Folders a listing of a tree goes into one by one at most, where GitHub cuts a whole one short. */
const MOST_FOLDERS = 5000;
/**
 * Files of a commit read at once (`files`) from which the tarball of the commit is asked for: a few
 * requests in place of one each. Fewer go one by one.
 */
export const TARBALL_FROM = 30;
/**
 * A tarball larger than this, packed, is not read to its end: a repository that has large files
 * committed as they are (videos, say) is read file by file then.
 */
export const TARBALL_MOST_BYTES = 64 * 1024 * 1024;
/** How long a tarball may take, from asking to its end. */
const TARBALL_TIMEOUT_MS = 120_000;
/** Blobs asked for at once, where files are read one by one. */
const BLOBS_AT_ONCE = 8;
/** What GitHub's API is asked with, as GitHubRest asks. */
const USER_AGENT = "AnimaQuill";

const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const personAt = (person: Person, at: Date) => ({ ...person, date: at.toISOString() });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An action of an object in an answer of Git LFS's batch API, as far as it is one. */
const lfsActionOf = (value: unknown, now: number): LfsAction | undefined => {
  if (!isObject(value) || typeof value.href !== "string") return undefined;
  try {
    const { protocol } = new URL(value.href);
    if (protocol !== "https:" && protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  const header: Record<string, string> = {};
  if (isObject(value.header))
    for (const [name, text] of Object.entries(value.header))
      if (typeof text === "string") header[name] = text;
  const expiresAt =
    typeof value.expires_at === "string"
      ? Date.parse(value.expires_at)
      : typeof value.expires_in === "number"
        ? now + value.expires_in * 1000
        : Number.NaN;
  return { href: value.href, header, ...(Number.isFinite(expiresAt) && { expiresAt }) };
};

/** What the batch API said about one object it was asked about. */
const lfsAnswerOf = (
  operation: "upload" | "download",
  item: Record<string, unknown>,
  now: number,
): LfsAnswer => {
  const error = isObject(item.error) ? item.error : undefined;
  if (error)
    return {
      kind: "refused",
      code: typeof error.code === "number" ? error.code : 0,
      message: typeof error.message === "string" ? error.message.slice(0, 200) : "",
    };
  const actions = isObject(item.actions) ? item.actions : {};
  if (operation === "download") {
    const download = lfsActionOf(actions.download, now);
    return download
      ? { kind: "download", download }
      : { kind: "refused", code: 404, message: "no address to download it from" };
  }
  // Nothing to do: the storage has it. The size it says may only be the one it was asked about.
  if (actions.upload === undefined)
    return {
      kind: "present",
      ...(typeof item.size === "number" && Number.isSafeInteger(item.size) && { size: item.size }),
    };
  const upload = lfsActionOf(actions.upload, now);
  if (!upload) return { kind: "refused", code: 0, message: "an address that is none" };
  const verify = lfsActionOf(actions.verify, now);
  return { kind: "upload", upload, ...(verify && { verify }) };
};

/** How long the storage has to say how large an object is. */
const SIZE_TIMEOUT_MS = 30_000;

/** A number of bytes as a header says it. */
const bytesIn = (text: string | null | undefined): number | undefined =>
  text !== null && text !== undefined && /^\d{1,15}$/.test(text) ? Number(text) : undefined;

/**
 * How large the object at a download address is, as the storage says in the headers of its answer:
 * asked with HEAD, and where it does not take that (an address signed for GET alone), with a GET of
 * the first byte, whose answer says the size of all of it. Nothing of the object is kept. Rejects
 * with GitHubUnavailable where it does not say; errors name neither the address nor its headers.
 *
 * Only where the batch API said, as it said it: a redirect is not followed (the headers of the
 * object, which can be a token, would go along), and counts as not saying. Only over https, but
 * where GitHub itself is reached over http (`plain`), as the fake GitHub of the tests is.
 */
async function sizeAt(
  action: LfsAction,
  request: typeof fetch,
  stop?: AbortSignal,
  plain = false,
): Promise<number> {
  if (!plain && new URL(action.href).protocol !== "https:")
    throw new GitHubUnavailable("Git LFS gave an address that is not https");
  const ask = async (method: "HEAD" | "GET") => {
    const headers = new Headers(action.header);
    // As it is kept, not as it would be packed for the way.
    headers.set("accept-encoding", "identity");
    if (method === "GET") headers.set("range", "bytes=0-0");
    try {
      const response = await request(action.href, {
        method,
        headers,
        redirect: "manual",
        signal: stop
          ? AbortSignal.any([AbortSignal.timeout(SIZE_TIMEOUT_MS), stop])
          : AbortSignal.timeout(SIZE_TIMEOUT_MS),
      });
      const whole = /^bytes \d+-\d+\/(\d{1,15})$/.exec(response.headers.get("content-range") ?? "");
      const size =
        response.status === 206
          ? whole
            ? Number(whole[1])
            : undefined
          : response.status === 200
            ? bytesIn(response.headers.get("content-length"))
            : undefined;
      // The first byte, or the whole of it where the storage does not do ranges: not wanted.
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, size };
    } catch (error) {
      throw new GitHubUnavailable(
        `${method} of an object in Git LFS: ${error instanceof Error ? error.name : "failed"}`,
      );
    }
  };
  const head = await ask("HEAD");
  if (head.size !== undefined) return head.size;
  const first = await ask("GET");
  if (first.size !== undefined) return first.size;
  throw new GitHubUnavailable(
    `the storage of Git LFS does not say how large an object is: ${head.status}, ${first.status}`,
  );
}

const repoInfoOf = (json: any): RepoInfo | undefined => {
  if (typeof json?.id !== "number" || typeof json.name !== "string") return undefined;
  const owner = json.owner as { id?: unknown; login?: unknown } | undefined;
  if (typeof owner?.id !== "number" || typeof owner.login !== "string") return undefined;
  return {
    id: json.id,
    ownerId: owner.id,
    owner: owner.login,
    name: json.name,
    branch: typeof json.default_branch === "string" ? json.default_branch : "main",
    private: json.private === true,
    archived: json.archived === true,
    url:
      typeof json.html_url === "string" && json.html_url.startsWith("https://")
        ? json.html_url
        : `https://github.com/${owner.login}/${json.name}`,
  };
};

class GitHubRepoSession implements RepoSession {
  readonly #place: GitHubPlace;
  readonly #app: GitHubApp;
  readonly #rest: GitHubRest;
  readonly #webUrl: string;
  /** GitHub's REST API, which a tarball is asked of. */
  readonly #apiUrl: string;
  /** What stops every call of the session, see `RepoHost.open`. */
  readonly #signal: AbortSignal | undefined;

  /** The time of a call, and what stops the session. */
  #within(ms: number): AbortSignal {
    const own = AbortSignal.timeout(ms);
    return this.#signal ? AbortSignal.any([own, this.#signal]) : own;
  }
  /** What reaches the addresses the large file storage gives out, which are not GitHub's API. */
  readonly #fetch: typeof fetch;
  /** /repos/{owner}/{name} as `info` last found it: names change, the number does not. */
  #base: string | undefined;

  constructor(
    place: GitHubPlace,
    app: GitHubApp,
    rest: GitHubRest,
    web: { readonly url: string; readonly api: string; readonly fetch: typeof fetch },
    signal?: AbortSignal,
  ) {
    this.#signal = signal;
    this.#place = place;
    this.#app = app;
    this.#rest = rest;
    this.#webUrl = web.url;
    this.#apiUrl = web.api;
    this.#fetch = web.fetch;
  }

  /** Why the installation gives no token, as a pause. */
  #paused(error: InstallationRefused): RepoPaused {
    return new RepoPaused(error.reason, error.message);
  }

  async #token(fresh = false): Promise<string> {
    try {
      return await this.#app.token(this.#place.installationId, this.#place.repoId, { fresh });
    } catch (error) {
      if (error instanceof InstallationRefused) throw this.#paused(error);
      throw error;
    }
  }

  /**
   * A call with the token of the repository. One that GitHub does not take any more (it expired,
   * or was taken back) is signed again, once; what then still fails says why, see `GitHubApp.token`.
   * Answers that say to come back later reject with GitHubUnavailable.
   */
  async #call(what: string, path: string, options: { method?: string; body?: unknown } = {}) {
    this.#signal?.throwIfAborted();
    const signal = this.#signal;
    let answer = await this.#rest.call(path, { ...options, signal, bearer: await this.#token() });
    if (answer.status === 401) {
      this.#app.forget(this.#place.installationId, this.#place.repoId);
      answer = await this.#rest.call(path, {
        ...options,
        signal,
        bearer: await this.#token(true),
      });
      if (answer.status === 401) await this.#turnedDown(what);
    }
    const later = GitHubRest.unavailable(what, answer);
    if (later) throw later;
    return answer;
  }

  /** Why GitHub does not take a token that is new: the installation says, see `GitHubApp.token`. */
  async #turnedDown(what: string): Promise<never> {
    const installation = await this.#app.installation(this.#place.installationId);
    if (!installation) throw new RepoPaused("uninstalled", "the App is not installed");
    if (installation.suspended) throw new RepoPaused("suspended", "the installation is suspended");
    throw new RepoPaused("gone", `${what}: a new token is not taken either`);
  }

  #refused(what: string, answer: RestAnswer): RepoRefused {
    return new RepoRefused(answer.status, `${what}: ${answer.status} ${messageOf(answer)}`.trim());
  }

  async #repo(): Promise<string> {
    if (this.#base === undefined) await this.info();
    return this.#base as string;
  }

  async info(): Promise<RepoInfo> {
    const what = "GET /repositories/{id}";
    const path = `/repositories/${this.#place.repoId}`;
    let answer = await this.#call(what, path);
    if ([403, 404, 410, 451].includes(answer.status)) {
      // Not there to this token: the installation may be why (suspended, uninstalled, or not
      // covering the repository any more), which a new token says, see `GitHubApp.token`.
      this.#app.forget(this.#place.installationId, this.#place.repoId);
      await this.#token(true);
      answer = await this.#call(what, path);
    }
    if ([403, 404, 410, 451].includes(answer.status))
      throw new RepoPaused("gone", `${what}: ${answer.status}`);
    const info = answer.status === 200 ? repoInfoOf(answer.json) : undefined;
    if (!info) throw this.#refused(what, answer);
    this.#base = `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.name)}`;
    return info;
  }

  async tip(branch: string): Promise<string | undefined> {
    const what = "GET /git/ref/heads/{branch}";
    const answer = await this.#call(
      what,
      `${await this.#repo()}/git/ref/heads/${segments(branch)}`,
    );
    // 409: "Git Repository is empty." The default branch of one with commits is always there:
    // where it is not, the repository is not there to this token any more.
    if (answer.status === 409) return undefined;
    if (answer.status === 404) throw new RepoPaused("gone", `${what}: 404`);
    const sha = (answer.json as { object?: { sha?: unknown } } | undefined)?.object?.sha;
    if (answer.status !== 200 || typeof sha !== "string") throw this.#refused(what, answer);
    return sha;
  }

  async commit(sha: string): Promise<CommitInfo | undefined> {
    const what = "GET /git/commits/{sha}";
    const answer = await this.#call(what, `${await this.#repo()}/git/commits/${sha}`);
    if (answer.status === 404 || answer.status === 422) return undefined;
    const json = answer.json as
      { sha?: unknown; tree?: { sha?: unknown }; parents?: unknown; message?: unknown } | undefined;
    if (answer.status !== 200 || typeof json?.tree?.sha !== "string")
      throw this.#refused(what, answer);
    const parents = Array.isArray(json.parents)
      ? json.parents.flatMap((parent: { sha?: unknown }) =>
          typeof parent?.sha === "string" ? [parent.sha] : [],
        )
      : [];
    return {
      sha: typeof json.sha === "string" ? json.sha : sha,
      tree: json.tree.sha,
      parents,
      message: typeof json.message === "string" ? json.message : "",
    };
  }

  /**
   * GitHub's compare API (GET /repos/{owner}/{repo}/compare/{base}...{head}, docs.github.com
   * "Compare two commits"): `status` of head against base, and `merge_base_commit`. Only the first
   * commit of its list is asked for (`per_page=1`): the status does not depend on it, and a long
   * range would otherwise come with 250 of them. Checked on the real GitHub (2-0 of the plan):
   * after a forced push it says "diverged", both ways, with 200. Not checked: a range of thousands
   * of commits, and two histories with nothing in common.
   */
  async compare(base: string, head: string): Promise<Comparison | undefined> {
    const what = "GET /compare/{base}...{head}";
    const answer = await this.#call(
      what,
      `${await this.#repo()}/compare/${base}...${head}?per_page=1`,
    );
    // 404: either commit is not there, or there is no history in common ("No common ancestor").
    if (answer.status === 404 || answer.status === 422) return undefined;
    const json = answer.json as
      { status?: unknown; merge_base_commit?: { sha?: unknown } | null } | undefined;
    const status = json?.status;
    if (
      answer.status !== 200 ||
      (status !== "ahead" && status !== "behind" && status !== "identical" && status !== "diverged")
    )
      throw this.#refused(what, answer);
    const mergeBase = json?.merge_base_commit?.sha;
    return { status, ...(typeof mergeBase === "string" && { mergeBase }) };
  }

  async #listing(sha: string, recursive: boolean): Promise<{ entries: TreeEntry[]; cut: boolean }> {
    const what = "GET /git/trees/{sha}";
    const answer = await this.#call(
      what,
      `${await this.#repo()}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`,
    );
    const json = answer.json as { tree?: unknown; truncated?: unknown } | undefined;
    if (answer.status !== 200 || !Array.isArray(json?.tree)) throw this.#refused(what, answer);
    const entries: TreeEntry[] = [];
    for (const item of json.tree as any[]) {
      if (typeof item?.path !== "string" || typeof item.sha !== "string") continue;
      const type = item.type === "tree" || item.type === "commit" ? item.type : "blob";
      entries.push({
        path: item.path,
        mode: typeof item.mode === "string" ? item.mode : "100644",
        type,
        sha: item.sha,
        ...(typeof item.size === "number" && { size: item.size }),
      });
    }
    return { entries, cut: json.truncated === true };
  }

  async tree(sha: string, options: { readonly recursive?: boolean } = {}) {
    const recursive = options.recursive === true;
    const first = await this.#listing(sha, recursive);
    if (!recursive && first.cut) throw new RepoRefused(200, "a folder too large to list");
    if (!recursive || !first.cut) return first.entries;
    // GitHub cut the listing short: folder by folder then, each as far as it goes in one.
    const entries: TreeEntry[] = [];
    const folders: { sha: string; prefix: string }[] = [{ sha, prefix: "" }];
    let walked = 0;
    while (folders.length > 0) {
      const folder = folders.shift() as { sha: string; prefix: string };
      if (++walked > MOST_FOLDERS) throw new RepoRefused(200, "a tree too large to list");
      const level = await this.#listing(folder.sha, false);
      if (level.cut) throw new RepoRefused(200, "a folder too large to list");
      for (const entry of level.entries) {
        const path = `${folder.prefix}${entry.path}`;
        entries.push({ ...entry, path });
        if (entry.type === "tree") folders.push({ sha: entry.sha, prefix: `${path}/` });
      }
    }
    return entries;
  }

  async blob(sha: string): Promise<Uint8Array> {
    const what = "GET /git/blobs/{sha}";
    const answer = await this.#call(what, `${await this.#repo()}/git/blobs/${sha}`);
    const json = answer.json as { content?: unknown; encoding?: unknown } | undefined;
    if (answer.status !== 200 || typeof json?.content !== "string")
      throw this.#refused(what, answer);
    return json.encoding === "base64"
      ? Buffer.from(json.content, "base64")
      : Buffer.from(json.content, "utf8");
  }

  async files(
    commit: string,
    entries: readonly TreeEntry[],
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    const wanted = new Map<string, TreeEntry>();
    for (const entry of entries)
      if (entry.type === "blob" && entry.mode !== "120000") wanted.set(entry.path, entry);
    const found = new Map<string, Uint8Array>();
    if (wanted.size >= TARBALL_FROM) {
      try {
        for (const [path, bytes] of await this.#tarball(commit, wanted)) {
          // Only what is what the listing says: anything else is read again on its own.
          const entry = wanted.get(path);
          if (entry && blobShaOf(bytes) === entry.sha) found.set(path, bytes);
        }
      } catch (error) {
        // A repository that is not there to the App, or a limit of GitHub's, is the same for the
        // files one by one; whatever else went wrong with the tarball, they are read that way.
        if (error instanceof RepoPaused) throw error;
        if (error instanceof GitHubUnavailable && error.retryAfterMs !== undefined) throw error;
      }
    }
    const missing = [...wanted.values()].filter(({ path }) => !found.has(path));
    let next = 0;
    const reader = async () => {
      while (next < missing.length) {
        const entry = missing[next++] as TreeEntry;
        const bytes = await this.blob(entry.sha);
        if (blobShaOf(bytes) !== entry.sha)
          throw new RepoRefused(200, `GET /git/blobs/{sha}: not what ${entry.sha} is`);
        found.set(entry.path, bytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BLOBS_AT_ONCE, missing.length) }, reader));
    return found;
  }

  /**
   * The files of a commit that are `wanted`, from its tarball: GitHub sends on to codeload, whose
   * address carries a token of its own, so the installation's token goes only to GitHub's API.
   * Rejects where the tarball cannot be had or read, or is too large, for the files to be read one
   * by one.
   */
  async #tarball(
    commit: string,
    wanted: ReadonlyMap<string, TreeEntry>,
  ): Promise<Map<string, Uint8Array>> {
    const what = "GET /tarball/{sha}";
    const url = `${this.#apiUrl}${await this.#repo()}/tarball/${commit}`;
    const signal = this.#within(TARBALL_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: {
          authorization: `Bearer ${await this.#token()}`,
          accept: "application/vnd.github+json",
          "user-agent": USER_AGENT,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) throw new RepoRefused(response.status, `${what}: sent on to nowhere`);
        const to = new URL(location, url);
        if (to.protocol !== "https:" && to.protocol !== "http:")
          throw new RepoRefused(response.status, `${what}: sent on to what is no address`);
        response = await this.#fetch(to.href, {
          headers: { "user-agent": USER_AGENT },
          redirect: "manual",
          signal,
        });
      }
    } catch (error) {
      if (error instanceof RepoRefused || error instanceof RepoPaused) throw error;
      throw new GitHubUnavailable(`${what}: ${error instanceof Error ? error.name : "failed"}`);
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      const later = GitHubRest.unavailable(what, {
        status: response.status,
        json: undefined,
        headers: response.headers,
      });
      if (later) throw later;
      throw new RepoRefused(response.status, `${what}: ${response.status}`);
    }
    const length = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(length) && length > TARBALL_MOST_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new TarballTooLarge("the tarball is larger than it may be");
    }
    let kept = 0;
    for (const entry of wanted.values()) kept += entry.size ?? TARBALL_MOST_BYTES;
    return readTarball(response.body, {
      wanted: (path) => wanted.has(path),
      mostBytes: TARBALL_MOST_BYTES,
      mostKept: kept,
    });
  }

  /** A blob of its own, for a file too large to go in the request for a tree. */
  async #writeBlob(bytes: Buffer): Promise<string> {
    const what = "POST /git/blobs";
    const answer = await this.#call(what, `${await this.#repo()}/git/blobs`, {
      body: { content: bytes.toString("base64"), encoding: "base64" },
    });
    const sha = (answer.json as { sha?: unknown } | undefined)?.sha;
    if (answer.status !== 201 || typeof sha !== "string") throw this.#refused(what, answer);
    return sha;
  }

  async writeTree(base: string, changes: readonly TreeChange[]): Promise<string> {
    const removals: object[] = [];
    const writes: { entry: object; bytes: number }[] = [];
    for (const change of changes) {
      if ("remove" in change) {
        removals.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const bytes = bytesOf(change.text);
      // A text with half a surrogate pair would not come back from JSON as these bytes.
      if (bytes.length <= INLINE_BYTES && change.text.isWellFormed()) {
        writes.push({
          entry: { path: change.path, mode: "100644", type: "blob", content: change.text },
          bytes: bytes.length,
        });
      } else {
        const sha = await this.#writeBlob(bytes);
        writes.push({ entry: { path: change.path, mode: "100644", type: "blob", sha }, bytes: 0 });
      }
    }
    // What goes, in requests of its own before what comes: a file where a folder of the same name
    // was, or the other way round, does not go in one request.
    let tree = base;
    const parts = [removals.map((entry) => ({ entry, bytes: 0 })), writes];
    for (const part of parts) {
      for (let at = 0; at < part.length;) {
        const batch: object[] = [];
        let bytes = 0;
        while (
          at < part.length &&
          batch.length < TREE_REQUEST_ENTRIES &&
          (batch.length === 0 ||
            bytes + (part[at] as { bytes: number }).bytes <= TREE_REQUEST_BYTES)
        ) {
          const next = part[at++] as { entry: object; bytes: number };
          batch.push(next.entry);
          bytes += next.bytes;
        }
        const what = "POST /git/trees";
        const answer = await this.#call(what, `${await this.#repo()}/git/trees`, {
          body: { base_tree: tree, tree: batch },
        });
        const sha = (answer.json as { sha?: unknown } | undefined)?.sha;
        if (answer.status !== 201 || typeof sha !== "string") throw this.#refused(what, answer);
        tree = sha;
      }
    }
    return tree;
  }

  async writeCommit(commit: {
    readonly tree: string;
    readonly parents: readonly string[];
    readonly message: string;
    readonly author: Person;
    readonly at: Date;
  }): Promise<string> {
    const what = "POST /git/commits";
    const person = personAt(commit.author, commit.at);
    const answer = await this.#call(what, `${await this.#repo()}/git/commits`, {
      body: {
        message: commit.message,
        tree: commit.tree,
        parents: commit.parents,
        author: person,
        committer: person,
      },
    });
    const sha = (answer.json as { sha?: unknown } | undefined)?.sha;
    if (answer.status !== 201 || typeof sha !== "string") throw this.#refused(what, answer);
    return sha;
  }

  async advance(
    branch: string,
    sha: string,
  ): Promise<"moved" | "behind" | { readonly refused: string }> {
    const what = "PATCH /git/refs/heads/{branch}";
    const answer = await this.#call(
      what,
      `${await this.#repo()}/git/refs/heads/${segments(branch)}`,
      {
        method: "PATCH",
        // Never forced: a branch that moved elsewhere is not written over.
        body: { sha, force: false },
      },
    );
    if (answer.status === 200) return "moved";
    const message = messageOf(answer);
    if (answer.status === 403 && /archived/i.test(message))
      throw new RepoPaused("archived", "the repository is archived");
    // Only this says the branch moved meanwhile; anything else, such as a protected branch or a
    // ruleset, says it does not move at all, in GitHub's own words.
    if ((answer.status === 422 || answer.status === 409) && /not a fast.?forward/i.test(message))
      return "behind";
    if (answer.status === 422 || answer.status === 409 || answer.status === 403)
      return { refused: message || `${what}: ${answer.status}` };
    throw this.#refused(what, answer);
  }

  async start(
    file: { readonly path: string; readonly text: string },
    message: string,
    author: Person,
    at: Date,
  ): Promise<string | undefined> {
    const what = "PUT /contents/{path}";
    const person = personAt(author, at);
    const answer = await this.#call(what, `${await this.#repo()}/contents/${segments(file.path)}`, {
      method: "PUT",
      body: {
        message,
        content: bytesOf(file.text).toString("base64"),
        author: person,
        committer: person,
      },
    });
    // The file is there by now ("sha" wanted), or the repository changed meanwhile.
    if (answer.status === 409 || answer.status === 422) return undefined;
    const sha = (answer.json as { commit?: { sha?: unknown } } | undefined)?.commit?.sha;
    if ((answer.status !== 201 && answer.status !== 200) || typeof sha !== "string")
      throw this.#refused(what, answer);
    return sha;
  }

  async lfsBatch(
    operation: "upload" | "download",
    objects: readonly LfsObject[],
  ): Promise<readonly LfsAnswer[]> {
    if (objects.length === 0) return [];
    const what = "POST {repository}.git/info/lfs/objects/batch";
    // By the names it has now, which only the number finds.
    const info = await this.info();
    const url = `${this.#webUrl}/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.name)}.git/info/lfs/objects/batch`;
    const body = {
      operation,
      transfers: ["basic"],
      objects: objects.map(({ oid, size }) => ({ oid, size })),
      hash_algo: "sha256",
    };
    const ask = async (fresh: boolean) =>
      this.#rest.request(url, {
        signal: this.#signal,
        method: "POST",
        basic: ["x-access-token", await this.#token(fresh)],
        body,
        mediaType: LFS_MEDIA,
      });
    let answer = await ask(false);
    if (answer.status === 401) {
      this.#app.forget(this.#place.installationId, this.#place.repoId);
      answer = await ask(true);
      if (answer.status === 401) await this.#turnedDown(what);
    }
    const message = messageOf(answer);
    if (answer.status === 507 || (answer.status === 403 && QUOTA.test(message)))
      throw new LfsQuota(`${what}: ${answer.status} ${message}`.trim());
    const later = GitHubRest.unavailable(what, answer);
    if (later) throw later;
    if (answer.status === 403 && /archived/i.test(message))
      throw new RepoPaused("archived", "the repository is archived");
    // The repository was there to `info` a moment ago, which is what says whether it is: a storage
    // that says otherwise is a failure, tried again later, not a repository that cannot be used.
    const items = (answer.json as { objects?: unknown } | undefined)?.objects;
    if (answer.status !== 200 || !Array.isArray(items)) throw this.#refused(what, answer);
    const now = Date.now();
    const byOid = new Map<string, Record<string, unknown>>();
    for (const item of items)
      if (isObject(item) && typeof item.oid === "string") byOid.set(item.oid, item);
    return objects.map(({ oid }) => {
      const item = byOid.get(oid);
      if (!item) throw new RepoRefused(answer.status, `${what}: no answer about an object`);
      return lfsAnswerOf(operation, item, now);
    });
  }

  async close(): Promise<void> {
    // Nothing is held: every call stands on its own.
  }

  async lfsSizes(objects: readonly LfsObject[]): Promise<readonly (number | undefined)[]> {
    const sizes: (number | undefined)[] = [];
    // As Git LFS asks: a hundred objects at a time.
    for (let at = 0; at < objects.length; at += LFS_BATCH) {
      const answers = await this.lfsBatch("download", objects.slice(at, at + LFS_BATCH));
      for (const answer of answers) {
        if (answer.kind === "download")
          sizes.push(
            await sizeAt(
              answer.download,
              this.#fetch,
              this.#signal,
              this.#webUrl.startsWith("http:"),
            ),
          );
        // Not there, or not of the size that was asked about, which only some storages mind.
        else if (answer.kind === "refused" && [404, 410, 422].includes(answer.code))
          sizes.push(undefined);
        else
          throw new GitHubUnavailable(
            `Git LFS says nothing of an object: ${answer.kind === "refused" ? answer.code : answer.kind}`,
          );
      }
    }
    return sizes;
  }
}

export class GitHubRepoHost implements RepoHost<GitHubPlace> {
  readonly #app: GitHubApp;
  readonly #rest: GitHubRest;
  readonly #web: { readonly url: string; readonly api: string; readonly fetch: typeof fetch };

  /** `webUrl`: github.com, or a GitHub of a company, where Git and Git LFS are. */
  constructor(app: GitHubApp, options: RestOptions & { readonly webUrl: string }) {
    this.#app = app;
    this.#rest = new GitHubRest(options);
    this.#web = { url: options.webUrl, api: options.apiUrl, fetch: options.fetch ?? fetch };
  }

  open(
    place: GitHubPlace,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): RepoSession {
    return new GitHubRepoSession(place, this.#app, this.#rest, this.#web, options.signal);
  }
}

/** A repository as a person's token sees it, for choosing one. */
export interface PersonRepo extends RepoInfo {
  readonly ownerType: string;
  /** Whether the person may push to it. */
  readonly pushable: boolean;
  /** As GitHub counts it, in KB: 0 for an empty one, and for a very small one. */
  readonly size: number;
  readonly description: string | undefined;
  readonly createdAt: number | undefined;
}

const personRepoOf = (json: any): PersonRepo | undefined => {
  const info = repoInfoOf(json);
  if (!info) return undefined;
  const created = typeof json.created_at === "string" ? Date.parse(json.created_at) : Number.NaN;
  return {
    ...info,
    ownerType: typeof json.owner?.type === "string" ? json.owner.type : "User",
    pushable: json.permissions?.push === true,
    size: typeof json.size === "number" ? json.size : 0,
    description: typeof json.description === "string" ? json.description : undefined,
    createdAt: Number.isFinite(created) ? created : undefined,
  };
};

/**
 * What a person's own token does with repositories: make one on their account, which only their
 * token can, and list or look up those their installation covers. Rejects with GitHubUnauthorized
 * when GitHub does not take the token, for the caller to get a new one, and GitHubUnavailable when
 * GitHub could not be asked.
 */
export class GitHubPersonRepos {
  readonly #rest: GitHubRest;

  constructor(options: RestOptions) {
    this.#rest = new GitHubRest(options);
  }

  async #call(what: string, path: string, token: string, body?: unknown) {
    const answer = await this.#rest.call(path, { bearer: token, body });
    if (answer.status === 401) throw new GitHubUnauthorized(`${what}: 401`);
    const later = GitHubRest.unavailable(what, answer);
    if (later) throw later;
    return answer;
  }

  /**
   * A new private repository on the person's account. "taken": they have one of that name. Any
   * other refusal says GitHub's message, for the log.
   */
  async create(
    token: string,
    repo: { readonly name: string; readonly description: string },
  ): Promise<
    | { readonly kind: "made"; readonly repo: PersonRepo }
    | { readonly kind: "taken" }
    | { readonly kind: "refused"; readonly status: number; readonly message: string }
  > {
    const what = "POST /user/repos";
    const answer = await this.#call(what, "/user/repos", token, {
      name: repo.name,
      description: repo.description,
      private: true,
      auto_init: false,
    });
    if (answer.status === 201) {
      const made = personRepoOf(answer.json);
      if (made) return { kind: "made", repo: made };
      throw new GitHubUnavailable(`${what}: an answer without a repository`);
    }
    if (answer.status === 422) {
      const errors = (answer.json as { errors?: unknown } | undefined)?.errors;
      const isTaken =
        Array.isArray(errors) &&
        errors.some(
          (error: { field?: unknown; message?: unknown; code?: unknown }) =>
            error?.field === "name" ||
            (typeof error?.message === "string" && /already exists/i.test(error.message)),
        );
      if (isTaken || /already exists/i.test(messageOf(answer))) return { kind: "taken" };
    }
    return { kind: "refused", status: answer.status, message: messageOf(answer) };
  }

  /**
   * A repository of an account by its names, or undefined where the token sees none. A name GitHub
   * sends on from (301, and the like) is one a repository had before it was renamed or moved: no
   * repository has it now, and a new one can.
   */
  async byName(token: string, owner: string, name: string): Promise<PersonRepo | undefined> {
    const what = "GET /repos/{owner}/{name}";
    const answer = await this.#call(
      what,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      token,
    );
    if (answer.status === 404 || answer.status === 403) return undefined;
    if (answer.status >= 300 && answer.status < 400) return undefined;
    const repo = answer.status === 200 ? personRepoOf(answer.json) : undefined;
    if (!repo) throw new GitHubUnavailable(`${what}: ${answer.status}`);
    return repo;
  }

  /** A repository by its number, or undefined where the token sees none. */
  async byId(token: string, id: number): Promise<PersonRepo | undefined> {
    const what = "GET /repositories/{id}";
    const answer = await this.#call(what, `/repositories/${id}`, token);
    if (answer.status === 404 || answer.status === 403) return undefined;
    const repo = answer.status === 200 ? personRepoOf(answer.json) : undefined;
    if (!repo) throw new GitHubUnavailable(`${what}: ${answer.status}`);
    return repo;
  }

  /** Whether a repository has no commits, with the person's token. */
  async isEmpty(token: string, repo: PersonRepo): Promise<boolean> {
    const what = "GET /git/ref/heads/{branch}";
    const answer = await this.#call(
      what,
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/ref/heads/${segments(repo.branch)}`,
      token,
    );
    if (answer.status === 409) return true;
    if (answer.status === 200 || answer.status === 404) return false;
    throw new GitHubUnavailable(`${what}: ${answer.status}`);
  }

  /** A page of the repositories an installation covers, as the person sees them. */
  async ofInstallation(
    token: string,
    installationId: number,
    page: number,
    perPage = 100,
  ): Promise<{ readonly total: number; readonly repositories: readonly PersonRepo[] }> {
    const what = "GET /user/installations/{id}/repositories";
    const answer = await this.#call(
      what,
      `/user/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
      token,
    );
    if (answer.status === 403 || answer.status === 404) return { total: 0, repositories: [] };
    const json = answer.json as { total_count?: unknown; repositories?: unknown } | undefined;
    if (answer.status !== 200 || !Array.isArray(json?.repositories))
      throw new GitHubUnavailable(`${what}: ${answer.status}`);
    return {
      total: typeof json.total_count === "number" ? json.total_count : json.repositories.length,
      repositories: (json.repositories as unknown[]).flatMap((item) => personRepoOf(item) ?? []),
    };
  }
}
