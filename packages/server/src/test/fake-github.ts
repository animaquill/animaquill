import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
  type KeyObject,
} from "node:crypto";
import { gzipSync } from "node:zlib";
import { GitObjects, type FlatFile } from "./fake-git.ts";

/**
 * GitHub, for tests: what signing in uses, and what saving projects to GitHub uses. It behaves the
 * way GitHub was found to, and never calls the real one.
 *
 * Signing in: authorizing the App (with PKCE), the tokens and refreshing them, the user, their
 * installations, and installing the App. Codes and refresh tokens work once, a refresh ends the old
 * access token, two refreshes with one refresh token leave the second with `bad_refresh_token`, and
 * coming back from installing the App has no state.
 *
 * Saving to GitHub: the App's JWT, checked against a key of its own (`privateKey`), for tokens of
 * an installation, limited to repositories and permissions as asked; making repositories with a
 * person's token (a name they have is 422, and an installation on selected repositories gets the
 * new one); listing an installation's repositories; the contents API for the first commit; and the
 * Git Data API: refs (422 for what is not a fast-forward), commits, trees (`base_tree`, paths into
 * folders, `sha: null` taking a file away, `content`, `recursive`, cut short on request) and blobs.
 * Objects are Git's own, by their real SHA-1, see fake-git.ts. What GitHub would send to the
 * webhook goes to `deliveries`, for a test to sign and pass on. `faults` makes it go wrong in the
 * ways GitHub does.
 *
 * What people do to a repository on GitHub itself: renaming it, moving it to another account,
 * making it private or public, archiving it, deleting it, see `rename` and what follows. The old
 * name of one that was renamed or moved answers 301, until a new repository takes it. The webhook
 * hears of these as "repository" only once the App is subscribed to that (`repositoryEvents`),
 * which it is not from the start, as the real App is not.
 *
 * In-process it is a `fetch` (`fake.fetch`); for browsers it runs as a server, see
 * fake-github-server.ts. Its web pages and its API are at one address: the API under /api.
 */

export interface FakeUser {
  readonly id: number;
  readonly login: string;
}

interface Code {
  readonly user: FakeUser;
  readonly challenge: string | undefined;
  readonly redirectUri: string;
  used: boolean;
}

interface Grant {
  readonly user: FakeUser;
  readonly access: string;
  readonly refresh: string;
  accessExpiresAt: number;
}

/** What a file of a commit of someone else's is: text, bytes, a link, a submodule, or none. */
export type FakeContent =
  string | Buffer | null | { readonly link: string } | { readonly submodule: string };

/** An installation of the App on an account. */
export interface FakeInstallation {
  readonly id: number;
  /** "all" or "selected". */
  selection: string;
  readonly login: string;
  readonly accountId: number;
  readonly accountType: string;
  /** The repositories it covers, when `selection` is "selected". */
  readonly repos: Set<number>;
  suspended: boolean;
}

export interface FakeRepo {
  readonly id: number;
  owner: { readonly id: number; login: string; readonly type: string };
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  archived: boolean;
  /** People see it, but may not push to it, as a repository they were given read access to. */
  readOnly?: boolean;
  createdAt: number;
  /** Branches, by name, to their last commit. */
  readonly refs: Map<string, string>;
  readonly objects: GitObjects;
  /** Its large file storage (Git LFS): what it has, by oid. */
  readonly lfs: Map<string, Buffer>;
  /** What was put at an address of an upload, by oid, until it is verified into `lfs`. */
  readonly lfsPut: Map<string, Buffer>;
}

interface InstallationToken {
  readonly installationId: number;
  /** Undefined: every repository the installation covers. */
  readonly repoIds: ReadonlySet<number> | undefined;
  readonly permissions: Readonly<Record<string, string>>;
  expiresAt: number;
}

/** What GitHub would send to the App's webhook. */
export interface FakeDelivery {
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

/** How a test makes GitHub go wrong. Counts go down by one with each call they hit. */
export interface FakeFaults {
  /** Calls of the API that answer 502. */
  down: number;
  /** Calls of the API that hit a secondary rate limit: 403 with retry-after. */
  limited: number;
  /** Every call fails before it reaches GitHub, as a network that is gone. */
  unreachable: boolean;
  /** Each call waits this long first. */
  delayMs: number;
  /** Recursive listings of trees come back cut short. */
  truncate: boolean;
  /** Listings of one level of a tree come back cut short too, as for a folder of 100,000 files. */
  truncateLevels: boolean;
  /** The next calls whose "METHOD /path" matches answer with this status, once each. */
  readonly once: { readonly match: RegExp; readonly status: number; readonly message?: string }[];
  /** Git LFS: the storage of the account is full, so the batch API takes no upload. */
  lfsQuota: boolean;
  /** Git LFS: the addresses of the next uploads have run out before anyone gets to use them. */
  lfsExpireEarly: number;
  /** Git LFS: the next uploads stop halfway, as a connection that breaks. */
  lfsCutUploads: number;
  /** Git LFS: each call of the addresses it gives out (S3's, to GitHub) waits this long first. */
  lfsDelayMs: number;
  /** Git LFS: the largest object it takes, as GitHub's 2 GB for free accounts. */
  lfsMaxBytes: number;
  /**
   * Git LFS: it goes by the oid alone, as the real one may: what it has of an oid is there whatever
   * size it is asked about, and the size it says is the one it was asked about. Otherwise an object
   * of another size than asked about is not there to it.
   */
  lfsAnySize: boolean;
  /** Git LFS: the addresses for downloads take GET alone, as addresses signed for one method do. */
  lfsNoHead: boolean;
  /** Git LFS: the next calls of its batch API answer 503, while the rest of GitHub is there. */
  lfsDown: number;
  /** Git LFS: the traffic of the account is used up, so the batch API gives no downloads. */
  lfsDownloadQuota: boolean;
  /** Git LFS: the next addresses for downloads have run out before anyone gets to use them. */
  lfsExpireDownloads: number;
  /** Git LFS: the next downloads stop halfway, as a connection that breaks. */
  lfsCutDownloads: number;
  /** Git LFS: downloads take no ranges, and send all of the object, as some storages do. */
  lfsNoRanges: boolean;
  /** Tarballs: the next ones that codeload sends stop halfway, as a connection that breaks. */
  tarballCut: number;
  /** Tarballs: the next ones answer 502 at codeload, while the rest of GitHub is there. */
  tarballDown: number;
}

export interface FakeGitHubOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly appId?: number;
  readonly appSlug?: string;
  /** Where the App sends people back to, for installing it. */
  readonly callbackUrl?: string;
  /** How long an access token lasts, in seconds. */
  readonly accessSeconds?: number;
}

const token = (prefix: string) => `${prefix}_${randomBytes(27).toString("base64url")}`;

/** One key of the App for every fake: making one takes a moment. */
let appKey: { readonly privateKey: string; readonly publicKey: KeyObject } | undefined;
const keyOfTheApp = () => {
  if (!appKey) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    appKey = {
      privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      publicKey: createPublicKey(pair.privateKey.export({ type: "pkcs1", format: "pem" })),
    };
  }
  return appKey;
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
const notFound = () => json({ message: "Not Found" }, 404);
const unprocessable = (message: string, errors?: unknown[]) =>
  json({ message, ...(errors && { errors }) }, 422);

/** GitHub's base64 of a blob: lines of 60 characters. */
/** A header of a tar entry, ustar, with its checksum. */
const tarHeader = (name: string, size: number, kind: string, mode: string, link = ""): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.padStart(7, "0")}\0`, 100, 8, "latin1");
  header.write("0000000\0", 108, 8, "latin1");
  header.write("0000000\0", 116, 8, "latin1");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  header.write(`${"0".padStart(11, "0")}\0`, 136, 12, "latin1");
  header.write(kind, 156, 1, "latin1");
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  header.fill(32, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
};

const padded = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/** A pax header of these records, for the entry after it. */
const paxHeader = (kind: "x" | "g", records: Readonly<Record<string, string>>): Buffer => {
  let body = "";
  for (const [key, value] of Object.entries(records)) {
    const tail = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(tail) + 1;
    while (String(length).length + Buffer.byteLength(tail) !== length) length += 1;
    body += `${length}${tail}`;
  }
  const data = Buffer.from(body, "utf8");
  return Buffer.concat([tarHeader("pax_global_header", data.length, kind, "666"), padded(data)]);
};

/**
 * The tarball of a commit as GitHub makes one: gzip around tar, a global pax header that names the
 * commit, everything under "<owner>-<name>-<sha7>/", folders as entries of their own, paths longer
 * than a header takes in pax headers, links as links. Submodules are left out.
 */
export const tarballOf = (repo: FakeRepo, sha: string): Buffer => {
  const top = `${repo.owner.login}-${repo.name}-${sha.slice(0, 7)}`;
  const parts: Buffer[] = [paxHeader("g", { comment: sha })];
  const entry = (path: string, data: Buffer, kind: string, mode: string, link = "") => {
    const name = `${top}/${path}`;
    if (Buffer.byteLength(name) > 99) parts.push(paxHeader("x", { path: name }));
    parts.push(tarHeader(name.slice(0, 99), data.length, kind, mode, link), padded(data));
  };
  entry("", Buffer.alloc(0), "5", "775");
  const folders = new Set<string>();
  const files = repo.objects.flatten(repo.objects.readCommit(sha).tree);
  for (const [path, file] of [...files].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = `${segments.slice(0, depth).join("/")}/`;
      if (!folders.has(folder)) {
        folders.add(folder);
        entry(folder, Buffer.alloc(0), "5", "775");
      }
    }
    const object = repo.objects.get(file.sha);
    if (!object || object.type !== "blob") continue;
    if (file.mode === "120000") entry(path, Buffer.alloc(0), "2", "777", object.data.toString());
    else entry(path, object.data, "0", file.mode === "100755" ? "775" : "664");
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
};

const wrapped = (data: Buffer) => (data.toString("base64").match(/.{1,60}/g) ?? [""]).join("\n");

const isGoodPath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.endsWith("/") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");

export class FakeGitHub {
  /** Calls of the compare API so far. */
  compared = 0;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly appId: number;
  readonly appSlug: string;
  readonly callbackUrl: string;
  accessSeconds: number;
  /** Who is signed in to GitHub in "the browser". */
  user: FakeUser = { id: 70000001, login: "octo" };
  /** People say no on the page of authorizing. */
  deny = false;
  /** How long each refresh takes, to see two at once. */
  refreshDelayMs = 0;
  /** Installations of the App, by the number of the account. */
  readonly installed = new Map<number, FakeInstallation>();
  /** Every refresh that reached the token endpoint, good or not. */
  refreshes = 0;
  /** Access tokens the App took back, see `DELETE /applications/{client_id}/token`. */
  readonly revoked: string[] = [];
  /** Taking a token back fails, as when GitHub is down. */
  failRevoking = false;
  /** The App's private key, PEM, which the platform signs its JWT with. */
  readonly privateKey: string;
  /** Repositories, by number. */
  readonly repos = new Map<number, FakeRepo>();
  /** What GitHub would have sent to the webhook, in order. */
  readonly deliveries: FakeDelivery[] = [];
  /**
   * Whether the App is subscribed to "repository": what happens to a repository itself. Without
   * it, the platform only finds out when it next looks.
   */
  repositoryEvents = false;
  /** Names repositories had before they were renamed or moved, "owner/name" in lower case, to their numbers. */
  readonly #formerNames = new Map<string, number>();
  readonly faults: FakeFaults = {
    down: 0,
    limited: 0,
    unreachable: false,
    delayMs: 0,
    truncate: false,
    truncateLevels: false,
    once: [],
    lfsQuota: false,
    lfsExpireEarly: 0,
    lfsCutUploads: 0,
    lfsDelayMs: 0,
    lfsMaxBytes: 2 * 1024 ** 3,
    lfsAnySize: false,
    lfsNoHead: false,
    lfsDown: 0,
    lfsDownloadQuota: false,
    lfsExpireDownloads: 0,
    lfsCutDownloads: 0,
    lfsNoRanges: false,
    tarballCut: 0,
    tarballDown: 0,
  };
  /** Every call of the API that got through, as "METHOD /path", for tests to count. */
  readonly calls: string[] = [];
  /** Where downloads of Git LFS asked to start, in order: `Range` of each GET with one. */
  readonly ranges: number[] = [];
  /** Runs before each call of the API is answered, to do something at that very moment. */
  onCall: ((call: string) => void | Promise<void>) | undefined;
  /** Installation tokens issued, with what they may. */
  readonly #installationTokens = new Map<string, InstallationToken>();
  readonly #codes = new Map<string, Code>();
  /** The one authorization of each person, by their id: a new one ends the one before. */
  readonly #grants = new Map<number, Grant>();
  readonly #publicKey: KeyObject;
  // Numbers of their own for each fake, as tests of one database can have several.
  #nextInstallation = 180_000_000 + Math.floor(Math.random() * 10_000_000) * 10;
  #nextRepo = 1_000_000_000 + Math.floor(Math.random() * 10_000_000) * 100;

  constructor(options: FakeGitHubOptions = {}) {
    this.clientId = options.clientId ?? "Iv1.a1b2c3d4e5f60718";
    this.clientSecret = options.clientSecret ?? "client-secret-value";
    this.appId = options.appId ?? 1000001;
    this.appSlug = options.appSlug ?? "animaquill";
    this.callbackUrl = options.callbackUrl ?? "https://editor.example.com/api/auth/github/callback";
    this.accessSeconds = options.accessSeconds ?? 28800;
    const key = keyOfTheApp();
    this.privateKey = key.privateKey;
    this.#publicKey = key.publicKey;
  }

  // --- Installations --------------------------------------------------------------------------

  install(user: FakeUser = this.user, selection = "selected", repos: readonly number[] = []) {
    const id = this.#nextInstallation++;
    const installation: FakeInstallation = {
      id,
      selection,
      login: user.login,
      accountId: user.id,
      accountType: "User",
      repos: new Set(repos),
      suspended: false,
    };
    this.installed.set(user.id, installation);
    this.#deliver("installation", "created", installation, {
      repositories: this.#coveredBy(installation).map((repo) => this.#repoBrief(repo)),
    });
    return id;
  }

  uninstall(user: FakeUser = this.user) {
    const installation = this.installed.get(user.id);
    this.installed.delete(user.id);
    if (installation) {
      for (const [key, issued] of this.#installationTokens)
        if (issued.installationId === installation.id) this.#installationTokens.delete(key);
      this.#deliver("installation", "deleted", installation);
    }
  }

  suspend(user: FakeUser = this.user, suspended = true) {
    const installation = this.installed.get(user.id);
    if (!installation) throw new Error(`nothing installed for ${user.login}`);
    installation.suspended = suspended;
    this.#deliver("installation", suspended ? "suspend" : "unsuspend", installation);
  }

  /** People take a repository out of what the installation covers, on GitHub. */
  unselect(repoId: number) {
    const repo = this.#repo(repoId);
    const installation = this.installed.get(repo.owner.id);
    if (!installation) throw new Error("not installed");
    installation.repos.delete(repoId);
    if (installation.selection === "all") {
      installation.selection = "selected";
      for (const other of this.repos.values())
        if (other.owner.id === repo.owner.id && other.id !== repoId)
          installation.repos.add(other.id);
    }
    this.#deliver("installation_repositories", "removed", installation, {
      repository_selection: installation.selection,
      repositories_added: [],
      repositories_removed: [this.#repoBrief(repo)],
    });
  }

  /** People put a repository back into what the installation covers. */
  select(repoId: number) {
    const repo = this.#repo(repoId);
    const installation = this.installed.get(repo.owner.id);
    if (!installation) throw new Error("not installed");
    installation.repos.add(repoId);
    this.#deliver("installation_repositories", "added", installation, {
      repository_selection: installation.selection,
      repositories_added: [this.#repoBrief(repo)],
      repositories_removed: [],
    });
  }

  // --- Repositories, set up and looked at by tests --------------------------------------------

  /**
   * A repository of an account, as if made on GitHub: with these files in a first commit, or empty.
   * It is covered by the installation on the account when that is on all repositories, or `select`.
   */
  addRepo(
    owner: FakeUser,
    options: {
      readonly name: string;
      readonly private?: boolean;
      readonly description?: string;
      readonly files?: Readonly<Record<string, string>>;
      readonly select?: boolean;
      readonly ownerType?: string;
      readonly branch?: string;
    },
  ): FakeRepo {
    const repo: FakeRepo = {
      id: this.#nextRepo++,
      owner: { id: owner.id, login: owner.login, type: options.ownerType ?? "User" },
      name: options.name,
      private: options.private ?? true,
      description: options.description ?? null,
      defaultBranch: options.branch ?? "main",
      archived: false,
      createdAt: Date.now(),
      refs: new Map(),
      objects: new GitObjects(),
      lfs: new Map(),
      lfsPut: new Map(),
    };
    this.repos.set(repo.id, repo);
    if (options.files && Object.keys(options.files).length > 0) {
      this.commitAs(repo.id, owner, options.files, "Initial commit");
    }
    if (options.select) this.installed.get(owner.id)?.repos.add(repo.id);
    return repo;
  }

  /**
   * A commit on the default branch as someone else, as from a push elsewhere: files with text are
   * written, files with null go. Resolves to the commit, and GitHub's push goes to `deliveries`.
   */
  commitAs(
    repoId: number,
    who: FakeUser,
    files: Readonly<Record<string, FakeContent>>,
    message = "Edit on GitHub",
    options: { readonly parent?: string | null } = {},
  ): string {
    const repo = this.#repo(repoId);
    const tip = repo.refs.get(repo.defaultBranch);
    // On another commit than the tip, for a history of its own: the branch is forced onto it.
    const before = options.parent === undefined ? tip : (options.parent ?? undefined);
    const flat = before
      ? repo.objects.flatten(repo.objects.readCommit(before).tree)
      : new Map<string, FlatFile>();
    for (const [path, text] of Object.entries(files)) {
      if (text === null) flat.delete(path);
      else if (typeof text === "string" || Buffer.isBuffer(text))
        flat.set(path, { mode: "100644", sha: repo.objects.blob(text) });
      // A symbolic link, to where `link` says.
      else if ("link" in text)
        flat.set(path, { mode: "120000", sha: repo.objects.blob(text.link) });
      // A submodule, at the commit of another repository it says.
      else flat.set(path, { mode: "160000", sha: text.submodule });
    }
    const time = Math.floor(Date.now() / 1000);
    const person = {
      name: who.login,
      email: `${who.id}+${who.login}@users.noreply.github.com`,
      time,
    };
    const sha = repo.objects.commit({
      tree: repo.objects.treeOf(flat),
      parents: before ? [before] : [],
      author: person,
      committer: person,
      message,
    });
    this.#move(repo, repo.defaultBranch, tip, sha, who);
    return sha;
  }

  /**
   * Someone forces the default branch onto a commit, as `git push --force` or `git reset` and a
   * forced push do: also back to an older one. GitHub's push goes to `deliveries`, with `forced`.
   */
  forcePush(repoId: number, who: FakeUser, sha: string): void {
    const repo = this.#repo(repoId);
    if (!repo.objects.has(sha, "commit")) throw new Error(`no commit ${sha}`);
    this.#move(repo, repo.defaultBranch, repo.refs.get(repo.defaultBranch), sha, who);
  }

  /** How Git has each file on a branch, by path: "100644" a file, "120000" a link. */
  modes(repoId: number, branch?: string): Map<string, string> {
    const repo = this.#repo(repoId);
    const tip = repo.refs.get(branch ?? repo.defaultBranch);
    const modes = new Map<string, string>();
    if (!tip) return modes;
    for (const [path, file] of repo.objects.flatten(repo.objects.readCommit(tip).tree))
      modes.set(path, file.mode);
    return modes;
  }

  /** The files on a branch, by path, as text. */
  files(repoId: number, branch?: string): Map<string, string> {
    const repo = this.#repo(repoId);
    const tip = repo.refs.get(branch ?? repo.defaultBranch);
    const files = new Map<string, string>();
    if (!tip) return files;
    for (const [path, file] of repo.objects.flatten(repo.objects.readCommit(tip).tree)) {
      const object = repo.objects.get(file.sha);
      if (object?.type === "blob") files.set(path, object.data.toString("utf8"));
    }
    return files;
  }

  /** The files of a commit, by path, as text. */
  filesAt(repoId: number, sha: string): Map<string, string> {
    const repo = this.#repo(repoId);
    const files = new Map<string, string>();
    for (const [path, file] of repo.objects.flatten(repo.objects.readCommit(sha).tree)) {
      const object = repo.objects.get(file.sha);
      if (object?.type === "blob") files.set(path, object.data.toString("utf8"));
    }
    return files;
  }

  /** The commits of the default branch, newest first, following first parents. */
  history(repoId: number) {
    const repo = this.#repo(repoId);
    const commits: (ReturnType<GitObjects["readCommit"]> & { readonly sha: string })[] = [];
    let sha = repo.refs.get(repo.defaultBranch);
    while (sha) {
      const commit = repo.objects.readCommit(sha);
      commits.push({ ...commit, sha });
      sha = commit.parents[0];
    }
    return commits;
  }

  /** A repository is deleted on GitHub. */
  deleteRepo(repoId: number) {
    const repo = this.repos.get(repoId);
    if (repo) this.#repositoryEvent(repo, "deleted");
    this.repos.delete(repoId);
    for (const installation of this.installed.values()) installation.repos.delete(repoId);
    for (const [name, id] of this.#formerNames) if (id === repoId) this.#formerNames.delete(name);
  }

  /** People rename a repository on GitHub: the old name sends on to it from now on. */
  rename(repoId: number, name: string) {
    const repo = this.#repo(repoId);
    const from = repo.name;
    this.#formerNames.set(`${repo.owner.login}/${from}`.toLowerCase(), repo.id);
    repo.name = name;
    this.#formerNames.delete(`${repo.owner.login}/${name}`.toLowerCase());
    this.#repositoryEvent(repo, "renamed", { repository: { name: { from } } });
  }

  /**
   * People move a repository to another account. It leaves the installation it was in; the one on
   * the new account covers it where that is on all repositories, and only that account's
   * installation hears of it, as GitHub tells the new owner alone.
   */
  transfer(repoId: number, to: FakeUser, type = "User") {
    const repo = this.#repo(repoId);
    const from = repo.owner;
    this.installed.get(from.id)?.repos.delete(repoId);
    this.#formerNames.set(`${from.login}/${repo.name}`.toLowerCase(), repo.id);
    repo.owner = { id: to.id, login: to.login, type };
    this.#formerNames.delete(`${to.login}/${repo.name}`.toLowerCase());
    this.#repositoryEvent(repo, "transferred", {
      owner: { from: { user: { id: from.id, login: from.login } } },
    });
  }

  /** People make a repository private, or public. */
  setPrivate(repoId: number, isPrivate: boolean) {
    const repo = this.#repo(repoId);
    if (repo.private === isPrivate) return;
    repo.private = isPrivate;
    this.#repositoryEvent(repo, isPrivate ? "privatized" : "publicized");
  }

  /** People archive a repository, which makes it read-only, or take that back. */
  setArchived(repoId: number, archived: boolean) {
    const repo = this.#repo(repoId);
    if (repo.archived === archived) return;
    repo.archived = archived;
    this.#repositoryEvent(repo, archived ? "archived" : "unarchived");
  }

  /** People change which branch is the default one. */
  setDefaultBranch(repoId: number, branch: string) {
    const repo = this.#repo(repoId);
    const from = repo.defaultBranch;
    const tip = repo.refs.get(from);
    if (tip && !repo.refs.has(branch)) repo.refs.set(branch, tip);
    repo.defaultBranch = branch;
    this.#repositoryEvent(repo, "edited", { default_branch: { from } });
  }

  /**
   * What GitHub sends about a repository itself, to the installation that covers it, where the App
   * is subscribed to it (`repositoryEvents`).
   */
  #repositoryEvent(repo: FakeRepo, action: string, changes?: Record<string, unknown>) {
    if (!this.repositoryEvents) return;
    const installation = this.installed.get(repo.owner.id);
    if (!installation || !this.#covers(installation, repo)) return;
    this.deliveries.push({
      event: "repository",
      payload: {
        action,
        ...(changes && { changes }),
        repository: {
          ...this.#repoBrief(repo),
          owner: { id: repo.owner.id, login: repo.owner.login, type: repo.owner.type },
          default_branch: repo.defaultBranch,
          archived: repo.archived,
        },
        installation: { id: installation.id },
        sender: { id: repo.owner.id, login: repo.owner.login },
      },
    });
  }

  /** Every installation token stops working, as when an hour has gone by. */
  expireInstallationTokens() {
    for (const issued of this.#installationTokens.values()) issued.expiresAt = 0;
  }

  /**
   * A delivery as GitHub signs it: its headers and the exact bytes, for posting to the webhook.
   */
  static signed(delivery: FakeDelivery, secret: string, id = crypto.randomUUID()) {
    const body = JSON.stringify(delivery.payload);
    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": delivery.event,
        "x-github-delivery": id,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    };
  }

  /** Takes out what was delivered so far. */
  takeDeliveries(): FakeDelivery[] {
    return this.deliveries.splice(0);
  }

  // --- Signing in, as before --------------------------------------------------------------------

  /** The authorization is taken back: every token of the person stops working. */
  revoke(user: FakeUser = this.user) {
    this.#grants.delete(user.id);
  }

  /** The access token GitHub would take for a person now. */
  accessOf(user: FakeUser = this.user) {
    return this.#grants.get(user.id)?.access;
  }

  /** As if the access token had run out. */
  expireAccess(user: FakeUser = this.user) {
    const grant = this.#grants.get(user.id);
    if (grant) grant.accessExpiresAt = 0;
  }

  /** Whether a code was taken for tokens: undefined for one GitHub never gave. */
  codeUsed(code: string): boolean | undefined {
    return this.#codes.get(code)?.used;
  }

  /** A code for the callback, as GitHub would give one, with or without PKCE. */
  newCode(user: FakeUser, redirectUri: string, challenge?: string) {
    const code = randomBytes(10).toString("hex");
    this.#codes.set(code, { user, challenge, redirectUri, used: false });
    return code;
  }

  /** Tokens of a person straight away, as signing in would give them, for tests of what comes after. */
  grant(user: FakeUser = this.user): string {
    const grant = {
      user,
      access: token("ghu"),
      refresh: token("ghr"),
      accessExpiresAt: Date.now() + this.accessSeconds * 1000,
    };
    this.#grants.set(user.id, grant);
    return grant.access;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.faults.unreachable) throw new TypeError("fetch failed");
    const request = new Request(input, init);
    // Given up on, as a fetch that takes too long is: it says so then, whatever goes on here.
    const { signal } = request;
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      this.handle(request)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", stop));
    });
  };

  /**
   * `browser`: who is signed in to GitHub in the browser this comes from, and whether they say no
   * when asked.
   */
  async handle(
    request: Request,
    browser: FakeUser = this.user,
    deny = this.deny,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/login/oauth/authorize")
      return this.#authorize(url, browser, deny);
    if (request.method === "POST" && path === "/login/oauth/access_token")
      return this.#token(request);
    if (request.method === "GET" && path === `/apps/${this.appSlug}/installations/new`)
      return this.#installPage(browser);
    if (request.method === "DELETE" && path === `/api/applications/${this.clientId}/token`)
      return this.#revokeToken(request);
    if (path.startsWith("/api/")) return this.#api(request, path.slice(4), url);
    const batch = /^\/([^/]+)\/([^/]+)\.git\/info\/lfs\/objects\/batch$/.exec(path);
    if (batch && request.method === "POST")
      return this.#lfsBatch(request, decodeURIComponent(batch[1]!), decodeURIComponent(batch[2]!));
    if (path.startsWith("/_lfs/")) return this.#lfsAddress(request, url);
    if (path.startsWith("/_codeload/")) return this.#codeload(request, url);
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  #authorize(url: URL, browser: FakeUser, deny: boolean): Response {
    const query = url.searchParams;
    if (query.get("client_id") !== this.clientId)
      return new Response("unknown client", { status: 404 });
    const redirectUri = query.get("redirect_uri") ?? this.callbackUrl;
    if (redirectUri !== this.callbackUrl)
      return new Response("The redirect_uri MUST match the registered callback URL", {
        status: 400,
      });
    const back = new URL(redirectUri);
    const state = query.get("state");
    if (deny) {
      back.searchParams.set("error", "access_denied");
    } else {
      const challenge =
        query.get("code_challenge_method") === "S256"
          ? (query.get("code_challenge") ?? undefined)
          : undefined;
      back.searchParams.set("code", this.newCode(browser, redirectUri, challenge));
    }
    if (state !== null) back.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  /** Installing on the page, and back to the callback without a state, as GitHub does. */
  #installPage(browser: FakeUser): Response {
    const id = this.install(browser);
    const back = new URL(this.callbackUrl);
    back.searchParams.set("code", this.newCode(browser, this.callbackUrl));
    back.searchParams.set("installation_id", String(id));
    back.searchParams.set("setup_action", "install");
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  async #token(request: Request): Promise<Response> {
    const fields = (await request.json().catch(() => ({}))) as Record<string, string | undefined>;
    if (fields.client_id !== this.clientId || fields.client_secret !== this.clientSecret)
      return Response.json({ error: "incorrect_client_credentials" });
    if (fields.grant_type === "refresh_token") return this.#refresh(fields.refresh_token);
    const code = fields.code === undefined ? undefined : this.#codes.get(fields.code);
    if (!code || code.used) return Response.json({ error: "bad_verification_code" });
    code.used = true;
    if (fields.redirect_uri !== undefined && fields.redirect_uri !== code.redirectUri)
      return Response.json({ error: "redirect_uri_mismatch" });
    if (code.challenge !== undefined) {
      const verifier = fields.code_verifier ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== code.challenge)
        return Response.json({ error: "bad_verification_code" });
    }
    return this.#issue(code.user);
  }

  async #refresh(refresh: string | undefined): Promise<Response> {
    this.refreshes += 1;
    if (this.refreshDelayMs > 0) await new Promise((done) => setTimeout(done, this.refreshDelayMs));
    for (const grant of this.#grants.values())
      if (grant.refresh === refresh) return this.#issue(grant.user);
    return Response.json({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
    });
  }

  #issue(user: FakeUser): Response {
    const grant = {
      user,
      access: token("ghu"),
      refresh: token("ghr"),
      accessExpiresAt: Date.now() + this.accessSeconds * 1000,
    };
    this.#grants.set(user.id, grant);
    return Response.json({
      access_token: grant.access,
      expires_in: this.accessSeconds,
      refresh_token: grant.refresh,
      refresh_token_expires_in: 15897600,
      token_type: "bearer",
      scope: "",
    });
  }

  /** The App takes back one of its tokens, with its own credentials. */
  async #revokeToken(request: Request): Promise<Response> {
    const basic = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    if (request.headers.get("authorization") !== basic)
      return Response.json({ message: "Not Found" }, { status: 404 });
    if (this.failRevoking) return Response.json({ message: "Server Error" }, { status: 500 });
    const { access_token: access } = (await request.json().catch(() => ({}))) as {
      access_token?: string;
    };
    for (const [id, grant] of this.#grants)
      if (grant.access === access) {
        this.#grants.delete(id);
        this.revoked.push(access);
        return new Response(null, { status: 204 });
      }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  // --- Who is asking ----------------------------------------------------------------------------

  #bearer(request: Request): string | undefined {
    return /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  }

  /** Whose access token this is, while it works: only the newest of each person does. */
  #whoHas(request: Request): FakeUser | undefined {
    const access = this.#bearer(request);
    for (const grant of this.#grants.values())
      if (grant.access === access && grant.accessExpiresAt > Date.now()) return grant.user;
    return undefined;
  }

  /** Whether this is a JWT of the App, signed with its key, for now. */
  #isAppJwt(request: Request): boolean {
    const jwt = this.#bearer(request);
    const parts = jwt?.split(".");
    if (!parts || parts.length !== 3) return false;
    const [head, body, signature] = parts as [string, string, string];
    try {
      const header = JSON.parse(Buffer.from(head, "base64url").toString()) as { alg?: unknown };
      const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as {
        iat?: unknown;
        exp?: unknown;
        iss?: unknown;
      };
      if (header.alg !== "RS256") return false;
      const good = verify(
        "sha256",
        Buffer.from(`${head}.${body}`),
        this.#publicKey,
        Buffer.from(signature, "base64url"),
      );
      const now = Date.now() / 1000;
      return (
        good &&
        (claims.iss === this.clientId || claims.iss === String(this.appId)) &&
        typeof claims.exp === "number" &&
        typeof claims.iat === "number" &&
        claims.exp > now &&
        claims.iat <= now + 60 &&
        claims.exp - claims.iat <= 660
      );
    } catch {
      return false;
    }
  }

  #installationToken(request: Request): InstallationToken | undefined {
    const bearer = this.#bearer(request);
    const issued = bearer === undefined ? undefined : this.#installationTokens.get(bearer);
    return issued && issued.expiresAt > Date.now() ? issued : undefined;
  }

  #installationById(id: number): FakeInstallation | undefined {
    for (const installation of this.installed.values())
      if (installation.id === id) return installation;
    return undefined;
  }

  #covers(installation: FakeInstallation, repo: FakeRepo): boolean {
    return (
      installation.accountId === repo.owner.id &&
      (installation.selection === "all" || installation.repos.has(repo.id))
    );
  }

  #coveredBy(installation: FakeInstallation): FakeRepo[] {
    return [...this.repos.values()].filter((repo) => this.#covers(installation, repo));
  }

  /**
   * Who may do what with a repository: a token of an installation that covers it (and, if it is
   * limited, to it), or a person's token, where the App is installed over it and they own it. A
   * public one any person's token reads, wherever the App is installed: of their private ones it
   * sees no more than the App does.
   */
  #access(request: Request, repo: FakeRepo): { read: boolean; write: boolean; user?: FakeUser } {
    const issued = this.#installationToken(request);
    if (issued) {
      const installation = this.#installationById(issued.installationId);
      const ok =
        installation !== undefined &&
        !installation.suspended &&
        this.#covers(installation, repo) &&
        (issued.repoIds === undefined || issued.repoIds.has(repo.id));
      const contents = issued.permissions["contents"];
      return { read: ok, write: ok && (contents === undefined || contents === "write") };
    }
    const user = this.#whoHas(request);
    if (!user) return { read: false, write: false };
    const installation = this.installed.get(repo.owner.id);
    const ok =
      user.id === repo.owner.id &&
      installation !== undefined &&
      !installation.suspended &&
      this.#covers(installation, repo);
    return { read: ok || !repo.private, write: ok, user };
  }

  #repo(id: number): FakeRepo {
    const repo = this.repos.get(id);
    if (!repo) throw new Error(`no repository ${id}`);
    return repo;
  }

  #repoBrief(repo: FakeRepo) {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner.login}/${repo.name}`,
      private: repo.private,
    };
  }

  #repoJson(repo: FakeRepo, user?: FakeUser) {
    return {
      ...this.#repoBrief(repo),
      owner: { id: repo.owner.id, login: repo.owner.login, type: repo.owner.type },
      html_url: `https://github.com/${repo.owner.login}/${repo.name}`,
      description: repo.description,
      default_branch: repo.defaultBranch,
      archived: repo.archived,
      size: repo.refs.size === 0 ? 0 : 1,
      created_at: new Date(repo.createdAt).toISOString(),
      ...(user && {
        permissions: {
          admin: user.id === repo.owner.id,
          push: user.id === repo.owner.id && repo.readOnly !== true,
          pull: true,
        },
      }),
    };
  }

  #installationJson(installation: FakeInstallation) {
    return {
      id: installation.id,
      app_id: this.appId,
      app_slug: this.appSlug,
      account: {
        id: installation.accountId,
        login: installation.login,
        type: installation.accountType,
      },
      repository_selection: installation.selection,
      suspended_at: installation.suspended ? new Date().toISOString() : null,
    };
  }

  #deliver(
    event: string,
    action: string | undefined,
    installation: FakeInstallation,
    more: Record<string, unknown> = {},
  ) {
    this.deliveries.push({
      event,
      payload: {
        ...(action !== undefined && { action }),
        installation: this.#installationJson(installation),
        sender: { id: installation.accountId, login: installation.login },
        ...more,
      },
    });
  }

  /** A branch moves, and GitHub tells the webhook. */
  #move(repo: FakeRepo, branch: string, before: string | undefined, after: string, who?: FakeUser) {
    repo.refs.set(branch, after);
    // As GitHub says of a push (docs.github.com, webhook events, "push"): whether it was forced,
    // which the fake takes as "not a fast-forward". Not checked on the real GitHub yet (2-0).
    const forced = before !== undefined && !repo.objects.isAncestor(before, after);
    const installation = this.installed.get(repo.owner.id);
    if (!installation || !this.#covers(installation, repo)) return;
    this.deliveries.push({
      event: "push",
      payload: {
        ref: `refs/heads/${branch}`,
        before: before ?? "0".repeat(40),
        after,
        forced,
        repository: {
          ...this.#repoBrief(repo),
          owner: { id: repo.owner.id, login: repo.owner.login },
          default_branch: repo.defaultBranch,
        },
        installation: { id: installation.id },
        sender: who ? { id: who.id, login: who.login } : { login: `${this.appSlug}[bot]` },
      },
    });
  }

  // --- Git LFS ----------------------------------------------------------------------------------

  /**
   * Puts an object into a repository's large file storage, as a push of Git LFS elsewhere would.
   * Resolves to its oid.
   */
  addLfsObject(repoId: number, data: Buffer): string {
    const oid = createHash("sha256").update(data).digest("hex");
    this.#repo(repoId).lfs.set(oid, data);
    return oid;
  }

  /** Addresses that run out early, see `lfsExpireEarly` and `lfsExpireDownloads`. */
  readonly #lfsRevoked = new Set<string>();

  /** What signs the addresses of the large file storage, which nobody else knows. */
  readonly #lfsSecret = randomBytes(16).toString("hex");
  /** Headers an upload or a verify has to carry, as GitHub's carry credentials of their own. */
  readonly #lfsHeaders = new Map<string, string>();

  #lfsSign(what: string): string {
    return createHmac("sha256", this.#lfsSecret).update(what).digest("hex").slice(0, 32);
  }

  /** An address of the storage, signed, which works until `expires`, with a header of its own. */
  #lfsAction(origin: string, op: string, repo: FakeRepo, oid: string, size: number) {
    const expires =
      this.faults.lfsExpireEarly > 0 && op === "upload" ? Date.now() - 1000 : Date.now() + 900_000;
    if (this.faults.lfsExpireEarly > 0 && op === "upload") this.faults.lfsExpireEarly -= 1;
    // Said to last, and taken back early all the same, as an address that is revoked.
    if (this.faults.lfsExpireDownloads > 0 && op === "download") {
      this.faults.lfsExpireDownloads -= 1;
      this.#lfsRevoked.add(`${op}:${repo.id}:${oid}:${size}:${expires}`);
    }
    const sig = this.#lfsSign(`${op}:${repo.id}:${oid}:${size}:${expires}`);
    const href = `${origin}/_lfs/${repo.id}/${op}/${oid}?size=${size}&expires=${expires}&sig=${sig}`;
    const credential = randomBytes(12).toString("hex");
    this.#lfsHeaders.set(sig, credential);
    const header =
      op === "verify"
        ? { Authorization: `RemoteAuth ${credential}` }
        : op === "upload"
          ? { "X-Amz-Fake-Credential": credential }
          : {};
    return {
      href,
      header,
      expires_in: Math.round((expires - Date.now()) / 1000),
      expires_at: new Date(expires).toISOString(),
    };
  }

  /** The batch API of Git LFS, with a token as the password of Basic. */
  async #lfsBatch(request: Request, owner: string, name: string): Promise<Response> {
    const lfs = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/vnd.git-lfs+json" },
      });
    const basic = /^Basic (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const password = basic
      ? Buffer.from(basic, "base64").toString("utf8").split(":").slice(1).join(":")
      : undefined;
    if (!password) return lfs({ message: "Credentials needed" }, 401);
    const asked = new Request(request.url, { headers: { authorization: `Bearer ${password}` } });
    if (!this.#installationToken(asked) && !this.#whoHas(asked))
      return lfs({ message: "Bad credentials" }, 401);
    const repo = [...this.repos.values()].find(
      (each) =>
        each.owner.login.toLowerCase() === owner.toLowerCase() &&
        each.name.toLowerCase() === name.toLowerCase(),
    );
    if (!repo) return lfs({ message: "Repository not found" }, 404);
    const access = this.#access(asked, repo);
    if (!access.read) return lfs({ message: "Repository not found" }, 404);
    const body = (await request.json().catch(() => ({}))) as {
      operation?: unknown;
      objects?: unknown;
    };
    if (
      (body.operation !== "upload" && body.operation !== "download") ||
      !Array.isArray(body.objects)
    )
      return lfs({ message: "Invalid request" }, 422);
    const upload = body.operation === "upload";
    this.calls.push(`POST lfs/batch ${body.operation}`);
    if (this.faults.lfsDown > 0) {
      this.faults.lfsDown -= 1;
      return lfs({ message: "Service unavailable" }, 503);
    }
    if (upload && !access.write) return lfs({ message: "Write access denied" }, 403);
    if (upload && repo.archived)
      return lfs({ message: "Repository was archived so is read-only." }, 403);
    if ((upload && this.faults.lfsQuota) || (!upload && this.faults.lfsDownloadQuota))
      return lfs(
        {
          message:
            "This repository is over its data quota. Account responsible for LFS bandwidth should purchase more data packs to restore access.",
        },
        403,
      );
    const origin = new URL(request.url).origin;
    const objects = (body.objects as { oid?: unknown; size?: unknown }[]).map((object) => {
      const { oid, size } = object;
      if (typeof oid !== "string" || !/^[0-9a-f]{64}$/.test(oid) || typeof size !== "number")
        return { oid, size, error: { code: 422, message: "Invalid object" } };
      if (size > this.faults.lfsMaxBytes)
        return {
          oid,
          size,
          error: {
            code: 422,
            message: `Size must be less than or equal to ${this.faults.lfsMaxBytes}`,
          },
        };
      const there = repo.lfs.get(oid);
      // By the oid alone, or only what is of the size asked about, see `lfsAnySize`.
      const have = this.faults.lfsAnySize || there?.length === size ? there : undefined;
      if (upload) {
        if (have) return { oid, size, authenticated: true };
        return {
          oid,
          size,
          authenticated: true,
          actions: {
            upload: this.#lfsAction(origin, "upload", repo, oid, size),
            verify: this.#lfsAction(origin, "verify", repo, oid, size),
          },
        };
      }
      if (!have) return { oid, size, error: { code: 404, message: "Object does not exist" } };
      return {
        oid,
        size,
        authenticated: true,
        actions: { download: this.#lfsAction(origin, "download", repo, oid, size) },
      };
    });
    return lfs({ transfer: "basic", objects, hash_algo: "sha256" });
  }

  /** The addresses that the batch API gave out: what S3 and lfs.github.com are to GitHub. */
  async #lfsAddress(request: Request, url: URL): Promise<Response> {
    if (this.faults.lfsDelayMs > 0)
      await new Promise((done) => setTimeout(done, this.faults.lfsDelayMs));
    const match = /^\/_lfs\/(\d+)\/(upload|verify|download)\/([0-9a-f]{64})$/.exec(url.pathname);
    const repo = match ? this.repos.get(Number(match[1])) : undefined;
    if (!match || !repo) return new Response("NoSuchKey", { status: 404 });
    const op = match[2] as string;
    const oid = match[3] as string;
    const size = Number(url.searchParams.get("size"));
    const expires = Number(url.searchParams.get("expires"));
    const sig = url.searchParams.get("sig") ?? "";
    if (sig !== this.#lfsSign(`${op}:${repo.id}:${oid}:${size}:${expires}`))
      return new Response("SignatureDoesNotMatch", { status: 403 });
    if (
      !(expires > Date.now()) ||
      this.#lfsRevoked.has(`${op}:${repo.id}:${oid}:${size}:${expires}`)
    )
      return new Response("Request has expired", { status: 403 });
    const credential = this.#lfsHeaders.get(sig);
    if (op === "upload" && request.method === "PUT") {
      if (request.headers.get("x-amz-fake-credential") !== credential)
        return new Response("AccessDenied", { status: 403 });
      // S3 takes nothing of a length it was not told first.
      if (request.headers.get("content-length") !== String(size))
        return new Response("MissingContentLength", { status: 411 });
      const reader = request.body?.getReader();
      const pieces: Buffer[] = [];
      let got = 0;
      for (;;) {
        const read = reader ? await reader.read() : { done: true as const, value: undefined };
        if (read.done) break;
        pieces.push(Buffer.from(read.value));
        got += read.value.length;
        if (this.faults.lfsCutUploads > 0 && got >= size / 2) {
          this.faults.lfsCutUploads -= 1;
          await reader?.cancel().catch(() => {});
          throw new TypeError("fetch failed: other side closed");
        }
      }
      const data = Buffer.concat(pieces);
      if (data.length !== size) return new Response("IncompleteBody", { status: 400 });
      this.calls.push(`PUT lfs/object`);
      repo.lfsPut.set(oid, data);
      return new Response(null, { status: 200 });
    }
    if (op === "verify" && request.method === "POST") {
      if (request.headers.get("authorization") !== `RemoteAuth ${credential}`)
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { oid?: unknown; size?: unknown };
      const put = repo.lfsPut.get(oid);
      if (body.oid !== oid || body.size !== size || put?.length !== size)
        return Response.json({ message: "Object not found" }, { status: 404 });
      this.calls.push(`POST lfs/verify`);
      // As it was put there: whether it is the content of its oid is for tests to look at.
      repo.lfs.set(oid, put);
      repo.lfsPut.delete(oid);
      return Response.json({});
    }
    if (op === "download" && (request.method === "GET" || request.method === "HEAD")) {
      const data = repo.lfs.get(oid);
      if (!data) return new Response("NoSuchKey", { status: 404 });
      // What is there, as large as it is, whatever size the address was asked for.
      if (request.method === "HEAD") {
        this.calls.push("HEAD lfs/object");
        if (this.faults.lfsNoHead) return new Response(null, { status: 403 });
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(data.length), "accept-ranges": "bytes" },
        });
      }
      this.calls.push("GET lfs/object");
      const range = this.faults.lfsNoRanges
        ? null
        : /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
      if (range) {
        const from = Number(range[1]);
        const to = Math.min(range[2] === "" ? data.length - 1 : Number(range[2]), data.length - 1);
        this.ranges.push(from);
        const part = new Uint8Array(data.subarray(from, to + 1));
        if (this.faults.lfsCutDownloads > 0) {
          this.faults.lfsCutDownloads -= 1;
          // Half of it, and then the connection goes.
          const half = part.subarray(0, Math.floor(part.length / 2));
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(half);
              setTimeout(() => controller.error(new TypeError("other side closed")), 5);
            },
          });
          return new Response(body, {
            status: 206,
            headers: {
              "content-range": `bytes ${from}-${to}/${data.length}`,
              "content-length": String(part.length),
            },
          });
        }
        return new Response(part, {
          status: 206,
          headers: {
            "content-range": `bytes ${from}-${to}/${data.length}`,
            "content-length": String(Math.max(0, to - from + 1)),
          },
        });
      }
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { "content-length": String(data.length) },
      });
    }
    return new Response("MethodNotAllowed", { status: 405 });
  }

  // --- The API ----------------------------------------------------------------------------------

  /**
   * codeload: the tarball of a commit, at the address GitHub sent on to, which only its own token
   * opens. A request that comes with a token of GitHub's is turned away, so that a test finds out
   * where one would go where it should not.
   */
  async #codeload(request: Request, url: URL): Promise<Response> {
    const found = /^\/_codeload\/(\d+)\/([0-9a-f]{40})$/.exec(url.pathname);
    if (!found || request.method !== "GET") return notFound();
    const repo = this.repos.get(Number(found[1]));
    const sha = found[2] as string;
    if (!repo || url.searchParams.get("token") !== this.#lfsSign(`codeload:${repo.id}:${sha}`))
      return new Response("Not Found", { status: 404 });
    if (request.headers.has("authorization"))
      return new Response("a token of GitHub's was sent to codeload", { status: 400 });
    this.calls.push("GET codeload");
    if (this.faults.tarballDown > 0) {
      this.faults.tarballDown -= 1;
      return new Response("Bad Gateway", { status: 502 });
    }
    const whole = tarballOf(repo, sha);
    if (this.faults.tarballCut > 0) {
      this.faults.tarballCut -= 1;
      return new Response(whole.subarray(0, Math.floor(whole.length / 2)), {
        headers: { "content-type": "application/x-gzip" },
      });
    }
    return new Response(whole, {
      headers: { "content-type": "application/x-gzip", "content-length": String(whole.length) },
    });
  }

  async #api(request: Request, path: string, url: URL): Promise<Response> {
    const call = `${request.method} ${path}`;
    if (this.faults.delayMs > 0) await new Promise((done) => setTimeout(done, this.faults.delayMs));
    await this.onCall?.(call);
    if (this.faults.down > 0) {
      this.faults.down -= 1;
      return json({ message: "Server Error" }, 502);
    }
    if (this.faults.limited > 0) {
      this.faults.limited -= 1;
      return json(
        { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
        403,
        { "retry-after": "60" },
      );
    }
    const once = this.faults.once.findIndex(({ match }) => match.test(call));
    if (once >= 0) {
      const [planned] = this.faults.once.splice(once, 1);
      return json({ message: planned?.message ?? "Planned failure" }, planned?.status ?? 500);
    }
    this.calls.push(call);

    if (path.startsWith("/app/")) return this.#appApi(request, path);
    const repoPath = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoPath) {
      const owner = decodeURIComponent(repoPath[1] as string);
      const name = decodeURIComponent(repoPath[2] as string);
      const repo = [...this.repos.values()].find(
        (each) =>
          each.owner.login.toLowerCase() === owner.toLowerCase() &&
          each.name.toLowerCase() === name.toLowerCase(),
      );
      // A name a repository had before: GitHub sends on to where it is now, by its number, whoever
      // may see it there. To anyone else it is not there, as the repository is not.
      const former = repo ? undefined : this.#formerNames.get(`${owner}/${name}`.toLowerCase());
      const moved = former === undefined ? undefined : this.repos.get(former);
      if (moved && this.#access(request, moved).read) {
        const to = `${url.origin}/api/repositories/${moved.id}${repoPath[3] ?? ""}`;
        return json({ message: "Moved Permanently", url: to }, 301, { location: to });
      }
      return this.#repoApi(request, repo, repoPath[3] ?? "", url);
    }
    // The installation of the App on an account, by its name, which only the App asks.
    const ofAccount = /^\/(users|orgs)\/([^/]+)\/installation$/.exec(path);
    if (ofAccount) {
      if (!this.#isAppJwt(request))
        return json({ message: "A JSON web token could not be decoded" }, 401);
      const login = decodeURIComponent(ofAccount[2] as string).toLowerCase();
      const found = [...this.installed.values()].find((each) => each.login.toLowerCase() === login);
      return found ? json(this.#installationJson(found)) : notFound();
    }
    const byId = /^\/repositories\/(\d+)(\/.*)?$/.exec(path);
    if (byId) return this.#repoApi(request, this.repos.get(Number(byId[1])), byId[2] ?? "", url);

    const user = this.#whoHas(request);
    if (!user) return json({ message: "Bad credentials" }, 401);
    if (path === "/user")
      return json({
        id: user.id,
        login: user.login,
        type: "User",
        avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
      });
    if (path === "/user/installations") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const mine = this.installed.get(user.id);
      const installations = mine && page === 1 ? [this.#installationJson(mine)] : [];
      return json({ total_count: installations.length, installations });
    }
    const listing = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (listing) {
      const installation = this.#installationById(Number(listing[1]));
      if (!installation || installation.accountId !== user.id) return notFound();
      const perPage = Math.min(100, Number(url.searchParams.get("per_page") ?? "30"));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
      const all = this.#coveredBy(installation).toSorted((a, b) => a.id - b.id);
      return json({
        total_count: all.length,
        repository_selection: installation.selection,
        repositories: all
          .slice((page - 1) * perPage, page * perPage)
          .map((repo) => this.#repoJson(repo, user)),
      });
    }
    if (path === "/user/repos" && request.method === "POST") return this.#createRepo(request, user);
    return notFound();
  }

  async #appApi(request: Request, path: string): Promise<Response> {
    if (!this.#isAppJwt(request))
      return json({ message: "A JSON web token could not be decoded" }, 401);
    const tokens = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (tokens && request.method === "POST") {
      const installation = this.#installationById(Number(tokens[1]));
      if (!installation) return notFound();
      if (installation.suspended)
        return json({ message: "This installation has been suspended" }, 403);
      const body = (await request.json().catch(() => ({}))) as {
        repository_ids?: unknown;
        permissions?: unknown;
      };
      let repoIds: Set<number> | undefined;
      if (Array.isArray(body.repository_ids)) {
        repoIds = new Set(body.repository_ids as number[]);
        for (const id of repoIds) {
          const repo = this.repos.get(id);
          if (!repo || !this.#covers(installation, repo))
            return unprocessable(
              "There is at least one repository that does not exist or is not accessible to the parent installation.",
            );
        }
      }
      const permissions =
        typeof body.permissions === "object" && body.permissions !== null
          ? (body.permissions as Record<string, string>)
          : { administration: "write", contents: "write", metadata: "read" };
      const issued = token("ghs");
      const expiresAt = Date.now() + 3600_000;
      this.#installationTokens.set(issued, {
        installationId: installation.id,
        repoIds,
        permissions,
        expiresAt,
      });
      return json(
        {
          token: issued,
          expires_at: new Date(expiresAt).toISOString(),
          permissions: { ...permissions, metadata: "read" },
          repository_selection: repoIds ? "selected" : installation.selection,
          ...(repoIds && {
            repositories: [...repoIds].map((id) => this.#repoBrief(this.#repo(id))),
          }),
        },
        201,
      );
    }
    if (path === "/app/installations" && request.method === "GET") {
      const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
      const all = [...this.installed.values()].toSorted((a, b) => a.id - b.id);
      return json(
        all.slice((page - 1) * 100, page * 100).map((each) => this.#installationJson(each)),
      );
    }
    const one = /^\/app\/installations\/(\d+)$/.exec(path);
    if (one && request.method === "GET") {
      const installation = this.#installationById(Number(one[1]));
      return installation ? json(this.#installationJson(installation)) : notFound();
    }
    return notFound();
  }

  async #createRepo(request: Request, user: FakeUser): Promise<Response> {
    const installation = this.installed.get(user.id);
    // Only an installation on the person's own account lets their token make a repository there.
    if (!installation || installation.suspended)
      return json({ message: "Resource not accessible by integration" }, 403, {
        "x-accepted-github-permissions": "administration=write; repository_creation=write",
      });
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      description?: unknown;
      private?: unknown;
      auto_init?: unknown;
    };
    if (typeof body.name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(body.name))
      return unprocessable("Repository creation failed.", [
        { resource: "Repository", code: "custom", field: "name", message: "name is invalid" },
      ]);
    const taken = [...this.repos.values()].some(
      (repo) =>
        repo.owner.id === user.id &&
        repo.name.toLowerCase() === (body.name as string).toLowerCase(),
    );
    if (taken)
      return unprocessable("Repository creation failed.", [
        {
          resource: "Repository",
          code: "custom",
          field: "name",
          message: "name already exists on this account",
        },
      ]);
    const repo = this.addRepo(user, {
      name: body.name,
      private: body.private === true,
      ...(typeof body.description === "string" && { description: body.description }),
      ...(body.auto_init === true && { files: { "README.md": `# ${body.name}\n` } }),
    });
    // A new repository joins an installation on selected repositories.
    installation.repos.add(repo.id);
    this.#deliver("installation_repositories", "added", installation, {
      repository_selection: installation.selection,
      repositories_added: [this.#repoBrief(repo)],
      repositories_removed: [],
    });
    return json(this.#repoJson(repo, user), 201);
  }

  async #repoApi(
    request: Request,
    repo: FakeRepo | undefined,
    rest: string,
    url: URL,
  ): Promise<Response> {
    if (!this.#bearer(request)) return json({ message: "Requires authentication" }, 401);
    const known =
      this.#installationToken(request) !== undefined || this.#whoHas(request) !== undefined;
    if (!known) return json({ message: "Bad credentials" }, 401);
    if (!repo) return notFound();
    const issued = this.#installationToken(request);
    if (issued && this.#installationById(issued.installationId)?.suspended)
      return json({ message: "This installation has been suspended" }, 403);
    const access = this.#access(request, repo);
    if (!access.read) return notFound();
    const method = request.method;
    const writes = method !== "GET";
    if (writes && !access.write)
      return json({ message: "Resource not accessible by integration" }, 403);
    if (writes && repo.archived)
      return json({ message: "Repository was archived so is read-only." }, 403);
    const objects = repo.objects;

    if (rest === "" && method === "GET") return json(this.#repoJson(repo, access.user));

    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (contents && method === "PUT") {
      const path = (contents[1] as string).split("/").map(decodeURIComponent).join("/");
      const body = (await request.json().catch(() => ({}))) as {
        message?: unknown;
        content?: unknown;
        sha?: unknown;
        branch?: unknown;
        author?: { name?: string; email?: string; date?: string };
        committer?: { name?: string; email?: string; date?: string };
      };
      if (typeof body.message !== "string" || typeof body.content !== "string" || !isGoodPath(path))
        return unprocessable("Invalid request.");
      const branch = typeof body.branch === "string" ? body.branch : repo.defaultBranch;
      const before = repo.refs.get(branch);
      if (!before && repo.refs.size > 0) return notFound();
      const flat = before
        ? objects.flatten(objects.readCommit(before).tree)
        : new Map<string, FlatFile>();
      const existing = flat.get(path);
      if (existing && body.sha !== existing.sha)
        return unprocessable(`Invalid request.\n\n"sha" wasn't supplied.`);
      flat.set(path, { mode: "100644", sha: objects.blob(Buffer.from(body.content, "base64")) });
      const signature = (who: typeof body.author) => ({
        name: who?.name ?? "GitHub",
        email: who?.email ?? "noreply@github.com",
        time: Math.floor((who?.date ? Date.parse(who.date) : Date.now()) / 1000),
      });
      const author = signature(body.author ?? body.committer);
      const sha = objects.commit({
        tree: objects.treeOf(flat),
        parents: before ? [before] : [],
        author,
        committer: body.committer ? signature(body.committer) : author,
        message: body.message,
      });
      this.#move(repo, branch, before, sha, access.user);
      return json({ content: { path, sha: flat.get(path)?.sha }, commit: { sha } }, 201);
    }

    // A tarball of a commit or a branch: GitHub sends on to codeload, with a token of its own in
    // the address, which needs nothing else.
    const tarball = /^\/tarball\/(.+)$/.exec(rest);
    if (tarball && method === "GET") {
      const ref = decodeURIComponent(tarball[1] as string);
      const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : repo.refs.get(ref);
      if (!sha || objects.get(sha)?.type !== "commit") return notFound();
      const signed = this.#lfsSign(`codeload:${repo.id}:${sha}`);
      const to = `${url.origin}/_codeload/${repo.id}/${sha}?token=${signed}`;
      return new Response(null, { status: 302, headers: { location: to } });
    }

    // How one commit stands to another, as GitHub's compare API says it (docs.github.com, "Compare
    // two commits"): only `status` and `merge_base_commit` are kept of what it answers. Where either
    // is not there, or the two have nothing in common, 404 ("No common ancestor").
    const compare = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest);
    if (compare && method === "GET") {
      this.compared += 1;
      const [, base, head] = compare as unknown as [string, string, string];
      if (!objects.has(base, "commit") || !objects.has(head, "commit")) return notFound();
      const mergeBase = objects.mergeBase(base, head);
      if (mergeBase === undefined)
        return json({ message: `No common ancestor between ${base} and ${head}.` }, 404);
      const status =
        base === head
          ? "identical"
          : mergeBase === base
            ? "ahead"
            : mergeBase === head
              ? "behind"
              : "diverged";
      return json({
        status,
        ahead_by: 0,
        behind_by: 0,
        merge_base_commit: { sha: mergeBase },
        base_commit: { sha: base },
        commits: [],
      });
    }

    const git = /^\/git\/(.+)$/.exec(rest);
    if (!git) return notFound();
    const route = git[1] as string;

    const ref = /^refs?\/heads\/(.+)$/.exec(route);
    if (ref) {
      const branch = (ref[1] as string).split("/").map(decodeURIComponent).join("/");
      if (method === "GET" && route.startsWith("ref/")) {
        if (repo.refs.size === 0) return json({ message: "Git Repository is empty." }, 409);
        const sha = repo.refs.get(branch);
        if (!sha) return notFound();
        return json({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
      }
      if (method === "PATCH" && route.startsWith("refs/")) {
        const body = (await request.json().catch(() => ({}))) as { sha?: unknown; force?: unknown };
        const before = repo.refs.get(branch);
        if (!before) return unprocessable("Reference does not exist");
        if (typeof body.sha !== "string" || !objects.has(body.sha, "commit"))
          return unprocessable("Object does not exist");
        if (body.force !== true && !objects.isAncestor(before, body.sha))
          return unprocessable("Update is not a fast forward");
        this.#move(repo, branch, before, body.sha, access.user);
        return json({ ref: `refs/heads/${branch}`, object: { sha: body.sha, type: "commit" } });
      }
    }
    if (route === "refs" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { ref?: unknown; sha?: unknown };
      const name =
        typeof body.ref === "string" ? /^refs\/heads\/(.+)$/.exec(body.ref)?.[1] : undefined;
      if (!name || typeof body.sha !== "string" || !objects.has(body.sha, "commit"))
        return unprocessable("Invalid request.");
      if (repo.refs.has(name)) return unprocessable("Reference already exists");
      this.#move(repo, name, undefined, body.sha, access.user);
      return json({ ref: body.ref, object: { sha: body.sha, type: "commit" } }, 201);
    }

    if (repo.refs.size === 0) return json({ message: "Git Repository is empty." }, 409);

    const commit = /^commits(?:\/([0-9a-f]{40}))?$/.exec(route);
    if (commit && method === "GET" && commit[1]) {
      const sha = commit[1];
      if (!objects.has(sha, "commit")) return notFound();
      const read = objects.readCommit(sha);
      const person = (who: { name: string; email: string; time: number }) => ({
        name: who.name,
        email: who.email,
        date: new Date(who.time * 1000).toISOString(),
      });
      return json({
        sha,
        tree: { sha: read.tree },
        parents: read.parents.map((parent) => ({ sha: parent })),
        message: read.message,
        author: person(read.author),
        committer: person(read.committer),
      });
    }
    if (commit && method === "POST" && !commit[1]) {
      const body = (await request.json().catch(() => ({}))) as {
        message?: unknown;
        tree?: unknown;
        parents?: unknown;
        author?: { name?: unknown; email?: unknown; date?: unknown };
        committer?: { name?: unknown; email?: unknown; date?: unknown };
      };
      if (typeof body.message !== "string" || typeof body.tree !== "string")
        return unprocessable("Invalid request.");
      if (!objects.has(body.tree, "tree")) return unprocessable("Tree SHA does not exist");
      const parents = Array.isArray(body.parents) ? (body.parents as unknown[]) : [];
      if (!parents.every((parent) => typeof parent === "string" && objects.has(parent, "commit")))
        return unprocessable("Parent SHA does not exist or is not a commit object");
      const signature = (who: typeof body.author) => ({
        name: typeof who?.name === "string" ? who.name : `${this.appSlug}[bot]`,
        email:
          typeof who?.email === "string"
            ? who.email
            : `${this.appId}+${this.appSlug}[bot]@users.noreply.github.com`,
        time: Math.floor(
          (typeof who?.date === "string" ? Date.parse(who.date) : Date.now()) / 1000,
        ),
      });
      const author = signature(body.author);
      const sha = objects.commit({
        tree: body.tree,
        parents: parents as string[],
        author,
        committer: body.committer ? signature(body.committer) : author,
        message: body.message,
      });
      return json({ sha, tree: { sha: body.tree }, message: body.message }, 201);
    }

    const tree = /^trees(?:\/([0-9a-f]{40}))?$/.exec(route);
    if (tree && method === "GET" && tree[1]) {
      const sha = tree[1];
      if (!objects.has(sha, "tree")) return notFound();
      const recursive = url.searchParams.has("recursive");
      const entries: object[] = [];
      const list = (at: string, prefix: string) => {
        for (const item of objects.readTree(at)) {
          const path = `${prefix}${item.name}`;
          const isTree = item.mode === "40000";
          const type = isTree ? "tree" : item.mode === "160000" ? "commit" : "blob";
          const blob = type === "blob" ? objects.get(item.sha) : undefined;
          entries.push({
            path,
            mode: isTree ? "040000" : item.mode,
            type,
            sha: item.sha,
            ...(blob && { size: blob.data.length }),
          });
          if (isTree && recursive) list(item.sha, `${path}/`);
        }
      };
      list(sha, "");
      const cut =
        entries.length > 1 && (recursive ? this.faults.truncate : this.faults.truncateLevels);
      return json({
        sha,
        tree: cut ? entries.slice(0, Math.ceil(entries.length / 2)) : entries,
        truncated: cut,
      });
    }
    if (tree && method === "POST" && !tree[1]) {
      const body = (await request.json().catch(() => ({}))) as {
        base_tree?: unknown;
        tree?: unknown;
      };
      if (!Array.isArray(body.tree)) return unprocessable("Invalid tree info");
      let flat = new Map<string, FlatFile>();
      if (body.base_tree !== undefined) {
        if (typeof body.base_tree !== "string" || !objects.has(body.base_tree, "tree"))
          return unprocessable("Invalid tree info", [{ base_tree: "not found" }]);
        flat = objects.flatten(body.base_tree);
      }
      for (const entry of body.tree as {
        path?: unknown;
        mode?: unknown;
        type?: unknown;
        sha?: unknown;
        content?: unknown;
      }[]) {
        if (typeof entry?.path !== "string" || !isGoodPath(entry.path))
          return unprocessable("Invalid tree info", [{ path: entry?.path }]);
        if (entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000")
          return unprocessable("Invalid tree info", [{ mode: entry.mode }]);
        if (entry.content !== undefined && entry.sha !== undefined)
          return unprocessable("Must supply either tree.sha or tree.content, not both");
        if (entry.sha === null) {
          flat.delete(entry.path);
          continue;
        }
        let sha: string;
        if (typeof entry.content === "string") sha = objects.blob(entry.content);
        else if (typeof entry.sha === "string" && objects.has(entry.sha, "blob")) sha = entry.sha;
        else return unprocessable("Invalid tree info", [{ sha: entry.sha }]);
        // A file where a folder was, or the other way round, is not what this fake does.
        for (const other of flat.keys())
          if (other.startsWith(`${entry.path}/`) || entry.path.startsWith(`${other}/`))
            return unprocessable("Invalid tree info", [{ path: entry.path }]);
        flat.set(entry.path, { mode: entry.mode, sha });
      }
      const sha = objects.treeOf(flat);
      return json({ sha, url: `https://api.github.com/repos/x/y/git/trees/${sha}` }, 201);
    }

    const blob = /^blobs(?:\/([0-9a-f]{40}))?$/.exec(route);
    if (blob && method === "GET" && blob[1]) {
      const object = objects.get(blob[1]);
      if (!object || object.type !== "blob") return notFound();
      return json({
        sha: blob[1],
        size: object.data.length,
        content: wrapped(object.data),
        encoding: "base64",
      });
    }
    if (blob && method === "POST" && !blob[1]) {
      const body = (await request.json().catch(() => ({}))) as {
        content?: unknown;
        encoding?: unknown;
      };
      if (typeof body.content !== "string") return unprocessable("Invalid request.");
      const data =
        body.encoding === "base64"
          ? Buffer.from(body.content, "base64")
          : Buffer.from(body.content, "utf8");
      return json({ sha: objects.blob(data) }, 201);
    }
    return notFound();
  }
}
